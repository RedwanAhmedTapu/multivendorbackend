// modules/chat/utils/chat-access.ts
//
// Phase 0 (chat hardening): the ONE place that decides who may see or act on a
// conversation. Used by the REST controllers and the Socket.IO handlers.
//
// Identity comes only from the authenticated server-side user (HTTP
// authenticateUser → req.user, or the same function run on the socket
// handshake → socket.data.user). `id` is ROLE-SPECIFIC, exactly as
// authenticateUser resolves it:
//   CUSTOMER → User.id, VENDOR → Vendor.id, EMPLOYEE / ADMIN → Employee.id
//   (ADMIN's auto-provisioned employee row), DELIVERY → its own id.
// ConversationParticipant / Message identity columns use the same ids
// (userId / vendorId / employeeId / deliveryPersonId).
//
// Access to a conversation =
//   (a) an active participant row matching the actor, OR
//   (b) admin-side support staff on a SUPPORT conversation (USER_SUPPORT /
//       VENDOR_SUPPORT): ADMIN, or an EMPLOYEE with no vendorId whose active
//       Employee.permissions.customerSupport is true — the same rule as
//       requirePermission("customerSupport") + blockVendorEmployees.
// A vendor's employee (EMPLOYEE with vendorId) never gets (b).

import { prisma } from "../../../config/prisma.ts";
import type { ParticipantType } from "@prisma/client";
import { identityWhere, isMessageSender, participantTypeForRole } from "./participant-resolver.ts";
import { agentChatEnabled, isAgentConversationType } from "../../agent/chat/agent-chat.config.ts";
import { isAgentChatStaff } from "../../agent/chat/agent-chat.policy.ts";

export { participantTypeForRole };

export interface ChatActor {
  id: string;
  participantType: ParticipantType;
  role: string;
  vendorId: string | null;
  employeeId: string | null;
}

export const SUPPORT_CONVERSATION_TYPES = ["USER_SUPPORT", "VENDOR_SUPPORT"] as const;

/** Builds the actor from an authenticated user (req.user / socket.data.user); null if unauthenticated. */
export function actorFrom(user: { id?: string; role?: string; vendorId?: string | null; employeeId?: string | null } | null | undefined): ChatActor | null {
  if (!user?.id || !user.role) return null;
  return {
    id: String(user.id),
    participantType: participantTypeForRole(user.role),
    role: String(user.role).toUpperCase(),
    vendorId: user.vendorId ?? null,
    employeeId: user.employeeId ?? null,
  };
}

/** ConversationParticipant / Message identity column for this actor. */
export function participantWhere(actor: ChatActor): Record<string, string> {
  return identityWhere(actor.participantType, actor.id, "employeeId"); // unknown → ADMIN / EMPLOYEE column
}

/** Personal socket room for this actor (matches SocketEmitter.toParticipant). */
export function personalRoom(actor: ChatActor): string {
  return `participant:${actor.participantType}:${actor.id}`;
}

/** Admin-side support staff: ADMIN, or an active admin-side EMPLOYEE holding customerSupport. */
export async function isSupportStaff(actor: ChatActor): Promise<boolean> {
  if (actor.role === "ADMIN") return true;
  if (actor.role !== "EMPLOYEE" || actor.vendorId || !actor.employeeId) return false;
  const employee = await prisma.employee.findUnique({
    where: { id: actor.employeeId },
    select: { isActive: true, vendorId: true, permissions: true },
  });
  if (!employee || !employee.isActive || employee.vendorId) return false;
  return !!((employee.permissions ?? {}) as Record<string, unknown>).customerSupport;
}

export interface ConversationAccess {
  conversation: { id: string; type: string };
  /** The actor's own active participant row, if any. */
  participant: { id: string } | null;
  viaSupport: boolean;
  /** P10: staff reading an agent↔vendor conversation (read-only, audited). Only ever set on agent conversations. */
  viaModeration?: boolean;
}

/** Null when the actor may not access the conversation (or it doesn't exist — callers answer 404 either way). */
export async function getConversationAccess(conversationId: string, actor: ChatActor): Promise<ConversationAccess | null> {
  if (typeof conversationId !== "string" || !conversationId) return null;
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, type: true } });
  if (!conversation) return null;
  // P10: agent conversations exist only while the feature is on.
  if (isAgentConversationType(conversation.type) && !agentChatEnabled()) return null;
  const participant = await prisma.conversationParticipant.findFirst({
    where: { conversationId, leftAt: null, ...participantWhere(actor) },
    select: { id: true },
  });
  if (participant) return { conversation, participant, viaSupport: false };
  if ((SUPPORT_CONVERSATION_TYPES as readonly string[]).includes(conversation.type) && (await isSupportStaff(actor))) {
    return { conversation, participant: null, viaSupport: true };
  }
  // P10: ADMIN / agentManagement staff — agent↔staff chats read + write (shared
  // inbox), agent↔vendor chats read-only moderation (audited by the caller).
  if (isAgentConversationType(conversation.type) && (await isAgentChatStaff(actor))) {
    return { conversation, participant: null, viaSupport: conversation.type === "AGENT_SUPPORT", viaModeration: conversation.type === "AGENT_VENDOR" };
  }
  return null;
}

/** Access to the conversation a message belongs to (plus the message's sender columns). */
export async function getMessageAccess(messageId: string, actor: ChatActor) {
  if (typeof messageId !== "string" || !messageId) return null;
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, conversationId: true, senderType: true, senderId: true, senderVendorId: true, senderEmployeeId: true, senderDeliveryPersonId: true },
  });
  if (!message) return null;
  const access = await getConversationAccess(message.conversationId, actor);
  return access ? { message, access } : null;
}

/** Did this actor send the message? */
export function isSender(
  message: { senderType: string; senderId: string | null; senderVendorId: string | null; senderEmployeeId: string | null; senderDeliveryPersonId: string | null },
  actor: ChatActor,
): boolean {
  return isMessageSender(message, actor.participantType, actor.id);
}

/** Standard "not found / no access" — never reveals whether a private conversation exists. */
export const NOT_FOUND = { error: "Not found" } as const;
