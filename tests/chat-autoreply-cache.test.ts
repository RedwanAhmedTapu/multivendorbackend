// tests/chat-autoreply-cache.test.ts
//
// Phase 1 — the auto-reply rule cache (AutoReplyService.getRules + mutations),
// with an in-memory Redis that implements node-redis v5's get / set(key, value,
// { EX }) / del semantics on a controllable clock, and an in-memory rule table
// behind prisma.autoReply. No Redis, no database.
//   1. vendor A never receives vendor B's rules through a cache hit (also when a
//      cached entry somehow contains them);
//   2. an update leaves no stale result; 3. a delete stops the rule being served;
//   4. per-vendor and global keys can't collide; pre-fix keys are never read;
//   5. Redis failure → the vendor-scoped database query (no error, no crash);
//      a trigger failure is caught (no unhandled rejection);
//   5b. (Phase 2) a failing auto-reply scope lookup is caught as well, and the
//      live newMessage emit still happens;
//   6. entries expire after AUTO_REPLY_CACHE_TTL_SECONDS (the old call set none).
//   npx tsx --test tests/chat-autoreply-cache.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { prisma } = await import("../src/config/prisma.ts");
const redisClient = (await import("../src/config/redis.ts")).default as any;
const { AutoReplyService, AUTO_REPLY_CACHE_TTL_SECONDS } = await import("../src/modules/chat/services/auto-reply.service.ts");
const { RedisKeys } = await import("../src/modules/chat/utils/redis-keys.ts");
const { MessageService } = await import("../src/modules/chat/services/message.service.ts");

type Row = Record<string, any>;
let now = 0;
let store: Map<string, { value: string; expiresAt: number | null }>;
let rules: Row[];
let dbReads: number;
let redisDown: boolean;
const restores: (() => void)[] = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};

beforeEach(() => {
  now = 1_000_000;
  store = new Map();
  dbReads = 0;
  redisDown = false;
  rules = [
    { id: "R_GLOBAL", scope: "GLOBAL", vendorId: null, isActive: true, name: "g", createdAt: 1 },
    { id: "R_A", scope: "VENDOR", vendorId: "VA", isActive: true, name: "a", createdAt: 2 },
    { id: "R_B", scope: "VENDOR", vendorId: "VB", isActive: true, name: "b", createdAt: 3 },
  ];
  const fail = () => {
    if (redisDown) throw new Error("ECONNREFUSED");
  };
  set(redisClient, "get", async (k: string) => {
    fail();
    const e = store.get(k);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= now) {
      store.delete(k);
      return null;
    }
    return e.value;
  });
  set(redisClient, "set", async (k: string, v: string, opts?: any) => {
    fail();
    // node-redis v5: only an options OBJECT carries EX; anything else = no expiry
    const ex = opts && typeof opts === "object" && typeof opts.EX === "number" ? opts.EX : null;
    store.set(k, { value: v, expiresAt: ex === null ? null : now + ex * 1000 });
    return "OK";
  });
  set(redisClient, "del", async (k: string) => (fail(), store.delete(k) ? 1 : 0));
  const matches = (r: Row, where: Row) =>
    r.isActive === where.isActive && where.OR.some((c: Row) => r.scope === c.scope && (c.vendorId === undefined || r.vendorId === c.vendorId));
  set(prisma.autoReply, "findMany", async ({ where }: Row) => (dbReads++, rules.filter((r) => matches(r, where)).map((r) => ({ ...r }))));
  set(prisma.autoReply, "findFirst", async ({ where }: Row) => rules.find((r) => r.id === where.id && r.vendorId === where.vendorId && r.scope === where.scope) ?? null);
  set(prisma.autoReply, "update", async ({ where, data }: Row) => Object.assign(rules.find((r) => r.id === where.id)!, data));
  set(prisma.autoReply, "delete", async ({ where }: Row) => {
    const i = rules.findIndex((r) => r.id === where.id);
    return rules.splice(i, 1)[0];
  });
  set(prisma.autoReply, "create", async ({ data }: Row) => {
    const r = { id: `R_NEW_${rules.length}`, isActive: true, createdAt: rules.length + 10, ...data };
    rules.push(r);
    return r;
  });
});
afterEach(() => restores.splice(0).reverse().forEach((r) => r()));

