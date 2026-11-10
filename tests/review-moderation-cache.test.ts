// tests/review-moderation-cache.test.ts
//
// Moderation side-effects that only a stubbed run can prove without a database:
//   • hiding / republishing invalidates the product cache with the right keys;
//   • a no-op status change writes nothing and invalidates nothing;
//   • a missing vendor_performance row is reported as a partial outcome;
//   • a failing vendor write surfaces as an error, not as success;
//   • vendor statistics really passes the publication filter to Prisma.
//
// Stubs only — no database, no Redis connection. Like the application itself,
// importing the cache layer requires REDIS_HOST / REDIS_PORT / REDIS_PASSWORD to
// be present in the environment; the suite invokes no Redis command.
//   npx tsx --test tests/review-moderation-cache.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../src/config/prisma.ts";
import redisClient from "../src/config/redis.ts";
import { ReviewAdminService } from "../src/modules/product-module/services/product/review-admin.service.ts";
import { ReviewAdminController } from "../src/modules/product-module/controllers/review-admin.controller.ts";
import { VendorStatisticsService } from "../src/modules/product-module/services/statistics/vendor-statistics.service.ts";

const fakeRes = () => {
  const res: any = { statusCode: 0, body: null };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
};

/** Redis stub: records deleted keys, never opens a socket. */
function stubRedis() {
  const client: any = redisClient;
  const deleted: string[] = [];
  const original = {
    get: client.get,
    set: client.set,
    del: client.del,
    scanIterator: client.scanIterator,
  };
  client.get = async () => null;
  client.set = async () => "OK";
  client.del = async (...keys: string[]) => {
    deleted.push(...keys.flat());
    return keys.length;
  };
  client.scanIterator = async function* () {};
  return {
    deleted,
    restore() {
      client.get = original.get;
      client.set = original.set;
      client.del = original.del;
      client.scanIterator = original.scanIterator;
    },
  };
}

/** Prisma stub for moderation: currentStatus drives the transition. */
function stubModerationPrisma(options: {
  currentStatus: string;
  vendorRowExists: boolean;
  vendorUpdateThrows?: boolean;
}) {
  const p: any = prisma;
  const originals = {
    findFirst: p.review.findFirst,
    queryRaw: p.$queryRaw,
    executeRaw: p.$executeRaw,
    productUpdate: p.product.update,
    vpFind: p.vendorPerformance.findUnique,
    vpUpdate: p.vendorPerformance.update,
  };
  const writes: any[] = [];
  let productWritten: any = null;
  let vendorWritten: any = null;

  p.review.findFirst = async () => ({
    id: "r1",
    productId: "p1",
    product: { vendorId: "v1", slug: "acme-widget" },
  });
  p.$queryRaw = async (strings: any) => {
    const sql = strings.join("?");
    if (sql.includes('SELECT "status"')) return [{ status: options.currentStatus }];
    if (sql.includes('AVG(r."rating")')) return [{ avg: 4.2 }];
    if (sql.includes('AVG("rating")::float8')) return [{ avg: 4.5, total: 2 }];
    throw new Error("unexpected SQL: " + sql.slice(0, 80));
  };
  p.$executeRaw = async (strings: any, ...values: any[]) => {
    writes.push({ sql: strings.join("?"), values });
    return 1;
  };
  p.product.update = async (args: any) => {
    productWritten = args.data;
    return args;
  };
  p.vendorPerformance.findUnique = async () => (options.vendorRowExists ? { id: "vp1" } : null);
  p.vendorPerformance.update = async (args: any) => {
    if (options.vendorUpdateThrows) throw new Error("vendor_performance write failed");
    vendorWritten = args.data;
    return args;
  };

  return {
    writes,
    get productWritten() {
      return productWritten;
    },
    get vendorWritten() {
      return vendorWritten;
    },
    restore() {
      p.review.findFirst = originals.findFirst;
      p.$queryRaw = originals.queryRaw;
      p.$executeRaw = originals.executeRaw;
      p.product.update = originals.productUpdate;
      p.vendorPerformance.findUnique = originals.vpFind;
      p.vendorPerformance.update = originals.vpUpdate;
    },
  };
}

test("hiding a published review invalidates the product, slug, vendor-stats and admin-stats keys", async () => {
  const redis = stubRedis();
  const db = stubModerationPrisma({ currentStatus: "PUBLISHED", vendorRowExists: true });
  try {
    const result = await ReviewAdminService.setStatus("r1", "HIDDEN", "spam link");

    assert.equal(result.changed, true);
    assert.deepEqual(result.productRating, { avgRating: 4.5, reviewCount: 2 });
    assert.deepEqual(result.aggregates, { product: "persisted", vendor: "persisted" });

    assert.ok(redis.deleted.includes("product:id:p1"), "product by id");
    assert.ok(redis.deleted.includes("product:slug:acme-widget"), "product by slug");
    assert.ok(redis.deleted.includes("stats:vendor:v1"), "vendor stats");
    assert.ok(redis.deleted.includes("stats:admin:global"), "admin stats");
  } finally {
    db.restore();
    redis.restore();
  }
});

