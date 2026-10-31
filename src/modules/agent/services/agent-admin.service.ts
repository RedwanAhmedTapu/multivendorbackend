// src/modules/agent/services/agent-admin.service.ts
//
// Admin management of agents: list / create / profile edits, status
// transitions (approve, suspend, reactivate, deactivate), vendor links,
// look-ups for the admin UI and the rate preview. Status changes and link
// changes are audited in the same transaction.

import { agentDb, agentTransaction, lockConfigArea } from "../agent-db.ts";
import { AgentError, conflict, notFound } from "../agent-http.ts";
import { writeConfigAudit, type AdminActor } from "./agent-audit.service.ts";
import { AGENT_PUBLIC_SELECT, createAgentByAdmin, revokeAllAgentAccess } from "./agent-auth.service.ts";
import { sendAgentApprovedEmail, sendAgentInviteEmail } from "./agent-mailer.ts";
import { getAgentSettings } from "./agent-settings.service.ts";
import { loadRateInputs, resolveAgentCommissionRate } from "./agent-rate.service.ts";

type Status = "PENDING" | "ACTIVE" | "SUSPENDED" | "DEACTIVATED";

/** Allowed status transitions. */
export const STATUS_TRANSITIONS: Record<"approve" | "suspend" | "reactivate" | "deactivate", { from: Status[]; to: Status }> = {
  approve: { from: ["PENDING"], to: "ACTIVE" },
  suspend: { from: ["ACTIVE"], to: "SUSPENDED" },
  reactivate: { from: ["SUSPENDED"], to: "ACTIVE" },
  deactivate: { from: ["PENDING", "ACTIVE", "SUSPENDED"], to: "DEACTIVATED" },
};

export async function listAgents(q: { status?: Status; levelId?: string; q?: string; page: number; limit: number }) {
  const where: any = {};
  if (q.status) where.status = q.status;
  if (q.levelId) where.levelId = q.levelId;
  if (q.q) {
    const term = q.q;
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { email: { contains: term.toLowerCase() } },
      { phone: { contains: term } },
      { agentCode: { contains: term.toUpperCase() } },
    ];
  }
  const [rows, total, counts] = await Promise.all([
    agentDb.prisma.agent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: {
        ...AGENT_PUBLIC_SELECT,
        statusReason: true,
        _count: { select: { vendorLinks: { where: { endedAt: null } } } },
      },
    }),
    agentDb.prisma.agent.count({ where }),
    agentDb.prisma.agent.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const statusCounts = Object.fromEntries(["PENDING", "ACTIVE", "SUSPENDED", "DEACTIVATED"].map((s) => [s, 0]));
  for (const c of counts as any[]) statusCounts[c.status] = c._count._all;
  return {
    items: rows.map((r: any) => ({ ...r, activeVendorCount: r._count.vendorLinks, _count: undefined })),
    total,
    page: q.page,
    limit: q.limit,
    statusCounts,
  };
}

export async function getAgentForAdmin(id: string) {
  const agent = await agentDb.prisma.agent.findUnique({
    where: { id },
    select: { ...AGENT_PUBLIC_SELECT, statusReason: true, approvedAt: true, approvedById: true, createdById: true, updatedAt: true },
  });
  if (!agent) throw notFound("Agent");
  const links = await agentDb.prisma.agentVendorLink.findMany({
    where: { agentId: id },
    orderBy: [{ endedAt: { sort: "asc", nulls: "first" } }, { startedAt: "desc" }],
    select: {
      id: true,
      source: true,
      startedAt: true,
      endedAt: true,
      note: true,
      vendor: { select: { id: true, storeName: true, status: true, avatar: true } },
    },
  });
  return { agent, vendorLinks: links };
}

export async function createAgent(input: { name: string; email: string; phone?: string; levelId?: string | null }, actor: AdminActor) {
  if (input.levelId) {
    const level = await agentDb.prisma.agentLevel.findUnique({ where: { id: input.levelId }, select: { id: true } });
    if (!level) throw notFound("Level");
  }
  const { agent, inviteToken } = await agentTransaction(async (tx) => {
    const created = await createAgentByAdmin(tx, input, actor.userId);
    await writeConfigAudit(tx, { entity: "AGENT", entityId: created.agent.id, action: "CREATE", newValue: created.agent, actor });
    return created;
  });
  let inviteEmailSent = true;
  try {
    await sendAgentInviteEmail(agent.email, agent.name, inviteToken);
  } catch (err: any) {
    inviteEmailSent = false;
    console.error(`[agent-admin] invite email failed for agent ${agent.id}: ${err?.message ?? err}`);
  }
  return { agent, inviteEmailSent };
}

