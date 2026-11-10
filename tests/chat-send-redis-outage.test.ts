// tests/chat-send-redis-outage.test.ts
//
// Phase 3 — POST /api/chat/messages when Redis (duplicate detection + rate
// limit) or the database misbehaves. REAL chat router (setupChatModule) on
// 127.0.0.1 with authenticateUser and the Phase 0 access check; prisma is in
// memory. Redis is either
//   - an in-memory double with modes: up / hang (what node-redis does while it
//     reconnects: the command is queued and never settles) / reject, or
//   - for test 2, the INSTALLED node-redis client against a minimal RESP server
//     on 127.0.0.1 that is stopped and restarted (protocol-level, not a real
//     Redis server).
// Policy under test (fail closed — no message is accepted without its abuse
// controls): Redis unavailable → 503 + Retry-After within a bounded time, no
// message persisted; duplicates and the rate limit still apply; a failure
// before persistence releases the duplicate key so a retry succeeds; nothing
// is ever persisted twice; no unhandled rejections.
//   npx tsx --test tests/chat-send-redis-outage.test.ts   (ACCESS_TOKEN_SECRET set)

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import express from "express";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { createClient } from "redis";

const { prisma } = await import("../src/config/prisma.ts");
const redisClient = (await import("../src/config/redis.ts")).default as any;
const { setupChatModule } = await import("../src/modules/chat/chat.module.ts");
const { AutoReplyService } = await import("../src/modules/chat/services/auto-reply.service.ts");

type Row = Record<string, any>;
const SECRET = process.env.ACCESS_TOKEN_SECRET ?? "";
const USERS: Record<string, Row> = {
  U_A: { id: "U_A", role: "CUSTOMER", isActive: true, vendorId: null, name: "A", email: null },
  U_B: { id: "U_B", role: "CUSTOMER", isActive: true, vendorId: null, name: "B", email: null },
};
const CONV = "ckconversation0000000001"; // cuid-shaped
let messages: Row[];
let dbDown: boolean;
let txDown: boolean; // Phase 4: the conversation update after the message is saved fails
const restores: (() => void)[] = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};

// ── in-memory Redis double ──
let mode: "up" | "hang" | "reject";
let kv: Map<string, { v: string; exp: number | null }>;
const live = (k: string) => {
  const e = kv.get(k);
  if (e && e.exp !== null && e.exp <= Date.now()) kv.delete(k);
  return kv.get(k);
};
const gate = <T>(fn: () => T): Promise<T> =>
  mode === "hang" ? new Promise<T>(() => {}) : mode === "reject" ? Promise.reject(new Error("The client is closed")) : Promise.resolve(fn());
const fake = {
  set: (k: string, v: string, o?: Row) =>
    gate(() => {
      if (o?.NX && live(k)) return null;
      kv.set(k, { v, exp: o?.EX ? Date.now() + o.EX * 1000 : null });
      return "OK";
    }),
  incr: (k: string) =>
    gate(() => {
      const n = Number(live(k)?.v ?? 0) + 1;
      kv.set(k, { v: String(n), exp: live(k)?.exp ?? null });
      return n;
    }),
  expire: (k: string, s: number) => gate(() => (live(k) ? (kv.get(k)!.exp = Date.now() + s * 1000, 1) : 0)),
  del: (k: string) => gate(() => (kv.delete(k) ? 1 : 0)),
  // the service's compare-and-delete release script
  eval: (_script: string, o: { keys: string[]; arguments: string[] }) =>
    gate(() => (live(o.keys[0])?.v === o.arguments[0] ? (kv.delete(o.keys[0]), 1) : 0)),
};
const useRedis = (impl: Row) => {
  for (const m of ["set", "incr", "expire", "del", "eval"]) redisClient[m] = impl[m];
};

