// tests/review-migration-a-guard.test.ts
//
// Static guard for Migration A (20261019120000_review_system_increment_2_additive).
//
// Encodes the Phase-3 preflight conclusions so they cannot drift between review
// and apply:
//   • the file is byte-identical to the reviewed version (its checksum is what
//     Prisma records — an edit after apply is a hard error, so pin it now);
//   • nothing destructive, nothing rewritten: additive DDL only;
//   • the blast radius is exactly reviews / review_images / review_comments;
//   • reviews_userId_productId_key is never touched (Migration B's job);
//   • nullability/defaults/FK actions/CHECK match schema.prisma.
//
// Reads files only. No database, no client.
//   npx tsx --test tests/review-migration-a-guard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const A_PATH = new URL(
  "../prisma/migrations/20261019120000_review_system_increment_2_additive/migration.sql",
  import.meta.url
);
const bytes = readFileSync(A_PATH);
const source = bytes.toString("utf8");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

/** Comments stripped, then split on `;` so multi-line statements stay whole. */
const statements = source
  .replace(/^\s*--.*$/gm, "")
  .split(";")
  .map((s) => s.replace(/\s+/g, " ").trim())
  .filter(Boolean);

const find = (prefix: string) => statements.find((s) => s.startsWith(prefix));

test("Migration A is byte-identical to the reviewed file", () => {
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, "f3f5adc3b38ea007381ffacaa666671cb7c509fcc7ad2c5ebd6a9f14de729179");
  assert.equal(statements.length, 18, "18 statements, as reviewed");
});

test("no destructive or rewriting statement exists anywhere", () => {
  assert.doesNotMatch(source, /\bDROP\b/i);
  assert.doesNotMatch(source, /\bTRUNCATE\b/i);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(source, /ALTER\s+COLUMN/i);
  assert.doesNotMatch(source, /\bRENAME\b/i);

  for (const statement of statements) {
    assert.match(
      statement,
      /^(CREATE (TYPE "ReviewStatus" AS ENUM|TABLE "review_\w+"|UNIQUE INDEX "[\w]+" ON "[\w]+"|INDEX "[\w]+" ON "[\w]+")|ALTER TABLE "[\w]+" ADD (COLUMN|CONSTRAINT))/,
      `unexpected statement: ${statement.slice(0, 90)}`
    );
    assert.doesNotMatch(statement, /^(UPDATE|DELETE|TRUNCATE|DROP)/i);
  }
});

test("blast radius is exactly the three review tables plus the enum", () => {
  const targets = new Set<string>();
  for (const statement of statements) {
    const alter = statement.match(/^ALTER TABLE "(\w+)"/);
    if (alter) targets.add(alter[1]);
    const create = statement.match(/^CREATE TABLE "(\w+)"/);
    if (create) targets.add(create[1]);
    const index = statement.match(/^CREATE (?:UNIQUE )?INDEX "[\w]+" ON "(\w+)"/);
    if (index) targets.add(index[1]);
  }
  assert.deepEqual([...targets].sort(), ["review_comments", "review_images", "reviews"]);

  // Only a reference to order_items is allowed — never a mutation of it.
  assert.ok(statements.some((s) => s.includes('REFERENCES "order_items"("id")')));
  assert.equal(statements.some((s) => s.startsWith('ALTER TABLE "order_items"')), false);
  for (const table of ["vendor_returns", "vendor_return_items", "refunds", "warehouse_stock", "products", "orders"]) {
    assert.equal(
      statements.some((s) => s.startsWith(`ALTER TABLE "${table}"`) || s.startsWith(`CREATE TABLE "${table}"`)),
      false,
      `Migration A must not touch ${table}`
    );
  }
});

test("the legacy product-level unique index is left strictly alone", () => {
  const code = source.split(/\r?\n/).filter((line) => !line.trim().startsWith("--"));
  assert.equal(
    code.filter((line) => line.includes("reviews_userId_productId_key")).length,
    0,
    "only Migration B may touch reviews_userId_productId_key"
  );
});

