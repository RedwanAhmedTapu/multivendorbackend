// modules/analytics/session-replay.contract.ts
//
// Visual session replay (rrweb) — mode, limits, excluded pages and chunk
// validation. Pure (no database / storage); shared by the ingestion and
// admin routes and the retention job.
//
// Phase 1 policy (no consent mechanism exists yet):
//   - SESSION_REPLAY_MODE=off (default) → nothing is accepted;
//   - SESSION_REPLAY_MODE=synthetic     → only recordings the browser marks
//     as synthetic (a tester's own opted-in browser) are accepted. There is
//     deliberately no "on" mode until consent is designed and approved.
//   - recordings are admin-only to watch; vendors never see them (one
//     browser session spans many vendors).
//   - checkout, payment, sign-in / registration / password reset, account
//     and order-tracking pages, every dashboard and chat are never recorded:
//     the browser stops recording on them and the server rejects any chunk
//     that navigates to one.
//   - the recording links to the Business Advisor journey through the same
//     analytics session id (x-fm-analytics-session → sessionKey "s:<id>").

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ReplayMode = "off" | "synthetic";

export function replayMode(raw: unknown = process.env.SESSION_REPLAY_MODE): ReplayMode {
  return String(raw ?? "").trim().toLowerCase() === "synthetic" ? "synthetic" : "off";
}

/**
 * Synthetic signed-in TEST accounts (to replay a signed-in cart in tests).
 * All must hold — any doubt means "not recordable":
 *   - never in production (NODE_ENV=production);
 *   - the email is on the reserved test.invalid domain (RFC 2606/6761 — it can
 *     never be a real person's mailbox);
 *   - the email is explicitly listed in SESSION_REPLAY_SYNTHETIC_ACCOUNTS.
 * The email comes from the database via authenticateUser, never from the client.
 * (Synthetic replay mode itself is checked separately by the routes.)
 */
export const SYNTHETIC_ACCOUNT_DOMAIN = "test.invalid";
export function isSyntheticTestAccount(
  email: unknown,
  list: unknown = process.env.SESSION_REPLAY_SYNTHETIC_ACCOUNTS,
  nodeEnv: unknown = process.env.NODE_ENV
): boolean {
  if (String(nodeEnv ?? "").trim().toLowerCase() === "production") return false;
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._+-]{1,64}@test\.invalid$/.test(e)) return false;
  return String(list ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .includes(e);
}

export const REPLAY_LIMITS = {
  /** One upload (gzip of a JSON array of rrweb events). */
  maxChunkBytes: 256 * 1024,
  /** Decompressed size of one chunk — anything larger is refused (zip-bomb guard). */
  maxChunkRawBytes: 4 * 1024 * 1024,
  maxEventsPerChunk: 5_000,
  /** Full snapshots in one chunk (a page load / route restart / periodic checkout). */
  maxFullSnapshotsPerChunk: 4,
  maxChunksPerRecording: 720,
  maxBytesPerRecording: 25 * 1024 * 1024,
  maxDurationMs: 2 * 60 * 60_000,
  /** Recordings per analytics session (each full page reload may resume or restart). */
  maxRecordingsPerSession: 10,
  /** Clock skew tolerated on event timestamps. */
  clockSkewMs: 5 * 60_000,
  recordingsPageSize: 20,
} as const;

export const REPLAY_RETENTION_DAYS_DEFAULT = 14;
export function replayRetentionDays(raw: unknown = process.env.SESSION_REPLAY_RETENTION_DAYS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : REPLAY_RETENTION_DAYS_DEFAULT;
}

/**
 * Pages that are never recorded (prefix match on the path). Mirrors the
 * browser's list in lib/analytics/replay/replay-config.ts.
 */
export const REPLAY_EXCLUDED_PATH_PREFIXES = [
  "/checkout",
  "/payment",
  "/payment-option",
  "/login",
  "/register",
  "/reset-password",
  "/verify-email",
  "/user-dashboard",
  "/vendor-dashboard",
  "/admin-dashboard",
  "/vendorauth",
  "/vendor-register",
  "/track",
  "/hrm",
  "/accounting",
  "/inventory",
  "/pos",
  "/store-editor",
  "/vendor-store-decoration",
  "/chat",
  "/messages",
] as const;

/** Path of a URL or path string, lower-cased, without query / hash. null when unparseable. */
export function pathOf(urlOrPath: unknown): string | null {
  if (typeof urlOrPath !== "string" || !urlOrPath) return null;
  try {
    const u = new URL(urlOrPath, "http://x.invalid");
    return decodeURIComponent(u.pathname).toLowerCase();
  } catch {
    return null;
  }
}

