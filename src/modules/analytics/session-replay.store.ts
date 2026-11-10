// modules/analytics/session-replay.store.ts
//
// Where recording chunks live. Only metadata goes to Postgres; the chunk
// bodies (gzip of rrweb JSON, as uploaded) go to object storage through the
// shared R2 client (lib/r2-client.ts).
//
// Recordings must never be publicly readable, so the store needs its OWN
// bucket — SESSION_REPLAY_R2_BUCKET — that has no public domain bound to it.
// It never falls back to the public media bucket (R2_BUCKET_NAME): without
// the variable, replay simply isn't available. Keys also carry a random part.

import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getR2Client } from "../../lib/r2-client.ts";

export type ReplayBlobStore = {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(keys: string[]): Promise<void>;
};

export function chunkStorageKey(recordingId: string, seq: number): string {
  return `session-replay/${recordingId}/${String(seq).padStart(5, "0")}-${randomBytes(8).toString("hex")}.json.gz`;
}

export function r2ReplayStore(
  bucket: string | undefined = process.env.SESSION_REPLAY_R2_BUCKET,
  client: () => { send: (cmd: any) => Promise<any> } = getR2Client
): ReplayBlobStore | null {
  const name = (bucket ?? "").trim();
  if (!name) return null;
  return {
    async put(key, body) {
      await client().send(
        new PutObjectCommand({ Bucket: name, Key: key, Body: body, ContentType: "application/octet-stream", CacheControl: "private, no-store" })
      );
    },
    async get(key) {
      try {
        const r = await client().send(new GetObjectCommand({ Bucket: name, Key: key }));
        const bytes = await r.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch (err: any) {
        if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        if (!batch.length) continue;
        const out: any = await client().send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
        // Quiet mode still reports per-key failures in Errors; ignoring them would let the
        // caller delete the rows and orphan the objects with nothing left to retry from.
        const failed: any[] = Array.isArray(out?.Errors) ? out.Errors : [];
        if (failed.length) throw new Error(`replay delete: ${failed.length} object(s) not removed`);
      }
    },
  };
}

const KEY = /^session-replay\/[A-Za-z0-9_-]{1,64}\/\d{5}-[0-9a-f]{16}\.json\.gz$/;

/**
 * Local-disk store for SYNTHETIC test runs on a developer machine only:
 * SESSION_REPLAY_LOCAL_DIR=<absolute path>. Refused when NODE_ENV=production,
 * for relative paths, and for any key not produced by chunkStorageKey (so a
 * key can never escape the directory). No R2, no network.
 */
export function localReplayStore(
  dir: string | undefined = process.env.SESSION_REPLAY_LOCAL_DIR,
  nodeEnv: string | undefined = process.env.NODE_ENV
): ReplayBlobStore | null {
  const root = (dir ?? "").trim();
  if (!root || nodeEnv === "production" || !isAbsolute(root)) return null;
  const file = (key: string) => {
    if (!KEY.test(key)) throw new Error("invalid replay key");
    return join(root, ...key.split("/"));
  };
  const missing = (err: any) => err?.code === "ENOENT";
  return {
    async put(key, body) {
      const f = file(key);
      await mkdir(join(f, ".."), { recursive: true });
      await writeFile(f, body);
    },
    async get(key) {
      try {
        return await readFile(file(key));
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    async delete(keys) {
      for (const k of keys) await unlink(file(k)).catch((err) => (missing(err) ? undefined : Promise.reject(err)));
    },
  };
}

/** The private R2 bucket when configured; otherwise the dev-only local store; otherwise none (replay unavailable). */
export function defaultReplayStore(): ReplayBlobStore | null {
  return r2ReplayStore() ?? localReplayStore();
}

/** In-memory store for tests and local synthetic runs. */
export function memoryReplayStore(): ReplayBlobStore & { blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>();
  return {
    blobs,
    async put(key, body) {
      blobs.set(key, Buffer.from(body));
    },
    async get(key) {
      return blobs.get(key) ?? null;
    },
    async delete(keys) {
      for (const k of keys) blobs.delete(k);
    },
  };
}
