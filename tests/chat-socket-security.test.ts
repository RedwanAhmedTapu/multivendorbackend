// tests/chat-socket-security.test.ts
//
// Phase 0 chat hardening — Socket.IO, through a REAL in-process Socket.IO
// server (setupChatModule on 127.0.0.1, ephemeral port) and a real
// socket.io-client (resolved from multivendorsite; the test skips if absent).
// Prisma and Redis are replaced in memory — no database, no Redis, no network
// beyond the loopback socket. Tokens are signed with the throwaway test secret.
//   - no / invalid / expired / inactive / role-mismatched token → refused;
//   - chat:join joins only the authenticated actor's own personal room, even
//     when the client names someone else;
//   - chat:joinConversation: non-participants refused, participants allowed;
//     admin-side support staff (ADMIN, or EMPLOYEE with customerSupport and no
//     vendorId) may open SUPPORT conversations, vendor employees may not;
//   - presence / typing / delivered receipts use the authenticated identity,
//     never the ids the client sends.
// Run with ACCESS_TOKEN_SECRET set (scratchpad run.sh "yes"):
//   npx tsx --test tests/chat-socket-security.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";

const { prisma } = await import("../src/config/prisma.ts");
const redisClient = (await import("../src/config/redis.ts")).default as any;
const { setupChatModule } = await import("../src/modules/chat/chat.module.ts");
const { SocketEmitter } = await import("../src/modules/chat/socket/chat.handler.ts");
const { ReadReceiptService } = await import("../src/modules/chat/services/read-receipt.service.ts");

let ioc: any = null;
try {
  ioc = createRequire(new URL("../../multivendorsite/package.json", import.meta.url))("socket.io-client");
} catch {
  ioc = null;
}
const skip = ioc ? false : "socket.io-client not found (it lives in multivendorsite/node_modules)";

type Row = Record<string, any>;
const SECRET = process.env.ACCESS_TOKEN_SECRET ?? "";
const USERS: Record<string, Row> = {
  U_CUST: { id: "U_CUST", role: "CUSTOMER", isActive: true, vendorId: null, name: "C", email: null },
  U_CUST2: { id: "U_CUST2", role: "CUSTOMER", isActive: true, vendorId: null, name: "C2", email: null },
  U_VEND: { id: "U_VEND", role: "VENDOR", isActive: true, vendorId: "V1", name: "V", email: null },
  U_ADMIN: { id: "U_ADMIN", role: "ADMIN", isActive: true, vendorId: null, name: "A", email: null },
  U_AGENT: { id: "U_AGENT", role: "EMPLOYEE", isActive: true, vendorId: null, name: "Agent", email: null },
  U_NOPERM: { id: "U_NOPERM", role: "EMPLOYEE", isActive: true, vendorId: null, name: "NoPerm", email: null },
  U_VSTAFF: { id: "U_VSTAFF", role: "EMPLOYEE", isActive: true, vendorId: null, name: "VendorStaff", email: null },
  U_GONE: { id: "U_GONE", role: "CUSTOMER", isActive: false, vendorId: null, name: "Gone", email: null },
};
const EMPLOYEES: Record<string, Row> = {
  E_ADMIN: { id: "E_ADMIN", userId: "U_ADMIN", vendorId: null, isActive: true, permissions: {} },
  E_AGENT: { id: "E_AGENT", userId: "U_AGENT", vendorId: null, isActive: true, permissions: { customerSupport: true } },
  E_NOPERM: { id: "E_NOPERM", userId: "U_NOPERM", vendorId: null, isActive: true, permissions: {} },
  E_VSTAFF: { id: "E_VSTAFF", userId: "U_VSTAFF", vendorId: "V1", isActive: true, permissions: { customerSupport: true } },
};
const CONVERSATIONS: Record<string, Row> = { C_MINE: { id: "C_MINE", type: "PRODUCT_INQUIRY" }, C_OTHER: { id: "C_OTHER", type: "PRODUCT_INQUIRY" }, C_SUPPORT: { id: "C_SUPPORT", type: "USER_SUPPORT" } };
const PARTICIPANTS: Row[] = [
  { id: "P_CUST_MINE", conversationId: "C_MINE", userId: "U_CUST", leftAt: null },
  { id: "P_VEND_MINE", conversationId: "C_MINE", vendorId: "V1", leftAt: null },
  { id: "P_CUST2_OTHER", conversationId: "C_OTHER", userId: "U_CUST2", leftAt: null },
  { id: "P_CUST2_SUP", conversationId: "C_SUPPORT", userId: "U_CUST2", leftAt: null },
];
const MESSAGES: Record<string, Row> = { M_MINE: { id: "M_MINE", conversationId: "C_MINE" }, M_OTHER: { id: "M_OTHER", conversationId: "C_OTHER" } };
const tok = (id: string, role: string, opts: jwt.SignOptions = { expiresIn: "5m" }) => jwt.sign({ id, role }, SECRET, { algorithm: "HS256", ...opts });

