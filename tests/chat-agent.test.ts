// tests/chat-agent.test.ts
//
// P10 Stage 5 — agents inside the existing chat engine (AGENT_CHAT_ENABLED on).
// Real policy / service / controller / socket code; Prisma and Redis are an
// in-memory store patched onto the real client. Covers: agent↔staff,
// agent↔linked vendor only, unlinked / customer / delivery / other agent
// refused, ended link read-only, suspended agent cut off, token isolation both
// ways (REST and both socket servers), rate and size limits, no customer PII,
// unread for both sides, the agent fan-out, the read-receipt fix, auto-replies,
// and flag-off behaviour.
//   DATABASE_URL=postgresql://x@127.0.0.1:1/x DIRECT_URL=… ACCESS_TOKEN_SECRET=… npx tsx --test tests/chat-agent.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.AGENT_ACCESS_TOKEN_SECRET ??= "agent-secret-for-tests-0123456789abcdefghijklmnop";
process.env.AGENT_CHAT_ENABLED = "1";

const { prisma } = await import("../src/config/prisma.ts");
const redisClient = (await import("../src/config/redis.ts")).default as any;
const access = await import("../src/modules/chat/utils/chat-access.ts");
const { MessageService } = await import("../src/modules/chat/services/message.service.ts");
const { MessageRepository } = await import("../src/modules/chat/repositories/message.repository.ts");
const { AutoReplyService } = await import("../src/modules/chat/services/auto-reply.service.ts");
const { SocketEmitter } = await import("../src/modules/chat/socket/chat.handler.ts");
const { chatSocketAuth } = await import("../src/modules/chat/socket/socket-auth.ts");
const msgController = await import("../src/modules/chat/controllers/message.controller.ts");
const { FindOrCreateConversationSchema } = await import("../src/modules/chat/dto/find-or-create-conversation.dto.ts");
const { authenticateUser } = await import("../src/middlewares/auth.middleware.ts");
const { authenticateAgent } = await import("../src/modules/agent/middlewares/agent-auth.middleware.ts");
const { agentDb } = await import("../src/modules/agent/agent-db.ts");
const { signAgentAccessToken } = await import("../src/modules/agent/services/agent-token.service.ts");
const policy = await import("../src/modules/agent/chat/agent-chat.policy.ts");
const svc = await import("../src/modules/agent/chat/agent-chat.service.ts");
const chatC = await import("../src/modules/agent/chat/agent-chat.controller.ts");
const sock = await import("../src/modules/agent/chat/agent-chat.socket.ts");
const { piiWarning } = await import("../src/modules/agent/chat/agent-chat.config.ts");

type Row = Record<string, any>;
const restores: Array<() => void> = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};

// ── in-memory store ───────────────────────────────────────────────────────
let S: {
  conversations: Row[];
  participants: Row[];
  messages: Row[];
  receipts: Row[];
  agents: Row[];
  sessions: Row[];
  links: Row[];
  vendors: Row[];
  employees: Row[];
  vendorOrders: Row[];
  audit: Row[];
  calls: Array<{ op: string; args: any }>;
};
let seq = 0;
/** cuid-shaped ids (the chat DTOs validate .cuid()). */
const nid = (p: string) => `c${p.toLowerCase()}${String(++seq).padStart(24 - p.length, "0")}`;

function matches(row: Row, where: Row = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === "NOT") {
      if (matches(row, cond as Row)) return false;
      continue;
    }
    if (k === "OR") {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (cond === null) {
      if (row[k] != null) return false;
      continue;
    }
    if (typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !(cond.in as any[]).includes(row[k])) return false;
      if ("not" in cond && row[k] === cond.not) return false;
      if ("gte" in cond && !(row[k] >= cond.gte)) return false;
      continue;
    }
    if (row[k] !== cond) return false;
  }
  return true;
}
const pick = (row: Row | undefined, select?: Row) => {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v === true) out[k] = row[k];
  return out;
};

