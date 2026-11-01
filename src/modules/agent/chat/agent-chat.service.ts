// src/modules/agent/chat/agent-chat.service.ts
//
// P10 — the agent side of the EXISTING chat engine. Conversations, messages,
// unread counts, read receipts and media all go through the chat module's own
// services and tables; this file only adds the agent rules (agent-chat.policy)
// and limits (2,000 chars, 20 messages/min, 5 MB images, 10-minute links).
// PRIVACY: nothing here selects customer fields; the context panel shows
// order numbers and statuses only.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { prisma } from "../../../config/prisma.ts";
import redisClient from "../../../config/redis.ts";
import { ConversationService } from "../../chat/services/conversation.service.ts";
import { MessageService } from "../../chat/services/message.service.ts";
import { ReadReceiptService } from "../../chat/services/read-receipt.service.ts";
import { mediaService } from "../../chat/services/media.service.ts";
import { MessageRepository } from "../../chat/repositories/message.repository.ts";
import { identityColumns } from "../../chat/utils/participant-resolver.ts";
import { withRedisTimeout, RedisUnavailableError } from "../../chat/utils/redis-timeout.ts";
import { extractMediaKeysFromUrls, getR2Client, validateImageFile } from "../../../lib/r2-chat-media.ts";
import { AgentError, notFound } from "../agent-http.ts";
import { AGENT_CHAT_LIMITS, MODERATION_NOTICE, isAgentConversationType, piiWarning } from "./agent-chat.config.ts";
import { agentAccess, agentConversationStates } from "./agent-chat.policy.ts";

const conversations = new ConversationService();
const messages = new MessageService();
const receipts = new ReadReceiptService();
const messageRepo = new MessageRepository();
const db = () => prisma as any;

export const agentSendSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(64),
    messageType: z.enum(["TEXT", "IMAGE"]).default("TEXT"),
    content: z.string().max(AGENT_CHAT_LIMITS.maxChars, { error: `Messages can be at most ${AGENT_CHAT_LIMITS.maxChars} characters` }).optional(),
    clientId: z.string().trim().min(1).max(100),
    replyToId: z.string().trim().max(64).optional(),
  })
  .strict()
  .refine((m) => m.messageType !== "TEXT" || !!m.content?.trim(), { error: "Write a message" });

const forbidden = (reason: string) => new AgentError("This conversation is read-only", 403, reason);

// ── conversations ─────────────────────────────────────────────────────────

/** The agent's conversations (newest first) through the chat module's list, with read-only state. */
export async function listAgentConversations(agentId: string, params: { cursor?: string; limit?: number }) {
  const out = await conversations.getUserList(agentId, "AGENT" as any, params);
  const rows = out.data.filter((r: any) => isAgentConversationType(r.conversation.type));
  const states = await agentConversationStates(rows.map((r: any) => ({ id: r.conversation.id, type: r.conversation.type, agentLinkId: r.conversation.agentLinkId ?? null })), agentId);
  return {
    ...out,
    data: rows.map((r: any) => ({ ...r, readOnly: states.get(r.conversation.id)?.readOnly ?? true, readOnlyReason: states.get(r.conversation.id)?.reason ?? null, notice: MODERATION_NOTICE })),
  };
}

async function findOrCreateByKey(dedupeKey: string, create: () => Promise<{ id: string }>) {
  const existing = await db().conversation.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) return existing;
  try {
    return await create();
  } catch (err: any) {
    if (err?.code === "P2002") {
      const winner = await db().conversation.findUnique({ where: { dedupeKey }, select: { id: true } });
      if (winner) return winner;
    }
    throw err;
  }
}

/** The agent's one conversation with FinixMart staff (created on first use). */
export async function openSupportConversation(agentId: string) {
  const agent = await db().agent.findUnique({ where: { id: agentId }, select: { id: true, name: true, avatar: true, status: true } });
  if (!agent || agent.status !== "ACTIVE") throw notFound("Agent");
  return findOrCreateByKey(`agent-support:${agentId}`, () =>
    db().conversation.create({
      data: {
        type: "AGENT_SUPPORT",
        dedupeKey: `agent-support:${agentId}`,
        title: `Agent ${agent.name}`,
        participants: { create: [{ participantType: "AGENT", ...identityColumns("AGENT", agentId), displayName: agent.name, displayImage: agent.avatar ?? null }] },
      },
      select: { id: true },
    }),
  );
}

