// tests/session-replay.test.ts
//
// Visual session replay — contract, ingestion, playback authorization,
// deletion and retention. No database and no object storage: the two
// proposed tables are an in-memory fake implementing the Prisma operations
// the code uses, and chunks go to the in-memory blob store. Routes run on the
// real analytics router with the real authenticateUser / requirePermission
// (prisma.user / prisma.employee / prisma.vendor stubbed).
//   npx tsx --test tests/session-replay.test.ts   (ACCESS_TOKEN_SECRET set)

import { test, before, after } from "node:test";
import { deleteRecordings } from "../src/modules/analytics/session-replay.routes.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import express from "express";
import jwt from "jsonwebtoken";

const C = await import("../src/modules/analytics/session-replay.contract.ts");
const { journeyLabel } = await import("../src/modules/analytics/analytics.contract.ts");
const { memoryReplayStore, r2ReplayStore, localReplayStore, defaultReplayStore, chunkStorageKey } = await import("../src/modules/analytics/session-replay.store.ts");
const { purgeExpiredRecordings } = await import("../src/modules/analytics/session-replay.routes.ts");
const { createAnalyticsRouter } = await import("../src/modules/analytics/analytics.routes.ts");
const { prisma } = await import("../src/config/prisma.ts");

type Row = Record<string, any>;
const SECRET = process.env.ACCESS_TOKEN_SECRET ?? "";
const NOW = new Date("2026-10-21T08:00:00.000Z");