test("republishing a hidden review invalidates the same keys", async () => {
  const redis = stubRedis();
  const db = stubModerationPrisma({ currentStatus: "HIDDEN", vendorRowExists: true });
  try {
    const result = await ReviewAdminService.setStatus("r1", "PUBLISHED");
    assert.equal(result.changed, true);
    assert.equal(result.status, "PUBLISHED");
    assert.ok(redis.deleted.includes("product:id:p1"));
    assert.ok(redis.deleted.includes("product:slug:acme-widget"));
    assert.ok(redis.deleted.includes("stats:vendor:v1"));
  } finally {
    db.restore();
    redis.restore();
  }
});

test("repeating the same status writes nothing and invalidates nothing", async () => {
  const redis = stubRedis();
  const db = stubModerationPrisma({ currentStatus: "HIDDEN", vendorRowExists: true });
  try {
    const result = await ReviewAdminService.setStatus("r1", "HIDDEN");

    assert.equal(result.changed, false);
    assert.deepEqual(result.aggregates, { product: "unchanged", vendor: "unchanged" });
    assert.equal(db.writes.length, 0, "no UPDATE");
    assert.equal(db.productWritten, null, "no product aggregate write");
    assert.deepEqual(redis.deleted, [], "no cache invalidation on a no-op");
  } finally {
    db.restore();
    redis.restore();
  }
});

test("a missing vendor_performance row is reported as a partial outcome, not success", async () => {
  const redis = stubRedis();
  const db = stubModerationPrisma({ currentStatus: "PUBLISHED", vendorRowExists: false });
  try {
    const result = await ReviewAdminService.setStatus("r1", "HIDDEN");

    assert.equal(result.changed, true);
    assert.deepEqual(result.vendorRating, { avgRating: 4.2, persisted: false });
    assert.equal(result.aggregates.product, "persisted");
    assert.equal(result.aggregates.vendor, "skipped_missing_vendor_performance_row");
    assert.ok(redis.deleted.includes("product:id:p1"));
  } finally {
    db.restore();
    redis.restore();
  }
});

test("a failing vendor aggregate write surfaces as an error, never as success", async () => {
  const redis = stubRedis();
  const db = stubModerationPrisma({
    currentStatus: "PUBLISHED",
    vendorRowExists: true,
    vendorUpdateThrows: true,
  });
  try {
    await assert.rejects(
      () => ReviewAdminService.setStatus("r1", "HIDDEN"),
      /vendor_performance write failed/
    );
    assert.ok(
      redis.deleted.includes("product:id:p1"),
      "product cache dropped even though the vendor write failed"
    );
  } finally {
    db.restore();
    redis.restore();
  }
});

test("vendor statistics passes the publication filter to both Prisma calls", async () => {
  const redis = stubRedis();
  const p: any = prisma;
  const originals = {
    productCount: p.product.count,
    productFindMany: p.product.findMany,
    productGroupBy: p.product.groupBy,
    reviewCount: p.review.count,
    reviewAggregate: p.review.aggregate,
    variantCount: p.productVariant.count,
    variantAggregate: p.productVariant.aggregate,
    queryRaw: p.$queryRaw,
    categoryFindMany: p.category.findMany,
    brandFindMany: p.brand.findMany,
  };
  let countWhere: any = null;
  let aggregateWhere: any = null;

  p.product.count = async () => 0;
  p.product.findMany = async () => [];
  p.product.groupBy = async () => [];
  p.productVariant.count = async () => 0;
  p.productVariant.aggregate = async () => ({ _sum: { avgCost: null } });
  p.category.findMany = async () => [];
  p.brand.findMany = async () => [];
  p.$queryRaw = async () => [{ count: 0n }];
  p.review.count = async (args: any) => {
    countWhere = args.where;
    return 3;
  };
  p.review.aggregate = async (args: any) => {
    aggregateWhere = args.where;
    return { _avg: { rating: 4.0 } };
  };

  try {
    const stats = await VendorStatisticsService.getStatistics("v1");

    const expected = { product: { vendorId: "v1", isDeleted: false }, status: "PUBLISHED" };
    assert.deepEqual(countWhere, expected, "count keeps vendor scope + PUBLISHED");
    assert.deepEqual(aggregateWhere, expected, "average uses the same predicate");
    assert.equal(stats.totalReviews, 3);
    assert.equal(stats.averageProductRating, 4, "average comes from the filtered aggregate");
  } finally {
    p.product.count = originals.productCount;
    p.product.findMany = originals.productFindMany;
    p.product.groupBy = originals.productGroupBy;
    p.review.count = originals.reviewCount;
    p.review.aggregate = originals.reviewAggregate;
    p.productVariant.count = originals.variantCount;
    p.productVariant.aggregate = originals.variantAggregate;
    p.$queryRaw = originals.queryRaw;
    p.category.findMany = originals.categoryFindMany;
    p.brand.findMany = originals.brandFindMany;
    redis.restore();
  }
});

test("the controller surfaces the partial outcome in the API envelope", async () => {
  const redis = stubRedis();
  const db = stubModerationPrisma({ currentStatus: "PUBLISHED", vendorRowExists: false });
  try {
    const res = fakeRes();
    await ReviewAdminController.setStatus(
      {
        user: { rawId: "admin-1", role: "ADMIN" },
        params: { reviewId: "r1" },
        body: { status: "HIDDEN" },
      } as any,
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.aggregates.product, "persisted");
    assert.equal(res.body.data.aggregates.vendor, "skipped_missing_vendor_performance_row");
    assert.equal(res.body.data.vendorRating.persisted, false);
  } finally {
    db.restore();
    redis.restore();
  }
});