/** A conversation with a vendor the agent is linked to RIGHT NOW (one per link: a new link ⇒ a new conversation). */
export async function openVendorConversation(agentId: string, vendorId: string) {
  const link = await db().agentVendorLink.findFirst({ where: { agentId, vendorId, endedAt: null }, select: { id: true } });
  if (!link) throw notFound("Vendor"); // unlinked vendors look like missing ones
  const [agent, vendor] = await Promise.all([
    db().agent.findUnique({ where: { id: agentId }, select: { name: true, avatar: true } }),
    db().vendor.findUnique({ where: { id: vendorId }, select: { id: true, storeName: true, avatar: true } }),
  ]);
  if (!vendor || !agent) throw notFound("Vendor");
  const dedupeKey = `agent-vendor:${link.id}`;
  return findOrCreateByKey(dedupeKey, () =>
    db().conversation.create({
      data: {
        type: "AGENT_VENDOR",
        dedupeKey,
        agentLinkId: link.id,
        participants: {
          create: [
            { participantType: "AGENT", ...identityColumns("AGENT", agentId), displayName: agent.name, displayImage: agent.avatar ?? null },
            { participantType: "VENDOR", ...identityColumns("VENDOR", vendorId), displayName: vendor.storeName, displayImage: vendor.avatar ?? null },
          ],
        },
      },
      select: { id: true },
    }),
  );
}

// ── messages ──────────────────────────────────────────────────────────────

async function signed(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const keys = extractMediaKeysFromUrls({ url } as any) as any;
    const key = keys?.optimizedKey ?? keys?.originalKey ?? keys?.thumbnailKey ?? Object.values(keys ?? {}).find(Boolean);
    if (!key || !process.env.R2_BUCKET_NAME) return null;
    return await getSignedUrl(getR2Client(), new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: String(key) }), { expiresIn: AGENT_CHAT_LIMITS.signedUrlSeconds });
  } catch {
    return null; // never hand out the raw stored URL instead
  }
}

/** Media in agent conversations is handed out as 10-minute signed links only. */
async function withSignedMedia<T extends { media?: any }>(rows: T[]): Promise<T[]> {
  return Promise.all(
    rows.map(async (m) => (m.media ? { ...m, media: { ...m.media, url: await signed(m.media.url), thumbnailUrl: await signed(m.media.thumbnailUrl), expiresInSeconds: AGENT_CHAT_LIMITS.signedUrlSeconds } } : m)),
  );
}

export async function agentMessages(agentId: string, conversationId: string, params: { cursor?: string; limit?: number }) {
  const access = await agentAccess(agentId, conversationId);
  if (!access) throw notFound("Conversation");
  const out = await messages.getMessages(conversationId, params);
  return { ...out, data: await withSignedMedia(out.data as any[]), readOnly: access.mode === "read", readOnlyReason: access.reason, notice: MODERATION_NOTICE };
}

async function rateLimit(agentId: string) {
  const key = `agentchat:rate:AGENT:${agentId}`;
  const op = <T>(fn: () => Promise<T>) => withRedisTimeout(fn, 1000).catch((): never => { throw new RedisUnavailableError(); });
  const n = await op(() => redisClient.incr(key));
  if (n === 1) await op(() => redisClient.expire(key, 60));
  if (n > AGENT_CHAT_LIMITS.perMinute) throw new AgentError(`You can send at most ${AGENT_CHAT_LIMITS.perMinute} messages a minute`, 429, "RATE_LIMITED");
}

