-- Session Replay (rrweb) recording metadata — ADDITIVE ONLY.
-- Creates two NEW tables (session_recordings, session_recording_chunks), their
-- indexes and one FK between them. It does not read, alter, lock or reference any
-- existing table, and contains no DROP / UPDATE / DELETE / data statements.
-- Chunk bodies live in a private object store, never in Postgres.
--
-- Idempotent: every object is created only if missing, so a re-run is a no-op.
-- Transaction: Prisma sends the script as one multi-statement query, which
-- PostgreSQL runs as a single implicit transaction — on any error nothing persists.
-- Lock risk: only the two new (empty) tables are locked; no existing table is touched.
-- Access: tables are created in "public" owned by the migrating role; on Supabase
-- the API roles (anon / authenticated / service_role) have no USAGE on "public",
-- so these tables are not exposed through the Data API.
-- Rollback (only if no recording data must be kept):
--   DROP TABLE "public"."session_recording_chunks"; DROP TABLE "public"."session_recordings";
--   then remove this migration's row from _prisma_migrations.

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."session_recordings" (
    "id" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "journeyLabel" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "uploadTokenHash" TEXT NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'RECORDING',
    "stopReason" TEXT,
    "entryPath" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstEventAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."session_recording_chunks" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "firstEventAt" TIMESTAMP(3) NOT NULL,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_recording_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_recordings_journeyLabel_startedAt_idx" ON "public"."session_recordings"("journeyLabel", "startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_recordings_sessionKey_idx" ON "public"."session_recordings"("sessionKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_recordings_startedAt_idx" ON "public"."session_recordings"("startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_recordings_expiresAt_idx" ON "public"."session_recordings"("expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_recordings_status_startedAt_idx" ON "public"."session_recordings"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "session_recording_chunks_recordingId_seq_key" ON "public"."session_recording_chunks"("recordingId", "seq");

-- AddForeignKey (only if missing — keeps the migration re-runnable)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'session_recording_chunks' AND c.conname = 'session_recording_chunks_recordingId_fkey'
  ) THEN
    ALTER TABLE "public"."session_recording_chunks" ADD CONSTRAINT "session_recording_chunks_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "public"."session_recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
