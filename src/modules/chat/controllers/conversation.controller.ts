import type { Request, Response } from "express";
import { participantTypeForRole } from "../utils/participant-resolver.ts";
import { ConversationService } from "../services/conversation.service.ts";
import { CreateConversationSchema } from "../dto/create-conversation.dto.ts";
import { FindOrCreateConversationSchema } from "../dto/find-or-create-conversation.dto.ts";
import { ParticipantType } from "@prisma/client";
import { prisma } from "../../../config/prisma.ts";
import { actorFrom } from "../utils/chat-access.ts";

const service = new ConversationService();

type Counterpart = { id: string; type: ParticipantType; displayName: string; displayImage?: string | null };

/**
 * Phase 0: the only conversations a caller may open through find-or-create.
 *   PRODUCT_INQUIRY — a CUSTOMER with an existing VENDOR; when a product is
 *                     named it must belong to that vendor (and not be deleted);
 *   USER_SUPPORT    — a CUSTOMER with an active admin-side employee;
 *   VENDOR_SUPPORT  — a VENDOR with an active admin-side employee.
 * DELIVERY_CHAT / GENERAL_CHAT have no client workflow and are refused.
 * Unknown / wrong-kind counterparts answer 404 (nothing is revealed).
 */
async function resolveCounterpart(
  type: string,
  myType: ParticipantType,
  other: Counterpart,
  productId?: string,
): Promise<{ participant: Counterpart } | { status: number; error: string }> {
  const notFound = { status: 404, error: "Not found" };
  if (type === "PRODUCT_INQUIRY") {
    if (myType !== "CUSTOMER" || other.type !== "VENDOR") return { status: 403, error: "Forbidden" };
    const vendor = await prisma.vendor.findUnique({ where: { id: other.id }, select: { id: true, storeName: true, avatar: true } });
    if (!vendor) return notFound;
    if (productId) {
      const product = await prisma.product.findUnique({ where: { id: productId }, select: { vendorId: true, deletedAt: true } });
      if (!product || product.deletedAt || product.vendorId !== vendor.id) return notFound;
    }
    return { participant: { id: vendor.id, type: "VENDOR", displayName: vendor.storeName, displayImage: vendor.avatar ?? null } };
  }
  if (type === "USER_SUPPORT" || type === "VENDOR_SUPPORT") {
    const expected = type === "USER_SUPPORT" ? "CUSTOMER" : "VENDOR";
    if (myType !== expected || (other.type !== "ADMIN" && other.type !== "EMPLOYEE")) return { status: 403, error: "Forbidden" };
    const employee = await prisma.employee.findUnique({ where: { id: other.id }, select: { isActive: true, vendorId: true } });
    if (!employee || !employee.isActive || employee.vendorId) return notFound;
    return { participant: other };
  }
  return { status: 403, error: "Forbidden" };
}

function getParticipantType(role?: string): ParticipantType {
  return participantTypeForRole(role); // unknown → CUSTOMER (historical)
}

export async function findOrCreate(req: Request, res: Response) {
  try {
    const data = FindOrCreateConversationSchema.parse(req.body);

    // ✅ FIX: Map req.user.role/type to ParticipantType
    const myType = getParticipantType(req.user?.type || req.user?.role);

    const me = {
      id: req.user.id,
      type: myType, // ← was req.user.participantType (undefined)
      displayName: req.user.name,
      displayImage: req.user.avatar ?? null,
    };

    // Phase 0: who may open which conversation, with whom. The caller is always
    // "me" (server identity); the counterpart must be a real record of the
    // right kind, and its vendor name/avatar come from the database.
    const other = await resolveCounterpart(data.type, myType, data.otherParticipant, data.productId);
    if ("status" in other) return res.status(other.status).json({ error: other.error });

    const result = await service.findOrCreate(
      data.type,
      { productId: data.productId, orderId: data.orderId },
      [me, other.participant]
    );

    res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ error: error.message || error.errors?.[0]?.message });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const data = CreateConversationSchema.parse(req.body);
    // Phase 0: admin-side support staff only (route guard); the creator is
    // always one of the participants.
    const actor = actorFrom((req as any).user);
    if (!actor) return res.status(401).json({ error: "Unauthorized" });
    const included = data.participantIds.some((p) => p.type === actor.participantType && p.id === actor.id);
    if (!included) {
      // Site tokens are never agents (agents use /api/agent/chat), so AGENT can't occur here.
      data.participantIds.push({ id: actor.id, type: actor.participantType as Exclude<ParticipantType, "AGENT">, displayName: (req as any).user?.name ?? null, displayImage: null });
    }
    const result = await service.create(data);
    res.status(201).json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ error: error.message || error.errors?.[0]?.message });
  }
}

export async function getMyList(req: Request, res: Response) {
  try {
    let { cursor, limit, status } = req.query;
    const safeCursor = (cursor === "null" || cursor === "undefined" || !cursor) ? null : String(cursor);

    const ownerId = req.user?.id;
    const ownerType = getParticipantType(req.user?.type || req.user?.role);

    if (!ownerId) return res.status(401).json({ error: "Unauthorized" });

    const result = await service.getUserList(ownerId, ownerType, { 
      cursor: safeCursor, 
      limit: Number(limit) || 30, 
      status: status as any 
    });
    
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateStatus(req: Request, res: Response) {
  try {
    const { status } = req.body;
    const result = await service.updateStatus(req.params.id, status, req.user!.id);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
}

export async function assign(req: Request, res: Response) {
  try {
    const { assigneeId, assigneeType, note } = req.body;
    // Phase 0: a conversation can only be assigned to an active admin-side employee.
    if ((assigneeType !== "ADMIN" && assigneeType !== "EMPLOYEE") || typeof assigneeId !== "string") {
      return res.status(400).json({ error: "Invalid assignee" });
    }
    const assignee = await prisma.employee.findUnique({ where: { id: assigneeId }, select: { isActive: true, vendorId: true } });
    if (!assignee || !assignee.isActive || assignee.vendorId) {
      return res.status(400).json({ error: "Invalid assignee" });
    }
    const result = await service.assign(req.params.id, assigneeId, assigneeType, req.user!.id, note);
    res.json({ success: true, data: result });
  } catch (error: any) { 
    res.status(400).json({ error: error.message }); 
  }
}

export async function addLabel(req: Request, res: Response) {
  try {
    const { label, color } = req.body;
    const result = await service.addLabel(req.params.id, label, color, req.user!.id);
    res.json({ success: true, data: result });
  } catch (error: any) { 
    res.status(400).json({ error: error.message }); 
  }
}

export async function addNote(req: Request, res: Response) {
  try {
    const { content } = req.body;
    const result = await service.addNote(req.params.id, req.user!.id, content);
    res.json({ success: true, data: result });
  } catch (error: any) { 
    res.status(400).json({ error: error.message }); 
  }
  
}
export async function getSupportQueue(req: Request, res: Response) {
  try {
    const category = (req.query.category as string) || "ALL";
    const view = (req.query.view as string) || "UNASSIGNED";
    const result = await service.getSupportQueue(
      category as any,
      view as any,
      req.user!.id, // auth.middleware.ts ADMIN fix হওয়ার পর সঠিক Employee.id
      {
        status: req.query.status as any,
        cursor: req.query.cursor as string,
        limit: Number(req.query.limit) || 20,
      },
    );
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}