// tests/chat-cache-redis-client.test.ts
//
// Phase 2 — chat caches against the INSTALLED node-redis client (redis 5.8.2):
// the real client encodes and sends every command over TCP to a minimal RESP
// server on 127.0.0.1 (ephemeral port) that implements GET / SET (EX, PX, NX,
// XX) / DEL / TTL with a real clock and records each command. This proves the
// wire format and the client's outage behaviour; it is NOT a real Redis server
// (no persistence, eviction, cluster or auth). prisma.* is in-memory.
//   1. auto-reply: SET carries EX 3600 on the wire; only v2 keys are read or
//      written; pre-fix keys (chat:ar:global, chat:ar:<vendor>) are never touched;
//   2. update / delete send DEL for the vendor's v2 key; the next read re-caches;
//   3. outage WHILE CONNECTED (the client reconnects and queues commands):
//      getRules falls back to the scoped database query in bounded time and an
//      update still succeeds — no hang, no unhandled rejection;
//   4. a read racing an update can re-cache the pre-update list, but only with
//      the TTL (documents the bounded staleness);
//   5. quick-reply suggestions are cached WITH EX 3600 (was: no expiry).
//   npx tsx --test tests/chat-cache-redis-client.test.ts

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createClient } from "redis";

const { prisma } = await import("../src/config/prisma.ts");
const redisClient = (await import("../src/config/redis.ts")).default as any;
const { AutoReplyService, AUTO_REPLY_CACHE_OP_TIMEOUT_MS } = await import("../src/modules/chat/services/auto-reply.service.ts");
const { QuickReplyService } = await import("../src/modules/chat/services/quick-reply.service.ts");
const { RedisKeys } = await import("../src/modules/chat/utils/redis-keys.ts");

type Row = Record<string, any>;

// ── minimal RESP server ────────────────────────────────────────────────
const data = new Map<string, { value: string; expiresAt: number | null }>();
const commands: string[][] = [];
const conns = new Set<net.Socket>();
let server: net.Server;
let port = 0;

function parse(buf: Buffer): [string[], Buffer] | null {
  if (buf[0] !== 0x2a) return null;
  const nl = buf.indexOf("\r\n");
  if (nl < 0) return null;
  const n = Number(buf.subarray(1, nl).toString());
  let p = nl + 2;
  const args: string[] = [];
  for (let k = 0; k < n; k++) {
    const e = buf.indexOf("\r\n", p);
    if (e < 0) return null;
    const len = Number(buf.subarray(p + 1, e).toString());
    const s = e + 2;
    if (buf.length < s + len + 2) return null;
    args.push(buf.subarray(s, s + len).toString());
    p = s + len + 2;
  }
  return [args, buf.subarray(p)];
}
const bulk = (v: string | null) => (v === null ? "$-1\r\n" : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
function live(k: string) {
  const e = data.get(k);
  if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
    data.delete(k);
    return undefined;
  }
  return e;
}
function exec(args: string[]): string {
  const [cmd, ...a] = args;
  switch (cmd.toUpperCase()) {
    case "GET":
      return bulk(live(a[0])?.value ?? null);
    case "SET": {
      const [k, v, ...opts] = a;
      let expiresAt: number | null = null;
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i].toUpperCase();
        if (o === "EX") expiresAt = Date.now() + Number(opts[++i]) * 1000;
        else if (o === "PX") expiresAt = Date.now() + Number(opts[++i]);
        else if (o === "NX" && live(k)) return bulk(null);
        else if (o === "XX" && !live(k)) return bulk(null);
      }
      data.set(k, { value: v, expiresAt });
      return "+OK\r\n";
    }
    case "DEL":
      return `:${a.filter((k) => live(k) && data.delete(k)).length}\r\n`;
    case "TTL": {
      const e = live(a[0]);
      return `:${!e ? -2 : e.expiresAt === null ? -1 : Math.ceil((e.expiresAt - Date.now()) / 1000)}\r\n`;
    }
    default:
      return "+OK\r\n"; // CLIENT SETINFO etc.
  }
}
function startServer(onPort = 0) {
  server = net.createServer((s) => {
    conns.add(s);
    let buf = Buffer.alloc(0);
    s.on("close", () => conns.delete(s));
    s.on("error", () => {});
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      let r;
      while ((r = parse(buf))) {
        buf = r[1];
        commands.push(r[0]);
        s.write(exec(r[0]));
      }
    });
  });
  return new Promise<void>((res) => server.listen(onPort, "127.0.0.1", () => ((port = (server.address() as net.AddressInfo).port), res())));
}
function stopServer() {
  for (const s of conns) s.destroy();
  return new Promise<void>((res) => server.close(() => res()));
}