export async function updateAgentByAdmin(id: string, data: { name?: string; phone?: string | null; levelId?: string | null }, actor: AdminActor) {
  return agentTransaction(async (tx) => {
    const before = await tx.agent.findUnique({ where: { id }, select: { id: true, name: true, phone: true, levelId: true } });
    if (!before) throw notFound("Agent");
    if (data.levelId) {
      const level = await tx.agentLevel.findUnique({ where: { id: data.levelId }, select: { id: true } });
      if (!level) throw notFound("Level");
    }
    if (data.phone) {
      const clash = await tx.agent.findUnique({ where: { phone: data.phone }, select: { id: true } });
      if (clash && clash.id !== id) throw conflict("An agent with this phone number already exists", "PHONE_TAKEN");
    }
    const after = await tx.agent.update({ where: { id }, data, select: { id: true, name: true, phone: true, levelId: true } });
    await writeConfigAudit(tx, { entity: "AGENT", entityId: id, action: "UPDATE", oldValue: before, newValue: after, actor });
    return after;
  });
}

export async function changeAgentStatus(
  id: string,
  action: keyof typeof STATUS_TRANSITIONS,
  reason: string | undefined,
  actor: AdminActor,
) {
  const rule = STATUS_TRANSITIONS[action];
  const result = await agentTransaction(async (tx) => {
    const before = await tx.agent.findUnique({ where: { id }, select: { id: true, status: true, statusReason: true, email: true, name: true } });
    if (!before) throw notFound("Agent");
    if (!rule.from.includes(before.status as Status)) {
      throw conflict(`Cannot ${action} an agent whose status is ${before.status}`, "STATUS_TRANSITION_NOT_ALLOWED");
    }
    // Guarded write: only if the status is still what we read.
    const claim = await tx.agent.updateMany({
      where: { id, status: before.status },
      data: {
        status: rule.to,
        statusReason: rule.to === "ACTIVE" ? null : (reason ?? null),
        ...(action === "approve" ? { approvedAt: new Date(), approvedById: actor.userId } : {}),
      },
    });
    if (claim.count !== 1) throw conflict("The agent's status changed meanwhile — reload and try again", "STATUS_CHANGED");
    if (rule.to === "SUSPENDED" || rule.to === "DEACTIVATED") await revokeAllAgentAccess(id, tx);
    await writeConfigAudit(tx, {
      entity: "AGENT",
      entityId: id,
      action: "STATUS",
      oldValue: { status: before.status, statusReason: before.statusReason },
      newValue: { status: rule.to, statusReason: rule.to === "ACTIVE" ? null : (reason ?? null), action },
      actor,
    });
    return before;
  });
  if (action === "approve") {
    sendAgentApprovedEmail(result.email, result.name).catch((err) =>
      console.error(`[agent-admin] approval email failed for agent ${id}: ${err?.message ?? err}`),
    );
  }
  return getAgentForAdmin(id);
}

// ── Vendor links ──────────────────────────────────────────────────────────

export async function assignVendorToAgent(agentId: string, input: { vendorId: string; note?: string; transfer: boolean }, actor: AdminActor) {
  return agentTransaction(async (tx) => {
    await lockConfigArea(tx, `vendor-link:${input.vendorId}`);
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { id: true, status: true } });
    if (!agent) throw notFound("Agent");
    if (agent.status !== "ACTIVE") throw conflict("Vendors can only be assigned to active agents", "AGENT_NOT_ACTIVE");
    const vendor = await tx.vendor.findUnique({ where: { id: input.vendorId }, select: { id: true, storeName: true } });
    if (!vendor) throw notFound("Vendor");

    const open = await tx.agentVendorLink.findFirst({
      where: { vendorId: input.vendorId, endedAt: null },
      select: { id: true, agentId: true, startedAt: true, source: true, agent: { select: { name: true } } },
    });
    if (open?.agentId === agentId) throw conflict("This vendor is already linked to this agent", "ALREADY_LINKED");
    if (open && !input.transfer) {
      throw conflict(`This vendor is linked to ${open.agent.name}. Confirm the transfer to move it.`, "VENDOR_LINKED_ELSEWHERE", {
        currentAgentId: open.agentId,
        currentAgentName: open.agent.name,
      });
    }
    const now = new Date();
    if (open) {
      await tx.agentVendorLink.update({ where: { id: open.id }, data: { endedAt: now, endedById: actor.userId } });
      await writeConfigAudit(tx, {
        entity: "VENDOR_LINK",
        entityId: open.id,
        action: "DEACTIVATE",
        oldValue: { agentId: open.agentId, vendorId: input.vendorId, startedAt: open.startedAt },
        newValue: { endedAt: now, reason: "transferred", toAgentId: agentId },
        actor,
      });
    }
    const link = await tx.agentVendorLink.create({
      data: { agentId, vendorId: input.vendorId, source: "ADMIN_ASSIGNED", assignedById: actor.userId, note: input.note ?? null, startedAt: now },
      select: { id: true, agentId: true, vendorId: true, source: true, startedAt: true, note: true },
    });
    await writeConfigAudit(tx, { entity: "VENDOR_LINK", entityId: link.id, action: "CREATE", newValue: { ...link, vendorName: vendor.storeName }, actor });
    return link;
  });
}

