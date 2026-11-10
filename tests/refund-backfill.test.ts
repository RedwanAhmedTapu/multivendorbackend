// tests/refund-backfill.test.ts
//
// PHASE 4 (H-2 / D1 / D3): offline checks of the artifacts that are NOT run.
//   D3 — detect-orphan-refunds.sql contains SELECT statements only; the
//        backfill script is a dry run unless BOTH --apply and
//        CONFIRM_REFUND_BACKFILL=yes are given; a dry run never writes; an
//        apply run inserts only missing records (re-checked per refund), skips
//        refunds without a paid payment, and never changes a Refund row.
//   D1 — the migration is additive (nullable column + unique index, no data
//        change); the schema declares the field; the key is written only when
//        REFUND_IDEMPOTENCY_KEYS=1 (after the migration is applied).
//
// Nothing here touches a database: the backfill runs against an in-memory db.
//   npx tsx --test tests/refund-backfill.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backfillRefundRecords, buildRefundRecordData, writesAllowed } from "../scripts/refund-records/backfill-refund-records.ts";
import { createCancellationRefundOnce } from "../src/services/order.service.ts";

type Row = Record<string, any>;
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const stripSqlComments = (sql: string) => sql.replace(/--.*$/gm, "");

// ── D3: detection query ─────────────────────────────────────────────────────

test("D3: the detection SQL is read-only (SELECT statements only)", () => {
  const sql = stripSqlComments(read("scripts/refund-records/detect-orphan-refunds.sql"));
  const statements = sql.split(";").map((x) => x.trim()).filter(Boolean);
  assert.ok(statements.length >= 1);
  for (const st of statements) assert.match(st, /^SELECT\b/i, st.slice(0, 40));
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|COPY)\b/i);
  assert.match(sql, /LEFT JOIN "refund_records" rr ON rr\."refundId" = r\."id"/);
  assert.match(sql, /WHERE rr\."id" IS NULL/);
});

// ── D3: backfill script ─────────────────────────────────────────────────────

test("D3: writes need BOTH --apply and CONFIRM_REFUND_BACKFILL=yes", () => {
  assert.equal(writesAllowed([], {}), false);
  assert.equal(writesAllowed(["--apply"], {}), false);
  assert.equal(writesAllowed(["--apply"], { CONFIRM_REFUND_BACKFILL: "true" }), false);
  assert.equal(writesAllowed([], { CONFIRM_REFUND_BACKFILL: "yes" }), false);
  assert.equal(writesAllowed(["--apply"], { CONFIRM_REFUND_BACKFILL: "yes" }), true);
});

function fakeDb(opts: { existingRecordFor?: string } = {}) {
  const writes: string[] = [];
  const records: Row[] = [];
  const orphans = [
    { id: "RF1", orderId: "O1", amount: 1500, reason: "Customer cancel", status: "PENDING", order: { userId: "U1", vendorOrders: [{ vendorId: "V1" }] } },
    { id: "RF2", orderId: "O2", amount: 200, reason: null, status: "REFUNDED", order: { userId: "U2", vendorOrders: [] } },
    { id: "RF3", orderId: "O3", amount: 50, reason: "x", status: "PENDING", order: { userId: null, vendorOrders: [] } },
  ];
  const payments: Record<string, Row> = {
    O1: { amount: 1500, sslCommerzDetail: { tranId: "T1", vendorId: "V9", customerId: "U1" } },
    O2: { amount: 1000, sslCommerzDetail: null },
  };
  const db = {
    refund: {
      findMany: async ({ where }: any) => {
        assert.deepEqual(where, { detail: { is: null } });
        return structuredClone(orphans);
      },
      update: async () => assert.fail("a Refund row is never changed"),
      updateMany: async () => assert.fail("a Refund row is never changed"),
    },
    payment: { findFirst: async ({ where }: any) => structuredClone(payments[where.orderId] ?? null) },
    $transaction: async (fn: any) => {
      writes.push("$transaction");
      return fn({
        refundRecord: {
          findUnique: async ({ where }: any) => (where.refundId === opts.existingRecordFor ? { id: "EXISTING" } : null),
          create: async ({ data }: any) => (records.push(data), data),
        },
      });
    },
  };
  return { db, writes, records };
}

