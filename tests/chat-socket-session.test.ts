// tests/chat-socket-session.test.ts
//
// Phase 3 — an ESTABLISHED chat socket stays authorized only while its access
// token and its user are valid. Real in-process Socket.IO server
// (setupChatModule, 127.0.0.1, ephemeral port) and a real socket.io-client
// (from multivendorsite; skipped if absent). Prisma and Redis in memory; tokens
// signed with the throwaway test secret. The guard's intervals are shortened.
//   1. token expiry: the server ends the session at `exp` (chat:auth_expired +
//      disconnect) and the socket leaves its rooms;
//   2. an event that arrives after `exp` is refused before any handler runs;
//   3. deactivation: the next event re-validates, is refused (ack Unauthorized),
//      the handler doesn't run, the socket is disconnected;
//   4. an idle deactivated socket is ended by the sweep and stops receiving
//      room broadcasts; a changed role is treated the same;
//   5. a valid user is not disconnected by re-validation or the sweep;
//   6. reconnect with a refreshed token works and room authorization still applies.
//   npx tsx --test tests/chat-socket-session.test.ts   (ACCESS_TOKEN_SECRET set)

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";

const { prisma } = await import("../src/config/prisma.ts");
const redisClient = (await import("../src/config/redis.ts")).default as any;
const { setupChatModule } = await import("../src/modules/chat/chat.module.ts");
const { socketSessionConfig } = await import("../src/modules/chat/socket/socket-auth.ts");

let ioc: any = null;
try {
  ioc = createRequire(new URL("../../multivendorsite/package.json", import.meta.url))("socket.io-client");
} catch {
  ioc = null;
}
const skip = ioc ? false : "socket.io-client not found (it lives in multivendorsite/node_modules)";

type Row = Record<string, any>;
const SECRET = process.env.ACCESS_TOKEN_SECRET ?? "";
let USERS: Record<string, Row>;
const CONVERSATIONS: Record<string, Row> = { C_MINE: { id: "C_MINE", type: "PRODUCT_INQUIRY" }, C_OTHER: { id: "C_OTHER", type: "PRODUCT_INQUIRY" } };
const PARTICIPANTS: Row[] = [
  { id: "P_CUST_MINE", conversationId: "C_MINE", userId: "U_CUST", leftAt: null },
  { id: "P_CUST2_OTHER", conversationId: "C_OTHER", userId: "U_CUST2", leftAt: null },
];
const tok = (id: string, expiresIn: jwt.SignOptions["expiresIn"] = "5m") => jwt.sign({ id, role: USERS[id].role }, SECRET, { algorithm: "HS256", expiresIn });
const restores: (() => void)[] = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
let httpServer: http.Server;
let io: Server;
let url = "";
let joins: string[];
const clients: any[] = [];
const defaults = { ...socketSessionConfig };