function install() {
  const P = prisma as any;
  set(P, "$transaction", async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(P)));
  set(P.conversation, "findUnique", async ({ where, select }: any) => pick(S.conversations.find((c) => matches(c, where)), select));
  set(P.conversation, "create", async ({ data, select }: any) => {
    if (data.dedupeKey && S.conversations.some((c) => c.dedupeKey === data.dedupeKey)) throw Object.assign(new Error("unique"), { code: "P2002" });
    const c = { id: nid("C"), status: "OPEN", agentLinkId: null, lastSenderType: null, ...data };
    delete c.participants;
    S.conversations.push(c);
    for (const p of data.participants?.create ?? []) S.participants.push({ id: nid("P"), conversationId: c.id, leftAt: null, unreadCount: 0, userId: null, vendorId: null, employeeId: null, deliveryPersonId: null, agentId: null, ...p });
    S.calls.push({ op: "conversation.create", args: data });
    return pick(c, select);
  });
  set(P.conversation, "update", async ({ where, data }: any) => Object.assign(S.conversations.find((c) => c.id === where.id)!, Object.fromEntries(Object.entries(data).filter(([k]) => k !== "messageCount"))));
  set(P.conversationParticipant, "findFirst", async ({ where, select }: any) => pick(S.participants.find((p) => matches(p, where)), select));
  set(P.conversationParticipant, "findMany", async ({ where, select }: any) => S.participants.filter((p) => matches(p, where)).map((p) => pick(p, select)));
  set(P.conversationParticipant, "updateMany", async ({ where, data }: any) => {
    const rows = S.participants.filter((p) => matches(p, where));
    for (const r of rows) if (data.unreadCount?.increment) r.unreadCount += data.unreadCount.increment;
    S.calls.push({ op: "participant.updateMany", args: where });
    return { count: rows.length };
  });
  set(P.conversationParticipant, "update", async ({ where, data }: any) => Object.assign(S.participants.find((p) => p.id === where.id)!, data));
  set(P.conversationParticipant, "aggregate", async ({ where }: any) => ({ _sum: { unreadCount: S.participants.filter((p) => matches(p, where)).reduce((s, p) => s + p.unreadCount, 0) } }));
  set(P.message, "create", async ({ data }: any) => {
    const m = { id: nid("M"), createdAt: new Date(), media: null, ...data };
    S.messages.push(m);
    return m;
  });
  set(P.message, "findUnique", async ({ where, select }: any) => pick(S.messages.find((m) => m.id === where.id), select));
  set(P.message, "findMany", async ({ where }: any) => S.messages.filter((m) => m.conversationId === where.conversationId).map((m) => ({ ...m, reactions: [] })));
  set(P.messageReceipt, "upsert", async (args: any) => (S.receipts.push(args.create), args.create));
  set(P.agent, "findUnique", async ({ where, select }: any) => pick(S.agents.find((a) => a.id === where.id), select));
  set(P.agentSession, "findUnique", async ({ where, select }: any) => pick(S.sessions.find((s) => s.id === where.id), select));
  set(P.agentVendorLink, "findFirst", async ({ where, select }: any) => pick(S.links.find((l) => matches(l, where)), select));
  set(P.agentVendorLink, "findUnique", async ({ where, select }: any) => pick(S.links.find((l) => l.id === where.id), select));
  set(P.agentVendorLink, "findMany", async ({ where }: any) => S.links.filter((l) => matches(l, where)).map((l) => ({ ...l, agent: { status: S.agents.find((a) => a.id === l.agentId)?.status } })));
  set(P.vendor, "findUnique", async ({ where, select }: any) => pick(S.vendors.find((v) => v.id === where.id), select));
  set(P.employee, "findUnique", async ({ where, select }: any) => pick(S.employees.find((e) => e.id === where.id), select));
  set(P.vendorOrder, "findMany", async (args: any) => (S.calls.push({ op: "vendorOrder.findMany", args }), S.vendorOrders.filter((o) => o.vendorId === args.where.vendorId).map((o) => ({ id: o.id, status: o.status, createdAt: o.createdAt, order: { orderNumber: o.orderNumber } }))));
  set(P.auditLog, "create", async ({ data }: any) => (S.audit.push(data), data));
  // agent auth middleware reads through agentDb
  set(agentDb, "prisma", P);
  const kv = new Map<string, number>();
  set(redisClient, "set", async (k: string, _v: string, o?: Row) => (o?.NX && kv.has(k) ? null : (kv.set(k, 1), "OK")));
  set(redisClient, "incr", async (k: string) => (kv.set(k, (kv.get(k) ?? 0) + 1), kv.get(k)!));
  set(redisClient, "expire", async () => 1);
  set(redisClient, "del", async () => 1);
  set(redisClient, "eval", async () => 0);
}