// ── wiring: the services' redisClient delegates to a real, connected client ──
let client: ReturnType<typeof createClient>;
const restores: (() => void)[] = [];
const swap = (o: any, k: string, v: any) => {
  const had = Object.prototype.hasOwnProperty.call(o, k);
  const orig = o[k];
  o[k] = v;
  restores.push(() => (had ? (o[k] = orig) : delete o[k]));
};
let rules: Row[];
let quick: Row[];
let gateFindMany: Promise<void> | null;

before(async () => {
  await startServer();
  client = createClient({ socket: { host: "127.0.0.1", port, reconnectStrategy: () => 100 } });
  client.on("error", () => {}); // reconnect noise during the outage test
  await client.connect();
});
after(async () => {
  client.destroy();
  if (server.listening) await stopServer();
});
beforeEach(() => {
  data.clear();
  commands.length = 0;
  gateFindMany = null;
  rules = [
    { id: "R_GLOBAL", scope: "GLOBAL", vendorId: null, isActive: true, name: "g", createdAt: 1 },
    { id: "R_A", scope: "VENDOR", vendorId: "VA", isActive: true, name: "a", createdAt: 2 },
    { id: "R_B", scope: "VENDOR", vendorId: "VB", isActive: true, name: "b", createdAt: 3 },
  ];
  quick = [
    { id: "Q_G", scope: "GLOBAL", vendorId: null, isActive: true, name: "hello", keywords: [] },
    { id: "Q_A", scope: "VENDOR", vendorId: "VA", isActive: true, name: "thanks", keywords: [] },
  ];
  for (const m of ["get", "set", "del"]) swap(redisClient, m, (...args: any[]) => (client as any)[m](...args));
  const matches = (r: Row, where: Row) =>
    r.isActive === where.isActive && where.OR.some((c: Row) => r.scope === c.scope && (c.vendorId === undefined || r.vendorId === c.vendorId));
  swap(prisma.autoReply, "findMany", async ({ where }: Row) => {
    const snapshot = rules.filter((r) => matches(r, where)).map((r) => ({ ...r }));
    if (gateFindMany) await gateFindMany;
    return snapshot;
  });
  swap(prisma.autoReply, "findFirst", async ({ where }: Row) => rules.find((r) => r.id === where.id && r.vendorId === where.vendorId && r.scope === where.scope) ?? null);
  swap(prisma.autoReply, "update", async ({ where, data: d }: Row) => Object.assign(rules.find((r) => r.id === where.id)!, d));
  swap(prisma.autoReply, "delete", async ({ where }: Row) => rules.splice(rules.findIndex((r) => r.id === where.id), 1)[0]);
  // Phase 3: generic where matching (Prisma drops undefined keys) for the explicit quick-reply scope filter
  const qMatch = (r: Row, w: Row): boolean =>
    Object.entries(w).every(([k, v]) => v === undefined || (k === "OR" ? (v as Row[]).some((c) => qMatch(r, c)) : (r[k] ?? null) === v));
  swap(prisma.quickReply, "findMany", async ({ where }: Row) => quick.filter((r) => qMatch(r, where)).map((r) => ({ ...r })));
});
afterEach(() => restores.splice(0).reverse().forEach((r) => r()));

const ids = (list: Row[]) => list.map((r) => r.id).sort();
const ttl = (k: string) => client.ttl(k);
const touched = () => commands.filter((c) => ["GET", "SET", "DEL"].includes(c[0].toUpperCase())).map((c) => `${c[0].toUpperCase()} ${c[1]}`);