// ── in-memory session_recordings / session_recording_chunks ─────────────
function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(r[k]);
      if ("lt" in v) return r[k] < v.lt;
      if ("gt" in v) return r[k] > v.gt;
    }
    return (r[k] instanceof Date ? r[k].getTime() : r[k]) === (v instanceof Date ? v.getTime() : v);
  });
}
const pick = (r: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r });
function makeDb() {
  let n = 0;
  const recs: Row[] = [];
  const chunks: Row[] = [];
  const db = {
    recs,
    chunks,
    sessionRecording: {
      count: async ({ where }: Row) => recs.filter((r) => matches(r, where)).length,
      create: async ({ data, select }: Row) => {
        const r = { id: `rec${String(++n).padStart(10, "0")}`, chunkCount: 0, eventCount: 0, bytes: 0, pageCount: 0, stopReason: null, firstEventAt: null, lastEventAt: null, ...data };
        recs.push(r);
        return pick(r, select);
      },
      findUnique: async ({ where, select }: Row) => {
        const r = recs.find((x) => x.id === where.id);
        return r ? pick(r, select) : null;
      },
      findMany: async ({ where, orderBy, skip = 0, take = 1e9, select }: Row) =>
        recs
          .filter((r) => matches(r, where))
          .sort((a, b) => (orderBy?.startedAt === "desc" ? b.startedAt - a.startedAt : 0))
          .slice(skip, skip + take)
          .map((r) => pick(r, select)),
      update: async ({ where, data }: Row) => {
        const r = recs.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === "object" && "increment" in (v as Row) ? r[k] + (v as Row).increment : v;
        return r;
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = recs.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      deleteMany: async ({ where }: Row) => {
        const before = recs.length;
        for (let i = recs.length - 1; i >= 0; i--) if (matches(recs[i], where)) recs.splice(i, 1);
        return { count: before - recs.length };
      },
    },
    sessionRecordingChunk: {
      findUnique: async ({ where, select }: Row) => {
        const c = chunks.find((x) => x.recordingId === where.recordingId_seq.recordingId && x.seq === where.recordingId_seq.seq);
        return c ? pick(c, select) : null;
      },
      create: async ({ data }: Row) => {
        if (chunks.some((c) => c.recordingId === data.recordingId && c.seq === data.seq)) throw Object.assign(new Error("dup"), { code: "P2002" });
        chunks.push({ id: `ch${chunks.length}`, ...data });
        return data;
      },
      findMany: async ({ where, select }: Row) => chunks.filter((c) => matches(c, where)).sort((a, b) => a.seq - b.seq).map((c) => pick(c, select)),
      deleteMany: async ({ where }: Row) => {
        const before = chunks.length;
        for (let i = chunks.length - 1; i >= 0; i--) if (matches(chunks[i], where)) chunks.splice(i, 1);
        return { count: before - chunks.length };
      },
    },
  };
  return db;
}

// rrweb-shaped synthetic events
const meta = (href: string, ts: number) => ({ type: 4, data: { href, width: 1280, height: 800 }, timestamp: ts });
const full = (ts: number) => ({ type: 2, data: { node: { type: 0, childNodes: [], id: 1 }, initialOffset: { top: 0, left: 0 } }, timestamp: ts });
const mutation = (ts: number) => ({ type: 3, data: { source: 0, adds: [], removes: [], texts: [{ id: 5, value: "*** ***" }], attributes: [] }, timestamp: ts });
const click = (ts: number) => ({ type: 3, data: { source: 2, type: 2, id: 9, x: 120, y: 340 }, timestamp: ts });
const scroll = (ts: number) => ({ type: 3, data: { source: 3, id: 1, x: 0, y: 900 }, timestamp: ts });
const T0 = NOW.getTime();

// ── 1. contract ─────────────────────────────────────────────────────────
test("contract: mode is off unless explicitly 'synthetic'; there is no 'on' mode", () => {
  assert.equal(C.replayMode(undefined), "off");
  assert.equal(C.replayMode("on"), "off");
  assert.equal(C.replayMode("true"), "off");
  assert.equal(C.replayMode(" Synthetic "), "synthetic");
});

test("contract: checkout, payment, auth, account, tracking, dashboards and chat are excluded; unknown paths count as excluded", () => {
  for (const p of ["/checkout", "/checkout?x=1", "/payment/success", "/payment-option", "/login", "/register", "/reset-password/abc", "/user-dashboard/orders", "/vendor-dashboard", "/admin-dashboard/x", "/track/123", "/chat", "/hrm", "https://finixmart.com.bd/CHECKOUT"]) {
    assert.ok(C.isExcludedPath(p), p);
  }
  for (const p of ["/", "/products/abc", "/category/shoes", "/cart", "/store/x", "/checkoutx", "/campaign/eid"]) assert.ok(!C.isExcludedPath(p), p);
  assert.ok(C.isExcludedPath(undefined));
  assert.equal(C.safeEntryPath("/products/a?email=x@y.z#h"), "/products/a", "query strings are never stored");
});

test("contract: retention days are bounded (1–90, default 14); upload tokens compare by hash in constant time", () => {
  assert.equal(C.replayRetentionDays(undefined), 14);
  assert.equal(C.replayRetentionDays("0"), 14);
  assert.equal(C.replayRetentionDays("365"), 14);
  assert.equal(C.replayRetentionDays("30"), 30);
  const t = C.newUploadToken();
  const h = C.hashUploadToken(t);
  assert.ok(!h.includes(t));
  assert.ok(C.tokenMatches(t, h));
  assert.ok(!C.tokenMatches(t + "x", h));
  assert.ok(!C.tokenMatches(undefined, h));
  assert.ok(!C.tokenMatches(t, "zz"));
});

test("contract: chunk validation counts pages / snapshots and refuses excluded pages, bad events and oversize batches", () => {
  const w = { notBefore: T0 - 1000, notAfter: T0 + 60_000 };
  const s = C.validateChunk([meta("http://localhost:3000/products/a", T0), full(T0 + 1), click(T0 + 500), meta("http://localhost:3000/category/b", T0 + 900), full(T0 + 901), scroll(T0 + 1200)], w);
  assert.deepEqual({ ...s, firstEventAt: s.firstEventAt.getTime(), lastEventAt: s.lastEventAt.getTime() }, { eventCount: 6, pages: 2, fullSnapshots: 2, firstEventAt: T0, lastEventAt: T0 + 1200 });
  const code = (f: () => unknown) => {
    try {
      f();
      return "ok";
    } catch (e: any) {
      return e.code;
    }
  };
  assert.equal(code(() => C.validateChunk([meta("http://localhost:3000/checkout", T0)], w)), "EXCLUDED_PAGE");
  assert.equal(code(() => C.validateChunk([], w)), "INVALID_CHUNK");
  assert.equal(code(() => C.validateChunk({}, w)), "INVALID_CHUNK");
  assert.equal(code(() => C.validateChunk([{ type: 9, timestamp: T0 }], w)), "INVALID_CHUNK");
  assert.equal(code(() => C.validateChunk([{ type: 3, timestamp: T0 + 3_600_000 }], w)), "INVALID_CHUNK", "timestamps far in the future");
  assert.equal(code(() => C.validateChunk(Array.from({ length: 5 }, (_, i) => full(T0 + i)), w)), "CHUNK_TOO_LARGE");
  assert.equal(code(() => C.validateChunk(Array.from({ length: 5001 }, (_, i) => scroll(T0 + (i % 1000))), w)), "CHUNK_TOO_LARGE");
});

test("store: without a dedicated private bucket there is no store (never the public media bucket)", () => {
  const saved = process.env.SESSION_REPLAY_R2_BUCKET;
  delete process.env.SESSION_REPLAY_R2_BUCKET;
  process.env.R2_BUCKET_NAME ??= "public-media";
  assert.equal(r2ReplayStore(), null);
  assert.equal(r2ReplayStore("  "), null);
  assert.ok(r2ReplayStore("private-replays"));
  if (saved !== undefined) process.env.SESSION_REPLAY_R2_BUCKET = saved;
});

// ── 2. routes ───────────────────────────────────────────────────────────
const USERS: Record<string, Row> = {
  U_CUST: { id: "U_CUST", role: "CUSTOMER", isActive: true, vendorId: null, name: "C", email: null },
  U_VA: { id: "U_VA", role: "VENDOR", isActive: true, vendorId: "VA", name: "A", email: null },
  U_VSTAFF: { id: "U_VSTAFF", role: "EMPLOYEE", isActive: true, vendorId: null, name: "Staff", email: null },
  U_AEMP: { id: "U_AEMP", role: "EMPLOYEE", isActive: true, vendorId: null, name: "Analyst", email: null },
  U_AEMP_NOPERM: { id: "U_AEMP_NOPERM", role: "EMPLOYEE", isActive: true, vendorId: null, name: "Clerk", email: null },
  U_ADMIN: { id: "U_ADMIN", role: "ADMIN", isActive: true, vendorId: null, name: "Admin", email: null },
};
const EMPLOYEES: Record<string, Row> = {
  E_VSTAFF: { id: "E_VSTAFF", userId: "U_VSTAFF", vendorId: "VA", isActive: true, permissions: { analytics: true } },
  E_AEMP: { id: "E_AEMP", userId: "U_AEMP", vendorId: null, isActive: true, permissions: { analytics: true } },
  E_AEMP_NOPERM: { id: "E_AEMP_NOPERM", userId: "U_AEMP_NOPERM", vendorId: null, isActive: true, permissions: {} },
  E_ADMIN: { id: "E_ADMIN", userId: "U_ADMIN", vendorId: null, isActive: true, permissions: {} },
};
const restores: (() => void)[] = [];
const swap = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
let server: http.Server;
let base = "";
let mode: "off" | "synthetic" = "synthetic";
let clock = NOW;
const db = makeDb();
const store = memoryReplayStore();
before(async () => {
  swap(prisma.user, "findUnique", async ({ where }: Row) => (USERS[where.id] ? { ...USERS[where.id] } : null));
  swap(prisma.vendor, "findUnique", async ({ where }: Row) => (where.id === "VA" ? { id: "VA", storeName: "A", email: null } : null));
  swap(prisma.employee, "findFirst", async ({ where }: Row) => Object.values(EMPLOYEES).find((e) => e.userId === where.userId && e.isActive) ?? null);
  swap(prisma.employee, "findUnique", async ({ where }: Row) => EMPLOYEES[where.id] ?? null);
  swap(prisma.employee, "create", async () => EMPLOYEES.E_ADMIN);
  const app = express();
  app.use(express.json());
  app.use(
    "/api/analytics",
    createAnalyticsRouter({
      db: { product: {}, vendor: {} } as any,
      recorder: {} as any,
      advisor: {} as any,
      replay: { db, store, mode: () => mode, now: () => clock, ingestLimit: 1000 },
    })
  );
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/analytics`;
});
after(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  restores.reverse().forEach((r) => r());
});
const tok = (id: string) => jwt.sign({ id, role: USERS[id].role }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
const SESSION = "session-replay-abcdef0123";
const BROWSER = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0", "x-fm-analytics-visitor": "visitor-replay-0123456789", "x-fm-analytics-session": SESSION };
async function start(body: unknown = { synthetic: true, path: "/products/p1" }, headers: Row = {}) {
  const res = await fetch(`${base}/replay/start`, { method: "POST", headers: { ...BROWSER, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}
async function upload(id: string, token: string, seq: number, events: unknown, headers: Row = {}, raw?: Buffer) {
  const res = await fetch(`${base}/replay/${id}/chunks?seq=${seq}`, {
    method: "POST",
    headers: { ...BROWSER, "content-type": "application/octet-stream", "x-fm-replay-token": token, ...headers },
    body: raw ?? gzipSync(Buffer.from(JSON.stringify(events))),
  });
  return { status: res.status, body: (await res.json()) as any };
}
async function admin(who: string | null, path: string, method = "GET") {
  const res = await fetch(`${base}/business-advisor/recordings${path}`, { method, headers: who ? { authorization: `Bearer ${tok(who)}` } : {} });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, body: type.includes("json") ? ((await res.json()) as any) : Buffer.from(await res.arrayBuffer()) };
}

test("ingestion: disabled by default, for bots, without a journey id, for staff, and on excluded pages — nothing is stored", { skip: !SECRET }, async () => {
  mode = "off";
  assert.deepEqual((await start()).body, { success: true, enabled: false });
  mode = "synthetic";
  assert.equal((await start({ path: "/products/p1" })).status, 400, "synthetic flag required");
  assert.equal((await start({ synthetic: true, path: "/x", vendorId: "VA" })).status, 400, "strict body — no client ownership ids");
  assert.equal((await start(undefined, { "user-agent": "curl/8.0" })).body.enabled, false);
  assert.equal((await start(undefined, { "x-fm-analytics-session": "" })).body.enabled, false, "no analytics session → no link → no recording");
  assert.equal((await start(undefined, { authorization: `Bearer ${tok("U_VA")}` })).body.enabled, false, "staff are never recorded");
  assert.equal((await start(undefined, { authorization: `Bearer ${tok("U_ADMIN")}` })).body.enabled, false);
  const ex = await start({ synthetic: true, path: "/checkout" });
  assert.deepEqual(ex.body, { success: true, enabled: false, reason: "excluded_page" });
  assert.equal(db.recs.length, 0);
});

test("ingestion: a synthetic session across pages — chunks are validated, stored compressed and linked to the analytics journey", { skip: !SECRET }, async () => {
  const s = await start();
  assert.equal(s.status, 201);
  assert.equal(s.body.enabled, true);
  const { recordingId: id, token } = s.body;
  const rec = db.recs.find((r) => r.id === id)!;
  assert.equal(rec.sessionKey, `s:${SESSION}`);
  assert.equal(rec.journeyLabel, journeyLabel(`s:${SESSION}`), "same J- label Business Advisor shows for the journey");
  assert.ok(!JSON.stringify(rec).includes(token), "only the token hash is stored");
  assert.equal(rec.expiresAt.getTime(), NOW.getTime() + 14 * 86_400_000);
  assert.equal(rec.entryPath, "/products/p1");

  const c0 = [meta("http://localhost:3000/products/p1", T0), full(T0 + 5), mutation(T0 + 300), click(T0 + 800), scroll(T0 + 900)];
  assert.equal((await upload(id, token, 0, c0)).status, 202);
  const c1 = [meta("http://localhost:3000/category/shoes", T0 + 5000), full(T0 + 5001), scroll(T0 + 6000), click(T0 + 7000)];
  assert.equal((await upload(id, token, 1, c1)).status, 202);
  assert.deepEqual((await upload(id, token, 1, c1)).body, { success: true, duplicate: true }, "a retried upload is idempotent");
  assert.equal(rec.chunkCount, 2);
  assert.equal(rec.eventCount, 9);
  assert.equal(rec.pageCount, 2);
  assert.equal(rec.firstEventAt.getTime(), T0);
  assert.equal(rec.lastEventAt.getTime(), T0 + 7000);
  assert.equal(store.blobs.size, 2);

  // excluded page inside a chunk → refused, recording continues
  const bad = await upload(id, token, 2, [meta("http://localhost:3000/payment/success", T0 + 8000), full(T0 + 8001)]);
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, "EXCLUDED_PAGE");
  assert.equal(rec.chunkCount, 2);
  assert.equal(rec.status, "RECORDING");

  // finish
  const fin = await fetch(`${base}/replay/${id}/finish`, { method: "POST", headers: { ...BROWSER, "x-fm-replay-token": token } });
  assert.equal(fin.status, 200);
  assert.equal(rec.status, "COMPLETE");
  assert.equal((await upload(id, token, 3, [scroll(T0 + 9000)])).status, 409, "no uploads after finish");
});

test("ingestion: ownership — wrong token, another journey, unknown id; malformed, oversize and zip-bomb chunks are refused", { skip: !SECRET }, async () => {
  const { recordingId: id, token } = (await start()).body;
  const ev = [scroll(T0 + 10)];
  const wrong = await upload(id, "x".repeat(32), 0, ev);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.stop, true);
  const other = await upload(id, token, 0, ev, { "x-fm-analytics-session": "another-session-0123456789" });
  assert.equal(other.status, 409);
  assert.equal(other.body.restart, true, "journey rotated → the browser starts a new recording");
  assert.equal((await upload("recXXXXXXXXXX", token, 0, ev)).status, 404);
  assert.equal((await upload(id, token, -1, ev)).status, 400);
  assert.equal((await upload(id, token, 0, null, {}, Buffer.from("not gzip"))).status, 400);
  assert.equal((await upload(id, token, 0, null, {}, gzipSync(Buffer.from("{not json")))).status, 400);
  const tooBig = await upload(id, token, 0, null, {}, Buffer.alloc(C.REPLAY_LIMITS.maxChunkBytes + 1, 1));
  assert.equal(tooBig.status, 413);
  // 10 MB of zeros compresses to ~10 KB — refused at decompression, not after
  const bomb = await upload(id, token, 0, null, {}, gzipSync(Buffer.alloc(10 * 1024 * 1024, 0x20)));
  assert.equal(bomb.status, 413);
  assert.equal(bomb.body.code, "CHUNK_TOO_LARGE");
  assert.equal(db.recs.find((r) => r.id === id)!.chunkCount, 0);
});

test("ingestion: limits stop a recording (bytes / duration) and cap recordings per journey; turning replay off stops uploads", { skip: !SECRET }, async () => {
  const { recordingId: id, token } = (await start()).body;
  const rec = db.recs.find((r) => r.id === id)!;
  rec.bytes = C.REPLAY_LIMITS.maxBytesPerRecording;
  const r1 = await upload(id, token, 0, [scroll(T0 + 1)]);
  assert.equal(r1.status, 409);
  assert.equal(r1.body.reason, "max_bytes");
  assert.equal(rec.status, "STOPPED");

  const b = (await start()).body;
  clock = new Date(NOW.getTime() + C.REPLAY_LIMITS.maxDurationMs + 1000);
  const r2 = await upload(b.recordingId, b.token, 0, [scroll(clock.getTime())]);
  assert.equal(r2.body.reason, "max_duration");
  clock = NOW;

  while (db.recs.filter((r) => r.sessionKey === `s:${SESSION}`).length < C.REPLAY_LIMITS.maxRecordingsPerSession) await start();
  assert.deepEqual((await start()).body, { success: true, enabled: false, reason: "limit" });

  const fresh = (await start(undefined, { "x-fm-analytics-session": "fresh-session-0123456789" })).body;
  mode = "off";
  const off = await upload(fresh.recordingId, fresh.token, 0, [scroll(T0 + 1)]);
  assert.equal(off.status, 409);
  assert.equal(off.body.stop, true);
  mode = "synthetic";
});

test("playback: administrators only — vendors, vendor staff, customers, staff without the analytics grant and anonymous are refused", { skip: !SECRET }, async () => {
  assert.equal((await admin(null, "")).status, 401);
  assert.equal((await admin("U_CUST", "")).status, 403);
  assert.equal((await admin("U_VA", "")).status, 403, "vendors never see recordings");
  assert.equal((await admin("U_VSTAFF", "")).status, 403, "vendor-side employees never see recordings");
  assert.equal((await admin("U_AEMP_NOPERM", "")).status, 403);
  assert.equal((await admin("U_AEMP", "")).status, 200, "admin-side employee with the analytics grant");
  const list = await admin("U_ADMIN", "");
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "private, no-store");
  assert.ok(list.body.data.items.length >= 1);
  assert.ok(list.body.data.items.every((r: any) => r.chunkCount > 0), "empty recordings aren't listed");
  const text = JSON.stringify(list.body);
  for (const secret of ["sessionKey", "actorKey", "uploadTokenHash", "storageKey", SESSION]) assert.ok(!text.includes(secret), `no ${secret} in the response`);
});

test("playback: list by journey, recording detail, chunk bytes as uploaded; invalid ids and journeys", { skip: !SECRET }, async () => {
  const label = journeyLabel(`s:${SESSION}`);
  const byJourney = await admin("U_ADMIN", `?journey=${label.toLowerCase()}`);
  assert.equal(byJourney.status, 200);
  const item = byJourney.body.data.items.find((r: any) => r.chunkCount === 2)!;
  assert.equal(item.journeyId, label);
  assert.equal(item.durationMs, 7000);
  assert.equal(item.pageCount, 2);
  assert.equal(item.synthetic, true);
  assert.equal((await admin("U_ADMIN", "?journey=J-NOPE")).status, 400);
  assert.equal((await admin("U_ADMIN", "?journey=J-00000000")).body.data.total, 0);

  const detail = await admin("U_ADMIN", `/${item.id}`);
  assert.deepEqual(detail.body.data.chunks.map((c: any) => c.seq), [0, 1]);
  const chunk = await admin("U_ADMIN", `/${item.id}/chunks/0`);
  assert.equal(chunk.status, 200);
  assert.equal(chunk.headers.get("content-type"), "application/octet-stream");
  assert.equal(chunk.headers.get("x-content-type-options"), "nosniff");
  const { gunzipSync } = await import("node:zlib");
  const events = JSON.parse(gunzipSync(chunk.body as Buffer).toString("utf8"));
  assert.equal(events[0].data.href, "http://localhost:3000/products/p1");
  assert.equal((await admin("U_ADMIN", `/${item.id}/chunks/7`)).status, 404);
  assert.equal((await admin("U_ADMIN", `/bad id`)).status, 404);
  assert.equal((await admin("U_VA", `/${item.id}/chunks/0`)).status, 403);
});

test("deletion: admin delete removes objects then rows; vendors can't delete", { skip: !SECRET }, async () => {
  const s = (await start(undefined, { "x-fm-analytics-session": "delete-session-0123456789" })).body;
  await upload(s.recordingId, s.token, 0, [meta("http://localhost:3000/", T0), full(T0 + 1)], { "x-fm-analytics-session": "delete-session-0123456789" });
  const keys = db.chunks.filter((c) => c.recordingId === s.recordingId).map((c) => c.storageKey);
  assert.equal(keys.length, 1);
  assert.equal((await admin("U_VA", `/${s.recordingId}`, "DELETE")).status, 403);
  const del = await admin("U_ADMIN", `/${s.recordingId}`, "DELETE");
  assert.equal(del.status, 200);
  assert.ok(!store.blobs.has(keys[0]));
  assert.ok(!db.recs.some((r) => r.id === s.recordingId));
  assert.ok(!db.chunks.some((c) => c.recordingId === s.recordingId));
  assert.equal((await admin("U_ADMIN", `/${s.recordingId}`, "DELETE")).status, 404);
});

test("not ready: before the migration (no delegates) or without a private bucket, ingestion is off and playback answers 503", { skip: !SECRET }, async () => {
  const app = express();
  app.use(express.json());
  app.use("/a", createAnalyticsRouter({ db: { product: {}, vendor: {} } as any, recorder: {} as any, advisor: {} as any, replay: { db: {}, store, mode: () => "synthetic" } }));
  app.use("/b", createAnalyticsRouter({ db: { product: {}, vendor: {} } as any, recorder: {} as any, advisor: {} as any, replay: { db, store: null, mode: () => "synthetic" } }));
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    for (const p of ["/a", "/b"]) {
      const s = await fetch(`${url}${p}/replay/start`, { method: "POST", headers: { ...BROWSER, "content-type": "application/json" }, body: JSON.stringify({ synthetic: true, path: "/" }) });
      assert.deepEqual(await s.json(), { success: true, enabled: false, reason: "not_ready" });
      const l = await fetch(`${url}${p}/business-advisor/recordings`, { headers: { authorization: `Bearer ${tok("U_ADMIN")}` } });
      assert.equal(l.status, 503);
      assert.equal(((await l.json()) as any).code, "REPLAY_NOT_READY");
    }
  } finally {
    await new Promise((r) => srv.close(() => r(undefined)));
  }
});

test("retention: expired recordings are deleted (objects + rows); abandoned uploads are closed; a no-op before the migration", async () => {
  const d = makeDb();
  const st = memoryReplayStore();
  const old = await d.sessionRecording.create({ data: { sessionKey: "s:a", status: "COMPLETE", startedAt: new Date(T0 - 20 * 86_400_000), expiresAt: new Date(T0 - 1) } });
  const live = await d.sessionRecording.create({ data: { sessionKey: "s:b", status: "COMPLETE", startedAt: new Date(T0 - 86_400_000), expiresAt: new Date(T0 + 86_400_000) } });
  const stale = await d.sessionRecording.create({ data: { sessionKey: "s:c", status: "RECORDING", startedAt: new Date(T0 - 5 * 3_600_000), expiresAt: new Date(T0 + 86_400_000) } });
  await st.put("k-old", Buffer.from("x"));
  await st.put("k-live", Buffer.from("y"));
  await d.sessionRecordingChunk.create({ data: { recordingId: old.id, seq: 0, storageKey: "k-old" } });
  await d.sessionRecordingChunk.create({ data: { recordingId: live.id, seq: 0, storageKey: "k-live" } });
  const r = await purgeExpiredRecordings(d as any, st, NOW);
  assert.deepEqual(r, { removed: 1, closed: 1 });
  assert.deepEqual(d.recs.map((x) => x.id), [live.id, stale.id]);
  assert.deepEqual([...st.blobs.keys()], ["k-live"]);
  assert.equal(d.recs.find((x) => x.id === stale.id)!.status, "COMPLETE");
  assert.deepEqual(await purgeExpiredRecordings({} as any, st, NOW), { removed: 0, closed: 0 });
  assert.deepEqual(await purgeExpiredRecordings(d as any, null, NOW), { removed: 0, closed: 0 });
  const missing = { sessionRecording: { findMany: async () => Promise.reject(Object.assign(new Error("no table"), { code: "P2021" })) }, sessionRecordingChunk: {} };
  assert.deepEqual(await purgeExpiredRecordings(missing as any, st, NOW), { removed: 0, closed: 0 });
});

test("high volume: a 1,000-chunk synthetic session is capped at the per-recording chunk limit", { skip: !SECRET }, async () => {
  const sess = "volume-session-0123456789";
  const { recordingId: id, token } = (await start(undefined, { "x-fm-analytics-session": sess })).body;
  const rec = db.recs.find((r) => r.id === id)!;
  rec.chunkCount = C.REPLAY_LIMITS.maxChunksPerRecording - 1;
  assert.equal((await upload(id, token, 0, [scroll(T0 + 1)], { "x-fm-analytics-session": sess })).status, 202);
  const over = await upload(id, token, 1, [scroll(T0 + 2)], { "x-fm-analytics-session": sess });
  assert.equal(over.status, 409);
  assert.equal(over.body.reason, "max_chunks");
  assert.equal((await upload(id, token, C.REPLAY_LIMITS.maxChunksPerRecording, [scroll(T0 + 3)], { "x-fm-analytics-session": sess })).status, 409);
});

test("deletion: a failed object delete aborts before rows are removed, and a retry finishes the job", async () => {
  const d = makeDb();
  const inner = memoryReplayStore();
  const rec = await d.sessionRecording.create({ data: { sessionKey: "s:fail-del", status: "COMPLETE", startedAt: new Date(T0), expiresAt: new Date(T0 + 86_400_000) } });
  await d.sessionRecordingChunk.create({ data: { recordingId: rec.id, seq: 0, storageKey: "k-fail", bytes: 4, eventCount: 2, firstEventAt: new Date(T0), lastEventAt: new Date(T0 + 1) } });
  await inner.put("k-fail", Buffer.from("abcd"));
  let failing = true;
  const flaky = { ...inner, async delete(keys: string[]) { if (failing) throw new Error("replay delete: 1 object(s) not removed"); return inner.delete(keys); } };

  await assert.rejects(() => deleteRecordings(d as any, flaky as any, [rec.id]), /not removed/);
  assert.ok(d.recs.some((r: any) => r.id === rec.id), "recording row must survive a storage failure");
  assert.ok(d.chunks.some((c: any) => c.recordingId === rec.id), "chunk rows must survive a storage failure");
  assert.ok(inner.blobs.has("k-fail"), "the object is still present so the retry can address it");

  failing = false;
  assert.equal(await deleteRecordings(d as any, flaky as any, [rec.id]), 1);
  assert.ok(!inner.blobs.has("k-fail"), "retry removes the object");
  assert.ok(!d.recs.some((r: any) => r.id === rec.id), "retry removes the recording row");
  assert.ok(!d.chunks.some((c: any) => c.recordingId === rec.id), "retry removes the chunk rows");
  assert.equal(await deleteRecordings(d as any, flaky as any, [rec.id]), 0, "deleting again is a no-op");
});

test("store: delete() throws when R2 reports failed keys, resolves on success, and batches by 1,000", async () => {
  const batches: number[] = [];
  const client = (resp: any) => ({
    async send(cmd: any) {
      batches.push(cmd.input.Delete.Objects.length);
      return resp;
    },
  });

  const failing = r2ReplayStore("replay-bucket", () => client({ Errors: [{ Key: "session-replay/a/00000-x.json.gz", Code: "InternalError" }] }) as any);
  assert.ok(failing, "a bucket name yields a store");
  await assert.rejects(() => failing!.delete(["k1"]), /1 object\(s\) not removed/);

  const ok = r2ReplayStore("replay-bucket", () => client({ Deleted: [{ Key: "k1" }] }) as any);
  await ok!.delete(["k1"]);

  const emptyish = r2ReplayStore("replay-bucket", () => client({}) as any);
  await emptyish!.delete(["k1"]);

  assert.equal(r2ReplayStore("", () => client({}) as any), null, "no bucket means no store, even with a client");

  const many = Array.from({ length: 2500 }, (_, i) => `k${i}`);
  await emptyish!.delete(many);
  assert.deepEqual(batches.slice(-3), [1000, 1000, 500], "keys are deleted in 1,000-key batches");
  assert.equal(await (r2ReplayStore("replay-bucket", () => client({}) as any))!.delete([]) === undefined, true, "empty key list is a no-op");
});

test("fail closed: a signed-in customer is never recorded — start is refused, and uploads from a signed-in session stop", { skip: !SECRET }, async () => {
  const sess = "signedin-session-0123456789";
  const refused = await start(undefined, { "x-fm-analytics-session": sess, authorization: `Bearer ${tok("U_CUST")}` });
  assert.deepEqual(refused.body, { success: true, enabled: false, reason: "signed_in" });
  assert.equal(db.recs.filter((r) => r.sessionKey === `s:${sess}`).length, 0, "nothing stored");
  // a recording started anonymously, then the shopper signs in → the next upload is refused and nothing is stored
  const { recordingId: id, token } = (await start(undefined, { "x-fm-analytics-session": sess })).body;
  const up = await upload(id, token, 0, [scroll(T0 + 1)], { "x-fm-analytics-session": sess, authorization: `Bearer ${tok("U_CUST")}` });
  assert.equal(up.status, 409);
  assert.equal(up.body.stop, true);
  assert.equal(up.body.reason, "signed_in");
  assert.equal(db.recs.find((r) => r.id === id)!.chunkCount, 0);
  // the same browser, signed out again, can upload
  assert.equal((await upload(id, token, 0, [scroll(T0 + 2)], { "x-fm-analytics-session": sess })).status, 202);
});

test("local store (dev-only synthetic runs): round-trips chunks on disk; refused in production, for relative / empty paths and for keys outside the format", async () => {
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fm-replay-local-"));
  try {
    assert.equal(localReplayStore(dir, "production"), null, "never in production");
    assert.equal(localReplayStore("relative/dir", "development"), null);
    assert.equal(localReplayStore("", "development"), null);
    assert.equal(localReplayStore(undefined, "development"), null);
    const st = localReplayStore(dir, "development")!;
    const key = chunkStorageKey("rec0000000001", 3);
    await st.put(key, Buffer.from("gzip-bytes"));
    assert.ok(existsSync(join(dir, ...key.split("/"))), "written under the configured directory");
    assert.equal((await st.get(key))!.toString(), "gzip-bytes");
    assert.equal(await st.get(chunkStorageKey("rec0000000001", 4)), null, "missing chunk → null");
    for (const bad of ["../../etc/passwd", "session-replay/../../x/00001-0123456789abcdef.json.gz", "session-replay/rec/1-x.json.gz", "/abs/key"]) {
      await assert.rejects(st.put(bad, Buffer.from("x")), /invalid replay key/, bad);
    }
    await st.delete([key, chunkStorageKey("rec0000000001", 9)]);
    assert.equal(await st.get(key), null, "deleted; deleting a missing key is not an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store selection: the private R2 bucket wins; the local store is only a dev fallback; nothing configured → no store (replay unavailable)", () => {
  const saved = { b: process.env.SESSION_REPLAY_R2_BUCKET, d: process.env.SESSION_REPLAY_LOCAL_DIR, e: process.env.NODE_ENV };
  const restore = () => {
    for (const [k, v] of [["SESSION_REPLAY_R2_BUCKET", saved.b], ["SESSION_REPLAY_LOCAL_DIR", saved.d], ["NODE_ENV", saved.e]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    delete process.env.SESSION_REPLAY_R2_BUCKET;
    delete process.env.SESSION_REPLAY_LOCAL_DIR;
    assert.equal(defaultReplayStore(), null);
    process.env.SESSION_REPLAY_LOCAL_DIR = process.platform === "win32" ? "C:/replay-test" : "/tmp/replay-test";
    process.env.NODE_ENV = "development";
    assert.ok(defaultReplayStore(), "local fallback in development");
    process.env.NODE_ENV = "production";
    assert.equal(defaultReplayStore(), null, "never the local store in production");
    process.env.SESSION_REPLAY_R2_BUCKET = "private-replays";
    assert.ok(defaultReplayStore(), "R2 when the private bucket is configured");
  } finally {
    restore();
  }
});

test("schema ↔ migration: every SessionRecording / SessionRecordingChunk field has its column; unique (recordingId, seq), indexes and the cascading FK match", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const dir = readdirSync(new URL("../prisma/migrations/", import.meta.url)).filter((d) => d.endsWith("_session_replay_recordings"));
  assert.deepEqual(dir, ["20261021150000_session_replay_recordings"], "exactly one replay migration");
  const sql = readFileSync(new URL(`../prisma/migrations/${dir[0]}/migration.sql`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const proposed = readFileSync(new URL(`../prisma/proposed/${dir[0]}/migration.sql`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(sql, proposed, "the committed migration is the reviewed proposal, unchanged");
  const model = (name: string) => {
    const body = new RegExp(`^model ${name} \\{\\n([\\s\\S]*?)\\n\\}`, "m").exec(schema)?.[1] ?? "";
    return body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
      .map((l) => l.split(/\s+/))
      .filter(([, type]) => /^(String|Int|Boolean|DateTime)\??$/.test(type))
      .map(([field]) => field);
  };
  const table = (name: string) => new RegExp(`CREATE TABLE IF NOT EXISTS "public"\\."${name}" \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1] ?? "";
  for (const [m, t] of [["SessionRecording", "session_recordings"], ["SessionRecordingChunk", "session_recording_chunks"]] as const) {
    const fields = model(m);
    assert.ok(fields.length >= 9, `${m} parsed`);
    const cols = [...table(t).matchAll(/^\s+"(\w+)"/gm)].map((x) => x[1]);
    assert.deepEqual([...cols].sort(), [...fields].sort(), `${m} fields == ${t} columns`);
    assert.ok(schema.includes(`@@map("${t}")`));
  }
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "session_recording_chunks_recordingId_seq_key" ON "public"\."session_recording_chunks"\("recordingId", "seq"\)/);
  assert.match(sql, /FOREIGN KEY \("recordingId"\) REFERENCES "public"\."session_recordings"\("id"\) ON DELETE CASCADE/);
  for (const idx of ["journeyLabel_startedAt", "sessionKey", "startedAt", "expiresAt", "status_startedAt"]) assert.ok(sql.includes(`"session_recordings_${idx}_idx"`), idx);
  assert.ok(!/^\s*DROP\b/im.test(sql), "additive only — nothing is dropped (DROP appears only in the rollback comment)");
  // idempotent: every CREATE is guarded and the FK is only added when missing
  assert.equal((sql.match(/^CREATE (UNIQUE )?(TABLE|INDEX) (?!IF NOT EXISTS)/gm) ?? []).length, 0, "every CREATE uses IF NOT EXISTS");
  assert.match(sql, /DO \$\$\nBEGIN\n  IF NOT EXISTS \([\s\S]*conname = 'session_recording_chunks_recordingId_fkey'[\s\S]*END IF;\nEND \$\$;/, "FK guarded by a NOT EXISTS check");
  assert.ok(!/^\s*(UPDATE|DELETE|INSERT|TRUNCATE)\b/im.test(sql), "no data statements");
  assert.deepEqual([...sql.matchAll(/ALTER TABLE "public"\."(\w+)"/g)].map((x) => x[1]), ["session_recording_chunks"], "no existing table is altered");
});

