// modules/chat/utils/redis-timeout.ts
//
// While the Redis connection is down and reconnecting, node-redis QUEUES
// commands instead of rejecting them (verified against redis 5.8.2 in Phase 2),
// so an unbounded await hangs until Redis returns. withRedisTimeout bounds one
// command: past `ms` it rejects with RedisUnavailableError and the caller
// applies its own policy (cache → database fallback; abuse controls → fail
// closed). The queued command itself still runs later, in order.

export class RedisUnavailableError extends Error {
  readonly code = "REDIS_UNAVAILABLE";
  constructor() {
    super("Redis unavailable");
  }
}

export function withRedisTimeout<T>(op: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RedisUnavailableError()), ms);
  });
  let pending: Promise<T>;
  try {
    pending = op();
  } catch {
    pending = Promise.reject(new RedisUnavailableError()); // e.g. ClientClosedError thrown synchronously
  }
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}
