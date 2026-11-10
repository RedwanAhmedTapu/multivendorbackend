// modules/analytics/session-replay.routes.ts
//
// Visual session replay — ingestion (public, synthetic-only for now) and
// admin playback. Mounted by createAnalyticsRouter:
//
//   POST   /api/analytics/replay/start                 → { recordingId, token } (or { enabled: false })
//   POST   /api/analytics/replay/:id/chunks?seq=N      gzip(JSON rrweb events), x-fm-replay-token
//   POST   /api/analytics/replay/:id/finish            x-fm-replay-token
//   GET    /api/analytics/business-advisor/recordings?journey=J-XXXXXXXX&page=N
//   GET    /api/analytics/business-advisor/recordings/:id
//   GET    /api/analytics/business-advisor/recordings/:id/chunks/:seq
//   DELETE /api/analytics/business-advisor/recordings/:id
//
// Ownership is never taken from the client: a recording is bound at start to
// the server-derived analytics context (journey key + actor key, staff
// refused) and to a random upload token (only its hash is stored). Every
// chunk must present the token AND come from the same journey. Playback runs
// behind the Business Advisor guard (authenticateUser + "analytics"
// permission) and is further limited to platform administrators — vendors
// and vendor-side employees are refused.
//
// Until the proposed migration is applied and Prisma Client regenerated, the
// sessionRecording delegates don't exist: ingestion answers { enabled: false }
// and the admin routes answer 503 REPLAY_NOT_READY. Nothing else is affected.

import express, { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { z } from "zod";
import { prisma } from "../../config/prisma.ts";
import { journeyLabel, looksLikeBot } from "./analytics.contract.ts";
import { analyticsContext, customerUserId } from "./analytics.context.ts";
import {
  ChunkRejected,
  REPLAY_LIMITS,
  isExcludedPath,
  hashUploadToken,
  isSyntheticTestAccount,
  newUploadToken,
  replayMode,
  replayRetentionDays,
  safeEntryPath,
  tokenMatches,
  validateChunk,
  type ReplayMode,
} from "./session-replay.contract.ts";
import { chunkStorageKey, defaultReplayStore, type ReplayBlobStore } from "./session-replay.store.ts";

type Delegate = Record<string, (...args: any[]) => Promise<any>>;
export type ReplayDb = { sessionRecording?: Delegate; sessionRecordingChunk?: Delegate };

export const REPLAY_TOKEN_HEADER = "x-fm-replay-token";
const gunzipAsync = promisify(gunzip) as (buf: Buffer, opts: { maxOutputLength: number }) => Promise<Buffer>;
const ID = /^[A-Za-z0-9_-]{10,40}$/;

export type ReplayDeps = {
  db?: ReplayDb;
  store?: ReplayBlobStore | null;
  mode?: () => ReplayMode;
  now?: () => Date;
  ingestLimit?: number;
  adminLimit?: number;
  /** Optional login (analytics.routes softAuthenticate) — staff are recognised and never recorded. */
  authenticate?: (req: Request, res: Response, next: NextFunction) => void;
};

function resolve(deps: ReplayDeps) {
  const db = deps.db ?? (prisma as unknown as ReplayDb);
  const store = deps.store === undefined ? defaultReplayStore() : deps.store;
  const ready = () => !!(db.sessionRecording?.create && db.sessionRecordingChunk?.create && store);
  return { db, store, ready, mode: deps.mode ?? (() => replayMode()), now: deps.now ?? (() => new Date()) };
}

const notReadyError = (err: any) => err?.code === "P2021" || err?.code === "P2022";
const disabled = (res: Response, reason?: string) => res.status(202).json({ success: true, enabled: false, ...(reason ? { reason } : {}) });
const stop = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ success: false, stop: true, error, ...extra });

const StartSchema = z.object({ synthetic: z.literal(true), path: z.string().min(1).max(2048) }).strict();

// ── ingestion ───────────────────────────────────────────────────────────