test("reviews columns: nullable link, defaulted status, no rewrite", () => {
  const addColumns = find('ALTER TABLE "reviews" ADD COLUMN')!;
  assert.match(addColumns, /ADD COLUMN "orderItemId" TEXT,/);
  assert.doesNotMatch(addColumns, /"orderItemId" TEXT NOT NULL/);
  assert.match(addColumns, /ADD COLUMN "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED'/);
  assert.match(addColumns, /ADD COLUMN "vendorReply" TEXT/);
  assert.match(addColumns, /ADD COLUMN "vendorReplyAt" TIMESTAMP\(3\)/);
  assert.match(addColumns, /ADD COLUMN "vendorReplyByUserId" TEXT/);
});

test("enum carries exactly the two states the workflow implements", () => {
  assert.ok(statements.includes(`CREATE TYPE "ReviewStatus" AS ENUM ('PUBLISHED', 'HIDDEN')`));
});

test("indexes added are the four reviewed ones plus the lookup pair", () => {
  const names = statements
    .map((s) => s.match(/^CREATE (?:UNIQUE )?INDEX "(\w+)"/)?.[1])
    .filter(Boolean)
    .sort();
  assert.deepEqual(names, [
    "review_comments_id_reviewId_key",
    "review_comments_parentId_idx",
    "review_comments_reviewId_createdAt_idx",
    "review_images_reviewId_position_key",
    "reviews_orderItemId_key",
    "reviews_productId_status_createdAt_idx",
    "reviews_status_idx",
    "reviews_userId_productId_idx",
  ]);
});

test("image cap is enforced in the database, not only in code", () => {
  assert.ok(
    statements.some(
      (s) =>
        s.startsWith('ALTER TABLE "review_images" ADD CONSTRAINT "review_images_position_range"') &&
        s.includes('CHECK ("position" >= 0 AND "position" < 3)')
    )
  );
  assert.ok(
    statements.includes(
      'CREATE UNIQUE INDEX "review_images_reviewId_position_key" ON "review_images"("reviewId", "position")'
    )
  );
});

test("foreign keys keep the reviewed referential actions", () => {
  const fks = statements.filter((s) => s.includes(" ADD CONSTRAINT") && s.includes("FOREIGN KEY"));
  assert.equal(fks.length, 5, "orderItem + 2 review-comment relations + images + composite parent");
  const byName = (needle: string) => fks.find((s) => s.includes(needle))!;
  assert.match(byName("reviews_orderItemId_fkey"), /ON DELETE SET NULL ON UPDATE CASCADE/);
  assert.match(byName("review_images_reviewId_fkey"), /REFERENCES "reviews"\("id"\) ON DELETE CASCADE/);
  assert.match(byName("review_comments_reviewId_fkey"), /REFERENCES "reviews"\("id"\) ON DELETE CASCADE/);
  assert.match(byName("review_comments_userId_fkey"), /REFERENCES "users"\("id"\) ON DELETE CASCADE/);
  assert.match(
    byName("review_comments_parentId_reviewId_fkey"),
    /FOREIGN KEY \("parentId", "reviewId"\) REFERENCES "review_comments"\("id", "reviewId"\) ON DELETE CASCADE/
  );
});

test("schema.prisma still matches what the migration will create", () => {
  assert.match(schema, /enum ReviewStatus \{[\s\S]{0,80}PUBLISHED[\s\S]{0,20}HIDDEN/);
  assert.match(schema, /orderItemId String\? @unique/);
  assert.match(schema, /status ReviewStatus @default\(PUBLISHED\)/);
  assert.match(schema, /@@index\(\[productId, status, createdAt\]\)/);
  assert.match(schema, /@@index\(\[userId, productId\]\)/);
  assert.match(schema, /@@index\(\[status\]\)/);
  assert.match(schema, /model ReviewImage \{/);
  assert.match(schema, /model ReviewComment \{/);
  assert.match(schema, /@@unique\(\[reviewId, position\]\)/);
  assert.match(schema, /@@unique\(\[id, reviewId\]\)/);
  assert.match(schema, /fields: \[parentId, reviewId\], references: \[id, reviewId\]/);
});

test("the Review model no longer declares a product-level unique (one per order line instead)", () => {
  const start = schema.indexOf("model Review {");
  assert.ok(start > 0);
  const end = schema.indexOf("\n}", start);
  const body = schema.slice(start, end + 2);
  assert.doesNotMatch(body, /@@unique\(\[userId, productId\]\)/);
  // The same pair legitimately exists on another model — a whole-file grep would
  // be a false positive, which is why this assertion is scoped.
  assert.match(schema, /model RecentlyViewedProduct \{[\s\S]*?@@unique\(\[userId, productId\]\)/);
});