let emitted: Array<{ event: string; room?: string; data: any }>;
let autoReplies: number;
const savedEmit = SocketEmitter._emit;
const savedExtra = [...SocketEmitter._extra];

beforeEach(() => {
  process.env.AGENT_CHAT_ENABLED = "1";
  S = { conversations: [], participants: [], messages: [], receipts: [], agents: [], sessions: [], links: [], vendors: [], employees: [], vendorOrders: [], audit: [], calls: [] };
  install();
  emitted = [];
  autoReplies = 0;
  SocketEmitter.setEmitter((event, data, room) => emitted.push({ event, data, room }));
  SocketEmitter._extra.length = 0;
  set(AutoReplyService.prototype, "processTrigger", async () => void autoReplies++);
  S.agents.push({ id: "A1", name: "Rahim", avatar: null, status: "ACTIVE", tokenVersion: 0 }, { id: "A2", name: "Karim", avatar: null, status: "ACTIVE", tokenVersion: 0 });
  S.sessions.push({ id: "S1", agentId: "A1", revokedAt: null, expiresAt: new Date(Date.now() + 3600_000) });
  S.vendors.push({ id: "V1", storeName: "Dhaka Fashion", avatar: null, status: "ACTIVE" }, { id: "V2", storeName: "Other Shop", avatar: null, status: "ACTIVE" });
  S.links.push({ id: "L1", agentId: "A1", vendorId: "V1", startedAt: new Date("2026-10-01"), endedAt: null });
  S.employees.push(
    { id: "E_AM", isActive: true, vendorId: null, permissions: { agentManagement: true } },
    { id: "E_CS", isActive: true, vendorId: null, permissions: { customerSupport: true } },
    { id: "E_VS", isActive: true, vendorId: "V1", permissions: { agentManagement: true } },
  );
});
afterEach(() => {
  while (restores.length) restores.pop()!();
  SocketEmitter._emit = savedEmit;
  SocketEmitter._extra.length = 0;
  SocketEmitter._extra.push(...savedExtra);
});

const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));
const actor = (role: string, id: string, extra: Row = {}) => access.actorFrom({ id, role, ...extra })!;
const parts = (conversationId: string) => S.participants.filter((p) => p.conversationId === conversationId);
async function vendorConversation() {
  const c = await svc.openVendorConversation("A1", "V1");
  return S.conversations.find((x) => x.id === c.id)!;
}
const http = () => {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; }, setHeader() {} };
  return res;
};

// ── conversations and access ──────────────────────────────────────────────

test("agent ↔ staff: one AGENT_SUPPORT conversation per agent with an AGENT participant row; staff = ADMIN or agentManagement only", async () => {
  const a = await svc.openSupportConversation("A1");
  const b = await svc.openSupportConversation("A1");
  assert.equal(a.id, b.id, "idempotent");
  const conv = S.conversations.find((c) => c.id === a.id)!;
  assert.equal(conv.type, "AGENT_SUPPORT");
  assert.deepEqual(parts(a.id).map((p) => [p.participantType, p.agentId, p.userId, p.vendorId, p.employeeId]), [["AGENT", "A1", null, null, null]]);
  assert.equal((await access.getConversationAccess(a.id, actor("ADMIN", "E_ADMIN")))?.viaSupport, true);
  assert.equal((await access.getConversationAccess(a.id, actor("EMPLOYEE", "E_AM", { employeeId: "E_AM" })))?.viaSupport, true);
  assert.equal(await access.getConversationAccess(a.id, actor("EMPLOYEE", "E_CS", { employeeId: "E_CS" })), null, "customerSupport alone isn't agent staff");
  assert.equal(await access.getConversationAccess(a.id, actor("EMPLOYEE", "E_VS", { employeeId: "E_VS", vendorId: "V1" })), null, "vendor staff never");
  assert.equal(await access.getConversationAccess(a.id, actor("VENDOR", "V1")), null);
  assert.equal(await access.getConversationAccess(a.id, actor("CUSTOMER", "U1")), null);
  assert.equal(await access.getConversationAccess(a.id, actor("DELIVERY", "D1")), null);
  assert.equal((await policy.agentAccess("A1", a.id))?.mode, "write");
  assert.equal(await policy.agentAccess("A2", a.id), null, "another agent's conversation looks missing");
});