export function createReplayIngestRouter(deps: ReplayDeps = {}) {
  const { db, store, ready, mode, now } = resolve(deps);
  const router = Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: deps.ingestLimit ?? 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many requests" },
  });
  router.use(limiter);
  if (deps.authenticate) router.use(deps.authenticate);

  router.post("/start", async (req: Request, res: Response) => {
    if (mode() !== "synthetic") return disabled(res);
    if (looksLikeBot(req.headers["user-agent"])) return disabled(res);
    const parsed = StartSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid replay start" });
    const ctx = analyticsContext(req as any, now());
    // a journey key from the browser's analytics session id is required to link the recording
    if (!ctx || !ctx.sessionKey.startsWith("s:")) return disabled(res);
    // fail closed: signed-in customers are never recorded — except explicitly listed synthetic TEST
    // accounts (reserved domain, never in production); see isSyntheticTestAccount
    if (customerUserId((req as any).user) && !isSyntheticTestAccount((req as any).user?.email)) return disabled(res, "signed_in");
    if (isExcludedPath(parsed.data.path)) return disabled(res, "excluded_page");
    if (!ready()) return disabled(res, "not_ready");
    try {
      const existing = await db.sessionRecording!.count({ where: { sessionKey: ctx.sessionKey } });
      // Best-effort invariant: two simultaneous /start calls for the same brand-new session can both pass this count and create an extra segment, so maxRecordingsPerSession is not strictly enforced under concurrency. Segments stay individually coherent (own upload token); duplicates are harmless, just slightly over the cap.
      if (existing >= REPLAY_LIMITS.maxRecordingsPerSession) return disabled(res, "limit");
      const token = newUploadToken();
      const at = now();
      const rec = await db.sessionRecording!.create({
        data: {
          sessionKey: ctx.sessionKey,
          journeyLabel: journeyLabel(ctx.sessionKey),
          actorKey: ctx.actorKey,
          uploadTokenHash: hashUploadToken(token),
          synthetic: true,
          status: "RECORDING",
          entryPath: safeEntryPath(parsed.data.path),
          startedAt: at,
          expiresAt: new Date(at.getTime() + replayRetentionDays() * 86_400_000),
        },
        select: { id: true },
      });
      return res.status(201).json({
        success: true,
        enabled: true,
        recordingId: rec.id,
        token,
        limits: { maxChunkBytes: REPLAY_LIMITS.maxChunkBytes, maxEventsPerChunk: REPLAY_LIMITS.maxEventsPerChunk },
      });
    } catch (err: any) {
      if (notReadyError(err)) return disabled(res, "not_ready");
      console.error("[replay] start skipped:", err?.code ?? err?.name ?? "error");
      return disabled(res);
    }
  });

  /** Common checks for an upload against an existing recording. */
  async function ownRecording(req: Request, res: Response) {
    if (mode() !== "synthetic") return void stop(res, 409, "Replay is disabled");
    if (!ready()) return void stop(res, 409, "Replay isn't available");
    const id = String(req.params.id ?? "");
    if (!ID.test(id)) return void stop(res, 400, "Invalid recording");
    const ctx = analyticsContext(req as any, now());
    if (!ctx) return void stop(res, 403, "Forbidden");
    if (customerUserId((req as any).user) && !isSyntheticTestAccount((req as any).user?.email))
      return void stop(res, 409, "Signed-in sessions aren't recorded", { reason: "signed_in" });
    const rec = await db.sessionRecording!.findUnique({
      where: { id },
      select: { id: true, sessionKey: true, uploadTokenHash: true, status: true, startedAt: true, chunkCount: true, bytes: true, expiresAt: true },
    });
    if (!rec) return void stop(res, 404, "Recording not found");
    // past its retention: no more uploads (the retention job deletes it)
    if (rec.expiresAt && new Date(rec.expiresAt).getTime() <= now().getTime()) return void stop(res, 409, "Recording expired");
    if (!tokenMatches(req.headers[REPLAY_TOKEN_HEADER], rec.uploadTokenHash)) return void stop(res, 403, "Forbidden");
    // the journey rotated (30 min idle) — the browser starts a new recording for the new journey
    if (rec.sessionKey !== ctx.sessionKey) return void res.status(409).json({ success: false, restart: true, error: "Journey changed" });
    return rec;
  }

  router.post(
    "/:id/chunks",
    express.raw({ type: "application/octet-stream", limit: REPLAY_LIMITS.maxChunkBytes }),
    async (req: Request, res: Response) => {
      try {
        const rec = await ownRecording(req, res);
        if (!rec) return;
        if (rec.status !== "RECORDING") return stop(res, 409, "Recording has ended");
        const seq = Number(req.query.seq);
        if (!Number.isInteger(seq) || seq < 0 || seq >= REPLAY_LIMITS.maxChunksPerRecording) return stop(res, 400, "Invalid sequence");
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ success: false, error: "Empty chunk" });

        const dup = await db.sessionRecordingChunk!.findUnique({ where: { recordingId_seq: { recordingId: rec.id, seq } }, select: { id: true } });
        if (dup) return res.status(200).json({ success: true, duplicate: true });

        const at = now();
        const overLimit =
          rec.chunkCount + 1 > REPLAY_LIMITS.maxChunksPerRecording
            ? "max_chunks"
            : rec.bytes + body.length > REPLAY_LIMITS.maxBytesPerRecording
              ? "max_bytes"
              : at.getTime() - new Date(rec.startedAt).getTime() > REPLAY_LIMITS.maxDurationMs
                ? "max_duration"
                : null;
        if (overLimit) {
          await db.sessionRecording!.update({ where: { id: rec.id }, data: { status: "STOPPED", stopReason: overLimit } });
          return stop(res, 409, "Recording limit reached", { reason: overLimit });
        }

        let events: unknown;
        try {
          const raw = await gunzipAsync(body, { maxOutputLength: REPLAY_LIMITS.maxChunkRawBytes });
          events = JSON.parse(raw.toString("utf8"));
        } catch (err: any) {
          if (err instanceof RangeError || err?.code === "ERR_BUFFER_TOO_LARGE") return res.status(413).json({ success: false, code: "CHUNK_TOO_LARGE", error: "Chunk too large" });
          return res.status(400).json({ success: false, code: "INVALID_CHUNK", error: "Invalid chunk" });
        }
        let summary;
        try {
          summary = validateChunk(events, {
            notBefore: new Date(rec.startedAt).getTime() - REPLAY_LIMITS.clockSkewMs,
            notAfter: at.getTime() + REPLAY_LIMITS.clockSkewMs,
          });
        } catch (err) {
          if (err instanceof ChunkRejected) {
            const status = err.code === "EXCLUDED_PAGE" ? 422 : err.code === "CHUNK_TOO_LARGE" ? 413 : 400;
            return res.status(status).json({ success: false, code: err.code, error: "Chunk refused" });
          }
          throw err;
        }

        const storageKey = chunkStorageKey(rec.id, seq);
        await store!.put(storageKey, body);
        try {
          await db.sessionRecordingChunk!.create({
            data: { recordingId: rec.id, seq, storageKey, bytes: body.length, eventCount: summary.eventCount, firstEventAt: summary.firstEventAt, lastEventAt: summary.lastEventAt },
          });
        } catch (err: any) {
          await store!.delete([storageKey]).catch(() => undefined);
          if (err?.code === "P2002") return res.status(200).json({ success: true, duplicate: true });
          throw err;
        }
        await db.sessionRecording!.update({
          where: { id: rec.id },
          data: {
            chunkCount: { increment: 1 },
            eventCount: { increment: summary.eventCount },
            bytes: { increment: body.length },
            pageCount: { increment: summary.pages },
            lastEventAt: summary.lastEventAt,
            ...(seq === 0 ? { firstEventAt: summary.firstEventAt } : {}),
          },
        });
        return res.status(202).json({ success: true });
      } catch (err: any) {
        if (notReadyError(err)) return stop(res, 409, "Replay isn't available");
        console.error("[replay] chunk skipped:", err?.code ?? err?.name ?? "error");
        return res.status(500).json({ success: false, error: "Internal server error" });
      }
    }
  );

  router.post("/:id/finish", async (req: Request, res: Response) => {
    try {
      const rec = await ownRecording(req, res);
      if (!rec) return;
      if (rec.status === "RECORDING") await db.sessionRecording!.update({ where: { id: rec.id }, data: { status: "COMPLETE" } });
      return res.status(200).json({ success: true });
    } catch (err: any) {
      if (notReadyError(err)) return stop(res, 409, "Replay isn't available");
      console.error("[replay] finish skipped:", err?.code ?? err?.name ?? "error");
      return res.status(500).json({ success: false, error: "Internal server error" });
    }
  });

  // body-parser errors (oversized / malformed upload) → JSON, never an HTML error page
  router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ success: false, code: "CHUNK_TOO_LARGE", error: "Chunk too large" });
    if (err?.type) return res.status(400).json({ success: false, error: "Invalid request" });
    return next(err);
  });
  return router;
}

