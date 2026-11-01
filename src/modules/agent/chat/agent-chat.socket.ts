// src/modules/agent/chat/agent-chat.socket.ts
//
// P10 — a SECOND Socket.IO server for agents, on its own path (/agent-socket)
// with its own CORS (the agent app's origin only) and its own auth (agent
// access tokens: secret, audience, ACTIVE status, tokenVersion, session).
// The site's default Socket.IO server, its chatSocketAuth middleware and its
// CORS are untouched; site tokens are refused here and agent tokens there.
//
// Behaviour is not duplicated: the chat module's SocketEmitter fans every
// chat event out to this server too (rooms participant:AGENT:<id> and
// conversation:<id>), so agents receive exactly the newMessage /
// conversationUpdated / messageRead payloads everyone else gets.
// Every incoming event re-checks the agent (ACTIVE, tokenVersion, session,
// token expiry) and, for conversation rooms, the agent-chat policy (own
// conversation; vendor link re-read). Not started when the AGENT_CHAT_ENABLED kill switch is "0" / "false".

import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { prisma } from "../../../config/prisma.ts";
import { SocketEmitter } from "../../chat/socket/chat.handler.ts";
import { verifyAgentAccessToken } from "../services/agent-token.service.ts";
import { agentFrontendOrigin } from "../agent.config.ts";
import { agentAccess } from "./agent-chat.policy.ts";
import { agentChatEnabled } from "./agent-chat.config.ts";

export const AGENT_SOCKET_PATH = "/agent-socket";
const SWEEP_MS = 60_000;

type Ack = ((res: { ok: boolean; error?: string }) => void) | undefined;
const reply = (ack: Ack, res: { ok: boolean; error?: string }) => typeof ack === "function" && ack(res);

/** Agent principal from a handshake token, or null. Same checks as authenticateAgent. */
export async function authenticateAgentToken(token: string): Promise<{ id: string; sid: string; tv: number; expMs: number } | null> {
  let claims;
  try {
    claims = verifyAgentAccessToken(token);
  } catch {
    return null; // not configured (503 on REST) → refuse the socket
  }
  if (!claims) return null;
  const db = prisma as any;
  const [agent, session] = await Promise.all([
    db.agent.findUnique({ where: { id: claims.sub }, select: { id: true, status: true, tokenVersion: true } }),
    db.agentSession.findUnique({ where: { id: claims.sid }, select: { agentId: true, revokedAt: true, expiresAt: true } }),
  ]);
  if (!agent || agent.status !== "ACTIVE" || agent.tokenVersion !== claims.tv) return null;
  if (!session || session.agentId !== agent.id || session.revokedAt || session.expiresAt <= new Date()) return null;
  const exp = (claims as any).exp;
  return { id: agent.id, sid: claims.sid, tv: claims.tv, expMs: typeof exp === "number" ? exp * 1000 : Date.now() + 15 * 60_000 };
}

export async function agentSocketAuth(socket: Socket, next: (err?: Error) => void) {
  const raw = (socket.handshake?.auth as Record<string, unknown> | undefined)?.token;
  const token = typeof raw === "string" ? raw.replace(/^Bearer\s+/i, "").trim() : "";
  const principal = token ? await authenticateAgentToken(token).catch(() => null) : null;
  if (!principal) return next(new Error("Unauthorized"));
  socket.data.agent = principal;
  socket.data.token = token;
  next();
}

/** Re-validate on every event; end the connection when the agent or its token is no longer valid. */
export function attachAgentSocketHandlers(socket: Socket) {
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(sweep);
    socket.emit("chat:auth_expired");
    socket.disconnect(true);
  };
  const valid = async (): Promise<boolean> => {
    if (ended) return false;
    const me = socket.data.agent as { id: string; expMs: number } | undefined;
    if (!me || Date.now() >= me.expMs) return false;
    const again = await authenticateAgentToken(socket.data.token).catch(() => null);
    return !!again && again.id === me.id;
  };
  const guard = async (ack?: Ack) => {
    if (await valid()) return true;
    reply(ack, { ok: false, error: "Unauthorized" });
    end();
    return false;
  };
  const sweep = setInterval(() => void guard(), SWEEP_MS);
  sweep.unref?.();

  socket.on("chat:join", async (_payload: unknown, ack?: Ack) => {
    if (!(await guard(ack))) return;
    socket.join(`participant:AGENT:${socket.data.agent.id}`);
    reply(ack, { ok: true });
  });
  socket.on("chat:joinConversation", async (conversationId: unknown, ack?: Ack) => {
    if (!(await guard(ack))) return;
    const access = typeof conversationId === "string" ? await agentAccess(socket.data.agent.id, conversationId).catch(() => null) : null;
    if (!access) return reply(ack, { ok: false, error: "Not found" });
    socket.join(`conversation:${conversationId}`);
    reply(ack, { ok: true });
  });
  socket.on("chat:leaveConversation", (conversationId: unknown) => {
    if (typeof conversationId === "string" && conversationId) socket.leave(`conversation:${conversationId}`);
  });
  socket.on("disconnect", () => {
    ended = true;
    clearInterval(sweep);
  });
}

/** Creates the agent Socket.IO server; returns null when the kill switch is on. */
export function setupAgentChatSocket(httpServer: HttpServer): Server | null {
  if (!agentChatEnabled()) return null;
  const agentIo = new Server(httpServer, {
    path: AGENT_SOCKET_PATH,
    // The agent app only; tokens travel in the handshake, never cookies.
    cors: { origin: [agentFrontendOrigin()], credentials: false, methods: ["GET", "POST"] },
    // Don't let this server close upgrade requests meant for the default one.
    destroyUpgrade: false,
  });
  agentIo.use((socket, next) => void agentSocketAuth(socket, next));
  agentIo.on("connection", attachAgentSocketHandlers);
  // Chat events reach agent rooms too. No room → presence broadcast: never sent to agents.
  SocketEmitter.addEmitter((event, data, room) => {
    if (room) agentIo.to(room).emit(event, data);
  });
  return agentIo;
}