test("agent ↔ vendor: only a currently linked vendor; one conversation per link; owner (not vendor staff) has access", async () => {
  await assert.rejects(svc.openVendorConversation("A1", "V2"), (e: any) => e.statusCode === 404, "unlinked vendor");
  await assert.rejects(svc.openVendorConversation("A2", "V1"), (e: any) => e.statusCode === 404, "someone else's vendor");
  const conv = await vendorConversation();
  assert.equal(conv.type, "AGENT_VENDOR");
  assert.equal(conv.agentLinkId, "L1");
  assert.equal((await svc.openVendorConversation("A1", "V1")).id, conv.id, "idempotent per link");
  assert.deepEqual(parts(conv.id).map((p) => [p.participantType, p.agentId ?? p.vendorId]), [["AGENT", "A1"], ["VENDOR", "V1"]]);
  assert.ok((await access.getConversationAccess(conv.id, actor("VENDOR", "V1")))?.participant, "vendor owner via its participant row");
  assert.equal(await access.getConversationAccess(conv.id, actor("VENDOR", "V2")), null);
  assert.equal(await access.getConversationAccess(conv.id, actor("EMPLOYEE", "E_VS", { employeeId: "E_VS", vendorId: "V1" })), null, "vendor staff never");
  const staff = await access.getConversationAccess(conv.id, actor("ADMIN", "E_ADMIN"));
  assert.equal(staff?.viaModeration, true);
  assert.equal(staff?.viaSupport, false);
});

test("ended link: the agent keeps read-only history, can't send; the vendor can't send; a new agent gets a fresh conversation", async () => {
  const conv = await vendorConversation();
  S.links[0].endedAt = new Date();
  const a = await policy.agentAccess("A1", conv.id);
  assert.deepEqual([a?.mode, a?.reason], ["read", "LINK_ENDED"]);
  await assert.rejects(svc.agentSend("A1", { conversationId: conv.id, content: "hi", clientId: "c1" }), (e: any) => e.statusCode === 403);
  assert.deepEqual(await policy.counterpartMayWrite(conv, { viaModeration: false }), { ok: false, reason: "LINK_ENDED" });
  assert.equal((await svc.agentMessages("A1", conv.id, {})).readOnly, true);
  S.links.push({ id: "L2", agentId: "A2", vendorId: "V1", startedAt: new Date(), endedAt: null });
  const fresh = await svc.openVendorConversation("A2", "V1");
  assert.notEqual(fresh.id, conv.id);
  assert.equal(await policy.agentAccess("A2", conv.id), null, "the new agent never sees the old history");
});

test("suspended agent: cut off at once (no access, socket token refused); the vendor sees the conversation read-only", async () => {
  const conv = await vendorConversation();
  S.agents[0].status = "SUSPENDED";
  assert.equal(await policy.agentAccess("A1", conv.id), null);
  assert.deepEqual(await policy.counterpartMayWrite(conv, { viaModeration: false }), { ok: false, reason: "AGENT_UNAVAILABLE" });
  const token = signAgentAccessToken({ agentId: "A1", sessionId: "S1", tokenVersion: 0 });
  assert.equal(await sock.authenticateAgentToken(token), null);
});

test("customers and delivery users can't open agent conversations (DTO enums unchanged)", () => {
  for (const type of ["AGENT_SUPPORT", "AGENT_VENDOR"]) assert.equal(FindOrCreateConversationSchema.safeParse({ type, otherParticipant: { id: "cvendor100000000000000001", type: "VENDOR", displayName: "x" } }).success, false, type);
  assert.equal(FindOrCreateConversationSchema.safeParse({ type: "USER_SUPPORT", otherParticipant: { id: "cvendor100000000000000001", type: "AGENT", displayName: "x" } }).success, false, "AGENT as counterpart");
});