// ── admin playback ──────────────────────────────────────────────────────

/** Platform administrators only: ADMIN, or an admin-side EMPLOYEE (the "analytics" permission is checked upstream). */
export function requireReplayViewer(req: Request, res: Response, next: NextFunction) {
  const user: any = (req as any).user;
  const role = String(user?.role ?? "").toUpperCase();
  if (role === "ADMIN" || (role === "EMPLOYEE" && !user?.vendorId)) return next();
  return res.status(403).json({ success: false, error: "Visual replays are available to platform administrators only" });
}

const JOURNEY = /^J-[0-9A-F]{8}$/;

export function createReplayAdminRouter(deps: ReplayDeps = {}) {
  const { db, store, ready, now } = resolve(deps);
  const router = Router();
  router.use(requireReplayViewer);
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: deps.adminLimit ?? 300,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: "Too many requests" },
    })
  );
  // a recording past expiresAt is never served, even before the retention job removes it
  const notExpired = () => ({ expiresAt: { gt: now() } });
  const live = (r: any) => !!r && new Date(r.expiresAt).getTime() > now().getTime();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!ready()) return res.status(503).json({ success: false, code: "REPLAY_NOT_READY", error: "Visual replay isn't set up yet." });
    next();
  });

  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (notReadyError(err)) return res.status(503).json({ success: false, code: "REPLAY_NOT_READY", error: "Visual replay isn't set up yet." });
      console.error("[replay] admin request failed:", err?.code ?? err?.name ?? "error");
      return res.status(500).json({ success: false, error: "Internal server error" });
    }
  };

  const view = (r: any) => ({
    id: r.id,
    journeyId: r.journeyLabel,
    synthetic: !!r.synthetic,
    status: r.status,
    stopReason: r.stopReason ?? null,
    entryPath: r.entryPath ?? null,
    startedAt: r.startedAt,
    firstEventAt: r.firstEventAt ?? null,
    lastEventAt: r.lastEventAt ?? null,
    durationMs: r.firstEventAt && r.lastEventAt ? Math.max(new Date(r.lastEventAt).getTime() - new Date(r.firstEventAt).getTime(), 0) : 0,
    pageCount: r.pageCount,
    chunkCount: r.chunkCount,
    eventCount: r.eventCount,
    bytes: r.bytes,
    expiresAt: r.expiresAt,
  });
  const SELECT = {
    id: true, journeyLabel: true, synthetic: true, status: true, stopReason: true, entryPath: true, startedAt: true,
    firstEventAt: true, lastEventAt: true, pageCount: true, chunkCount: true, eventCount: true, bytes: true, expiresAt: true,
  };

  router.get("/", wrap(async (req, res) => {
    const journey = typeof req.query.journey === "string" ? req.query.journey.trim().toUpperCase() : "";
    if (journey && !JOURNEY.test(journey)) return res.status(400).json({ success: false, error: "Invalid journey" });
    const page = Math.max(1, Math.min(500, Number.parseInt(String(req.query.page ?? "1"), 10) || 1));
    const size = REPLAY_LIMITS.recordingsPageSize;
    const where = { chunkCount: { gt: 0 }, ...notExpired(), ...(journey ? { journeyLabel: journey } : {}) };
    const [rows, total] = await Promise.all([
      db.sessionRecording!.findMany({ where, orderBy: { startedAt: "desc" }, skip: (page - 1) * size, take: size, select: SELECT }),
      db.sessionRecording!.count({ where }),
    ]);
    return res.json({ success: true, data: { items: rows.map(view), total, page, pageSize: size } });
  }));

  router.get("/:id", wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!ID.test(id)) return res.status(404).json({ success: false, error: "Recording not found" });
    const rec = await db.sessionRecording!.findUnique({ where: { id }, select: SELECT });
    if (!live(rec)) return res.status(404).json({ success: false, error: "Recording not found" });
    const chunks = await db.sessionRecordingChunk!.findMany({
      where: { recordingId: id },
      orderBy: { seq: "asc" },
      select: { seq: true, bytes: true, eventCount: true, firstEventAt: true, lastEventAt: true },
    });
    return res.json({ success: true, data: { ...view(rec), chunks } });
  }));

  router.get("/:id/chunks/:seq", wrap(async (req, res) => {
    const id = String(req.params.id);
    const seq = Number(req.params.seq);
    if (!ID.test(id) || !Number.isInteger(seq) || seq < 0) return res.status(404).json({ success: false, error: "Chunk not found" });
    const owner = await db.sessionRecording!.findUnique({ where: { id }, select: { expiresAt: true } });
    if (!live(owner)) return res.status(404).json({ success: false, error: "Chunk not found" });
    const chunk = await db.sessionRecordingChunk!.findUnique({ where: { recordingId_seq: { recordingId: id, seq } }, select: { storageKey: true } });
    const body = chunk ? await store!.get(chunk.storageKey) : null;
    if (!body) return res.status(404).json({ success: false, error: "Chunk not found" });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "attachment");
    return res.status(200).end(body);
  }));

  router.delete("/:id", wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!ID.test(id)) return res.status(404).json({ success: false, error: "Recording not found" });
    const removed = await deleteRecordings(db, store!, [id]);
    if (!removed) return res.status(404).json({ success: false, error: "Recording not found" });
    return res.json({ success: true, data: { deleted: removed } });
  }));
  return router;
}

