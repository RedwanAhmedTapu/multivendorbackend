// tests/chat-baseline/socket-schema-media.test.ts
//
// CHARACTERIZATION (agent-chat Stage 1): today's socket wiring (auth on the
// default server, rooms, event names), schema rules that matter to chat
// (enums, identity columns, cascades) and the attachment limits.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { prisma } = await import("../../src/config/prisma.ts");
const { initChatSocket, SocketEmitter, joinConversationIfAllowed } = await import("../../src/modules/chat/socket/chat.handler.ts");
const { chatSocketAuth } = await import("../../src/modules/chat/socket/socket-auth.ts");

const restores: Array<() => void> = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
const savedEmitter = SocketEmitter._emit;
afterEach(() => {
  while (restores.length) restores.pop()!();
  SocketEmitter._emit = savedEmitter;
});

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

/** A fake socket.io server + socket that records rooms and handlers. */
function fakeIo() {
  const handlers: Record<string, (...a: any[]) => any> = {};
  const socket: any = { data: {}, rooms: new Set<string>(), on: (e: string, h: any) => (handlers[e] = h), join: (r: string) => socket.rooms.add(r), leave: (r: string) => socket.rooms.delete(r) };
  const sent: Array<{ room?: string; event: string; data: any }> = [];
  const io: any = {
    on: (_e: string, cb: any) => cb(socket),
    to: (room: string) => ({ emit: (event: string, data: any) => sent.push({ room, event, data }) }),
    emit: (event: string, data: any) => sent.push({ event, data }),
  };
  return { io, socket, handlers, sent };
}

test("socket: chat:join joins the personal room from the AUTHENTICATED user (payload ids ignored), max 200 conversations, ack {ok}", async () => {
  const { io, socket, handlers } = fakeIo();
  initChatSocket(io);
  socket.data.user = { id: "V1", role: "VENDOR", vendorId: "V1" };
  set(prisma.conversation, "findUnique", async ({ where }: any) => ({ id: where.id, type: "PRODUCT_INQUIRY" }));
  set(prisma.conversationParticipant, "findFirst", async ({ where }: any) => (where.conversationId === "C_OK" && where.vendorId === "V1" ? { id: "P" } : null));
  let ack: any;
  await handlers["chat:join"]({ participantType: "CUSTOMER", participantId: "SOMEONE_ELSE", conversations: ["C_OK", "C_NO"] }, (r: any) => (ack = r));
  assert.deepEqual(ack, { ok: true });
  assert.deepEqual([...socket.rooms].sort(), ["conversation:C_OK", "participant:VENDOR:V1"]);

  socket.data.user = null;
  await handlers["chat:join"]({}, (r: any) => (ack = r));
  assert.deepEqual(ack, { ok: false, error: "Unauthorized" });
});

test("socket: chat:joinConversation acks {ok:false, error:'Not found'} without access; leave removes the room", async () => {
  const { io, socket, handlers } = fakeIo();
  initChatSocket(io);
  socket.data.user = { id: "U1", role: "CUSTOMER" };
  set(prisma.conversation, "findUnique", async ({ where }: any) => ({ id: where.id, type: "PRODUCT_INQUIRY" }));
  set(prisma.conversationParticipant, "findFirst", async ({ where }: any) => (where.conversationId === "C_OK" && where.userId === "U1" ? { id: "P" } : null));
  let ack: any;
  await handlers["chat:joinConversation"]("C_NO", (r: any) => (ack = r));
  assert.deepEqual(ack, { ok: false, error: "Not found" });
  await handlers["chat:joinConversation"]("C_OK", (r: any) => (ack = r));
  assert.deepEqual(ack, { ok: true });
  handlers["chat:leaveConversation"]("C_OK");
  assert.equal(socket.rooms.has("conversation:C_OK"), false);
  assert.equal(await joinConversationIfAllowed(socket, 42 as any), false);
});

test("socket: SocketEmitter routes to rooms and participant rooms; no room → broadcast", () => {
  const { io, sent } = fakeIo();
  initChatSocket(io);
  SocketEmitter.toRoom("conversation:C").emit("newMessage", { a: 1 });
  SocketEmitter.toParticipant("VENDOR" as any, "V1").emit("conversationUpdated", { b: 2 });
  (SocketEmitter._emit as any)("presence:status", { c: 3 });
  assert.deepEqual(sent, [
    { room: "conversation:C", event: "newMessage", data: { a: 1 } },
    { room: "participant:VENDOR:V1", event: "conversationUpdated", data: { b: 2 } },
    { event: "presence:status", data: { c: 3 } },
  ]);
});