// ── token isolation ───────────────────────────────────────────────────────

test("token isolation: agent token refused by /api/chat auth and the default socket; site token refused by agent auth and /agent-socket", async () => {
  const agentToken = signAgentAccessToken({ agentId: "A1", sessionId: "S1", tokenVersion: 0 });
  const siteToken = jwt.sign({ id: "U1", role: "CUSTOMER" }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: 600 });

  const r1 = http();
  await authenticateUser({ headers: { authorization: `Bearer ${agentToken}` } } as any, r1, () => assert.fail("agent token passed authenticateUser"));
  assert.equal(r1.statusCode, 401);

  const r2 = http();
  await authenticateAgent({ headers: { authorization: `Bearer ${siteToken}` } } as any, r2, () => assert.fail("site token passed authenticateAgent"));
  assert.equal(r2.statusCode, 401);

  const e1: any = await new Promise((resolve) => chatSocketAuth({ handshake: { auth: { token: agentToken } }, data: {} } as any, resolve));
  assert.equal(e1?.message, "Unauthorized", "default socket refuses agent tokens");
  const e2: any = await new Promise((resolve) => sock.agentSocketAuth({ handshake: { auth: { token: siteToken } }, data: {} } as any, resolve));
  assert.equal(e2?.message, "Unauthorized", "/agent-socket refuses site tokens");
  const ok: any = await new Promise((resolve) => sock.agentSocketAuth({ handshake: { auth: { token: agentToken } }, data: {} } as any, resolve));
  assert.equal(ok, undefined, "agent token accepted on /agent-socket");
});

test("/agent-socket: personal room from the token, conversation rooms per policy; events re-check the agent; flag off → no server", async () => {
  const conv = await vendorConversation();
  const handlers: Row = {};
  const socket: any = { data: { agent: { id: "A1", expMs: Date.now() + 600_000 }, token: signAgentAccessToken({ agentId: "A1", sessionId: "S1", tokenVersion: 0 }) }, rooms: new Set(), on: (e: string, h: any) => (handlers[e] = h), join: (r: string) => socket.rooms.add(r), leave: (r: string) => socket.rooms.delete(r), emit: () => {}, disconnect: () => (socket.disconnected = true) };
  sock.attachAgentSocketHandlers(socket);
  let ack: any;
  await handlers["chat:join"]({ participantId: "SOMEONE" }, (r: any) => (ack = r));
  assert.deepEqual(ack, { ok: true });
  await handlers["chat:joinConversation"](conv.id, (r: any) => (ack = r));
  assert.deepEqual(ack, { ok: true });
  assert.deepEqual([...socket.rooms].sort(), [`conversation:${conv.id}`, "participant:AGENT:A1"]);
  const other = await svc.openSupportConversation("A2");
  await handlers["chat:joinConversation"](other.id, (r: any) => (ack = r));
  assert.deepEqual(ack, { ok: false, error: "Not found" });
  S.agents[0].tokenVersion = 1; // "log out everywhere" / suspension bumps it
  await handlers["chat:join"]({}, (r: any) => (ack = r));
  assert.deepEqual(ack, { ok: false, error: "Unauthorized" });
  assert.equal(socket.disconnected, true);
  socket.on("disconnect", () => {});
  handlers.disconnect?.();

  process.env.AGENT_CHAT_ENABLED = "";
  assert.equal(sock.setupAgentChatSocket({} as any), null);
});

// ── messages, unread, fan-out ─────────────────────────────────────────────