// ── deletion & retention ────────────────────────────────────────────────

/** Deletes the chunk objects first, then the rows (chunks cascade). Returns recordings removed. */
export async function deleteRecordings(db: ReplayDb, store: ReplayBlobStore, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const chunks = await db.sessionRecordingChunk!.findMany({ where: { recordingId: { in: ids } }, select: { storageKey: true } });
  await store.delete(chunks.map((c: any) => c.storageKey));
  await db.sessionRecordingChunk!.deleteMany({ where: { recordingId: { in: ids } } });
  const r = await db.sessionRecording!.deleteMany({ where: { id: { in: ids } } });
  return r.count;
}

/**
 * Removes recordings past expiresAt (SESSION_REPLAY_RETENTION_DAYS, 1–90,
 * default 14, fixed at start) and closes recordings abandoned mid-upload.
 * A no-op until the tables exist or when no private store is configured.
 */
export async function purgeExpiredRecordings(
  db: ReplayDb = prisma as unknown as ReplayDb,
  store: ReplayBlobStore | null = defaultReplayStore(),
  now: Date = new Date(),
  batch = 200
): Promise<{ removed: number; closed: number }> {
  if (!db.sessionRecording?.findMany || !db.sessionRecordingChunk || !store) return { removed: 0, closed: 0 };
  try {
    let removed = 0;
    for (let i = 0; i < 50; i++) {
      const expired = await db.sessionRecording.findMany({ where: { expiresAt: { lt: now } }, select: { id: true }, take: batch });
      if (!expired.length) break;
      removed += await deleteRecordings(db, store, expired.map((r: any) => r.id));
      if (expired.length < batch) break;
    }
    const staleBefore = new Date(now.getTime() - REPLAY_LIMITS.maxDurationMs - 60 * 60_000);
    const closed = await db.sessionRecording.updateMany({ where: { status: "RECORDING", startedAt: { lt: staleBefore } }, data: { status: "COMPLETE" } });
    return { removed, closed: closed.count };
  } catch (err: any) {
    if (notReadyError(err)) return { removed: 0, closed: 0 };
    throw err;
  }
}
