import type { Request, Response } from "express";
import { AGENT_CHAT_LIMITS, isAgentConversationType, piiWarning } from "../../agent/chat/agent-chat.config.ts";
import { counterpartMayWrite } from "../../agent/chat/agent-chat.policy.ts";
import { prisma } from "../../../config/prisma.ts";
import { participantTypeForRole } from "../utils/participant-resolver.ts";
import { MessageService } from "../services/message.service.ts";
import { SendMessageSchema } from "../dto/send-message.dto.ts";
import { ParticipantType } from "@prisma/client";
import { actorFrom, getConversationAccess, getMessageAccess, NOT_FOUND } from "../utils/chat-access.ts";
import { RedisUnavailableError } from "../utils/redis-timeout.ts";

// Phase 3: send() failures the client can act on keep their 400 answers;
// Redis unavailable is a retryable 503 (nothing was accepted); anything else
// (e.g. the database) is a generic 500 — no internal detail in the response.
const SEND_CLIENT_ERRORS = new Set(["Duplicate message", "Rate limit exceeded", "CONVERSATION_NOT_FOUND"]);

const service = new MessageService();

// Phase 0: message types a client may send. SYSTEM and QUICK_REPLY are
// server-generated only (no client workflow sends them — ChatBox sends TEXT,
// IMAGE and AUDIO).
const CLIENT_MESSAGE_TYPES = new Set(["TEXT", "IMAGE", "AUDIO"]);

// ✅ Helper to safely map JWT role to Prisma ParticipantType
function getParticipantType(role?: string): ParticipantType {
  return participantTypeForRole(role); // unknown → CUSTOMER (historical)
}

export async function send(req: Request, res: Response) {
  try {
    const data = SendMessageSchema.parse(req.body);
    
    // ✅ FIX: Safely extract id and map role/type to ParticipantType
    const senderId = req.user?.id;
    const senderType = getParticipantType(req.user?.type || req.user?.role);

    if (!senderId) {
      return res.status(401).json({ error: "Unauthorized: User ID missing" });
    }
    if (!CLIENT_MESSAGE_TYPES.has(data.messageType)) {
      return res.status(400).json({ error: "Unsupported message type" });
    }
    // Phase 0: only someone with access to the conversation may post in it
    // (its participant, or admin-side support staff on a support chat). The
    // sender identity is the authenticated actor — never taken from the body.
    const actor = actorFrom((req as any).user);
    const access = actor ? await getConversationAccess(data.conversationId, actor) : null;
    if (!actor || !access) {
      return res.status(404).json(NOT_FOUND);
    }
    // P10: agent conversations — read-only rules, 2,000 characters, PII warning.
    let agentWarning: string | null = null;
    if (isAgentConversationType(access.conversation.type)) {
      const gate = await counterpartMayWrite(access.conversation, { viaModeration: !!access.viaModeration });
      if (!gate.ok) return res.status(403).json({ error: "This conversation is read-only", code: gate.reason });
      if ((data.content?.length ?? 0) > AGENT_CHAT_LIMITS.maxChars) {
        return res.status(400).json({ error: `Messages can be at most ${AGENT_CHAT_LIMITS.maxChars} characters` });
      }
      agentWarning = piiWarning(data.content);
    }

    const result = await service.send(data, senderType, senderId);
    res.status(201).json({ success: true, data: result, ...(agentWarning ? { warning: agentWarning } : {}) });
  } catch (error: any) {
    if (error instanceof RedisUnavailableError) {
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ error: "Messaging is temporarily unavailable. Please retry.", retryable: true });
    }
    if (error?.name === "ZodError" || SEND_CLIENT_ERRORS.has(error?.message)) {
      return res.status(400).json({ error: error.message || error.errors?.[0]?.message });
    }
    console.error("[chat] send failed:", error?.code ?? error?.name ?? "error");
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getList(req: Request, res: Response) {
  try {
    let { cursor, limit } = req.query;
    const safeCursor = (cursor === "null" || cursor === "undefined" || !cursor) ? undefined : String(cursor);

    // Phase 0: history is readable only with access to this conversation.
    const actor = actorFrom((req as any).user);
    const access = actor ? await getConversationAccess(req.params.conversationId, actor) : null;
    if (!actor || !access) {
      return res.status(404).json(NOT_FOUND);
    }
    // P10: every staff read of an agent↔vendor conversation is audited (before the read).
    if (access.viaModeration) {
      await prisma.auditLog.create({
        data: { userId: (req as any).user?.rawId ?? null, action: "AGENT_CHAT_MODERATION_READ", entity: "Conversation", entityId: req.params.conversationId, newData: { conversationId: req.params.conversationId, role: actor.role } },
      });
    }

    const result = await service.getMessages(req.params.conversationId, { 
      cursor: safeCursor, 
      limit: Number(limit) || 50 
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function react(req: Request, res: Response) {
  try {
    const { reaction } = req.body;
    // Phase 0: the reacting participant is the actor's OWN participant row in
    // the message's conversation — a body participantId is ignored.
    const actor = actorFrom((req as any).user);
    const found = actor ? await getMessageAccess(req.params.messageId, actor) : null;
    if (!found) return res.status(404).json(NOT_FOUND);
    if (!found.access.participant) return res.status(403).json({ error: "Forbidden" });
    if (typeof reaction !== "string" || !reaction || reaction.length > 32) {
      return res.status(400).json({ error: "Invalid reaction" });
    }
    const result = await service.toggleReaction(req.params.messageId, found.access.participant.id, reaction);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
}

export async function remove(req: Request, res: Response) {
  try {
    // Phase 0: only within a conversation the actor may access.
    const actor = actorFrom((req as any).user);
    if (!actor || !(await getMessageAccess(req.params.messageId, actor))) {
      return res.status(404).json(NOT_FOUND);
    }
    await service.softDelete(req.params.messageId, actor.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
}