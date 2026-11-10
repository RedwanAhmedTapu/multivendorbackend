// tests/job-runner.test.ts
//
// Marketing Center Phase 1: single-instance job runner (Redis lock).
// A fake Redis implements SET NX PX and the runner's two Lua scripts
// (owner-only release / renew), so the locking rules are tested without a
// Redis server. Timers are injected, so nothing waits on real intervals.
//   npx tsx --test tests/job-runner.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobRunner, startJobRunner, LOCK_PREFIX, type LockRedis } from "../src/jobs/job-runner.ts";

/** In-memory Redis: SET NX PX + the release/renew scripts (by their commands). */
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  let clock = 0;
  const live = (k: string) => {
    const e = store.get(k);
    if (e && e.expiresAt <= clock) store.delete(k);
    return store.get(k);
  };
  const redis: LockRedis & { failSet?: boolean } = {
    async set(key, value, opts) {
      if (redis.failSet) throw new Error("ECONNREFUSED");
      if (live(key)) return null;
      store.set(key, { value, expiresAt: clock + opts.PX });
      return "OK";
    },
    async eval(script, { keys: [key], arguments: [token, ttl] }) {
      const e = live(key);
      if (!e || e.value !== token) return 0;
      if (script.includes('"del"')) {
        store.delete(key);
        return 1;
      }
      if (script.includes('"pexpire"')) {
        e.expiresAt = clock + Number(ttl);
        return 1;
      }
      throw new Error("unexpected script");
    },
  };
  return { redis, store, advance: (ms: number) => (clock += ms), live };
}

/** Manual timers: tick() fires every registered interval once. */
function manualTimers() {
  const timers = new Map<number, () => void>();
  let id = 0;
  return {
    setInterval: ((fn: () => void) => (timers.set(++id, fn), id)) as unknown as typeof setInterval,
    clearInterval: ((t: number) => timers.delete(t)) as unknown as typeof clearInterval,
    tick: () => [...timers.values()].forEach((fn) => fn()),
    count: () => timers.size,
  };
}

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

test("runs the job when the lock is free, then releases the lock", async () => {
  const { redis, live } = fakeRedis();
  const r = createJobRunner({ redis, logger: quietLogger });
  let runs = 0;
  r.register({ name: "flash-slots", intervalMs: 60_000, run: async () => void runs++ });
  assert.equal(await r.runOnce("flash-slots"), "ran");
  assert.equal(runs, 1);
  assert.equal(live(LOCK_PREFIX + "flash-slots"), undefined, "lock released");
});

test("two instances racing for the same job: exactly one runs", async () => {
  const shared = fakeRedis();
  const a = createJobRunner({ redis: shared.redis, logger: quietLogger });
  const b = createJobRunner({ redis: shared.redis, logger: quietLogger });
  const gate = deferred();
  let runs = 0;
  const job = { name: "coins-switch", intervalMs: 60_000, run: async () => { runs++; await gate.promise; } };
  a.register(job);
  b.register(job);
  const pa = a.runOnce("coins-switch");
  const pb = b.runOnce("coins-switch");
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  const outcomes = (await Promise.all([pa, pb])).sort();
  assert.deepEqual(outcomes, ["locked", "ran"]);
  assert.equal(runs, 1);
});

test("a lock held by another instance skips the tick; Redis down skips it too (never runs unlocked)", async () => {
  const { redis, store } = fakeRedis();
  store.set(LOCK_PREFIX + "ad-budget-reset", { value: "other-instance", expiresAt: Number.MAX_SAFE_INTEGER });
  const r = createJobRunner({ redis, logger: quietLogger });
  let runs = 0;
  r.register({ name: "ad-budget-reset", intervalMs: 60_000, run: async () => void runs++ });
  assert.equal(await r.runOnce("ad-budget-reset"), "locked");
  store.clear();
  redis.failSet = true;
  assert.equal(await r.runOnce("ad-budget-reset"), "lock-error");
  assert.equal(runs, 0);
});

test("a failing job is reported and its lock is still released", async () => {
  const { redis, live } = fakeRedis();
  const errors: string[] = [];
  const r = createJobRunner({ redis, logger: { ...quietLogger, error: (m) => errors.push(m) } });
  r.register({ name: "boom", intervalMs: 60_000, run: async () => { throw new Error("db down"); } });
  assert.equal(await r.runOnce("boom"), "failed");
  assert.equal(live(LOCK_PREFIX + "boom"), undefined);
  assert.match(errors[0], /boom failed/);
});