test("agent sends through the chat MessageService: AGENT sender column, vendor unread +1, fan-out to the vendor; vendor reply reaches participant:AGENT", async () => {
  const conv = await vendorConversation();
  const out = await svc.agentSend("A1", { conversationId: conv.id, content: "Hello Dhaka Fashion", clientId: "c1" });
  const m = S.messages[0];
  assert.deepEqual([m.senderType, m.senderAgentId, m.senderId, m.senderVendorId, m.senderEmployeeId, m.senderDeliveryPersonId], ["AGENT", "A1", null, null, null, null]);
  assert.equal(out.warning, null);
  const vendorRow = parts(conv.id).find((p) => p.vendorId === "V1")!;
  const agentRow = parts(conv.id).find((p) => p.agentId === "A1")!;
  assert.deepEqual([vendorRow.unreadCount, agentRow.unreadCount], [1, 0]);
  await flush();
  assert.ok(emitted.some((e) => e.event === "newMessage" && e.room === "participant:VENDOR:V1"));
  assert.ok(!emitted.some((e) => e.room === "participant:AGENT:A1"), "never the sender's own room");
  assert.equal(autoReplies, 0, "no auto-replies in agent conversations");

  emitted = [];
  await new MessageService().send({ conversationId: conv.id, messageType: "TEXT", content: "Thanks", clientId: "v1" } as any, "VENDOR" as any, "V1");
  assert.deepEqual([vendorRow.unreadCount, agentRow.unreadCount], [1, 1]);
  await flush();
  assert.ok(emitted.some((e) => e.event === "newMessage" && e.room === "participant:AGENT:A1"), "agent fan-out");
  assert.ok(emitted.some((e) => e.event === "conversationUpdated" && e.room === "participant:AGENT:A1"));
  assert.deepEqual(await svc.agentUnreadTotal("A1"), { unread: 1 });
  await svc.agentMarkRead("A1", conv.id, S.messages[1].id);
  assert.equal(agentRow.unreadCount, 0);
  assert.equal(S.receipts.at(-1).participantId, agentRow.id, "the agent's own row");
});

test("auto-replies still fire for ordinary (non-agent) conversations", async () => {
  S.conversations.push({ id: "CP", type: "PRODUCT_INQUIRY" });
  S.participants.push({ id: "PC", conversationId: "CP", participantType: "CUSTOMER", userId: "U1", vendorId: null, employeeId: null, deliveryPersonId: null, agentId: null, leftAt: null, unreadCount: 0 });
  await new MessageService().send({ conversationId: "CP", messageType: "TEXT", content: "price?", clientId: "u1" } as any, "CUSTOMER" as any, "U1");
  await flush();
  assert.equal(autoReplies, 1);
});

test("limits: 2,000 characters, 20 messages a minute per agent, images ≤ 5 MB jpeg/png/webp", async () => {
  const conv = await vendorConversation();
  await assert.rejects(svc.agentSend("A1", { conversationId: conv.id, content: "x".repeat(2001), clientId: "long" }), (e: any) => e.name === "ZodError");
  for (let i = 0; i < 20; i++) await svc.agentSend("A1", { conversationId: conv.id, content: `m${i}`, clientId: `r${i}` });
  await assert.rejects(svc.agentSend("A1", { conversationId: conv.id, content: "21st", clientId: "r21" }), (e: any) => e.statusCode === 429);
  const mine = S.messages[0].id;
  await assert.rejects(svc.agentUploadImage("A1", mine, { buffer: Buffer.alloc(1), mimetype: "image/png", originalname: "a.png", size: 5 * 1024 * 1024 + 1 }), (e: any) => e.statusCode === 413);
  await assert.rejects(svc.agentUploadImage("A1", mine, { buffer: Buffer.alloc(1), mimetype: "application/pdf", originalname: "a.pdf", size: 10 }), (e: any) => e.statusCode === 415);
  await assert.rejects(svc.agentUploadImage("A2", mine, { buffer: Buffer.alloc(1), mimetype: "image/png", originalname: "a.png", size: 10 }), (e: any) => e.statusCode === 404, "not the sender");
});

test("site users in agent conversations (existing /api/chat send): read-only rules, 2,000 chars, PII warning, staff moderation can't write", async () => {
  const conv = await vendorConversation();
  const send = async (user: Row, content: string) => {
    const res = http();
    await msgController.send({ body: { conversationId: conv.id, messageType: "TEXT", content, clientId: `c${++seq}` }, user } as any, res);
    return res;
  };
  const vendorUser = { id: "V1", rawId: "U_V1", role: "VENDOR", vendorId: "V1" };
  const r1 = await send(vendorUser, "Call the buyer on 01711-000-000");
  assert.equal(r1.statusCode, 201);
  assert.match(r1.body.warning, /phone numbers or e-mail/);
  assert.equal((await send(vendorUser, "y".repeat(2001))).statusCode, 400);
  assert.equal((await send({ id: "E_ADMIN", rawId: "U_ADMIN", role: "ADMIN" }, "hello")).statusCode, 403, "moderation is read-only");
  S.links[0].endedAt = new Date();
  assert.equal((await send(vendorUser, "still there?")).statusCode, 403);
  assert.equal(piiWarning("write to me at buyer@example.com"), "Please don't share customers' phone numbers or e-mail addresses in agent chats.");
  assert.equal(piiWarning("order FM-1001 is late"), null);
});