test("synthetic test accounts: only listed @test.invalid emails, never in production, no look-alike domains", () => {
  const list = "shopper1@test.invalid, Shopper2@Test.Invalid";
  assert.equal(C.isSyntheticTestAccount("shopper1@test.invalid", list, "development"), true);
  assert.equal(C.isSyntheticTestAccount("SHOPPER2@test.invalid", list, "development"), true, "case-insensitive");
  assert.equal(C.isSyntheticTestAccount("shopper1@test.invalid", list, "production"), false, "never in production");
  assert.equal(C.isSyntheticTestAccount("shopper3@test.invalid", list, "development"), false, "not listed");
  for (const look of ["shopper1@testXinvalid", "shopper1@test.invalid.evil.com", "shopper1@gmail.com", "shopper1@test.invalid ", "", null, undefined]) {
    assert.equal(C.isSyntheticTestAccount(look, list + ",shopper1@gmail.com,shopper1@test.invalid.evil.com", "development"), look === "shopper1@test.invalid " ? true : false, String(look));
  }
  assert.equal(C.isSyntheticTestAccount("shopper1@test.invalid", "", "development"), false, "empty allowlist → nobody");
  assert.equal(C.isSyntheticTestAccount("shopper1@test.invalid", undefined, "development"), false);
});