before(async () => {
  if (skip) return;
  set(prisma.user, "findUnique", async ({ where }: Row) => (USERS[where.id] ? { ...USERS[where.id] } : null));
  set(prisma.vendor, "findUnique", async ({ where }: Row) => (where.id === "V1" ? { id: "V1", storeName: "Store", email: null } : null));
  set(prisma.employee, "findFirst", async () => null);
  set(prisma.conversation, "findUnique", async ({ where }: Row) => CONVERSATIONS[where.id] ?? null);
  set(prisma.conversationParticipant, "findFirst", async ({ where }: Row) => {
    const keys = Object.keys(where).filter((k) => !["conversationId", "leftAt"].includes(k));
    const p = PARTICIPANTS.find((x) => x.conversationId === where.conversationId && keys.every((k) => x[k] === where[k])) ?? null;
    if (p) joins.push(`${where.conversationId}`);
    return p;
  });
  for (const m of ["set", "sAdd", "expire", "del", "sRem"]) set(redisClient, m, async () => "OK");
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
beforeEach(() => {
  USERS = {
    U_CUST: { id: "U_CUST", role: "CUSTOMER", isActive: true, vendorId: null, name: "C", email: null },
    U_CUST2: { id: "U_CUST2", role: "CUSTOMER", isActive: true, vendorId: null, name: "C2", email: null },
  };
  joins = [];
  Object.assign(socketSessionConfig, defaults);
});
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  Object.assign(socketSessionConfig, defaults);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(25);
  }
  return cond();
}
function connect(token: string): Promise<any> {
  const c = ioc.io(url, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
  clients.push(c);
  c.events = [] as string[];
  c.on("chat:auth_expired", () => c.events.push("auth_expired"));
  c.on("disconnect", (reason: string) => c.events.push(`disconnect:${reason}`));
  c.on("probe", () => c.events.push("probe"));
  return new Promise((res, rej) => {
    c.once("connect", () => res(c));
    c.once("connect_error", (e: Error) => rej(e));
  });
}
const emitAck = (c: any, ev: string, arg: unknown) => c.timeout(2000).emitWithAck(ev, arg).catch((e: Error) => ({ timeout: e.message }));
const inRoom = async (room: string) => (await io.in(room).fetchSockets()).length;

test("1. token expiry: the server ends the session at exp and the socket leaves its rooms", { skip }, async () => {
  const c = await connect(tok("U_CUST", "2s"));
  assert.deepEqual(await emitAck(c, "chat:joinConversation", "C_MINE"), { ok: true });
  assert.equal(await inRoom("conversation:C_MINE"), 1);
  assert.ok(await until(() => !c.connected, 5000), "disconnected at expiry");
  assert.deepEqual(c.events, ["auth_expired", "disconnect:io server disconnect"]);
  assert.ok(await until(async () => (await inRoom("conversation:C_MINE")) === 0));
});

test("2. an event arriving after exp is refused before any handler runs", { skip }, async () => {
  const c = await connect(tok("U_CUST"));
  const server = [...io.sockets.sockets.values()].find((s) => s.connected)!;
  server.data.auth.expMs = Date.now() - 1; // the expiry timer hasn't fired (clock / timer drift)
  joins = [];
  assert.deepEqual(await emitAck(c, "chat:joinConversation", "C_MINE"), { ok: false, error: "Unauthorized" });
  assert.deepEqual(joins, [], "the room-authorization handler never ran");
  assert.ok(await until(() => !c.connected));
  assert.equal(await inRoom("conversation:C_MINE"), 0);
});

test("3. deactivation: the next event re-validates, is refused, and the socket is disconnected", { skip }, async () => {
  socketSessionConfig.revalidateAfterMs = 0;
  const c = await connect(tok("U_CUST"));
  assert.deepEqual(await emitAck(c, "chat:joinConversation", "C_MINE"), { ok: true });
  USERS.U_CUST.isActive = false; // deactivated by an admin
  joins = [];
  assert.deepEqual(await emitAck(c, "chat:joinConversation", "C_MINE"), { ok: false, error: "Unauthorized" });
  assert.deepEqual(joins, []);
  assert.ok(await until(() => !c.connected));
  assert.ok(c.events.includes("auth_expired"));
  // and it can't come back with the same (still unexpired) token
  await assert.rejects(connect(tok("U_CUST")), /Unauthorized/);
});

test("4. an idle deactivated socket is ended by the sweep and stops receiving; a changed role is treated the same", { skip }, async () => {
  socketSessionConfig.sweepIntervalMs = 150;
  const a = await connect(tok("U_CUST"));
  const b = await connect(tok("U_CUST2"));
  await emitAck(a, "chat:joinConversation", "C_MINE");
  USERS.U_CUST.isActive = false;
  USERS.U_CUST2.role = "VENDOR"; // identity changed (the token says CUSTOMER)
  assert.ok(await until(() => !a.connected && !b.connected, 3000), `${a.connected} ${b.connected}`);
  io.to("conversation:C_MINE").emit("probe");
  await sleep(150);
  assert.ok(!a.events.includes("probe"), "no broadcast after the session ended");
});

test("5. a valid user is not disconnected by re-validation or the sweep", { skip }, async () => {
  socketSessionConfig.revalidateAfterMs = 0;
  socketSessionConfig.sweepIntervalMs = 100;
  const c = await connect(tok("U_CUST"));
  for (let i = 0; i < 5; i++) assert.deepEqual(await emitAck(c, "chat:joinConversation", "C_MINE"), { ok: true });
  await sleep(500); // several sweeps
  assert.ok(c.connected);
  assert.deepEqual(c.events, []);
  io.to("conversation:C_MINE").emit("probe");
  assert.ok(await until(() => c.events.includes("probe")));
});

test("6. reconnect with a refreshed token works; room authorization still applies", { skip }, async () => {
  const old = await connect(tok("U_CUST", "1s"));
  assert.ok(await until(() => !old.connected, 4000));
  const fresh = await connect(tok("U_CUST")); // what the client does after the refresh
  assert.deepEqual(await emitAck(fresh, "chat:joinConversation", "C_MINE"), { ok: true });
  assert.deepEqual(await emitAck(fresh, "chat:joinConversation", "C_OTHER"), { ok: false, error: "Not found" }, "still no access to someone else's conversation");
  assert.equal(await inRoom("conversation:C_OTHER"), 0);
});