const ids = (list: Row[]) => list.map((r) => r.id).sort();
const svc = () => new AutoReplyService();

test("1. vendor A never gets vendor B's rules through the cache — also if an entry somehow contains them", async () => {
  assert.deepEqual(ids(await svc().getRules("VB")), ["R_B", "R_GLOBAL"]); // B's list is cached
  assert.deepEqual(ids(await svc().getRules("VA")), ["R_A", "R_GLOBAL"]);
  assert.deepEqual(ids(await svc().getRules("VA")), ["R_A", "R_GLOBAL"], "cache hit");
  assert.equal(dbReads, 2, "the second A read came from the cache");
  // a poisoned / foreign entry under A's key is filtered on read
  store.set(RedisKeys.autoReplies("VA"), { value: JSON.stringify(rules), expiresAt: null });
  assert.deepEqual(ids(await svc().getRules("VA")), ["R_A", "R_GLOBAL"]);
  // no vendor in scope → GLOBAL only, from cache or not
  assert.deepEqual(ids(await svc().getRules(undefined)), ["R_GLOBAL"]);
  store.set(RedisKeys.autoReplies(undefined), { value: JSON.stringify(rules), expiresAt: null });
  assert.deepEqual(ids(await svc().getRules(undefined)), ["R_GLOBAL"]);
});

test("2. an update leaves no stale result", async () => {
  await svc().getRules("VA");
  await svc().update("R_A", { message: "new text", isActive: false }, "VA");
  assert.deepEqual(ids(await svc().getRules("VA")), ["R_GLOBAL"], "the deactivated rule isn't served from the old cache entry");
  await svc().update("R_A", { isActive: true }, "VA");
  const back = await svc().getRules("VA");
  assert.equal(back.find((r: Row) => r.id === "R_A")?.message, "new text");
});

test("3. a deleted rule is never served afterwards", async () => {
  assert.ok(ids(await svc().getRules("VA")).includes("R_A"));
  await svc().delete("R_A", "VA");
  assert.ok(!ids(await svc().getRules("VA")).includes("R_A"));
  // vendor B deleting A's rule is refused and doesn't touch A's cache
  await svc().getRules("VA");
  assert.equal(await svc().delete("R_GLOBAL", "VB"), null);
  assert.ok(store.has(RedisKeys.autoReplies("VA")));
});

test("4. keys: one per vendor, a separate global key, no collisions; pre-fix keys are ignored", async () => {
  const a = RedisKeys.autoReplies("VA");
  const b = RedisKeys.autoReplies("VB");
  const g = RedisKeys.autoReplies(undefined);
  assert.equal(new Set([a, b, g, RedisKeys.autoReplies("global")]).size, 4, "a vendor literally named 'global' can't hit the global key");
  assert.ok(a.startsWith("chat:ar:v2:vendor:") && g === "chat:ar:v2:global");
  // what the pre-fix code may have left behind (all vendors' rules, no TTL)
  store.set("chat:ar:global", { value: JSON.stringify(rules), expiresAt: null });
  store.set("chat:ar:VA", { value: JSON.stringify(rules), expiresAt: null });
  assert.deepEqual(ids(await svc().getRules(undefined)), ["R_GLOBAL"]);
  assert.deepEqual(ids(await svc().getRules("VA")), ["R_A", "R_GLOBAL"]);
});