test("an overlapping tick on the same instance is skipped as busy", async () => {
  const { redis } = fakeRedis();
  const r = createJobRunner({ redis, logger: quietLogger });
  const gate = deferred();
  r.register({ name: "slow", intervalMs: 60_000, run: () => gate.promise });
  const first = r.runOnce("slow");
  await new Promise((res) => setImmediate(res));
  assert.equal(await r.runOnce("slow"), "busy");
  gate.resolve();
  assert.equal(await first, "ran");
});

test("release is owner-only: an expired lock re-taken by another instance is not deleted", async () => {
  const fake = fakeRedis();
  const t = manualTimers();
  const r = createJobRunner({ redis: fake.redis, logger: quietLogger, setInterval: t.setInterval, clearInterval: t.clearInterval });
  const gate = deferred();
  r.register({ name: "long", intervalMs: 60_000, lockTtlMs: 30_000, run: () => gate.promise });
  const p = r.runOnce("long");
  await new Promise((res) => setImmediate(res));
  fake.advance(31_000); // our lock expires (no renewal tick fired)
  assert.equal(await fake.redis.set(LOCK_PREFIX + "long", "other", { NX: true, PX: 30_000 }), "OK");
  gate.resolve();
  assert.equal(await p, "ran");
  assert.equal(fake.live(LOCK_PREFIX + "long")?.value, "other", "the other instance's lock survives our release");
});

test("the lock is renewed while running; losing it aborts the job's signal", async () => {
  const fake = fakeRedis();
  const t = manualTimers();
  const r = createJobRunner({ redis: fake.redis, logger: quietLogger, setInterval: t.setInterval, clearInterval: t.clearInterval });
  const gate = deferred();
  let signal!: AbortSignal;
  r.register({ name: "renewing", intervalMs: 60_000, lockTtlMs: 30_000, run: async (ctx) => { signal = ctx.signal; await gate.promise; } });
  const p = r.runOnce("renewing");
  await new Promise((res) => setImmediate(res));
  fake.advance(20_000);
  t.tick(); // renewal → extends to now + 30s
  await new Promise((res) => setImmediate(res));
  fake.advance(20_000); // would have expired without the renewal
  assert.ok(fake.live(LOCK_PREFIX + "renewing"), "renewed lock still held");
  assert.equal(signal.aborted, false);
  fake.store.set(LOCK_PREFIX + "renewing", { value: "stolen", expiresAt: Number.MAX_SAFE_INTEGER });
  t.tick();
  await new Promise((res) => setImmediate(res));
  assert.equal(signal.aborted, true, "lost lock → abort");
  gate.resolve();
  await p;
  assert.equal(t.count(), 0, "renewal timer cleared");
});

test("start() schedules every registered job; stop() clears them and later ticks do nothing", async () => {
  const { redis } = fakeRedis();
  const t = manualTimers();
  const r = createJobRunner({ redis, logger: quietLogger, setInterval: t.setInterval, clearInterval: t.clearInterval });
  let runs = 0;
  r.register({ name: "a", intervalMs: 60_000, run: async () => void runs++ });
  r.register({ name: "b", intervalMs: 60_000, run: async () => void runs++ });
  r.start();
  assert.equal(t.count(), 2);
  t.tick();
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(runs, 2);
  r.stop();
  assert.equal(t.count(), 0);
  assert.equal(await r.runOnce("a"), "stopped");
});

test("registration rules: unique valid names, interval ≥ 1s, not after start", () => {
  const { redis } = fakeRedis();
  const t = manualTimers();
  const r = createJobRunner({ redis, logger: quietLogger, setInterval: t.setInterval, clearInterval: t.clearInterval });
  r.register({ name: "ok-job", intervalMs: 1000, run: async () => {} });
  assert.throws(() => r.register({ name: "ok-job", intervalMs: 1000, run: async () => {} }), /already registered/);
  assert.throws(() => r.register({ name: "Bad Name", intervalMs: 1000, run: async () => {} }), /Invalid job name/);
  assert.throws(() => r.register({ name: "fast", intervalMs: 10, run: async () => {} }), /at least 1000/);
  r.start();
  assert.throws(() => r.register({ name: "late", intervalMs: 1000, run: async () => {} }), /before start/);
  r.stop();
});

test("startJobRunner is a no-op unless JOBS_ENABLED=1 (does not touch Redis)", async () => {
  const prev = process.env.JOBS_ENABLED;
  delete process.env.JOBS_ENABLED;
  const log = console.log;
  console.log = () => {};
  try {
    let registered = false;
    assert.equal(await startJobRunner(() => void (registered = true)), null);
    assert.equal(registered, false);
  } finally {
    console.log = log;
    if (prev === undefined) delete process.env.JOBS_ENABLED;
    else process.env.JOBS_ENABLED = prev;
  }
});
