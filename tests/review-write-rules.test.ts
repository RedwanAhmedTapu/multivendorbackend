// tests/review-write-rules.test.ts
//
// Increment 2 compatibility work — the WRITE rules, tested without a database.
//
//   • duplicate rule: one review per delivered order item (target) and the
//     documented pre-migration guard, including repeat purchases and legacy
//     (orderItemId NULL) coexistence;
//   • discussion replies: same-review parenting + depth ≤ 1;
//   • review images: maximum three, positions 0..2, valid URLs only;
//   • publication filter constant used by both rating aggregates;
//   • the two compound-unique call sites are gone (and the third grep hit was a
//     different model), `getMine` returns a list, and the schema matches.
//
// Pure rules + source-level checks only: no query, no network, no client.
//   npx tsx --test tests/review-write-rules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_REPLY_DEPTH,
  MAX_REVIEW_IMAGES,
  PUBLISHED_REVIEW_FILTER,
  REVIEW_WRITE_MODE,
  decideReviewWrite,
  normalizeReviewImages,
  validateReplyTarget,
} from "../src/modules/product-module/services/product/review-write-rules.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/* ── duplicate rule ────────────────────────────────────────────────────────── */

test("target rule: one review per delivered order item", () => {
  const decision = decideReviewWrite({
    mode: "post_migration",
    orderItemId: "oi-1",
    existingForOrderItem: { id: "rev-1", orderItemId: "oi-1" },
    existingForProduct: [],
  });
  assert.deepEqual(decision, { action: "reject_duplicate_line", reviewId: "rev-1" });
});

test("target rule: a repeat purchase is a legitimate new review", () => {
  const decision = decideReviewWrite({
    mode: "post_migration",
    orderItemId: "oi-2",
    existingForOrderItem: null,
    existingForProduct: [{ id: "rev-1", orderItemId: "oi-1" }],
  });
  assert.deepEqual(decision, { action: "create" });
});

test("target rule: a legacy review (orderItemId NULL) may coexist with a new linked one", () => {
  const decision = decideReviewWrite({
    mode: "post_migration",
    orderItemId: "oi-3",
    existingForOrderItem: null,
    existingForProduct: [{ id: "legacy-1", orderItemId: null }],
  });
  assert.deepEqual(decision, { action: "create" });
});

test("target rule: a create without a delivered line is refused, never guessed", () => {
  assert.deepEqual(
    decideReviewWrite({ mode: "post_migration", orderItemId: null, existingForProduct: [] }),
    { action: "reject_missing_purchase_link" },
  );
  assert.deepEqual(
    decideReviewWrite({ mode: "post_migration", orderItemId: undefined, existingForProduct: [] }),
    { action: "reject_missing_purchase_link" },
  );
});

test("pre-migration guard: at most one review per (user, product) — documented, temporary", () => {
  assert.equal(REVIEW_WRITE_MODE, "pre_migration", "the live mode until the migration is applied");
  assert.deepEqual(
    decideReviewWrite({ mode: "pre_migration", existingForProduct: [{ id: "rev-1" }] }),
    { action: "reject_existing_product_review", reviewId: "rev-1" },
  );
  assert.deepEqual(decideReviewWrite({ mode: "pre_migration", existingForProduct: [] }), {
    action: "create",
  });
});

/* ── replies ───────────────────────────────────────────────────────────────── */

test("a top-level comment needs no parent", () => {
  assert.deepEqual(validateReplyTarget({ reviewId: "r1", parentId: null }), { ok: true });
  assert.deepEqual(validateReplyTarget({ reviewId: "r1", parentId: undefined }), { ok: true });
});

test("a reply may hang off a top-level comment of the SAME review", () => {
  assert.deepEqual(
    validateReplyTarget({
      reviewId: "r1",
      parentId: "c1",
      parent: { id: "c1", reviewId: "r1", parentId: null },
    }),
    { ok: true },
  );
});

test("a reply to another review's comment is rejected (cross-review parent)", () => {
  assert.deepEqual(
    validateReplyTarget({
      reviewId: "r1",
      parentId: "c2",
      parent: { id: "c2", reviewId: "r2", parentId: null },
    }),
    { ok: false, reason: "PARENT_NOT_IN_REVIEW" },
  );
  assert.deepEqual(validateReplyTarget({ reviewId: "r1", parentId: "missing" }), {
    ok: false,
    reason: "PARENT_NOT_IN_REVIEW",
  });
});

test("depth is limited to one level of replies", () => {
  assert.equal(MAX_REPLY_DEPTH, 1);
  assert.deepEqual(
    validateReplyTarget({
      reviewId: "r1",
      parentId: "c2",
      parent: { id: "c2", reviewId: "r1", parentId: "c1" }, // already a reply
    }),
    { ok: false, reason: "DEPTH_LIMIT" },
  );
});

test("a comment may never be its own parent", () => {
  assert.deepEqual(validateReplyTarget({ reviewId: "r1", parentId: "r1" }), {
    ok: false,
    reason: "SELF_PARENT",
  });
});

/* ── images ────────────────────────────────────────────────────────────────── */

