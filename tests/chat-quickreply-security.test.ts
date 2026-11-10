// tests/chat-quickreply-security.test.ts
//
// Phase 3 — quick-reply authorization and tenant isolation, through the REAL
// chat router (setupChatModule) on 127.0.0.1, so authenticateUser and the
// VENDOR route guard run. prisma.quickReply is an in-memory table whose `where`
// matching follows Prisma 6.16.1's query construction (verified against the
// installed client: a key whose value is `undefined` is DROPPED from the query,
// so `{ scope: "VENDOR", vendorId: undefined }` matches every vendor's rows).
// Redis is an in-memory map. No database, no Redis server.
//   1. no vendor scope (customer / admin): suggestions are platform GLOBAL only;
//   2. vendor A sees platform GLOBAL + its own rows, never vendor B's;
//   3. cross-vendor / platform PATCH and DELETE → 404, same answer as a missing
//      id, nothing written; ownership is part of the write's own `where`;
//   4. protected fields (scope other than VENDOR, vendorId, employeeId,
//      counters, ids) are refused; create is always the caller's VENDOR row;
//   5. malformed input is refused;
//   6. cache: vendor-scoped, versioned keys; invalidation touches only the
//      caller's key; a cached entry is re-checked against the scope;
//   7. only vendors manage quick replies (route guard).
//   npx tsx --test tests/chat-quickreply-security.test.ts   (ACCESS_TOKEN_SECRET set)

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";

const { prisma } = await import("../src/config/prisma.ts");
const redisClient = (await import("../src/config/redis.ts")).default as any;
const { setupChatModule } = await import("../src/modules/chat/chat.module.ts");
const { RedisKeys } = await import("../src/modules/chat/utils/redis-keys.ts");

type Row = Record<string, any>;
const SECRET = process.env.ACCESS_TOKEN_SECRET ?? "";
const USERS: Record<string, Row> = {
  U_VA: { id: "U_VA", role: "VENDOR", isActive: true, vendorId: "VA", name: "A", email: null },
  U_VB: { id: "U_VB", role: "VENDOR", isActive: true, vendorId: "VB", name: "B", email: null },
  U_CUST: { id: "U_CUST", role: "CUSTOMER", isActive: true, vendorId: null, name: "C", email: null },
  U_ADMIN: { id: "U_ADMIN", role: "ADMIN", isActive: true, vendorId: null, name: "Admin", email: null },
};

