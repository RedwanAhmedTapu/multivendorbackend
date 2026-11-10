// tests/review-aggregate-visibility.test.ts
//
// Public aggregates must count PUBLISHED reviews only.
//
// With the current generated client `Review.status` does not exist, so the
// predicate intentionally degrades to { productId } — identical to the old
// behaviour, no number moves. These tests pin BOTH halves of that contract:
//
//   • the predicate's shape today (no status key → no change in behaviour) and
//     its shape once the column exists (status = PUBLISHED);
//   • that product-rating and review-summary actually build their aggregate
//     query from that predicate — captured from the real service code with a
//     stubbed prisma, not asserted from a constant.
//
//   npx tsx --test tests/review-aggregate-visibility.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { prisma } from "../src/config/prisma.ts";
import { ProductRatingService } from "../src/modules/product-module/services/product/product-rating.service.ts";
import { ReviewSummaryService } from "../src/modules/product-module/services/product/review-summary.service.ts";
import {
  REVIEW_SCHEMA_READY,
  publishedReviewWhere,
} from "../src/modules/product-module/services/product/review-moderation.scope.ts";

const SRC = new URL("../src/modules/product-module/services/product/", import.meta.url);
const source = (file: string) => readFileSync(new URL(file, SRC), "utf8");

test("predicate: disabled path stays bare, enabled path filters PUBLISHED", () => {
  // Readiness is ON now; the disabled branch is exercised explicitly so the
  // old behaviour stays covered and a regression would be caught.
  assert.equal(REVIEW_SCHEMA_READY, true);
  assert.deepEqual(publishedReviewWhere("p1", false), { productId: "p1" });
  assert.equal("status" in publishedReviewWhere("p1", false), false);

  assert.deepEqual(publishedReviewWhere("p1"), { productId: "p1", status: "PUBLISHED" });
  assert.deepEqual(publishedReviewWhere("p1", true), { productId: "p1", status: "PUBLISHED" });

  // The default follows the live flag, so there is exactly one switch.
  assert.deepEqual(publishedReviewWhere("p1"), REVIEW_SCHEMA_READY ? { productId: "p1", status: "PUBLISHED" } : { productId: "p1" });
});

test("ProductRatingService builds its aggregate from the visibility predicate", async () => {
  const originalAggregate = (prisma as any).review.aggregate;
  const originalUpdate = (prisma as any).product.update;
  let capturedWhere: unknown = null;
  let written: unknown = null;

  (prisma as any).review.aggregate = async (args: any) => {
    capturedWhere = args.where;
    return { _avg: { rating: 4.26 }, _count: { rating: 7 } };
  };
  (prisma as any).product.update = async (args: any) => {
    written = args.data;
    return {};
  };

  try {
    const result = await ProductRatingService.recalculate("p1");
    assert.deepEqual(capturedWhere, { productId: "p1", status: "PUBLISHED" });
    assert.equal("status" in (capturedWhere as object), true, "hidden reviews must not reach the average");
    // One decimal place, count straight through.
    assert.deepEqual(result, { avgRating: 4.3, reviewCount: 7 });
    assert.deepEqual(written, { avgRating: 4.3, reviewCount: 7 });
  } finally {
    (prisma as any).review.aggregate = originalAggregate;
    (prisma as any).product.update = originalUpdate;
  }
});

test("review summary counts only the reviews the predicate allows", async () => {
  const originalGroupBy = (prisma as any).review.groupBy;
  const originalFind = (prisma as any).product.findUnique;
  let capturedWhere: unknown = null;

  (prisma as any).review.groupBy = async (args: any) => {
    capturedWhere = args.where;
    return [
      { rating: 5, _count: { rating: 3 } },
      { rating: 4, _count: { rating: 1 } },
      { rating: 1, _count: { rating: 2 } },
    ];
  };
  (prisma as any).product.findUnique = async () => ({ avgRating: 4.2, reviewCount: 6 });

  try {
    const summary = await ReviewSummaryService.getSummary("p1");
    assert.deepEqual(capturedWhere, { productId: "p1", status: "PUBLISHED" });
    const dist = summary.ratingDistribution as { star: number; count: number }[];
    assert.equal(dist.length, 5);
    // Object.entries yields integer keys in ascending order, so assert by star
    // rather than by position. The frontend re-sorts into 5..1 for display.
    assert.deepEqual(
      Object.fromEntries(dist.map((d) => [d.star, d.count])),
      { 1: 2, 2: 0, 3: 0, 4: 1, 5: 3 }
    );
    assert.equal(summary.totalReviews, 6);
  } finally {
    (prisma as any).review.groupBy = originalGroupBy;
    (prisma as any).product.findUnique = originalFind;
  }
});

test("neither public aggregate can drift back to a bare product scope", () => {
  for (const file of ["product-rating.service.ts", "review-summary.service.ts"]) {
    const body = source(file);
    assert.match(body, /publishedReviewWhere\(/, `${file} must use the shared predicate`);
    assert.doesNotMatch(
      body,
      /where:\s*\{\s*productId\s*\}/,
      `${file} must not inline a product-only aggregate filter`
    );
  }
});