export async function agentSend(agentId: string, input: unknown) {
  const data = agentSendSchema.parse(input);
  const access = await agentAccess(agentId, data.conversationId);
  if (!access) throw notFound("Conversation");
  if (access.mode !== "write") throw forbidden(access.reason ?? "READ_ONLY");
  await rateLimit(agentId);
  const message = await messages.send({ ...data, content: data.content } as any, "AGENT" as any, agentId);
  return { message, warning: piiWarning(data.content) };
}

export async function agentMarkRead(agentId: string, conversationId: string, messageId: string) {
  const access = await agentAccess(agentId, conversationId);
  if (!access) throw notFound("Conversation");
  const participantId = await messageRepo.getParticipantId(conversationId, agentId, "AGENT");
  if (!participantId) throw notFound("Conversation");
  const message = await db().message.findUnique({ where: { id: String(messageId) }, select: { conversationId: true } });
  if (message?.conversationId !== conversationId) throw notFound("Message");
  await receipts.markAsRead(conversationId, participantId, messageId, agentId);
  return { ok: true };
}

/** Attach an image to the agent's own message (≤ 5 MB, jpeg/png/webp). */
export async function agentUploadImage(agentId: string, messageId: string, file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined) {
  if (!file) throw new AgentError("No file provided", 400, "VALIDATION_ERROR");
  if (file.size > AGENT_CHAT_LIMITS.maxAttachmentBytes) throw new AgentError("Images can be at most 5 MB", 413, "FILE_TOO_LARGE");
  if (!AGENT_CHAT_LIMITS.allowedImageTypes.includes(file.mimetype)) throw new AgentError("Only JPEG, PNG or WebP images", 415, "UNSUPPORTED_TYPE");
  const msg = await db().message.findUnique({ where: { id: String(messageId) }, select: { id: true, conversationId: true, senderType: true, senderAgentId: true } });
  if (!msg || msg.senderType !== "AGENT" || msg.senderAgentId !== agentId) throw notFound("Message");
  const access = await agentAccess(agentId, msg.conversationId);
  if (!access) throw notFound("Message");
  if (access.mode !== "write") throw forbidden(access.reason ?? "READ_ONLY");
  validateImageFile({ buffer: file.buffer, mimeType: file.mimetype, fileName: file.originalname });
  const result = await mediaService.processImage({ messageId: msg.id, file: file.buffer, fileName: file.originalname, mimeType: file.mimetype });
  return { url: await signed(result.url), thumbnailUrl: await signed(result.thumbnailUrl), width: result.width, height: result.height, expiresInSeconds: AGENT_CHAT_LIMITS.signedUrlSeconds };
}

/** Side panel for an agent↔vendor conversation: order numbers and statuses only (no customer data). */
export async function agentConversationContext(agentId: string, conversationId: string) {
  const access = await agentAccess(agentId, conversationId);
  if (!access) throw notFound("Conversation");
  if (access.conversation.type !== "AGENT_VENDOR") return { orders: [], vendor: null };
  const link = await db().agentVendorLink.findUnique({ where: { id: access.conversation.agentLinkId }, select: { vendorId: true, startedAt: true } });
  if (!link) return { orders: [], vendor: null };
  const [orders, vendor] = await Promise.all([
    db().vendorOrder.findMany({
      where: { vendorId: link.vendorId, createdAt: { gte: link.startedAt } },
      orderBy: { createdAt: "desc" },
      take: 8,
      // PRIVACY: explicit allow-list — no customer relation.
      select: { id: true, status: true, createdAt: true, order: { select: { orderNumber: true } } },
    }),
    db().vendor.findUnique({ where: { id: link.vendorId }, select: { id: true, storeName: true, avatar: true, status: true } }),
  ]);
  return {
    vendor,
    orders: orders.map((o: any) => ({ vendorOrderId: o.id, orderNumber: o.order?.orderNumber ?? null, status: o.status, createdAt: o.createdAt })),
  };
}

export async function agentUnreadTotal(agentId: string) {
  const agg = await db().conversationParticipant.aggregate({ where: { agentId, leftAt: null }, _sum: { unreadCount: true } });
  return { unread: agg._sum.unreadCount ?? 0 };
}