const restores: (() => void)[] = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
const redisCalls: string[] = [];
const receipts: Row[] = [];
let httpServer: http.Server;
let io: Server;
let url = "";

before(async () => {
  if (skip) return;
  // EMPLOYEE U_VSTAFF is a vendor's staff member: its Employee row carries vendorId V1.
  USERS.U_VSTAFF.vendorId = null;
  set(prisma.user, "findUnique", async ({ where }: Row) => (USERS[where.id] ? { ...USERS[where.id] } : null));
  set(prisma.vendor, "findUnique", async ({ where }: Row) => (where.id === "V1" ? { id: "V1", storeName: "Store", email: null } : null));
  set(prisma.employee, "findFirst", async ({ where }: Row) => Object.values(EMPLOYEES).find((e) => e.userId === where.userId && e.isActive) ?? null);
  set(prisma.employee, "findUnique", async ({ where }: Row) => EMPLOYEES[where.id] ?? null);
  set(prisma.employee, "create", async () => assert.fail("no employee provisioning in this test"));
  set(prisma.conversation, "findUnique", async ({ where }: Row) => CONVERSATIONS[where.id] ?? null);
  set(prisma.conversationParticipant, "findFirst", async ({ where }: Row) => {
    const keys = Object.keys(where).filter((k) => !["conversationId", "leftAt"].includes(k));
    return PARTICIPANTS.find((p) => p.conversationId === where.conversationId && keys.every((k) => p[k] === where[k])) ?? null;
  });
  set(prisma.message, "findUnique", async ({ where }: Row) => MESSAGES[where.id] ?? null);
  for (const m of ["set", "sAdd", "expire", "del", "sRem"]) set(redisClient, m, async (key: string) => (redisCalls.push(`${m}:${key}`), "OK"));
  set(ReadReceiptService.prototype, "markAsRead", async (conversationId: string, participantId: string, messageId: string) => (receipts.push({ conversationId, participantId, messageId }), undefined));
  httpServer = http.createServer();
  io = new Server(httpServer);
  setupChatModule(io);
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(httpServer.address() as any).port}`;
});

after(async () => {
  if (skip) return;
  io.close();
  await new Promise((r) => httpServer.close(() => r(undefined)));
  restores.reverse().forEach((r) => r());
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function connect(token?: string): Promise<{ socket: any; error: string | null }> {
  const socket = ioc.io(url, { transports: ["websocket"], reconnection: false, forceNew: true, ...(token === undefined ? {} : { auth: { token } }) });
  const error = await new Promise<string | null>((resolve) => {
    socket.once("connect", () => resolve(null));
    socket.once("connect_error", (e: Error) => resolve(e.message));
  });
  return { socket, error };
}
const ack = (socket: any, event: string, payload: unknown) => new Promise<any>((r) => socket.emit(event, payload, r));
function collect(socket: any, event: string) {
  const got: any[] = [];
  socket.on(event, (d: any) => got.push(d));
  return got;
}

test("connections need a valid token: missing, garbage, wrong secret, expired, inactive and role-mismatch are refused", { skip }, async () => {
  const cases: [string | undefined, string][] = [
    [undefined, "Unauthorized"],
    ["", "Unauthorized"],
    ["not-a-jwt", "Unauthorized"],
    [jwt.sign({ id: "U_CUST", role: "CUSTOMER" }, "some-other-secret"), "Unauthorized"],
    [tok("U_CUST", "CUSTOMER", { expiresIn: -10 }), "Unauthorized"],
    [tok("U_GONE", "CUSTOMER"), "Unauthorized"],
    [tok("U_CUST", "ADMIN"), "Forbidden"], // token role ≠ database role
  ];
  for (const [token, want] of cases) {
    const { socket, error } = await connect(token);
    assert.equal(error, want, String(token).slice(0, 20));
    socket.close();
  }
  const ok = await connect(`Bearer ${tok("U_CUST", "CUSTOMER")}`);
  assert.equal(ok.error, null, "a valid token (with or without the Bearer prefix) connects");
  ok.socket.close();
});

test("chat:join joins only the actor's OWN personal room — naming another participant doesn't work", { skip }, async () => {
  const { socket } = await connect(tok("U_CUST", "CUSTOMER"));
  try {
    const got = collect(socket, "newMessage");
    assert.deepEqual(await ack(socket, "chat:join", { participantType: "VENDOR", participantId: "V1", conversations: ["C_OTHER", "C_MINE"] }), { ok: true });
    SocketEmitter.toParticipant("VENDOR", "V1").emit("newMessage", { to: "vendor" });
    SocketEmitter.toParticipant("CUSTOMER", "U_CUST2").emit("newMessage", { to: "cust2" });
    SocketEmitter.toRoom("conversation:C_OTHER").emit("newMessage", { to: "other-conv" });
    SocketEmitter.toParticipant("CUSTOMER", "U_CUST").emit("newMessage", { to: "me" });
    SocketEmitter.toRoom("conversation:C_MINE").emit("newMessage", { to: "my-conv" });
    await sleep(80);
    assert.deepEqual(got.map((g) => g.to).sort(), ["me", "my-conv"]);
  } finally {
    socket.close();
  }
});

test("chat:joinConversation: a non-participant is refused (and gets nothing); the participant is allowed", { skip }, async () => {
  const stranger = await connect(tok("U_CUST", "CUSTOMER"));
  const owner = await connect(tok("U_CUST2", "CUSTOMER"));
  try {
    const leaked = collect(stranger.socket, "newMessage");
    const delivered = collect(owner.socket, "newMessage");
    assert.deepEqual(await ack(stranger.socket, "chat:joinConversation", "C_OTHER"), { ok: false, error: "Not found" });
    assert.deepEqual(await ack(stranger.socket, "chat:joinConversation", "C_DOES_NOT_EXIST"), { ok: false, error: "Not found" }, "same answer — existence isn't revealed");
    assert.deepEqual(await ack(owner.socket, "chat:joinConversation", "C_OTHER"), { ok: true });
    SocketEmitter.toRoom("conversation:C_OTHER").emit("newMessage", { id: "x" });
    await sleep(80);
    assert.equal(leaked.length, 0);
    assert.equal(delivered.length, 1);
  } finally {
    stranger.socket.close();
    owner.socket.close();
  }
});

test("support conversations: ADMIN and customerSupport staff may open them; vendor staff, staff without the permission and vendors may not", { skip }, async () => {
  const want: [string, string, boolean][] = [
    ["U_ADMIN", "ADMIN", true],
    ["U_AGENT", "EMPLOYEE", true],
    ["U_NOPERM", "EMPLOYEE", false],
    ["U_VSTAFF", "EMPLOYEE", false],
    ["U_VEND", "VENDOR", false],
    ["U_CUST", "CUSTOMER", false],
  ];
  for (const [id, role, allowed] of want) {
    const { socket, error } = await connect(tok(id, role));
    assert.equal(error, null, id);
    try {
      assert.equal((await ack(socket, "chat:joinConversation", "C_SUPPORT")).ok, allowed, id);
      if (role === "ADMIN") assert.equal((await ack(socket, "chat:joinConversation", "C_OTHER")).ok, false, "support access doesn't extend to product chats");
    } finally {
      socket.close();
    }
  }
});

test("presence uses the authenticated identity — a client can't mark someone else online or offline", { skip }, async () => {
  const { socket } = await connect(tok("U_CUST", "CUSTOMER"));
  try {
    redisCalls.length = 0;
    socket.emit("presence:online", "V1");
    socket.emit("presence:heartbeat", "V1");
    socket.emit("presence:offline", "V1");
    await sleep(100);
    assert.ok(redisCalls.length > 0);
    assert.ok(redisCalls.every((c) => !c.includes("V1")), redisCalls.join(" | "));
    assert.ok(redisCalls.some((c) => c === "set:chat:online:U_CUST"));
  } finally {
    socket.close();
  }
});

test("delivered receipts: only the actor's own participant row, only for a message of that conversation", { skip }, async () => {
  const { socket } = await connect(tok("U_CUST", "CUSTOMER"));
  try {
    receipts.length = 0;
    socket.emit("message:delivered", { conversationId: "C_OTHER", messageId: "M_OTHER", participantId: "P_CUST2_OTHER", userId: "U_CUST2", participantType: "CUSTOMER" });
    socket.emit("message:delivered", { conversationId: "C_MINE", messageId: "M_OTHER" }); // message from another conversation
    socket.emit("message:delivered", { conversationId: "C_MINE", messageId: "M_MINE", participantId: "P_VEND_MINE" });
    await sleep(120);
    assert.deepEqual(receipts, [{ conversationId: "C_MINE", participantId: "P_CUST_MINE", messageId: "M_MINE" }]);
  } finally {
    socket.close();
  }
});

test("typing: relayed only inside a joined conversation, with the authenticated id", { skip }, async () => {
  const a = await connect(tok("U_CUST", "CUSTOMER"));
  const b = await connect(tok("U_VEND", "VENDOR"));
  const spy = await connect(tok("U_CUST2", "CUSTOMER"));
  try {
    const seenByVendor = collect(b.socket, "typing:start");
    await ack(b.socket, "chat:joinConversation", "C_MINE");
    await ack(spy.socket, "chat:joinConversation", "C_OTHER");
    a.socket.emit("typing:start", { conversationId: "C_MINE" }); // not joined yet → dropped
    await sleep(60);
    assert.equal(seenByVendor.length, 0);
    await ack(a.socket, "chat:joinConversation", "C_MINE");
    a.socket.emit("typing:start", { conversationId: "C_MINE", userId: "SPOOF" });
    spy.socket.emit("typing:start", { conversationId: "C_MINE" }); // spy never joined C_MINE
    await sleep(80);
    assert.deepEqual(seenByVendor, [{ userId: "U_CUST" }]);
  } finally {
    a.socket.close();
    b.socket.close();
    spy.socket.close();
  }
});