// ── in-memory quick_replies with Prisma's undefined-key semantics ──
let rows: Row[];
let writes: Row[];
let cache: Map<string, string>;
let cacheOps: string[];
function matches(r: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue; // Prisma drops undefined keys
    if (k === "OR") {
      if (!(v as Row[]).some((c) => matches(r, c))) return false;
    } else if (k === "AND") {
      if (!(v as Row[]).every((c) => matches(r, c))) return false;
    } else if (v !== null && typeof v === "object" && "in" in (v as Row)) {
      if (!(v as Row).in.includes(r[k])) return false;
    } else if ((r[k] ?? null) !== v) return false;
  }
  return true;
}
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
  const q = prisma.quickReply as any;
  set(q, "findMany", async ({ where }: Row) => rows.filter((r) => matches(r, where)).map((r) => ({ ...r })));
  set(q, "findFirst", async ({ where }: Row) => {
    const r = rows.find((x) => matches(x, where));
    return r ? { ...r } : null;
  });
  set(q, "create", async ({ data }: Row) => {
    writes.push({ op: "create", data });
    const r = { id: `Q_NEW_${rows.length}`, isActive: true, usageCount: 0, sortOrder: 0, employeeId: null, ...data };
    rows.push(r);
    return { ...r };
  });
  set(q, "update", async ({ where, data }: Row) => {
    writes.push({ op: "update", where, data });
    const r = rows.find((x) => x.id === where.id);
    if (!r) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
    return { ...Object.assign(r, data) };
  });
  set(q, "updateMany", async ({ where, data }: Row) => {
    writes.push({ op: "updateMany", where, data });
    const hit = rows.filter((x) => matches(x, where));
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  });
  set(q, "delete", async ({ where }: Row) => {
    writes.push({ op: "delete", where });
    const i = rows.findIndex((x) => x.id === where.id);
    if (i < 0) throw Object.assign(new Error("Record to delete does not exist."), { code: "P2025" });
    return rows.splice(i, 1)[0];
  });
  set(q, "deleteMany", async ({ where }: Row) => {
    writes.push({ op: "deleteMany", where });
    const before = rows.length;
    rows = rows.filter((x) => !matches(x, where));
    return { count: before - rows.length };
  });
  set(redisClient, "get", async (k: string) => (cacheOps.push(`GET ${k}`), cache.get(k) ?? null));
  set(redisClient, "set", async (k: string, v: string) => (cacheOps.push(`SET ${k}`), cache.set(k, v), "OK"));
  set(redisClient, "del", async (k: string) => (cacheOps.push(`DEL ${k}`), cache.delete(k) ? 1 : 0));
  const app = express();
  app.use(express.json());
  app.use("/api/chat", setupChatModule(new Server()));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/chat/quick-replies`;
});
after(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  restores.reverse().forEach((r) => r());
});
beforeEach(() => {
  rows = [
    { id: "Q_PLATFORM", scope: "GLOBAL", vendorId: null, employeeId: null, isActive: true, name: "welcome", content: "Welcome to FinixMart", keywords: [], sortOrder: 0, usageCount: 0 },
    { id: "Q_A", scope: "VENDOR", vendorId: "VA", employeeId: null, isActive: true, name: "a-ship", content: "A ships in 2 days", keywords: ["ship"], sortOrder: 0, usageCount: 0 },
    { id: "Q_B", scope: "VENDOR", vendorId: "VB", employeeId: null, isActive: true, name: "b-secret", content: "B private discount code", keywords: ["code"], sortOrder: 0, usageCount: 0 },
    // created by the old code: create defaulted scope to GLOBAL but stored the vendor's id
    { id: "Q_B_LEGACY", scope: "GLOBAL", vendorId: "VB", employeeId: null, isActive: true, name: "b-legacy", content: "B legacy text", keywords: [], sortOrder: 0, usageCount: 0 },
  ];
  writes = [];
  cache = new Map();
  cacheOps = [];
});

const tok = (id: string) => jwt.sign({ id, role: USERS[id].role }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
async function call(who: string, method: string, path: string, body?: unknown, raw?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const ids = (list: Row[]) => list.map((r) => r.id).sort();
const QR = { name: "Thanks", content: "Thank you for your order" };

test("1. no vendor scope (customer, admin): suggestions are platform GLOBAL quick replies only", async () => {
  for (const who of ["U_CUST", "U_ADMIN"]) {
    const r = await call(who, "GET", "/suggestions");
    assert.equal(r.status, 200, who);
    assert.deepEqual(ids(r.body.data), ["Q_PLATFORM"], `${who}: ${JSON.stringify(ids(r.body.data))}`);
    const s = await call(who, "GET", "/suggestions?q=code");
    assert.deepEqual(ids(s.body.data), [], `${who} can't search another vendor's text`);
  }
  const cached = JSON.parse(cache.get(RedisKeys.quickReplies(undefined)) ?? "[]");
  assert.deepEqual(ids(cached), ["Q_PLATFORM"], "the shared key holds platform rows only");
});

test("2. vendor A sees platform GLOBAL + its own quick replies, never vendor B's (nor B's legacy GLOBAL-scoped row)", async () => {
  const a = await call("U_VA", "GET", "/suggestions");
  assert.deepEqual(ids(a.body.data), ["Q_A", "Q_PLATFORM"]);
  const b = await call("U_VB", "GET", "/suggestions");
  assert.deepEqual(ids(b.body.data), ["Q_B", "Q_B_LEGACY", "Q_PLATFORM"], "B keeps its own rows, including the legacy one");
  assert.deepEqual(ids((await call("U_VA", "GET", "/suggestions?q=code")).body.data), []);
});

test("3. cross-vendor / platform PATCH and DELETE are 404 (same as a missing id); nothing written; ownership is in the write's where", async () => {
  const missing = await call("U_VA", "PATCH", "/Q_MISSING", { content: "x" });
  for (const id of ["Q_B", "Q_B_LEGACY", "Q_PLATFORM", "Q_MISSING"]) {
    const p = await call("U_VA", "PATCH", `/${id}`, { content: "hijacked" });
    assert.equal(p.status, 404, `PATCH ${id}`);
    assert.deepEqual(p.body, missing.body, "a foreign id is indistinguishable from a missing one");
    assert.equal((await call("U_VA", "DELETE", `/${id}`)).status, 404, `DELETE ${id}`);
  }
  assert.equal(rows.find((r) => r.id === "Q_B")!.content, "B private discount code");
  assert.ok(rows.some((r) => r.id === "Q_B") && rows.some((r) => r.id === "Q_PLATFORM"));
  assert.ok(writes.every((w) => w.where?.vendorId === "VA"), JSON.stringify(writes));
  // the owner still can
  const own = await call("U_VA", "PATCH", "/Q_A", { content: "A ships tomorrow" });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.data.id, "Q_A");
  assert.equal(own.body.data.content, "A ships tomorrow");
  assert.equal((await call("U_VA", "DELETE", "/Q_A")).status, 200);
  assert.ok(!rows.some((r) => r.id === "Q_A"));
  for (const w of writes) {
    assert.ok(["updateMany", "deleteMany"].includes(w.op), `${w.op}: ownership must be enforced by the write itself`);
    assert.equal(w.where.vendorId, "VA");
  }
});

test("4. protected fields are refused; create is always the caller's own VENDOR row", async () => {
  for (const extra of [{ scope: "GLOBAL" }, { scope: "EMPLOYEE" }, { vendorId: "VB" }, { employeeId: "E1" }, { usageCount: 99 }, { id: "Q_FORGED" }, { isActive: false, vendorId: "VB" }]) {
    const c = await call("U_VA", "POST", "/", { ...QR, ...extra });
    assert.equal(c.status, 400, `create ${JSON.stringify(extra)}`);
    const u = await call("U_VA", "PATCH", "/Q_A", extra);
    assert.equal(u.status, 400, `update ${JSON.stringify(extra)}`);
  }
  assert.deepEqual(writes, []);
  assert.equal(rows.find((r) => r.id === "Q_A")!.scope, "VENDOR");
  const ok = await call("U_VA", "POST", "/", QR);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(writes[0].data, { ...QR, scope: "VENDOR", vendorId: "VA" });
  const explicit = await call("U_VA", "POST", "/", { ...QR, scope: "VENDOR" }); // what the frontend type allows
  assert.equal(explicit.status, 201);
  assert.equal(writes[1].data.scope, "VENDOR");
});

test("5. malformed input is refused", async () => {
  const bad: unknown[] = [{}, { name: "x" }, { content: "x" }, { ...QR, name: "" }, { ...QR, content: "  " }, { ...QR, name: "n".repeat(101) }, { ...QR, keywords: "ship" }, { ...QR, keywords: [1] }, { ...QR, shortcut: 5 }, [QR], { ...QR, unknownField: 1 }];
  for (const body of bad) assert.equal((await call("U_VA", "POST", "/", body)).status, 400, JSON.stringify(body));
  for (const body of [{}, { name: "" }, { keywords: "x" }, { unknownField: 1 }]) assert.equal((await call("U_VA", "PATCH", "/Q_A", body)).status, 400, JSON.stringify(body));
  assert.equal((await call("U_VA", "POST", "/", undefined, "{not json")).status, 400);
  assert.deepEqual(writes, []);
});

test("6. cache: vendor-scoped versioned keys; invalidation touches only the caller's key; cached entries are re-checked", async () => {
  const kA = RedisKeys.quickReplies("VA");
  const kB = RedisKeys.quickReplies("VB");
  const kG = RedisKeys.quickReplies(undefined);
  assert.equal(new Set([kA, kB, kG, RedisKeys.quickReplies("global")]).size, 4, "a vendor id can't collide with the shared key");
  assert.ok(!["chat:qr:VA", "chat:qr:global"].includes(kA) && !["chat:qr:global"].includes(kG), "versioned: pre-fix entries are never read");
  // what the old code may have left (every vendor's rows under the shared key)
  cache.set("chat:qr:global", JSON.stringify(rows));
  cache.set("chat:qr:VA", JSON.stringify(rows));
  assert.deepEqual(ids((await call("U_CUST", "GET", "/suggestions")).body.data), ["Q_PLATFORM"]);
  await call("U_VA", "GET", "/suggestions");
  await call("U_VB", "GET", "/suggestions");
  assert.ok(cache.has(kA) && cache.has(kB));
  cacheOps = [];
  await call("U_VA", "PATCH", "/Q_A", { content: "fresh" });
  assert.deepEqual(cacheOps, [`DEL ${kA}`], "only A's key is invalidated");
  assert.ok(cache.has(kB), "B's cache untouched");
  const a = await call("U_VA", "GET", "/suggestions");
  assert.equal(a.body.data.find((r: Row) => r.id === "Q_A").content, "fresh", "no stale result after update");
  // a foreign row planted in A's entry is filtered on read
  cache.set(kA, JSON.stringify(rows));
  assert.deepEqual(ids((await call("U_VA", "GET", "/suggestions")).body.data), ["Q_A", "Q_PLATFORM"]);
  cache.set(kG, JSON.stringify(rows));
  assert.deepEqual(ids((await call("U_CUST", "GET", "/suggestions")).body.data), ["Q_PLATFORM"]);
  // a cross-vendor attempt invalidates nothing
  cacheOps = [];
  await call("U_VA", "DELETE", "/Q_B");
  assert.deepEqual(cacheOps, []);
});

test("7. only vendors manage quick replies (customers and admins are refused by the route guard)", async () => {
  for (const who of ["U_CUST", "U_ADMIN"]) {
    assert.equal((await call(who, "POST", "/", QR)).status, 403, who);
    assert.equal((await call(who, "PATCH", "/Q_PLATFORM", { content: "x" })).status, 403, who);
    assert.equal((await call(who, "DELETE", "/Q_PLATFORM")).status, 403, who);
  }
  assert.deepEqual(writes, []);
});
