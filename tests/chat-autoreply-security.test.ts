// tests/chat-autoreply-security.test.ts
//
// Phase 0 chat hardening — vendor auto-reply rule management, through the REAL
// chat router (setupChatModule) on 127.0.0.1, so authenticateUser and the
// VENDOR role guard run. Prisma and Redis are replaced in memory.
//   - a vendor can't update or delete another vendor's rule, or a GLOBAL rule;
//   - a vendor can't create or promote a rule into GLOBAL scope or onto another
//     vendor; unexpected body fields are ignored; SYSTEM / QUICK_REPLY refused;
//   - listing returns only GLOBAL + the vendor's own rules;
//   - the trigger lookup with no vendor in scope reads GLOBAL rules only
//     (it used to match every vendor's rules).
//   npx tsx --test tests/chat-autoreply-security.test.ts   (ACCESS_TOKEN_SECRET set)

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";

const { prisma } = await import("../src/config/prisma.ts");
const redisClient = (await import("../src/config/redis.ts")).default as any;
const { setupChatModule } = await import("../src/modules/chat/chat.module.ts");
const { AutoReplyRepository } = await import("../src/modules/chat/repositories/auto-reply.repository.ts");

type Row = Record<string, any>;
const SECRET = process.env.ACCESS_TOKEN_SECRET ?? "";
const USERS: Record<string, Row> = {
  U_VA: { id: "U_VA", role: "VENDOR", isActive: true, vendorId: "VA", name: "A", email: null },
  U_VB: { id: "U_VB", role: "VENDOR", isActive: true, vendorId: "VB", name: "B", email: null },
  U_CUST: { id: "U_CUST", role: "CUSTOMER", isActive: true, vendorId: null, name: "C", email: null },
  U_ADMIN: { id: "U_ADMIN", role: "ADMIN", isActive: true, vendorId: null, name: "Admin", email: null },
};
let rules: Record<string, Row>;
let writes: Row[];
let findManyWhere: Row[];
const restores: (() => void)[] = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
let server: http.Server;
let base = "";

before(async () => {
  set(prisma.user, "findUnique", async ({ where }: Row) => (USERS[where.id] ? { ...USERS[where.id] } : null));
  set(prisma.vendor, "findUnique", async ({ where }: Row) => (["VA", "VB"].includes(where.id) ? { id: where.id, storeName: where.id, email: null } : null));
  set(prisma.employee, "findFirst", async () => ({ id: "E_ADMIN", vendorId: null }));
  set(prisma.autoReply, "findFirst", async ({ where }: Row) => {
    const r = rules[where.id];
    return r && r.vendorId === where.vendorId && r.scope === where.scope ? { id: r.id } : null;
  });
  set(prisma.autoReply, "create", async ({ data }: Row) => (writes.push({ op: "create", data }), { id: "R_NEW", ...data }));
  set(prisma.autoReply, "update", async ({ where, data }: Row) => (writes.push({ op: "update", id: where.id, data }), { ...rules[where.id], ...data }));
  set(prisma.autoReply, "delete", async ({ where }: Row) => (writes.push({ op: "delete", id: where.id }), rules[where.id]));
  set(prisma.autoReply, "findMany", async ({ where }: Row) => (findManyWhere.push(where), []));
  for (const m of ["del", "set"]) set(redisClient, m, async () => "OK");
  set(redisClient, "get", async () => null);
  const app = express();
  app.use(express.json());
  app.use("/api/chat", setupChatModule(new Server()));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/chat/auto-replies`;
});
after(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  restores.reverse().forEach((r) => r());
});
beforeEach(() => {
  rules = {
    R_A: { id: "R_A", scope: "VENDOR", vendorId: "VA" },
    R_B: { id: "R_B", scope: "VENDOR", vendorId: "VB" },
    R_GLOBAL: { id: "R_GLOBAL", scope: "GLOBAL", vendorId: null },
  };
  writes = [];
  findManyWhere = [];
});

const tok = (id: string) => jwt.sign({ id, role: USERS[id].role }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const RULE = { name: "Away", triggerType: "FIRST_MESSAGE", message: "We'll reply soon" };

test("vendor A can't update or delete vendor B's rule, nor a GLOBAL rule — 404, nothing written", async () => {
  for (const id of ["R_B", "R_GLOBAL", "R_MISSING"]) {
    assert.equal((await call("U_VA", "PATCH", `/${id}`, { message: "hijacked" })).status, 404, id);
    assert.equal((await call("U_VA", "DELETE", `/${id}`)).status, 404, id);
  }
  assert.deepEqual(writes, []);
  assert.equal((await call("U_VA", "PATCH", "/R_A", { message: "updated" })).status, 200);
  assert.equal((await call("U_VA", "DELETE", "/R_A")).status, 200);
  assert.deepEqual(writes.map((w) => `${w.op}:${w.id}`), ["update:R_A", "delete:R_A"]);
});

test("create: always the caller's own VENDOR rule — scope / vendorId / counters in the body are ignored", async () => {
  const r = await call("U_VA", "POST", "/", { ...RULE, scope: "GLOBAL", vendorId: "VB", triggerCount: 999, id: "R_FORGED", createdAt: "2020-01-01", extra: "x" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(writes[0].data, { ...RULE, scope: "VENDOR", vendorId: "VA" });
});

test("update: scope / vendorId can't be promoted; only whitelisted fields are written", async () => {
  const r = await call("U_VA", "PATCH", "/R_A", { message: "new", scope: "GLOBAL", vendorId: "VB", triggerCount: 0 });
  assert.equal(r.status, 200);
  assert.deepEqual(writes[0].data, { message: "new" });
});

test("invalid rules are refused: SYSTEM / QUICK_REPLY message types, unknown trigger, empty message", async () => {
  for (const body of [{ ...RULE, messageType: "SYSTEM" }, { ...RULE, messageType: "QUICK_REPLY" }, { ...RULE, triggerType: "ALWAYS" }, { ...RULE, message: " " }, { name: "x" }]) {
    assert.equal((await call("U_VA", "POST", "/", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call("U_VA", "PATCH", "/R_A", { messageType: "SYSTEM" })).status, 400);
  assert.deepEqual(writes, []);
});

test("only vendors manage rules (customers and admins are refused by the route guard)", async () => {
  for (const who of ["U_CUST", "U_ADMIN"]) {
    assert.equal((await call(who, "POST", "/", RULE)).status, 403, who);
    assert.equal((await call(who, "DELETE", "/R_A")).status, 403, who);
  }
  assert.deepEqual(writes, []);
});

test("listing reads GLOBAL + the vendor's own rules only", async () => {
  assert.equal((await call("U_VA", "GET", "/")).status, 200);
  assert.deepEqual(findManyWhere[0], { isActive: true, OR: [{ scope: "GLOBAL" }, { scope: "VENDOR", vendorId: "VA" }] });
});

test("trigger lookup without a vendor in scope reads GLOBAL rules only (no other vendor's rules)", async () => {
  await new AutoReplyRepository().findActiveByScope(undefined);
  assert.deepEqual(findManyWhere.at(-1), { isActive: true, OR: [{ scope: "GLOBAL" }] });
  await new AutoReplyRepository().findActiveByScope("VB");
  assert.deepEqual(findManyWhere.at(-1), { isActive: true, OR: [{ scope: "GLOBAL" }, { scope: "VENDOR", vendorId: "VB" }] });
});