let server: http.Server;
let base = "";
before(async () => {
  set(prisma.user, "findUnique", async ({ where }: Row) => (USERS[where.id] ? { ...USERS[where.id] } : null));
  set(prisma.conversation, "findUnique", async ({ where }: Row) => (where.id === CONV ? { id: CONV, type: "PRODUCT_INQUIRY" } : null));
  set(prisma.conversationParticipant, "findFirst", async ({ where }: Row) =>
    where.conversationId === CONV && ["U_A", "U_B"].includes(where.userId) ? { id: `P_${where.userId}`, conversationId: CONV, userId: where.userId } : where.participantType === "VENDOR" ? null : null
  );
  set(prisma.conversationParticipant, "findMany", async () => []);
  set(prisma.message, "create", async ({ data }: Row) => {
    if (dbDown) throw Object.assign(new Error("Can't reach database server at 10.0.0.5:5432"), { code: "P1001" });
    const m = { id: `M${messages.length + 1}`, createdAt: new Date(), media: [], ...data };
    messages.push(m);
    return m;
  });
  set(prisma, "$transaction", async (arr: any) => {
    if (txDown) throw Object.assign(new Error("Transaction failed at 10.0.0.5"), { code: "P2034" });
    return Promise.all(arr);
  });
  set(prisma.conversation, "update", async () => ({}));
  set(prisma.conversationParticipant, "updateMany", async () => ({ count: 1 }));
  set(AutoReplyService.prototype, "processTrigger", async () => {});
  for (const m of ["set", "incr", "expire", "del", "eval"]) set(redisClient, m, redisClient[m]); // restored after
  const app = express();
  app.use(express.json());
  app.use("/api/chat", setupChatModule(new Server()));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/chat/messages`;
});
after(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  restores.reverse().forEach((r) => r());
});
beforeEach(() => {
  messages = [];
  dbDown = false;
  txDown = false;
  mode = "up";
  kv = new Map();
  useRedis(fake);
});

const tok = (id: string) => jwt.sign({ id, role: USERS[id].role }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
async function send(who: string, clientId: string, content = "hi") {
  const t = Date.now();
  const res = await fetch(base, {
    method: "POST",
    headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
    body: JSON.stringify({ conversationId: CONV, messageType: "TEXT", content, clientId }),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => ({ status: 0, headers: new Headers(), json: async () => ({ error: String(e.name) }) }) as any);
  return { status: res.status, body: await res.json().catch(() => null), retryAfter: res.headers.get("retry-after"), ms: Date.now() - t };
}
async function noUnhandled<T>(fn: () => Promise<T>) {
  const seen: unknown[] = [];
  const h = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", h);
  try {
    const r = await fn();
    await new Promise((x) => setTimeout(x, 50));
    assert.deepEqual(seen, [], "no unhandled rejection");
    return r;
  } finally {
    process.off("unhandledRejection", h);
  }
}

test("1. Redis timeout (commands queued while reconnecting): 503 + Retry-After in bounded time, nothing persisted", { timeout: 20_000 }, async () => {
  await noUnhandled(async () => {
    mode = "hang";
    const r = await send("U_A", "c-1");
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.ok(r.retryAfter, "retryable");
    assert.ok(r.ms < 4000, `answered in ${r.ms} ms`);
    assert.equal(messages.length, 0);
    assert.ok(!JSON.stringify(r.body).includes("ECONN") && !JSON.stringify(r.body).includes("closed"), "no internal detail");
    mode = "reject";
    const r2 = await send("U_A", "c-2");
    assert.equal(r2.status, 503);
    assert.equal(messages.length, 0);
    // recovery: the same clientId goes through once Redis is back
    mode = "up";
    assert.equal((await send("U_A", "c-1")).status, 201);
    assert.equal(messages.length, 1);
  });
});

test("2. Redis disconnection with the real client: 503 while down, success after it comes back, duplicates still caught", { timeout: 30_000 }, async () => {
  const store = new Map<string, string>();
  const conns = new Set<net.Socket>();
  const parse = (buf: Buffer): [string[], Buffer] | null => {
    if (buf[0] !== 0x2a) return null;
    let nl = buf.indexOf("\r\n");
    if (nl < 0) return null;
    const n = Number(buf.subarray(1, nl).toString());
    let p = nl + 2;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const e = buf.indexOf("\r\n", p);
      if (e < 0) return null;
      const len = Number(buf.subarray(p + 1, e).toString());
      if (buf.length < e + 2 + len + 2) return null;
      out.push(buf.subarray(e + 2, e + 2 + len).toString());
      p = e + 2 + len + 2;
    }
    return [out, buf.subarray(p)];
  };
  const exec = ([c, ...a]: string[]) => {
    switch (c.toUpperCase()) {
      case "SET": {
        if (a.map((x) => x.toUpperCase()).includes("NX") && store.has(a[0])) return "$-1\r\n";
        store.set(a[0], a[1]);
        return "+OK\r\n";
      }
      case "INCR": {
        const n = Number(store.get(a[0]) ?? 0) + 1;
        store.set(a[0], String(n));
        return `:${n}\r\n`;
      }
      case "EXPIRE":
        return ":1\r\n";
      case "DEL":
        return `:${store.delete(a[0]) ? 1 : 0}\r\n`;
      case "EVAL": // only the release script: [script, numkeys, key, token]
        return `:${store.get(a[2]) === a[3] && store.delete(a[2]) ? 1 : 0}\r\n`;
      default:
        return "+OK\r\n";
    }
  };
  let srv!: net.Server;
  let port = 0;
  const start = () =>
    new Promise<void>((res) => {
      srv = net.createServer((s) => {
        conns.add(s);
        let buf = Buffer.alloc(0);
        s.on("close", () => conns.delete(s));
        s.on("error", () => {});
        s.on("data", (d) => {
          buf = Buffer.concat([buf, d]);
          let r;
          while ((r = parse(buf))) {
            buf = r[1];
            s.write(exec(r[0]));
          }
        });
      });
      srv.listen(port, "127.0.0.1", () => ((port = (srv.address() as net.AddressInfo).port), res()));
    });
  const stop = () => {
    conns.forEach((s) => s.destroy());
    return new Promise<void>((r) => srv.close(() => r()));
  };
  await start();
  const real = createClient({ socket: { host: "127.0.0.1", port, reconnectStrategy: () => 100 } });
  real.on("error", () => {});
  await real.connect();
  try {
    useRedis({ set: real.set.bind(real), incr: real.incr.bind(real), expire: real.expire.bind(real), del: real.del.bind(real), eval: real.eval.bind(real) });
    await noUnhandled(async () => {
      assert.equal((await send("U_A", "r-1")).status, 201);
      await stop();
      await new Promise((r) => setTimeout(r, 50));
      const down = await send("U_A", "r-2");
      assert.equal(down.status, 503, JSON.stringify(down.body));
      assert.ok(down.ms < 4000, `${down.ms} ms`);
      assert.equal(messages.length, 1);
      await start();
      const end = Date.now() + 5000;
      while (!real.isReady && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      assert.ok(real.isReady, "client reconnected");
      assert.equal((await send("U_A", "r-2")).status, 201, "the retried message goes through");
      const dup = await send("U_A", "r-2");
      assert.equal(dup.status, 400);
      assert.equal(dup.body.error, "Duplicate message");
      assert.equal(messages.length, 2);
    });
  } finally {
    real.destroy();
    if (srv.listening) await stop();
  }
});

test("3. duplicates: the same clientId is persisted once (also concurrently); another sender's identical clientId is independent", async () => {
  assert.equal((await send("U_A", "d-1")).status, 201);
  const again = await send("U_A", "d-1");
  assert.equal(again.status, 400);
  assert.equal(again.body.error, "Duplicate message");
  const burst = await Promise.all([1, 2, 3, 4, 5].map(() => send("U_A", "d-2")));
  assert.equal(burst.filter((r) => r.status === 201).length, 1, JSON.stringify(burst.map((r) => r.status)));
  assert.equal(messages.length, 2);
  assert.equal((await send("U_B", "d-1")).status, 201, "B's message isn't blocked by A's clientId");
  assert.equal(messages.length, 3);
});

test("4. the rate limit still applies (30 per minute per sender)", async () => {
  for (let i = 0; i < 30; i++) assert.equal((await send("U_A", `rl-${i}`)).status, 201, `message ${i}`);
  const over = await send("U_A", "rl-30");
  assert.equal(over.status, 400);
  assert.equal(over.body.error, "Rate limit exceeded");
  assert.equal(messages.length, 30);
  assert.equal((await send("U_B", "rl-b")).status, 201, "another sender has its own budget");
});

test("5. database failure: 5xx without internal detail, nothing persisted, and the retry with the same clientId succeeds", async () => {
  await noUnhandled(async () => {
    dbDown = true;
    const r = await send("U_A", "db-1");
    assert.ok(r.status >= 500, `status ${r.status}`);
    assert.ok(!JSON.stringify(r.body).includes("10.0.0.5"), "no database detail in the response");
    assert.equal(messages.length, 0);
    dbDown = false;
    const retry = await send("U_A", "db-1");
    assert.equal(retry.status, 201, `retry: ${JSON.stringify(retry.body)}`);
    assert.equal(messages.length, 1);
    assert.equal((await send("U_A", "db-1")).status, 400, "and only once");
  });
});

test("6. Phase 4 (documents existing behaviour): saved, then the conversation update fails → 500 without detail; a same-clientId retry is a duplicate, never a second save", async () => {
  await noUnhandled(async () => {
    txDown = true;
    const r = await send("U_A", "tx-1");
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes("10.0.0.5"));
    assert.equal(messages.length, 1, "the message row exists (no rollback of the create)");
    txDown = false;
    const retry = await send("U_A", "tx-1");
    assert.equal(retry.status, 400);
    assert.equal(retry.body.error, "Duplicate message");
    assert.equal(messages.length, 1, "not saved twice");
  });
});

test("7. Phase 4: a malformed body is still a 400 (validation), not a 500", async () => {
  const res = await fetch(base, {
    method: "POST",
    headers: { authorization: `Bearer ${tok("U_A")}`, "content-type": "application/json" },
    body: JSON.stringify({ conversationId: CONV, messageType: "TEXT", content: "hi" }), // no clientId
  });
  assert.equal(res.status, 400);
  assert.equal(messages.length, 0);
});