test("chunk validation: only the section-only excluded-page marker is allowed as a custom event; plugin events are refused", () => {
  const w = { notBefore: T0 - 1000, notAfter: T0 + 60_000 };
  const marker = (payload: any) => ({ type: 5, timestamp: T0 + 10, data: { tag: C.EXCLUDED_MARKER_TAG, payload } });
  assert.equal(C.validateChunk([marker({ section: "checkout" })], w).eventCount, 1);
  const code = (events: any[]) => {
    try {
      C.validateChunk(events, w);
      return "ok";
    } catch (e: any) {
      return e.code;
    }
  };
  assert.equal(code([marker({ section: "checkout", path: "/checkout?addr=x" })]), "INVALID_CHUNK", "no extra payload (paths, queries)");
  assert.equal(code([marker({ section: "my-secret-page" })]), "INVALID_CHUNK", "section must be from the list");
  assert.equal(code([{ type: 5, timestamp: T0, data: { tag: "anything", payload: { email: "a@b.c" } } }]), "INVALID_CHUNK", "no free-form custom data");
  assert.equal(code([{ type: 6, timestamp: T0, data: { plugin: "rrweb/console@1", payload: {} } }]), "INVALID_CHUNK", "no plugin events");
});

test("signed-in recording: a listed synthetic test account is recorded; an unlisted customer is refused at start and at upload", { skip: !SECRET }, async () => {
  USERS.U_SYN = { id: "U_SYN", role: "CUSTOMER", isActive: true, vendorId: null, name: "Synthetic Shopper", email: "shopper1@test.invalid" };
  USERS.U_SYN_UNLISTED = { id: "U_SYN_UNLISTED", role: "CUSTOMER", isActive: true, vendorId: null, name: "Other", email: "shopper9@test.invalid" };
  const saved = process.env.SESSION_REPLAY_SYNTHETIC_ACCOUNTS;
  process.env.SESSION_REPLAY_SYNTHETIC_ACCOUNTS = "shopper1@test.invalid";
  try {
    const sess = "synthetic-signedin-0123456789";
    const ok1 = await start(undefined, { "x-fm-analytics-session": sess, authorization: `Bearer ${tok("U_SYN")}` });
    assert.equal(ok1.status, 201);
    const { recordingId: id, token } = ok1.body;
    const up = await upload(id, token, 0, [meta("http://localhost:3000/cart", T0), full(T0 + 1)], { "x-fm-analytics-session": sess, authorization: `Bearer ${tok("U_SYN")}` });
    assert.equal(up.status, 202, "the synthetic test account's signed-in cart is recordable");
    const rec = db.recs.find((r) => r.id === id)!;
    assert.match(rec.actorKey, /^u:[0-9a-f]{40}$/, "pseudonymous actor key, no raw user id");
    // unlisted @test.invalid customer → refused (the allowlist decides, not the domain alone)
    const no = await start(undefined, { "x-fm-analytics-session": "synthetic-unlisted-0123456789", authorization: `Bearer ${tok("U_SYN_UNLISTED")}` });
    assert.deepEqual(no.body, { success: true, enabled: false, reason: "signed_in" });
    // the same browser recording, then an unlisted customer uploads → refused
    const bad = await upload(id, token, 1, [scroll(T0 + 5)], { "x-fm-analytics-session": sess, authorization: `Bearer ${tok("U_SYN_UNLISTED")}` });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.reason, "signed_in");
    // allowlist removed → the synthetic account is refused too
    delete process.env.SESSION_REPLAY_SYNTHETIC_ACCOUNTS;
    const off = await start(undefined, { "x-fm-analytics-session": "synthetic-off-0123456789", authorization: `Bearer ${tok("U_SYN")}` });
    assert.equal(off.body.reason, "signed_in");
  } finally {
    if (saved === undefined) delete process.env.SESSION_REPLAY_SYNTHETIC_ACCOUNTS;
    else process.env.SESSION_REPLAY_SYNTHETIC_ACCOUNTS = saved;
  }
});