export function isExcludedPath(urlOrPath: unknown): boolean {
  const p = pathOf(urlOrPath);
  if (p === null) return true; // unknown → treat as sensitive
  return REPLAY_EXCLUDED_PATH_PREFIXES.some((x) => p === x || p.startsWith(`${x}/`));
}

/** Path stored for display: no query string or hash (they may carry personal data). */
export function safeEntryPath(urlOrPath: unknown): string | null {
  const p = pathOf(urlOrPath);
  return p && p.length <= 300 ? p : null;
}

// ── upload token (proves the uploader started this recording) ──────────

export function newUploadToken(): string {
  return randomBytes(24).toString("base64url");
}
export function hashUploadToken(token: string): string {
  return createHash("sha256").update(`finixmart-replay:${token}`).digest("hex");
}
export function tokenMatches(token: unknown, storedHash: string): boolean {
  if (typeof token !== "string" || token.length < 16 || token.length > 128) return false;
  const a = Buffer.from(hashUploadToken(token), "hex");
  const b = Buffer.from(String(storedHash ?? ""), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── chunk validation ────────────────────────────────────────────────────

/** rrweb EventType: 0 DomContentLoaded … 4 Meta, 2 FullSnapshot, 3 Incremental, 5 Custom, 6 Plugin. */
const EVENT_META = 4;
const EVENT_FULL_SNAPSHOT = 2;
const EVENT_CUSTOM = 5;
const EVENT_PLUGIN = 6;

/**
 * The only custom event a recording may carry: "the shopper went to an
 * excluded section here" — a section name from this list, nothing else (no
 * path, query or page content). Mirrors lib/analytics/replay/replay-config.ts.
 */
export const EXCLUDED_MARKER_TAG = "fm:excluded-page";
export const EXCLUDED_SECTIONS = ["checkout", "sign-in", "account", "dashboard", "chat", "other"] as const;
function isExcludedMarker(data: any): boolean {
  if (!data || typeof data !== "object" || data.tag !== EXCLUDED_MARKER_TAG) return false;
  const p = data.payload;
  return !!p && typeof p === "object" && Object.keys(p).length === 1 && (EXCLUDED_SECTIONS as readonly string[]).includes(p.section);
}

export type ChunkSummary = { eventCount: number; firstEventAt: Date; lastEventAt: Date; pages: number; fullSnapshots: number };

export class ChunkRejected extends Error {
  readonly code: "INVALID_CHUNK" | "EXCLUDED_PAGE" | "CHUNK_TOO_LARGE";
  constructor(code: "INVALID_CHUNK" | "EXCLUDED_PAGE" | "CHUNK_TOO_LARGE") {
    super(code);
    this.code = code;
  }
}

/**
 * Checks a decompressed chunk: a non-empty array of rrweb events with integer
 * types and sane timestamps; page changes (Meta events) never land on an
 * excluded page. Returns counts for the recording's metadata.
 */
export function validateChunk(events: unknown, window: { notBefore: number; notAfter: number }): ChunkSummary {
  if (!Array.isArray(events) || events.length === 0) throw new ChunkRejected("INVALID_CHUNK");
  if (events.length > REPLAY_LIMITS.maxEventsPerChunk) throw new ChunkRejected("CHUNK_TOO_LARGE");
  let first = Infinity;
  let last = -Infinity;
  let pages = 0;
  let fullSnapshots = 0;
  for (const e of events as any[]) {
    if (!e || typeof e !== "object" || !Number.isInteger(e.type) || e.type < 0 || e.type > 6) throw new ChunkRejected("INVALID_CHUNK");
    const ts = e.timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts < window.notBefore || ts > window.notAfter) throw new ChunkRejected("INVALID_CHUNK");
    if (e.type === EVENT_META) {
      if (isExcludedPath(e.data?.href)) throw new ChunkRejected("EXCLUDED_PAGE");
      pages++;
    }
    if (e.type === EVENT_FULL_SNAPSHOT) fullSnapshots++;
    // no free-form custom data: only the excluded-section marker; rrweb plugins aren't used
    if (e.type === EVENT_CUSTOM && !isExcludedMarker(e.data)) throw new ChunkRejected("INVALID_CHUNK");
    if (e.type === EVENT_PLUGIN) throw new ChunkRejected("INVALID_CHUNK");
    first = Math.min(first, ts);
    last = Math.max(last, ts);
  }
  if (fullSnapshots > REPLAY_LIMITS.maxFullSnapshotsPerChunk) throw new ChunkRejected("CHUNK_TOO_LARGE");
  return { eventCount: events.length, firstEventAt: new Date(first), lastEventAt: new Date(last), pages, fullSnapshots };
}

export const RECORDING_STATUSES = ["RECORDING", "COMPLETE", "STOPPED"] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];