test("1. auto-reply: SET carries EX 3600 on the wire; only v2 keys are used; pre-fix keys are never touched", async () => {
  data.set("chat:ar:global", { value: JSON.stringify(rules), expiresAt: null }); // left by pre-fix code
  data.set("chat:ar:VA", { value: JSON.stringify(rules), expiresAt: null });
  assert.deepEqual(ids(await new AutoReplyService().getRules("VA")), ["R_A", "R_GLOBAL"]);
  assert.deepEqual(ids(await new AutoReplyService().getRules(undefined)), ["R_GLOBAL"]);
  const sets = commands.filter((c) => c[0] === "SET");
  assert.deepEqual(sets.map((c) => [c[1], ...c.slice(3)]), [
    ["chat:ar:v2:vendor:VA", "EX", "3600"],
    ["chat:ar:v2:global", "EX", "3600"],
  ]);
  assert.equal(await ttl("chat:ar:v2:vendor:VA"), 3600, "the server applied the expiry");
  assert.deepEqual(JSON.parse(data.get("chat:ar:v2:vendor:VA")!.value).map((r: Row) => r.id).sort(), ["R_A", "R_GLOBAL"], "only this scope is cached");
  assert.ok(!touched().some((t) => / chat:ar:(global|VA)$/.test(t)), touched().join(", "));
  // cache hit on the second read
  commands.length = 0;
  await new AutoReplyService().getRules("VA");
  assert.deepEqual(touched(), ["GET chat:ar:v2:vendor:VA"]);
});

test("2. update / delete send DEL for the vendor's v2 key; the next read re-caches fresh rules", async () => {
  await new AutoReplyService().getRules("VA");
  commands.length = 0;
  await new AutoReplyService().update("R_A", { isActive: false }, "VA");
  assert.deepEqual(touched(), ["DEL chat:ar:v2:vendor:VA"]);
  assert.deepEqual(ids(await new AutoReplyService().getRules("VA")), ["R_GLOBAL"]);
  rules.find((r) => r.id === "R_A")!.isActive = true;
  await new AutoReplyService().delete("R_A", "VA");
  assert.ok(!ids(await new AutoReplyService().getRules("VA")).includes("R_A"));
  assert.ok(data.has("chat:ar:v2:vendor:VB") === false, "vendor B's key untouched");
});

test("3. outage while connected: the client queues commands; getRules falls back to the database in bounded time, updates still succeed", { timeout: 10_000 }, async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await stopServer();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(client.isReady, false, "client is reconnecting");
    let t = Date.now();
    assert.deepEqual(ids(await new AutoReplyService().getRules("VA")), ["R_A", "R_GLOBAL"]);
    const readMs = Date.now() - t;
    assert.ok(readMs < AUTO_REPLY_CACHE_OP_TIMEOUT_MS * 2 + 300, `getRules took ${readMs} ms`);
    t = Date.now();
    const updated = await new AutoReplyService().update("R_A", { message: "saved" }, "VA");
    assert.equal(updated?.message, "saved");
    assert.ok(Date.now() - t < AUTO_REPLY_CACHE_OP_TIMEOUT_MS + 300);
    // Redis comes back: the queued commands run in order, so the queued DEL
    // (from the update) lands after the queued SET (from the read).
    await startServer(port);
    assert.ok(await new Promise((r) => {
      const end = Date.now() + 3000;
      const tick = () => (client.isReady ? r(true) : Date.now() > end ? r(false) : setTimeout(tick, 20));
      tick();
    }), "client reconnected");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(data.has("chat:ar:v2:vendor:VA"), false, "no pre-update list survives the outage");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    if (!server.listening) await startServer(port);
  }
});

test("4. a read racing an update can re-cache the pre-update list — bounded by the TTL", async () => {
  let release!: () => void;
  gateFindMany = new Promise<void>((r) => (release = r));
  const racing = new AutoReplyService().getRules("VA"); // DB snapshot taken: R_A active
  await new Promise((r) => setTimeout(r, 20));
  gateFindMany = null;
  await new AutoReplyService().update("R_A", { isActive: false }, "VA"); // DEL happens before the racing SET
  release();
  await racing;
  const cached = JSON.parse(data.get("chat:ar:v2:vendor:VA")!.value).map((r: Row) => r.id);
  assert.ok(cached.includes("R_A"), "known residual: the racing read re-cached the old list");
  assert.equal(await ttl("chat:ar:v2:vendor:VA"), 3600, "…but it expires within AUTO_REPLY_CACHE_TTL_SECONDS");
});

test("5. quick-reply suggestions are cached with EX 3600 (the old call set no expiry)", async () => {
  await new QuickReplyService().getSuggestions("", "VA");
  const set = commands.find((c) => c[0] === "SET")!;
  assert.equal(set[1], RedisKeys.quickReplies("VA")); // Phase 3: versioned vendor key
  assert.deepEqual(set.slice(3), ["EX", "3600"], JSON.stringify(set.slice(3)));
  assert.equal(await ttl(RedisKeys.quickReplies("VA")), 3600);
});
