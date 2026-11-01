// src/modules/agent/chat/agent-chat.controller.ts
//
// P10 — /api/agent/chat/* (authenticateAgent: agent tokens only) and the staff
// list under /api/admin/agents/chat (site tokens: ADMIN or agentManagement).
// Every route answers 404 when the AGENT_CHAT_ENABLED kill switch is "0" / "false". The agent identity
// always comes from req.agent; site users keep using the existing /api/chat
// routes for reading and replying (same services, same tables).

import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../../../config/prisma.ts";
import { handle, ok } from "../agent-http.ts";
import type { AgentRequest } from "../middlewares/agent-auth.middleware.ts";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import { pageQuery } from "../validators/agent-primitives.ts";
import { AGENT_CHAT_LIMITS, MODERATION_NOTICE, agentChatEnabled } from "./agent-chat.config.ts";
import { agentConversationStates } from "./agent-chat.policy.ts";
import * as svc from "./agent-chat.service.ts";

/** 404 for every agent-chat route while the kill switch is on. */
export function requireAgentChat(_req: Request, res: Response, next: NextFunction) {
  if (!agentChatEnabled()) {
    res.status(404).json({ success: false, message: "Not found" });
    return;
  }
  next();
}

export const agentChatUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AGENT_CHAT_LIMITS.maxAttachmentBytes, files: 1 } }).single("file");

const id = (req: Request, key: string) => z.string().trim().min(1).max(64).parse(String(req.params[key] ?? ""));
const listQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
const messagesQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const readBody = z.object({ messageId: z.string().trim().min(1).max(64) }).strict();
const agentId = (req: AgentRequest) => req.agent!.id;

// ── agent ─────────────────────────────────────────────────────────────────
export const list = handle(async (req: AgentRequest, res) => {
  const q = listQuery.parse(req.query);
  ok(res, await svc.listAgentConversations(agentId(req), { cursor: q.cursor, limit: q.limit }));
});
export const openSupport = handle(async (req: AgentRequest, res) => ok(res, await svc.openSupportConversation(agentId(req)), undefined, 201));
export const openVendor = handle(async (req: AgentRequest, res) => ok(res, await svc.openVendorConversation(agentId(req), id(req, "vendorId")), undefined, 201));
export const messages = handle(async (req: AgentRequest, res) => {
  const q = messagesQuery.parse(req.query);
  ok(res, await svc.agentMessages(agentId(req), id(req, "conversationId"), { cursor: q.cursor, limit: q.limit }));
});
export const send = handle(async (req: AgentRequest, res) => {
  const out = await svc.agentSend(agentId(req), req.body);
  ok(res, out.message, out.warning ? { warning: out.warning } : undefined, 201);
});
export const markRead = handle(async (req: AgentRequest, res) => {
  const { messageId } = readBody.parse(req.body);
  ok(res, await svc.agentMarkRead(agentId(req), id(req, "conversationId"), messageId));
});
export const uploadImage = handle(async (req: AgentRequest, res) => {
  ok(res, await svc.agentUploadImage(agentId(req), id(req, "messageId"), (req as any).file));
});
export const context = handle(async (req: AgentRequest, res) => ok(res, await svc.agentConversationContext(agentId(req), id(req, "conversationId"))));
export const unread = handle(async (req: AgentRequest, res) => ok(res, await svc.agentUnreadTotal(agentId(req))));

// ── staff (site token) ────────────────────────────────────────────────────
const staffListQuery = z.object({ ...pageQuery, type: z.enum(["AGENT_SUPPORT", "AGENT_VENDOR"]).optional(), agentId: z.string().trim().max(64).optional() });

/**
 * Agent conversations for the admin chat UI. Staff read and reply through the
 * existing /api/chat routes (getConversationAccess grants AGENT_SUPPORT read +
 * write and AGENT_VENDOR read-only moderation, audited on every read).
 */
export const staffList = handle(async (req: AuthRequest, res) => {
  const q = staffListQuery.parse(req.query);
  const db = prisma as any;
  const where: any = { type: q.type ? q.type : { in: ["AGENT_SUPPORT", "AGENT_VENDOR"] } };
  if (q.agentId) where.participants = { some: { agentId: q.agentId } };
  const [rows, total] = await Promise.all([
    db.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: {
        id: true,
        type: true,
        status: true,
        agentLinkId: true,
        lastMessageAt: true,
        lastMessageText: true,
        lastSenderType: true,
        participants: { where: { leftAt: null }, select: { id: true, participantType: true, agentId: true, vendorId: true, displayName: true, displayImage: true } },
      },
    }),
    db.conversation.count({ where }),
  ]);
  const states = await agentConversationStates(rows);
  ok(res, {
    items: rows.map((c: any) => {
      const agent = c.participants.find((p: any) => p.participantType === "AGENT");
      const vendor = c.participants.find((p: any) => p.participantType === "VENDOR");
      return {
        id: c.id,
        type: c.type,
        status: c.status,
        lastMessageAt: c.lastMessageAt,
        lastMessageText: c.lastMessageText,
        awaitingStaff: c.type === "AGENT_SUPPORT" && c.lastSenderType === "AGENT",
        agent: agent ? { id: agent.agentId, displayName: agent.displayName, displayImage: agent.displayImage } : null,
        vendor: vendor ? { id: vendor.vendorId, displayName: vendor.displayName, displayImage: vendor.displayImage } : null,
        staffMayWrite: c.type === "AGENT_SUPPORT",
        readOnlyReason: c.type === "AGENT_VENDOR" ? "READ_ONLY_MODERATION" : (states.get(c.id)?.reason ?? null),
        notice: MODERATION_NOTICE,
      };
    }),
    total,
    page: q.page,
    limit: q.limit,
  });
});

/** Staff start (or open) the support conversation with an agent. */
export const staffOpenWithAgent = handle(async (req: AuthRequest, res) => {
  const conv = await svc.openSupportConversation(id(req as Request, "id"));
  ok(res, conv, undefined, 201);
});