test("moderation reads are audited before the history is returned; moderation can't join the live room", async () => {
  const conv = await vendorConversation();
  const res = http();
  await msgController.getList({ params: { conversationId: conv.id }, query: {}, user: { id: "E_ADMIN", rawId: "U_ADMIN", role: "ADMIN" } } as any, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(S.audit.map((a) => [a.action, a.userId, a.entityId]), [["AGENT_CHAT_MODERATION_READ", "U_ADMIN", conv.id]]);
  const { joinConversationIfAllowed } = await import("../src/modules/chat/socket/chat.handler.ts");
  const socket: any = { data: { user: { id: "E_ADMIN", role: "ADMIN" } }, join: () => assert.fail("joined") };
  assert.equal(await joinConversationIfAllowed(socket, conv.id), false);
});

test("no customer PII: the context panel selects order number / status only; message reads carry no user fields", async () => {
  const conv = await vendorConversation();
  S.vendorOrders.push({ id: "VO1", vendorId: "V1", status: "DELIVERED", createdAt: new Date("2026-10-05"), orderNumber: "FM-1001", customerName: "SECRET", phone: "01711000000" });
  const ctx = await svc.agentConversationContext("A1", conv.id);
  assert.deepEqual(ctx.orders, [{ vendorOrderId: "VO1", orderNumber: "FM-1001", status: "DELIVERED", createdAt: new Date("2026-10-05") }]);
  const select = S.calls.find((c) => c.op === "vendorOrder.findMany")!.args.select;
  assert.deepEqual(Object.keys(select).sort(), ["createdAt", "id", "order", "status"]);
  assert.deepEqual(select.order, { select: { orderNumber: true } });
  assert.ok(!JSON.stringify(ctx).includes("SECRET") && !JSON.stringify(ctx).includes("01711"));
  const repoSrc = (await import("node:fs")).readFileSync(new URL("../src/modules/chat/repositories/message.repository.ts", import.meta.url), "utf8");
  assert.ok(!/user:\s*\{|customer|phone|email|address/i.test(repoSrc.slice(repoSrc.indexOf("select:"), repoSrc.indexOf("getParticipantId"))), "message select has no user relation");
});

// ── read receipts ─────────────────────────────────────────────────────────

test("read-receipt fix: an unknown type matches nobody; existing types still resolve their own row only", async () => {
  S.participants.push(
    { id: "PX", conversationId: "CX", userId: "U1", vendorId: null, employeeId: null, deliveryPersonId: null, agentId: null, leftAt: null },
    { id: "PY", conversationId: "CX", userId: null, vendorId: "V1", employeeId: null, deliveryPersonId: null, agentId: null, leftAt: null },
  );
  const repo = new MessageRepository();
  assert.equal(await repo.getParticipantId("CX", "V1", "WHATEVER"), undefined);
  assert.equal(await repo.getParticipantId("CX", "U1", "CUSTOMER"), "PX");
  assert.equal(await repo.getParticipantId("CX", "V1", "VENDOR"), "PY");
  assert.equal(await repo.getParticipantId("CX", "U1", "VENDOR"), undefined);
});

// ── flag off ──────────────────────────────────────────────────────────────

test("flag off: agent routes 404, agent conversations invisible even to their participants", async () => {
  const conv = await vendorConversation();
  process.env.AGENT_CHAT_ENABLED = "0";
  const res = http();
  let nexted = false;
  chatC.requireAgentChat({} as any, res, () => (nexted = true));
  assert.equal(res.statusCode, 404);
  assert.equal(nexted, false);
  assert.equal(await access.getConversationAccess(conv.id, actor("VENDOR", "V1")), null);
  assert.equal(await access.getConversationAccess(conv.id, actor("ADMIN", "E_ADMIN")), null);
});
