// tests/pos-credit-postgres.test.ts
//
// The customer-credit SQL (posCustomerSql) against a REAL PostgreSQL, run
// through the same Serializable runStockMutation the POS sale uses.
// Opt-in: set POS_PG_TEST_URL to a throwaway LOCAL database, e.g.
//   POS_PG_TEST_URL=postgresql://postgres@127.0.0.1:55432/pos_credit_test
// Each run creates and drops its own schema. Anything but a localhost URL is refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { posCustomerSql } from "../src/services/pos.service.ts";
import { runStockMutation } from "../src/modules/shared/stock-mutations.ts";

const URL_ = process.env.POS_PG_TEST_URL ?? "";
const local = /^postgres(ql)?:\/\/[^@]*@?(127\.0\.0\.1|localhost)(:\d+)?\//.test(URL_);
const skip = !URL_ ? "POS_PG_TEST_URL not set" : !local ? "POS_PG_TEST_URL must point at localhost" : false;

const SCHEMA = `pos_credit_${process.pid}`;
let db: PrismaClient;

before(async () => {
  if (skip) return;
  db = new PrismaClient({ datasourceUrl: `${URL_}${URL_.includes("?") ? "&" : "?"}schema=${SCHEMA}` });
  const baseline = readFileSync(new URL("../prisma/proposed/20261022200000_pos_baseline/migration.sql", import.meta.url), "utf8");
  const start = baseline.indexOf('CREATE TABLE IF NOT EXISTS "public"."pos_customers"');
  const ddl = baseline.slice(start, baseline.indexOf(");", start) + 2).replace('"public".', "");
  await db.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
  await db.$executeRawUnsafe(`SET search_path TO "${SCHEMA}"`);
  await db.$executeRawUnsafe(ddl);
});

after(async () => {
  if (skip || !db) return;
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

let n = 0;
async function customer(fields: { loanLimit?: number; due?: number; vendorId?: string } = {}) {
  const id = `cust_${++n}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "pos_customers" ("id","vendorId","name","phone","loanLimit","due","loanBalance","updatedAt") VALUES ($1,$2,'C',$3,$4,$5,$5,NOW())`,
    id, fields.vendorId ?? "V1", `017${n}`, fields.loanLimit ?? 0, fields.due ?? 0,
  );
  return id;
}
const row = async (id: string) =>
  ((await db.$queryRawUnsafe(`SELECT "due","loanBalance","orders","spent","lastOrderAt" FROM "pos_customers" WHERE "id" = $1`, id)) as any[])[0];
const sell = (id: string, due: number, net = due, vendorId = "V1", at = new Date("2026-10-25T09:30:00Z")) =>
  runStockMutation(db, (tx) => tx.$executeRaw(posCustomerSql.sale(id, vendorId, due, net, at)));

test("limit 0 refuses any credit; a fully paid sale still counts", { skip }, async () => {
  const c = await customer({ loanLimit: 0 });
  assert.equal(await sell(c, 10), 0, "no credit facility");
  assert.equal(await sell(c, 0, 250), 1, "paid sale is fine");
  const r = await row(c);
  assert.equal(r.due, 0);
  assert.equal(r.orders, 1);
  assert.equal(r.spent, 250);
});

test("within, exactly at and above the limit; existing debt counts", { skip }, async () => {
  const c = await customer({ loanLimit: 100, due: 40 });
  assert.equal(await sell(c, 61), 0, "40 + 61 > 100");
  assert.equal(await sell(c, 60), 1, "40 + 60 = 100 is allowed");
  assert.equal(await sell(c, 0.01), 0, "nothing left");
  const r = await row(c);
  assert.equal(r.due, 100);
  assert.equal(r.loanBalance, 100, "loanBalance mirrors due");
  assert.equal(r.orders, 1, "the refused sales did not count");
  assert.equal(new Date(r.lastOrderAt).toISOString(), "2026-10-25T09:30:00.000Z", "stored as UTC");
});

test("another vendor's id never matches", { skip }, async () => {
  const c = await customer({ loanLimit: 500, vendorId: "V2" });
  assert.equal(await sell(c, 10, 10, "V1"), 0);
  assert.equal((await row(c)).due, 0);
});

test("concurrent sales cannot spend the same headroom (Serializable + retry)", { skip }, async () => {
  const c = await customer({ loanLimit: 100 });
  const attempt = () =>
    runStockMutation(db, async (tx) => {
      const k = await tx.$executeRaw(posCustomerSql.sale(c, "V1", 30, 30, new Date()));
      await tx.$executeRawUnsafe("SELECT pg_sleep(0.05)"); // keep the transactions overlapping
      return k;
    }).catch((e) => e);
  const results = await Promise.all(Array.from({ length: 8 }, attempt));
  const errors = results.filter((r) => typeof r !== "number");
  const won = results.filter((r) => r === 1).length;
  const r = await row(c);
  assert.ok(r.due <= 100, `due ${r.due} stays within the limit`);
  assert.equal(r.due, won * 30, "due equals exactly the committed sales");
  assert.equal(r.orders, won);
  assert.equal(won, 3, `3 × 30 fit in 100 (errors: ${errors.map((e: any) => e?.code ?? e?.message).join(",")})`);
});

test("refund/void and collection clear the due without going negative; loanBalance follows", { skip }, async () => {
  const c = await customer({ loanLimit: 300 });
  await sell(c, 200, 300);
  await runStockMutation(db, (tx) => tx.$executeRaw(posCustomerSql.collect(c, "V1", 50)));
  let r = await row(c);
  assert.equal(r.due, 150);
  await runStockMutation(db, (tx) => tx.$executeRaw(posCustomerSql.reverse(c, "V1", 150, 300, true)));
  r = await row(c);
  assert.deepEqual([r.due, r.loanBalance, r.orders, r.spent], [0, 0, 0, 0], "void undoes the sale");
  await runStockMutation(db, (tx) => tx.$executeRaw(posCustomerSql.collect(c, "V1", 999)));
  assert.equal((await row(c)).due, 0, "never negative");
});
