// src/utils/challengeStore.util.ts
interface ChallengeEntry {
  challenge: string;
  userId?: string;
  expiresAt: number;
}

const store = new Map<string, ChallengeEntry>();
const TTL_MS = 5 * 60 * 1000;

export function saveChallenge(challengeId: string, challenge: string, userId?: string) {
  store.set(challengeId, { challenge, userId, expiresAt: Date.now() + TTL_MS });
}

export function consumeChallenge(challengeId: string): ChallengeEntry | null {
  const entry = store.get(challengeId);
  store.delete(challengeId); // one-time use regardless of outcome
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

// periodic sweep so abandoned attempts don't leak memory
setInterval(() => {
  const now = Date.now();
  for (const [id, e] of store) if (e.expiresAt < now) store.delete(id);
}, 60_000).unref();