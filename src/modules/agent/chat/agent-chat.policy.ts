// src/modules/agent/chat/agent-chat.policy.ts
//
// P10 — the ONE place that decides who may read or write an agent
// conversation. Used by the agent REST routes, the /agent-socket server and
// the two small hooks in the existing chat module (getConversationAccess and
// the send controller). Everything is re-checked on every request / event.
//
//   AGENT_SUPPORT (agent ↔ FinixMart staff, one per agent, shared staff inbox)
//     agent  : its own conversation only, while ACTIVE → read + write
//     staff  : ADMIN, or an active admin-side EMPLOYEE with agentManagement → read + write
//   AGENT_VENDOR (agent ↔ one linked vendor, one per vendor link)
//     agent  : its own conversation; write only while THAT link is open, read-only after
//     vendor : the vendor OWNER (vendor participant row; vendor staff never) — write only
//              while the link is open and the agent is ACTIVE, read-only otherwise
//     staff  : read-only moderation (audited by the caller)
// A suspended / deactivated agent can't authenticate at all (cut off); its
// conversations stay as history for the other side. No agent can see another
// agent's conversation (participant row required). Customers and delivery
// users never get a branch here.

import { prisma } from "../../../config/prisma.ts";
import { isAgentConversationType, type AgentConversationType } from "./agent-chat.config.ts";

export type AgentChatMode = "write" | "read";
export type ConversationRef = { id: string; type: string; agentLinkId?: string | null };

const db = () => prisma as any;

/** Admin-side staff for agent chat: ADMIN, or an active EMPLOYEE without vendorId holding agentManagement. */
export async function isAgentChatStaff(actor: { role: string; vendorId: string | null; employeeId: string | null }): Promise<boolean> {
  if (actor.role === "ADMIN") return true;
  if (actor.role !== "EMPLOYEE" || actor.vendorId || !actor.employeeId) return false;
  const employee = await prisma.employee.findUnique({ where: { id: actor.employeeId }, select: { isActive: true, vendorId: true, permissions: true } });
  if (!employee || !employee.isActive || employee.vendorId) return false;
  return !!((employee.permissions ?? {}) as Record<string, unknown>).agentManagement;
}

/** The conversation's link is open and belongs to `agentId`. */
async function linkOpenFor(conversation: ConversationRef, agentId?: string | null): Promise<{ open: boolean; agentId: string | null }> {
  if (!conversation.agentLinkId) return { open: false, agentId: null };
  const link = await db().agentVendorLink.findUnique({ where: { id: conversation.agentLinkId }, select: { agentId: true, endedAt: true } });
  if (!link) return { open: false, agentId: null };
  return { open: !link.endedAt && (!agentId || link.agentId === agentId), agentId: link.agentId };
}

async function agentActive(agentId: string | null | undefined): Promise<boolean> {
  if (!agentId) return false;
  const a = await db().agent.findUnique({ where: { id: agentId }, select: { status: true } });
  return a?.status === "ACTIVE";
}

/** The agent's participant id and mode in its own agent conversation, or null (no access). */
export async function agentAccess(agentId: string, conversationId: string): Promise<{ conversation: ConversationRef; participantId: string; mode: AgentChatMode; reason: string | null } | null> {
  if (typeof conversationId !== "string" || !conversationId) return null;
  const conversation = await db().conversation.findUnique({ where: { id: conversationId }, select: { id: true, type: true, agentLinkId: true } });
  if (!conversation || !isAgentConversationType(conversation.type)) return null;
  const participant = await db().conversationParticipant.findFirst({ where: { conversationId, agentId, leftAt: null }, select: { id: true } });
  if (!participant) return null; // another agent's conversation looks like a missing one
  if (!(await agentActive(agentId))) return null; // cut off immediately (the auth layer refuses too)
  if (conversation.type === "AGENT_SUPPORT") return { conversation, participantId: participant.id, mode: "write", reason: null };
  const link = await linkOpenFor(conversation, agentId);
  return { conversation, participantId: participant.id, mode: link.open ? "write" : "read", reason: link.open ? null : "LINK_ENDED" };
}

/**
 * May a site user (vendor owner / staff) that already has access write in an
 * agent conversation? `viaModeration` = staff reading an agent↔vendor chat.
 */
export async function counterpartMayWrite(conversation: ConversationRef, opts: { viaModeration: boolean }): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.viaModeration) return { ok: false, reason: "READ_ONLY_MODERATION" };
  if (conversation.type === "AGENT_SUPPORT") return { ok: true };
  if (conversation.type !== "AGENT_VENDOR") return { ok: false, reason: "NOT_AGENT_CONVERSATION" };
  const full = conversation.agentLinkId === undefined ? await db().conversation.findUnique({ where: { id: conversation.id }, select: { id: true, type: true, agentLinkId: true } }) : conversation;
  const link = await linkOpenFor(full ?? conversation);
  if (!link.open) return { ok: false, reason: "LINK_ENDED" };
  if (!(await agentActive(link.agentId))) return { ok: false, reason: "AGENT_UNAVAILABLE" };
  return { ok: true };
}

/** Read-only / banner info for a list of agent conversations (one link query). */
export async function agentConversationStates(conversations: Array<{ id: string; type: string; agentLinkId?: string | null }>, viewerAgentId?: string) {
  const linkIds = [...new Set(conversations.map((c) => c.agentLinkId).filter(Boolean))] as string[];
  const links: Array<{ id: string; agentId: string; endedAt: Date | null; agent: { status: string } | null }> = linkIds.length
    ? await db().agentVendorLink.findMany({ where: { id: { in: linkIds } }, select: { id: true, agentId: true, endedAt: true, agent: { select: { status: true } } } })
    : [];
  const byId = new Map(links.map((l) => [l.id, l]));
  const out = new Map<string, { readOnly: boolean; reason: string | null }>();
  for (const c of conversations) {
    if (c.type !== "AGENT_VENDOR") {
      out.set(c.id, { readOnly: false, reason: null });
      continue;
    }
    const l = c.agentLinkId ? byId.get(c.agentLinkId) : undefined;
    const open = !!l && !l.endedAt && (!viewerAgentId || l.agentId === viewerAgentId);
    const active = l?.agent?.status === "ACTIVE";
    out.set(c.id, { readOnly: !open || !active, reason: !open ? "LINK_ENDED" : !active ? "AGENT_UNAVAILABLE" : null });
  }
  return out;
}

export type { AgentConversationType };