test("5. Redis down: reads fall back to the scoped database query, mutations still succeed; a trigger failure is caught", async () => {
  redisDown = true;
  assert.deepEqual(ids(await svc().getRules("VA")), ["R_A", "R_GLOBAL"]);
  assert.deepEqual(ids(await svc().getRules(undefined)), ["R_GLOBAL"]);
  const updated = await svc().update("R_A", { message: "saved anyway" }, "VA");
  assert.equal(updated?.message, "saved anyway", "a cache failure doesn't turn a saved change into an error");
  // unparseable cache entry → database
  redisDown = false;
  store.set(RedisKeys.autoReplies("VA"), { value: "{not json", expiresAt: null });
  assert.deepEqual(ids(await svc().getRules("VA")), ["R_A", "R_GLOBAL"]);
  // the fire-and-forget trigger in MessageService.send: a rejection is handled
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    set(AutoReplyService.prototype, "processTrigger", async () => {
      throw Object.assign(new Error("redis down"), { code: "ECONNREFUSED" });
    });
    set(redisClient, "incr", async () => 1);
    set(redisClient, "expire", async () => 1);
    set(prisma.conversation, "findUnique", async () => ({ id: "C1" }));
    set(prisma.message, "create", async ({ data }: Row) => ({ id: "M1", createdAt: new Date(), media: [], ...data }));
    set(prisma, "$transaction", async (arr: any) => Promise.all(arr));
    set(prisma.conversation, "update", async () => ({}));
    set(prisma.conversationParticipant, "updateMany", async () => ({ count: 1 }));
    set(prisma.conversationParticipant, "findFirst", async () => ({ vendorId: "VA" }));
    set(prisma.conversationParticipant, "findMany", async () => []);
    await new MessageService().send({ conversationId: "C1", messageType: "TEXT", content: "hi", clientId: "c-1" } as any, "CUSTOMER", "U1");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("5b. Phase 2: the auto-reply scope lookup failing (DB hiccup) is caught too, and the live emit still goes out", async () => {
  const { SocketEmitter } = await import("../src/modules/chat/socket/chat.handler.ts");
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const emitted: string[] = [];
  const prevEmit = SocketEmitter._emit;
  SocketEmitter.setEmitter((event, _d, room) => emitted.push(`${event}@${room}`));
  try {
    let triggered = 0;
    set(AutoReplyService.prototype, "processTrigger", async () => void triggered++);
    set(redisClient, "incr", async () => 1);
    set(redisClient, "expire", async () => 1);
    set(prisma.conversation, "findUnique", async () => ({ id: "C1" }));
    set(prisma.message, "create", async ({ data }: Row) => ({ id: "M1", createdAt: new Date(), media: [], ...data }));
    set(prisma, "$transaction", async (arr: any) => Promise.all(arr));
    set(prisma.conversation, "update", async () => ({}));
    set(prisma.conversationParticipant, "updateMany", async () => ({ count: 1 }));
    set(prisma.conversationParticipant, "findFirst", async () => {
      throw Object.assign(new Error("db down"), { code: "P1001" });
    });
    set(prisma.conversationParticipant, "findMany", async () => []);
    await new MessageService().send({ conversationId: "C1", messageType: "TEXT", content: "hi", clientId: "c-2" } as any, "CUSTOMER", "U1");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, [], "no unhandled rejection");
    assert.equal(triggered, 0, "no auto-reply without a resolved scope");
    assert.ok(emitted.includes("newMessage@conversation:C1"), JSON.stringify(emitted));
  } finally {
    process.off("unhandledRejection", onUnhandled);
    SocketEmitter._emit = prevEmit;
  }
});

test("6. cache entries expire after AUTO_REPLY_CACHE_TTL_SECONDS", async () => {
  assert.equal(AUTO_REPLY_CACHE_TTL_SECONDS, 3600);
  await svc().getRules("VA");
  const entry = store.get(RedisKeys.autoReplies("VA"))!;
  assert.equal(entry.expiresAt, now + 3600 * 1000, "written with { EX: 3600 } — the old call set no expiry");
  rules.find((r) => r.id === "R_GLOBAL")!.isActive = false; // changed outside the vendor API (no invalidation)
  now += 3599 * 1000;
  assert.deepEqual(ids(await svc().getRules("VA")), ["R_A", "R_GLOBAL"], "still cached just before expiry");
  now += 2 * 1000;
  assert.deepEqual(ids(await svc().getRules("VA")), ["R_A"], "re-read from the database after expiry");
});
