// tests/review-hidden-visibility.test.ts
//
// HIDDEN reviews must not reach any public surface once readiness is on, and
// nothing may change while it is off.
//
// The switch is a module constant, so ready-mode behaviour is proved two ways:
//   • the helper's own shape ({} vs { status: "PUBLISHED" });
//   • the query every surface actually builds, captured from the real code with
//     a stubbed prisma — today it must contain no status key.
// Plus source guards so a surface cannot quietly lose the filter.
//
//   npx tsx --test tests/review-hidden-visibility.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { prisma } from "../src/config/prisma.ts";
import { ReviewService } from "../src/modules/product-module/services/product/review.service.ts";
import { detailInclude } from "../src/modules/product-module/repositories/product.repository.ts";
import {
  REVIEW_SCHEMA_READY,
  publishedReviewFilter,
  publishedReviewWhere,
} from "../src/modules/product-module/services/product/review-moderation.scope.ts";
import { listReviewsQuerySchema } from "../src/modules/product-module/validators/review.validator.ts";

const source = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("filter helper: empty while off, PUBLISHED-only while on", () => {
  assert.deepEqual(publishedReviewFilter(false), {});
  assert.deepEqual(publishedReviewFilter(true), { status: "PUBLISHED" });
  // Default follows the single switch.
  assert.deepEqual(publishedReviewFilter(), REVIEW_SCHEMA_READY ? { status: "PUBLISHED" } : {});
});

test("product predicate composes the filter without duplicating keys", () => {
  assert.deepEqual(publishedReviewWhere("p1", false), { productId: "p1" });
  assert.deepEqual(publishedReviewWhere("p1", true), { productId: "p1", status: "PUBLISHED" });
});

test("public list + count exclude non-published reviews (same filter for both)", async () => {
  const originalFind = (prisma as any).review.findMany;
  const originalCount = (prisma as any).review.count;
  let listWhere: unknown = null;
  let countWhere: unknown = null;

  (prisma as any).review.findMany = async (args: any) => {
    listWhere = args.where;
    return [];
  };
  (prisma as any).review.count = async (args: any) => {
    countWhere = args.where;
    return 0;
  };

  try {
    const result = await ReviewService.listByProduct("p1", listReviewsQuerySchema.parse({ rating: "5" }));
    assert.deepEqual(listWhere, { productId: "p1", rating: 5, status: "PUBLISHED" });
    assert.equal("status" in (listWhere as object), true, "hidden reviews must not be listed");
    assert.deepEqual(countWhere, listWhere, "count must use the same filter as the list");
    assert.deepEqual(result.items, []);
    assert.equal(result.pagination.totalItems, 0);
  } finally {
    (prisma as any).review.findMany = originalFind;
    (prisma as any).review.count = originalCount;
  }
});

test("product-detail embed is built from the helper", () => {
  const where = (detailInclude as any).reviews.where;
  assert.deepEqual(where, publishedReviewFilter());
  assert.equal("status" in where, true, "hidden reviews must not appear in the product payload");
  // Sanity: the embed still carries its projection/ordering/cap.
  assert.ok((detailInclude as any).reviews.take === 10);
  assert.ok((detailInclude as any).reviews.include.user);
});

test("vendor statistics filter both its count and its average", () => {
  const body = source("modules/product-module/services/statistics/vendor-statistics.service.ts");
  assert.match(body, /import \{ publishedReviewFilter \}/);
  const uses = body.match(/publishedReviewFilter\(\)/g) ?? [];
  assert.equal(uses.length, 2, "count + aggregate must both be filtered");
});

test("vendor performance average is built from the publication filter", async () => {
  const { VendorService, vendorServiceDb } = await import("../src/services/vendor.service.ts");
  const service = new VendorService();
  // vendor.service.ts queries through its own exported client, not the shared
  // singleton — stub the exact object the class uses.
  const db: any = vendorServiceDb;

  const originalOrderAgg = db.order.aggregate;
  const originalOrderCount = db.order.count;
  const originalReviewAgg = db.review.aggregate;
  const originalUpsert = db.vendorPerformance.upsert;
  let reviewWhere: any = null;
  let upsert: any = null;

  db.order.aggregate = async () => ({ _sum: { totalAmount: 1000 }, _count: 5 });
  db.order.count = async () => 4;
  db.review.aggregate = async (args: any) => {
    reviewWhere = args.where;
    return { _avg: { rating: 4.5 } };
  };
  db.vendorPerformance.upsert = async (args: any) => {
    upsert = args;
    return args;
  };

  try {
    await service.updateVendorPerformance("v1");

    // Readiness ON: the vendor average counts only published reviews.
    assert.deepEqual(reviewWhere, { product: { vendorId: "v1" }, status: "PUBLISHED" });
    assert.equal("status" in reviewWhere, true);
    // …and it is exactly the helper's output, so flipping the switch is all that changes.
    assert.deepEqual(reviewWhere, { product: { vendorId: "v1" }, ...publishedReviewFilter() });

    // Readiness ON: the same composition carries the PUBLISHED constraint.
    const ready = { product: { vendorId: "v1" }, ...publishedReviewFilter(true) };
    assert.deepEqual(ready, { product: { vendorId: "v1" }, status: "PUBLISHED" });

    // The filtered average is what gets persisted, alongside the untouched order stats.
    assert.equal(upsert.update.avgRating, 4.5);
    assert.equal(upsert.update.totalOrders, 5);
    assert.equal(upsert.update.totalSales, 1000);
  } finally {
    db.order.aggregate = originalOrderAgg;
    db.order.count = originalOrderCount;
    db.review.aggregate = originalReviewAgg;
    db.vendorPerformance.upsert = originalUpsert;
  }
});

test("vendor performance source keeps the filter wired", () => {
  const body = source("services/vendor.service.ts");
  assert.match(body, /import \{ publishedReviewFilter \}/);
  assert.match(body, /where: \{ product: \{ vendorId \}, \.\.\.publishedReviewFilter\(\) \}/);
});

test("vendor and admin feeds project the Increment-2 fields the UIs render", () => {
  for (const file of [
    "modules/product-module/services/product/review-vendor.service.ts",
    "modules/product-module/services/product/review-admin.service.ts",
  ]) {
    const body = source(file);
    for (const field of [
      "orderItemId: true",
      "status: true",
      "vendorReply: true",
      "vendorReplyAt: true",
      "vendorReplyByUserId: true",
      "images: { select: { id: true, url: true, position: true } }",
    ]) {
      assert.ok(body.includes(field), `${file} must project ${field}`);
    }
  }
});

test("readiness is on while the write mode stays pre_migration", () => {
  assert.equal(REVIEW_SCHEMA_READY, true);
  const rules = source("modules/product-module/services/product/review-write-rules.ts");
  assert.match(rules, /REVIEW_WRITE_MODE: ReviewWriteMode = "pre_migration"/);
});
