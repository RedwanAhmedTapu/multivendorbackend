// modules/chat/controllers/staff-chat.controller.ts
//
// Admin inbox "New chat": admin-side support staff (the supportStaff route
// guard: ADMIN, or an admin-side EMPLOYEE with customerSupport) search for a
// vendor or customer and open a support conversation with them. Same
// conversation types and tables as the existing support chat
// (VENDOR_SUPPORT / USER_SUPPORT). An existing conversation with that vendor
// or customer is always reused, so staff never create a duplicate. Staff
// appear to the other side as "FinixMart Support".

import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../../config/prisma.ts";
import { toSupportQueueItem } from "../services/conversation.service.ts";
import { actorFrom } from "../utils/chat-access.ts";
import { identityColumnOf, identityColumns } from "../utils/participant-resolver.ts";

const SUPPORT_DISPLAY_NAME = "FinixMart Support";

const startSchema = z.object({ kind: z.enum(["VENDOR", "CUSTOMER"]), id: z.string().trim().min(1).max(64) }).strict();
const lookupSchema = z.object({ kind: z.enum(["VENDOR", "CUSTOMER"]), q: z.string().trim().max(100).default("") });

/** Enough to tell two customers apart, not the contact details themselves. */
export function maskContact(email?: string | null, phone?: string | null): string | null {
  if (email) {
    const [name, domain] = email.split("@");
    return `${name.slice(0, 1)}***@${domain ?? ""}`;
  }
  return phone ? `•••• ${phone.slice(-4)}` : null;
}

export async function staffLookup(req: Request, res: Response) {
  try {
    const { kind, q } = lookupSchema.parse(req.query);
    if (kind === "VENDOR") {
      const vendors = await prisma.vendor.findMany({
        where: q ? { storeName: { contains: q, mode: "insensitive" } } : {},
        orderBy: { storeName: "asc" },
        take: 20,
        select: { id: true, storeName: true, avatar: true },
      });
      return res.json({ success: true, data: vendors.map((v) => ({ id: v.id, name: v.storeName, image: v.avatar ?? null, detail: null })) });
    }
    if (q.length < 2) return res.json({ success: true, data: [] }); // customers are searched, never listed
    const customers = await prisma.user.findMany({
      where: {
        role: "CUSTOMER",
        isActive: true,
        OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }],
      },
      orderBy: { name: "asc" },
      take: 20,
      select: { id: true, name: true, email: true, phone: true },
    });
    res.json({ success: true, data: customers.map((c) => ({ id: c.id, name: c.name ?? "Customer", image: null, detail: maskContact(c.email, c.phone) })) });
  } catch (error: any) {
    if (error?.name === "ZodError") return res.status(400).json({ error: "Invalid search" });
    console.error("[chat] staff lookup failed:", error?.code ?? error?.name ?? "error");
    res.status(500).json({ error: "Internal server error" });
  }
}

const findExisting = async (kind: "VENDOR" | "CUSTOMER", id: string, type: "VENDOR_SUPPORT" | "USER_SUPPORT") => {
  const row = await prisma.conversationParticipant.findFirst({
    where: { leftAt: null, participantType: kind, [identityColumnOf(kind)!]: id, conversation: { type } },
    orderBy: { joinedAt: "desc" },
    select: { conversationId: true },
  });
  return row?.conversationId ?? null;
};

export async function staffStart(req: Request, res: Response) {
  try {
    const { kind, id } = startSchema.parse(req.body);
    const actor = actorFrom((req as any).user);
    if (!actor) return res.status(401).json({ error: "Unauthorized" });

    // The counterpart must be a real record of the right kind; its name comes from the database.
    let counterpart: { displayName: string; displayImage: string | null } | null = null;
    if (kind === "VENDOR") {
      const vendor = await prisma.vendor.findUnique({ where: { id }, select: { storeName: true, avatar: true } });
      if (vendor) counterpart = { displayName: vendor.storeName, displayImage: vendor.avatar ?? null };
    } else {
      const user = await prisma.user.findUnique({ where: { id }, select: { name: true, role: true, isActive: true } });
      if (user?.role === "CUSTOMER" && user.isActive) counterpart = { displayName: user.name ?? "Customer", displayImage: null };
    }
    if (!counterpart) return res.status(404).json({ error: "Not found" });

    const type = kind === "VENDOR" ? "VENDOR_SUPPORT" : "USER_SUPPORT";
    let conversationId = await findExisting(kind, id, type);
    if (!conversationId) {
      const dedupeKey = `staff-support:${type}:${id}`;
      try {
        conversationId = await prisma.$transaction(async (tx) => {
          const conv = await tx.conversation.create({
            data: {
              type,
              dedupeKey,
              participants: {
                create: [
                  { participantType: kind, ...identityColumns(kind, id), ...counterpart },
                  { participantType: actor.participantType, ...identityColumns(actor.participantType, actor.id), displayName: SUPPORT_DISPLAY_NAME, displayImage: null },
                ],
              },
            },
            select: { id: true },
          });
          await tx.conversationActivity.create({ data: { conversationId: conv.id, activityType: "CREATED", metadata: { count: 2, startedBy: actor.participantType } } });
          return conv.id;
        });
      } catch (err: any) {
        if (err?.code !== "P2002") throw err;
        // Another staff member started it at the same moment.
        const winner = await prisma.conversation.findUnique({ where: { dedupeKey }, select: { id: true } });
        if (!winner) throw err;
        conversationId = winner.id;
      }
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { participants: { where: { leftAt: null } }, assignments: { where: { isActive: true } } },
    });
    res.status(200).json({ success: true, data: toSupportQueueItem(conversation) });
  } catch (error: any) {
    if (error?.name === "ZodError") return res.status(400).json({ error: "Invalid request" });
    console.error("[chat] staff start failed:", error?.code ?? error?.name ?? "error");
    res.status(500).json({ error: "Internal server error" });
  }
}