test("expiry: a recording past expiresAt is never listed or served (before the retention job runs), and uploads to it stop", { skip: !SECRET }, async () => {
  const sess = "expiring-session-0123456789";
  const { recordingId: id, token } = (await start(undefined, { "x-fm-analytics-session": sess })).body;
  assert.equal((await upload(id, token, 0, [meta("http://localhost:3000/products/p1", T0), full(T0 + 1)], { "x-fm-analytics-session": sess })).status, 202);
  assert.equal((await admin("U_ADMIN", `/${id}`)).status, 200, "served while live");
  const rec = db.recs.find((r) => r.id === id)!;
  rec.expiresAt = new Date(NOW.getTime() - 1);
  const list = await admin("U_ADMIN", "");
  assert.ok(!list.body.data.items.some((r: any) => r.id === id), "not listed once expired");
  assert.equal((await admin("U_ADMIN", `/${id}`)).status, 404);
  assert.equal((await admin("U_ADMIN", `/${id}/chunks/0`)).status, 404, "chunk bytes not served once expired");
  const up = await upload(id, token, 1, [scroll(T0 + 2)], { "x-fm-analytics-session": sess });
  assert.equal(up.status, 409);
  assert.equal(up.body.stop, true);
  assert.equal(rec.chunkCount, 1, "nothing stored after expiry");
});

test("admin playback is rate-limited per client", { skip: !SECRET }, async () => {
  const app = express();
  app.use(express.json());
  app.use("/x", createAnalyticsRouter({ db: { product: {}, vendor: {} } as any, recorder: {} as any, advisor: {} as any, replay: { db, store, mode: () => "synthetic", now: () => clock, adminLimit: 2 } }));
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/x/business-advisor/recordings`;
  try {
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(url, { headers: { authorization: `Bearer ${tok("U_ADMIN")}` } })).status);
    assert.deepEqual(codes, [200, 200, 429]);
  } finally {
    await new Promise((r) => srv.close(() => r(undefined)));
  }
});