test("socket auth: a handshake without a token is refused with 'Unauthorized'", async () => {
  const err: any = await new Promise((resolve) => chatSocketAuth({ handshake: { auth: {} }, data: {} } as any, resolve));
  assert.equal(err?.message, "Unauthorized");
  const err2: any = await new Promise((resolve) => chatSocketAuth({ handshake: { auth: { token: "Bearer not-a-jwt" } }, data: {} } as any, resolve));
  assert.equal(err2?.message, "Unauthorized");
});

test("wiring: the default server's chat auth is io.use(chatSocketAuth); its CORS is the site origins only", () => {
  const mod = src("src/modules/chat/chat.module.ts");
  assert.match(mod, /io\.use\(chatSocketAuth\)/);
  assert.match(mod, /io\.on\("connection", chatSocketSession\)/);
  const server = src("src/server.ts");
  assert.match(server, /const io = new Server\(server, \{\s*cors: \{\s*origin: allowedOrigins,/);
  assert.match(server, /app\.use\("\/api\/chat", setupChatModule\(io\)\)/);
});

test("event names: server emits newMessage / conversationUpdated / messageRead / chat:auth_expired; listens chat:join / chat:joinConversation / chat:leaveConversation", () => {
  const all = ["services/message.service.ts", "services/read-receipt.service.ts", "socket/socket-auth.ts", "socket/chat.handler.ts", "socket/typing.handler.ts", "socket/presence.handler.ts", "socket/receipt.handler.ts"]
    .map((f) => src(`src/modules/chat/${f}`))
    .join("\n");
  for (const e of ['"newMessage"', '"conversationUpdated"', '"messageRead"', '"chat:auth_expired"', '"chat:join"', '"chat:joinConversation"', '"chat:leaveConversation"', '"message:delivered"']) assert.ok(all.includes(e), e);
});

// ── schema ────────────────────────────────────────────────────────────────

const schema = src("prisma/schema.prisma");
const block = (name: string) => {
  const m = schema.match(new RegExp(`\\n(model|enum) ${name} \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, name);
  return m![0];
};

test("schema: the existing ParticipantType and ConversationType values are unchanged and in order (P10 Stage 3 only APPENDS AGENT / AGENT_SUPPORT / AGENT_VENDOR)", () => {
  assert.deepEqual(block("ParticipantType").match(/^\s+([A-Z_]+)\s*$/gm)!.map((s) => s.trim()), ["CUSTOMER", "VENDOR", "ADMIN", "EMPLOYEE", "DELIVERY", "AGENT"]);
  assert.deepEqual(block("ConversationType").match(/^\s+([A-Z_]+)\s*$/gm)!.map((s) => s.trim()), ["PRODUCT_INQUIRY", "VENDOR_SUPPORT", "USER_SUPPORT", "DELIVERY_CHAT", "GENERAL_CHAT", "AGENT_SUPPORT", "AGENT_VENDOR"]);
});

test("schema: participant and sender identity columns cascade on delete (history goes with the identity)", () => {
  const p = block("ConversationParticipant");
  for (const rel of ["user ", "vendor ", "employee ", "deliveryPerson "]) {
    const line = p.split("\n").find((l) => l.trim().startsWith(rel))!;
    assert.match(line, /onDelete: Cascade/, rel);
  }
  assert.match(p, /@@unique\(\[conversationId, userId, vendorId, employeeId, deliveryPersonId\]\)/);
  const m = block("Message");
  for (const col of ["senderId", "senderVendorId", "senderEmployeeId", "senderDeliveryPersonId"]) {
    const line = m.split("\n").find((l) => l.includes(`fields: [${col}]`))!;
    assert.match(line, /onDelete: Cascade/, col);
  }
  const c = block("Conversation");
  for (const col of ["productId", "orderId"]) assert.match(c.split("\n").find((l) => l.includes(`fields: [${col}]`))!, /onDelete: Cascade/, col);
});

// ── attachments ───────────────────────────────────────────────────────────

test("attachments: multer 10 MB in memory; R2 images jpeg/png/webp/gif ≤ 10 MB, audio ≤ 20 MB under chat/", () => {
  const r2 = src("src/lib/r2-chat-media.ts");
  assert.match(r2, /chatFolder: "chat"/);
  assert.match(r2, /allowedImageTypes: \["image\/jpeg", "image\/png", "image\/webp", "image\/gif"\]/);
  assert.match(r2, /maxImageSize: 10 \* 1024 \* 1024/);
  assert.match(r2, /maxAudioSize: 20 \* 1024 \* 1024/);
  const multer = src("src/lib/multr-config.ts");
  assert.match(multer, /memoryStorage/);
  assert.match(multer, /10 \* 1024 \* 1024/);
});