test("up to three images, positions 0–2", () => {
  assert.equal(MAX_REVIEW_IMAGES, 3);
  const empty = normalizeReviewImages([]);
  assert.deepEqual(empty, { ok: true, images: [] });

  const three = normalizeReviewImages(["/uploads/reviews/a.jpg", "/uploads/reviews/b.jpg", "https://cdn/x.png"]);
  assert.equal(three.ok, true);
  if (three.ok) {
    assert.deepEqual(
      three.images.map((i) => i.position),
      [0, 1, 2],
    );
  }
});

test("a fourth image is refused (and the DB enforces it too)", () => {
  const four = normalizeReviewImages([
    "/uploads/reviews/a.jpg",
    "/uploads/reviews/b.jpg",
    "/uploads/reviews/c.jpg",
    "/uploads/reviews/d.jpg",
  ]);
  assert.deepEqual(four, { ok: false, reason: "TOO_MANY" });
});

test("blank and duplicate URLs never consume a slot; junk URLs are rejected", () => {
  const out = normalizeReviewImages(["  ", "/uploads/reviews/a.jpg", "/uploads/reviews/a.jpg", ""]);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.images.length, 1);

  for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAA", "ftp://x/y.png", "../etc/passwd"]) {
    assert.deepEqual(normalizeReviewImages([bad]), { ok: false, reason: "INVALID_URL" }, bad);
  }
});

/* ── aggregates ────────────────────────────────────────────────────────────── */

test("one publication filter constant for both aggregates", () => {
  assert.deepEqual(PUBLISHED_REVIEW_FILTER, { status: "PUBLISHED" });
  // Documented, not wired: the frozen client has no `status` field yet.
  const rating = read("src/modules/product-module/services/product/product-rating.service.ts");
  const summary = read("src/modules/product-module/services/product/review-summary.service.ts");
  assert.doesNotMatch(rating, /status:\s*"PUBLISHED"/, "not wired before the client can see it");
  assert.doesNotMatch(summary, /status:\s*"PUBLISHED"/, "not wired before the client can see it");
});

/* ── the compound-unique rewrite ───────────────────────────────────────────── */

test("neither review call site uses the removed compound selector any more", () => {
  const service = read("src/modules/product-module/services/product/review.service.ts");
  const controller = read("src/modules/product-module/controllers/review.controller.ts");
  // The COMPOUND SELECTOR shape, not the word: the service documents the removed
  // selector in a comment, which is fine.
  assert.doesNotMatch(service, /userId_productId:\s*\{/);
  assert.doesNotMatch(controller, /userId_productId/);
  assert.match(service, /prisma\.review\.findMany\(\{\s*where: \{ userId, productId: input\.productId \}/);
  assert.doesNotMatch(service, /async getByUserAndProduct/);
  assert.match(service, /async listByUserAndProduct\(userId: string, productId: string\)/);
  assert.match(service, /orderBy: \{ createdAt: "desc" \}/);
  assert.match(controller, /ReviewService\.listByUserAndProduct\(userId, req\.params\.productId\)/);
});

test("the third grep hit was a different model, not a review call site", () => {
  const filter = read("src/modules/product-module/services/product/product-filter.service.ts");
  assert.match(filter, /recentlyViewedProduct\.upsert\(\{\s*where: \{ userId_productId: \{ userId, productId \} \}/);
});

test("the duplicate check goes through the policy module", () => {
  const service = read("src/modules/product-module/services/product/review.service.ts");
  assert.match(service, /decideReviewWrite\(\{/);
  assert.match(service, /mode: REVIEW_WRITE_MODE/);
  // pre_migration: any non-create decision rejects (the DB index still enforces
  // one-review-per-product). post_migration: the line-level actions are handled.
  assert.match(service, /decision\.action !== "create"/);
  assert.match(service, /decision\.action === "reject_duplicate_line"/);
  assert.match(service, /decision\.action === "reject_missing_purchase_link"/);
  // The eligibility rule still runs before the insert.
  const create = service.slice(service.indexOf("async create("), service.indexOf("async update("));
  assert.ok(
    create.indexOf("ReviewEligibilityService.assert") < create.indexOf("prisma.review.create"),
    "eligibility before insert",
  );
});

/* ── schema shape ──────────────────────────────────────────────────────────── */

test("the schema has only PUBLISHED/HIDDEN and the same-review composite parent FK", () => {
  const schema = read("prisma/schema.prisma");
  const enumBlock = schema.slice(schema.indexOf("enum ReviewStatus {"), schema.indexOf("}", schema.indexOf("enum ReviewStatus {")));
  assert.match(enumBlock, /PUBLISHED/);
  assert.match(enumBlock, /HIDDEN/);
  assert.doesNotMatch(enumBlock, /PENDING|REPORTED/, "no moderation state without its workflow");
  assert.match(schema, /@@unique\(\[id, reviewId\]\)/);
  assert.match(schema, /parent\s+ReviewComment\?\s+@relation\("ReviewCommentReplies", fields: \[parentId, reviewId\], references: \[id, reviewId\]/);
});