export async function endVendorLink(linkId: string, reason: string | undefined, actor: AdminActor) {
  return agentTransaction(async (tx) => {
    const link = await tx.agentVendorLink.findUnique({ where: { id: linkId }, select: { id: true, agentId: true, vendorId: true, startedAt: true, endedAt: true, note: true } });
    if (!link) throw notFound("Vendor link");
    if (link.endedAt) throw conflict("This link has already ended", "LINK_ENDED");
    const now = new Date();
    const claim = await tx.agentVendorLink.updateMany({ where: { id: linkId, endedAt: null }, data: { endedAt: now, endedById: actor.userId, note: reason ?? link.note } });
    if (claim.count !== 1) throw conflict("This link has already ended", "LINK_ENDED");
    await writeConfigAudit(tx, { entity: "VENDOR_LINK", entityId: linkId, action: "DEACTIVATE", oldValue: link, newValue: { endedAt: now, reason: reason ?? null }, actor });
    return { id: linkId, endedAt: now };
  });
}

// ── Look-ups for the admin UI ────────────────────────────────────────────

export async function lookupVendors(q: string) {
  const vendors = await agentDb.prisma.vendor.findMany({
    where: q ? { storeName: { contains: q, mode: "insensitive" } } : {},
    orderBy: { storeName: "asc" },
    take: 20,
    select: {
      id: true,
      storeName: true,
      status: true,
      agentLinks: { where: { endedAt: null }, select: { agentId: true, agent: { select: { name: true, agentCode: true } } } },
    },
  });
  return vendors.map((v: any) => ({
    id: v.id,
    storeName: v.storeName,
    status: v.status,
    currentAgent: v.agentLinks[0] ? { id: v.agentLinks[0].agentId, name: v.agentLinks[0].agent.name, agentCode: v.agentLinks[0].agent.agentCode } : null,
  }));
}

export async function lookupCategories(q: string) {
  return agentDb.prisma.category.findMany({
    where: q ? { name: { contains: q, mode: "insensitive" } } : {},
    orderBy: { name: "asc" },
    take: 20,
    select: { id: true, name: true, parent: { select: { name: true } } },
  });
}

export async function lookupAgents(q: string) {
  return agentDb.prisma.agent.findMany({
    where: q
      ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { agentCode: { contains: q.toUpperCase() } }, { email: { contains: q.toLowerCase() } }] }
      : {},
    orderBy: { name: "asc" },
    take: 20,
    select: { id: true, name: true, agentCode: true, status: true },
  });
}

/** Runs the real resolver with today's data — what a commission would use right now. */
export async function previewRate(params: { agentId?: string; vendorId?: string; categoryId?: string }) {
  if (!params.agentId && !params.vendorId) {
    throw new AgentError("Choose an agent or a vendor", 400, "VALIDATION_ERROR");
  }
  let agentId = params.agentId ?? null;
  if (!agentId && params.vendorId) {
    const link = await agentDb.prisma.agentVendorLink.findFirst({ where: { vendorId: params.vendorId, endedAt: null }, select: { agentId: true } });
    agentId = link?.agentId ?? null;
  }
  const settings = await getAgentSettings({ fresh: true });
  const inputs = await loadRateInputs({ agentId, vendorId: params.vendorId ?? null, categoryId: params.categoryId ?? null }, settings);
  const resolution = resolveAgentCommissionRate(inputs);
  return { agentId, resolution };
}
