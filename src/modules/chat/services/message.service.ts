import { randomUUID } from "node:crypto";
import { prisma } from "../../../config/prisma.ts";
import { MessageRepository } from "../repositories/message.repository.ts";
import redisClient from "../../../config/redis.ts";
import { RedisKeys } from "../utils/redis-keys.ts";
import { getTruncatedText, getParticipantFilter } from "../utils/helpers.ts";
import { isOwnRow, ownerIdOf, senderColumns } from "../utils/participant-resolver.ts";
import { agentChatEnabled, isAgentConversationType } from "../../agent/chat/agent-chat.config.ts";
import type { SendMessageInput } from "../dto/send-message.dto.ts";
import { SocketEmitter } from "../socket/chat.handler.ts";
import { ParticipantType } from "@prisma/client";
import { AutoReplyService } from "./auto-reply.service.ts";
import { encodeCursor } from "../utils/pagination.ts";
import { withRedisTimeout, RedisUnavailableError } from "../utils/redis-timeout.ts";

/** Phase 3: upper bound for each duplicate / rate-limit Redis command in send(). */
export const REDIS_OP_TIMEOUT_MS = 1000;
const RELEASE_IF_OWNER = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export class MessageService {
  private repo = new MessageRepository();
  private autoReplyService = new AutoReplyService();

  async send(data: SendMessageInput, senderType: ParticipantType, senderId: string) {
    // Phase 3: duplicate detection and the rate limit are abuse controls with
    // no database equivalent (Message has no clientId), so when Redis can't
    // answer within REDIS_OP_TIMEOUT_MS the send FAILS CLOSED with
    // RedisUnavailableError (→ 503, retryable) — never bypassed, never an
    // indefinite wait. A failure before the message is persisted releases the
    // duplicate key, so the client's retry with the same clientId is accepted.
    const redisOp = <T>(op: () => Promise<T>) =>
      withRedisTimeout(op, REDIS_OP_TIMEOUT_MS).catch((): never => {
        throw new RedisUnavailableError();
      });
    const dedupKey = RedisKeys.messageDedup(senderType, senderId, data.clientId);
    // The key holds this request's own token and is released only if it still
    // does (atomic compare-and-delete), so a release never removes the key of
    // a concurrent request that did persist the message. Fire-and-forget: a
    // command issued while Redis is down is queued and runs, in order, after
    // a queued SET from this same request.
    const claim = randomUUID();
    const releaseDedup = () => {
      redisOp(() => redisClient.eval(RELEASE_IF_OWNER, { keys: [dedupKey], arguments: [claim] })).catch(() => undefined);
    };
    let isDup;
    try {
      isDup = await redisOp(() => redisClient.set(dedupKey, claim, { EX: 60, NX: true }));
    } catch (err) {
      releaseDedup(); // the SET may still run once Redis is back
      throw err;
    }
    if (!isDup) throw new Error("Duplicate message");

    let message;
    let conversationType: string | undefined; // P10: agent conversations skip auto-replies
    try {
      const rateKey = RedisKeys.rateLimit(senderId);
      const count = await redisOp(() => redisClient.incr(rateKey));
      if (count === 1) await redisOp(() => redisClient.expire(rateKey, 60));
      if (count > 30) throw new Error("Rate limit exceeded");

      // Guard against the FK case we hit earlier: fail clean instead of
      // leaking a raw Prisma error if the conversation doesn't exist.
      const conversationExists = await prisma.conversation.findUnique({
        where: { id: data.conversationId },
        select: { id: true, type: true },
      });
      if (!conversationExists) {
        throw new Error("CONVERSATION_NOT_FOUND");
      }
      conversationType = (conversationExists as { type?: string }).type;

      message = await prisma.message.create({
        data: {
          conversationId: data.conversationId,
          messageType: data.messageType,
          senderType,
          content: data.content,
          contentSearch: data.content?.toLowerCase(),
          status: "SENT",
          replyToId: data.replyToId,
          quickReplyId: data.quickReplyId,
          ...senderColumns(senderType, senderId),
        },
        include: { media: true },
      });
    } catch (err) {
      releaseDedup(); // nothing was persisted — the retry must not be refused as a duplicate
      throw err;
    }

    // Atomic updates
    await prisma.$transaction([
      prisma.conversation.update({
        where: { id: data.conversationId },
        data: {
          lastMessageAt: message.createdAt,
          lastMessageText: getTruncatedText(data.messageType, data.content),
          lastMessageType: data.messageType,
          lastSenderId: senderId,
          lastSenderType: senderType,
          lastMessageStatus: "SENT",
          messageCount: { increment: 1 },
        },
      }),
      prisma.conversationParticipant.updateMany({
        where: {
          conversationId: data.conversationId,
          leftAt: null,
          NOT: getParticipantFilter(senderType, senderId),
        },
        data: { unreadCount: { increment: 1 } },
      }),
    ]);

    // Async non-blocking tasks
   setImmediate(async () => {
  // Phase 1: never an unhandled rejection (Redis / DB hiccup) — that would take
  // the process down. Only the error kind is logged, never rule or message content.
  // Phase 2: the scope lookup is guarded too (it ran outside any catch, and a
  // failure there also skipped the live emits below).
  const logTriggerError = (err: any) => console.error("[auto-reply] trigger failed:", err?.code ?? err?.name ?? "error");
  try {
    let scopeVendorId: string | undefined;
    if (senderType === "CUSTOMER") {
      const vendorParticipant = await prisma.conversationParticipant.findFirst({
        where: { conversationId: data.conversationId, participantType: "VENDOR", leftAt: null },
        select: { vendorId: true },
      });
      scopeVendorId = vendorParticipant?.vendorId ?? undefined;
    }
    // P10: vendor / global auto-replies never answer inside agent conversations.
    if (!isAgentConversationType(conversationType)) {
      this.autoReplyService.processTrigger(data.conversationId, message, scopeVendorId).catch(logTriggerError);
    }
  } catch (err) {
    logTriggerError(err);
  }

      // Existing: notifies whoever currently has this specific thread open
      SocketEmitter.toRoom(`conversation:${data.conversationId}`).emit("newMessage", message);

      // NEW: notifies every OTHER participant on this conversation, even if
      // they don't have the thread open — this is what makes a vendor's
      // inbox update live instead of only after a refresh.
      try {
        const participants = await prisma.conversationParticipant.findMany({
          where: { conversationId: data.conversationId, leftAt: null },
          select: {
            participantType: true,
            userId: true,
            vendorId: true,
            employeeId: true,
            deliveryPersonId: true,
            ...(agentChatEnabled() ? { agentId: true } : {}), // P10: agents get the fan-out too
          },
        });

        const summary = {
          conversationId: data.conversationId,
          lastMessageAt: message.createdAt,
          lastMessageText: getTruncatedText(data.messageType, data.content),
          lastMessageType: data.messageType,
          lastSenderId: senderId,
          lastSenderType: senderType,
        };

        for (const p of participants) {
          const pid = ownerIdOf(p);
          if (!pid) continue;

          // Don't bother re-notifying the sender's own personal room
          if (isOwnRow(p, senderType, senderId)) continue;

          SocketEmitter.toParticipant(p.participantType, pid).emit("newMessage", message);
          SocketEmitter.toParticipant(p.participantType, pid).emit("conversationUpdated", summary);
        }
      } catch (err) {
        console.error("Failed to fan out personal-room notifications:", err);
      }
    });

    return message;
  }

  async getMessages(conversationId: string, params: { cursor?: string; limit?: number }) {
    const limit = Math.min(params.limit || 50, 100);
    const messages = await this.repo.getMessages(conversationId, params);
    return {
      data: messages,
      nextCursor:
        messages.length === limit
          ? encodeCursor( // Phase 0: was require(...) — undefined in this ES module (crashed every full page)
              messages[messages.length - 1].createdAt,
              messages[messages.length - 1].id
            )
          : null,
      hasMore: messages.length === limit,
    };
  }

  async toggleReaction(messageId: string, participantId: string, reaction: string) {
    const existing = await prisma.messageReaction.findUnique({
      where: { messageId_participantId: { messageId, participantId } },
    });
    if (existing) {
      return existing.reaction === reaction
        ? prisma.messageReaction.delete({ where: { id: existing.id } }).then(() => null)
        : prisma.messageReaction.update({ where: { id: existing.id }, data: { reaction } });
    }
    return prisma.messageReaction.create({ data: { messageId, participantId, reaction } });
  }

  async softDelete(messageId: string, ownerId: string) {
    const msg = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    const deletedFor = Array.isArray(msg.deletedFor) ? msg.deletedFor : [];
    if (!deletedFor.includes(ownerId)) {
      await prisma.message.update({ where: { id: messageId }, data: { deletedFor: { push: ownerId } } });
    }
  }
}