test("D3: a dry run reads only and reports planned / manual-review refunds", async () => {
  const env = fakeDb();
  const out = await backfillRefundRecords(env.db, { apply: false });
  assert.equal(out.mode, "dry-run");
  assert.equal(out.orphanCount, 3);
  assert.deepEqual(out.planned, ["RF1", "RF2"]);
  assert.deepEqual(out.manualReview, ["RF3"], "no paid payment → manual review");
  assert.deepEqual(env.writes, [], "no transaction, no write");
  assert.deepEqual(env.records, []);
});

test("D3: an apply run inserts only the missing records, re-checking each refund", async () => {
  const env = fakeDb({ existingRecordFor: "RF2" });
  const out = await backfillRefundRecords(env.db, { apply: true });
  assert.deepEqual(out.created, ["RF1"], "RF2 already had a record (concurrent run) → skipped");
  assert.equal(env.records.length, 1);
  const rec = env.records[0];
  assert.equal(rec.refundId, "RF1");
  assert.equal(rec.status, "PENDING", "status copied, never changed");
  assert.equal(rec.refundType, "FULL_REFUND");
  assert.equal(rec.vendorId, "V9");
  assert.equal(rec.initiatedBy, "backfill:phase4");
});

test("D3: buildRefundRecordData — partial refunds and fallbacks", () => {
  const rec = buildRefundRecordData(
    { id: "RF2", amount: 200, reason: null, status: "REFUNDED", order: { userId: "U2", vendorOrders: [{ vendorId: "V2" }] } },
    { amount: 1000, sslCommerzDetail: null },
  );
  assert.equal(rec.refundType, "PARTIAL_REFUND");
  assert.equal(rec.vendorId, "V2");
  assert.equal(rec.customerId, "U2");
  assert.equal(rec.status, "REFUNDED");
  assert.match(rec.refundNumber, /^RF-\d+-[0-9A-F]{8}$/);
});

test("D3: the script does nothing on import (no auto-run)", () => {
  const src = read("scripts/refund-records/backfill-refund-records.ts");
  assert.match(src, /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\)/);
});

// ── D1: migration + flag ────────────────────────────────────────────────────

test("D1: the migration is additive — nullable column + unique index, no data change", () => {
  const sql = stripSqlComments(read("prisma/migrations/20261013000000_refund_idempotency_key/migration.sql"));
  assert.match(sql, /ALTER TABLE "refunds" ADD COLUMN "idempotencyKey" TEXT;/);
  assert.match(sql, /CREATE UNIQUE INDEX "refunds_idempotencyKey_key" ON "refunds"\("idempotencyKey"\);/);
  assert.doesNotMatch(sql, /NOT NULL|\bDROP\b|\bUPDATE\b|\bDELETE\b|\bINSERT\b/i);
  assert.match(read("prisma/schema.prisma"), /idempotencyKey String\?\s+@unique/);
});

async function cancellationRefundData(env: Record<string, string | undefined>) {
  const saved = process.env.REFUND_IDEMPOTENCY_KEYS;
  if (env.REFUND_IDEMPOTENCY_KEYS === undefined) delete process.env.REFUND_IDEMPOTENCY_KEYS;
  else process.env.REFUND_IDEMPOTENCY_KEYS = env.REFUND_IDEMPOTENCY_KEYS;
  const created: Row[] = [];
  try {
    await createCancellationRefundOnce(
      {
        payment: { findFirst: async () => ({ id: "PAY1", amount: 1500, sslCommerzDetail: null }) },
        $executeRaw: async () => 1,
        refund: { aggregate: async () => ({ _sum: { amount: null } }), create: async ({ data }: any) => (created.push(data), { id: "RF1" }) },
        order: { findUnique: async () => ({ userId: "U1", vendorOrders: [] }) },
        refundRecord: { create: async () => ({}) },
      },
      "O1",
      "cancel",
      { initiatedBy: "U1", refundType: "CUSTOMER_INITIATED" },
    );
  } finally {
    if (saved === undefined) delete process.env.REFUND_IDEMPOTENCY_KEYS;
    else process.env.REFUND_IDEMPOTENCY_KEYS = saved;
  }
  return created[0];
}

test("D1: the idempotency key is NOT written until REFUND_IDEMPOTENCY_KEYS=1 (migration not applied)", async () => {
  assert.ok(!("idempotencyKey" in (await cancellationRefundData({}))));
  assert.ok(!("idempotencyKey" in (await cancellationRefundData({ REFUND_IDEMPOTENCY_KEYS: "true" }))));
  assert.equal((await cancellationRefundData({ REFUND_IDEMPOTENCY_KEYS: "1" })).idempotencyKey, "order-cancel:O1");
});
