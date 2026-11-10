// src/jobs/job-runner.ts
//
// Single-instance background job runner (Marketing Center, Phase 1).
//
// Every job runs on an interval. Before each run the instance must win a
// Redis lock (SET key token NX PX ttl), so with N API instances a job runs
// on at most ONE of them at a time; the lock is renewed while the job runs
// and released only by its owner (compare-and-delete). If Redis is down or
// another instance holds the lock, the tick is skipped — never run unlocked.
//
// Jobs MUST be idempotent ("activate slots whose startAt <= now", "apply coin
// rate changes whose pendingEffectiveAt <= now", "reset budgets whose
// spentTodayDate < today"): a skipped or repeated tick must be harmless.
//
// No external scheduler dependency (node-cron is not installed). Disabled by
// default: startJobRunner() is a no-op unless JOBS_ENABLED=1.

import { randomUUID } from "node:crypto";

export interface JobContext {
  /** Aborted when the lock is lost or the runner stops — long jobs should check it. */
  signal: AbortSignal;
  now: Date;
}

export interface JobDefinition {
  name: string;
  intervalMs: number;
  /** Lock lifetime; renewed every lockTtlMs/3 while the job runs. */
  lockTtlMs?: number;
  run: (ctx: JobContext) => Promise<void>;
}

/** The subset of the node-redis v5 client the runner uses. */
export interface LockRedis {
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface JobLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export type JobRunOutcome = "ran" | "failed" | "locked" | "busy" | "lock-error" | "stopped";

export const LOCK_PREFIX = "jobs:lock:";
const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const RENEW_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

export function createJobRunner(deps: {
  redis: LockRedis;
  logger?: JobLogger;
  now?: () => Date;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}) {
  const logger = deps.logger ?? { info: console.log, warn: console.warn, error: console.error };
  const now = deps.now ?? (() => new Date());
  const every = deps.setInterval ?? setInterval;
  const cancel = deps.clearInterval ?? clearInterval;
  const jobs = new Map<string, JobDefinition>();
  const running = new Set<string>();
  const timers: ReturnType<typeof setInterval>[] = [];
  let stopped = false;
  let started = false;

  function register(job: JobDefinition) {
    if (!/^[a-z0-9][a-z0-9:-]*$/.test(job.name)) throw new Error(`Invalid job name "${job.name}"`);
    if (jobs.has(job.name)) throw new Error(`Job "${job.name}" is already registered`);
    if (!(job.intervalMs >= 1000)) throw new Error(`Job "${job.name}": intervalMs must be at least 1000`);
    if (started) throw new Error("Register jobs before start()");
    jobs.set(job.name, job);
  }

  /** One locked execution. Exported for tests and manual triggers. */
  async function runOnce(name: string): Promise<JobRunOutcome> {
    const job = jobs.get(name);
    if (!job) throw new Error(`Unknown job "${name}"`);
    if (stopped) return "stopped";
    if (running.has(name)) return "busy"; // previous tick still running here

    const key = LOCK_PREFIX + name;
    const token = randomUUID();
    const ttl = job.lockTtlMs ?? Math.max(30_000, job.intervalMs * 2);
    let acquired: string | null;
    try {
      acquired = await deps.redis.set(key, token, { NX: true, PX: ttl });
    } catch (err) {
      logger.warn(`[jobs] ${name}: lock unavailable, tick skipped (${(err as Error).message})`);
      return "lock-error";
    }
    if (acquired !== "OK") return "locked"; // another instance owns it

    running.add(name);
    const controller = new AbortController();
    const renew = every(async () => {
      try {
        const ok = await deps.redis.eval(RENEW_SCRIPT, { keys: [key], arguments: [token, String(ttl)] });
        if (Number(ok) !== 1) {
          logger.warn(`[jobs] ${name}: lock lost while running — signalling abort`);
          controller.abort();
        }
      } catch {
        controller.abort();
      }
    }, Math.max(1000, Math.floor(ttl / 3)));

    try {
      await job.run({ signal: controller.signal, now: now() });
      return "ran";
    } catch (err) {
      logger.error(`[jobs] ${name} failed`, err);
      return "failed";
    } finally {
      cancel(renew);
      running.delete(name);
      try {
        await deps.redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
      } catch (err) {
        logger.warn(`[jobs] ${name}: lock release failed, it expires in ${ttl}ms (${(err as Error).message})`);
      }
    }
  }

  function start() {
    if (started) return;
    started = true;
    for (const job of jobs.values()) {
      timers.push(every(() => void runOnce(job.name), job.intervalMs));
    }
    logger.info(`[jobs] runner started with ${jobs.size} job(s): ${[...jobs.keys()].join(", ") || "none"}`);
  }

  function stop() {
    stopped = true;
    for (const t of timers.splice(0)) cancel(t);
  }

  return { register, runOnce, start, stop, jobNames: () => [...jobs.keys()] };
}

export type JobRunner = ReturnType<typeof createJobRunner>;

/**
 * Process-wide runner. Jobs are registered by later phases (flash slots,
 * coins 24h switch, ad budget reset). Only starts when JOBS_ENABLED=1.
 */
export async function startJobRunner(register: (runner: JobRunner) => void = () => {}) {
  if (process.env.JOBS_ENABLED !== "1") {
    console.log("[jobs] runner disabled (set JOBS_ENABLED=1 to enable)");
    return null;
  }
  const { default: redisClient } = await import("../config/redis.ts");
  const runner = createJobRunner({ redis: redisClient as unknown as LockRedis });
  register(runner);
  runner.start();
  return runner;
}
