// tests/review-admin-api.test.ts
//
// Admin review queue + moderation contract: admin-only, filter shaping,
// idempotent status transitions, comment-parenting rules, and the guarantee
// that an unprovisioned schema never performs a write.
//
//   npx tsx --test tests/review-admin-api.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../src/config/prisma.ts";
import redisClient from "../src/config/redis.ts";

// Moderation now invalidates the product cache, so the cache layer must not talk
// to a real Redis in this suite. Stubbed once for the whole file.
const redis: any = redisClient;
redis.get = async () => null;
redis.set = async () => "OK";
redis.del = async () => 1;
redis.scanIterator = async function* () {};
import { ReviewAdminService } from "../src/modules/product-module/services/product/review-admin.service.ts";
import { ReviewAdminController } from "../src/modules/product-module/controllers/review-admin.controller.ts";
import {
  REVIEW_SCHEMA_READY,
  ReviewSchemaNotProvisionedError,
  assertStatusFilterSupported,
  buildAdminReviewWhere,
  moderationMeta,
  nextReviewStatus,
  validateCommentParent,
} from "../src/modules/product-module/services/product/review-moderation.scope.ts";
import {
  adminListQuerySchema,
  adminStatusSchema,
  commentBodySchema,
} from "../src/modules/product-module/validators/review-moderation.validator.ts";

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

const adminReq = (over: any = {}) =>
  ({ user: { rawId: "admin-1", vendorId: null, role: "ADMIN" }, query: {}, params: {}, body: {}, ...over }) as any;

const q = (over: any = {}) => adminListQuerySchema.parse(over);

test("admin scope is global by default and narrows only on a validated vendorId", () => {
  assert.deepEqual(buildAdminReviewWhere(q({})), {});
  assert.deepEqual(buildAdminReviewWhere(q({ vendorId: "v-9" })).product, { vendorId: "v-9" });
});

test("admin search spans review text, product and reviewer", () => {
  const where = buildAdminReviewWhere(q({ search: "refund" })) as any;
  assert.equal(where.OR.length, 3);
  assert.deepEqual(where.OR[2], { user: { name: { contains: "refund", mode: "insensitive" } } });
});

test("status filtering is accepted now that the column exists", () => {
  assert.doesNotThrow(() => assertStatusFilterSupported("ALL"));
  if (!REVIEW_SCHEMA_READY) {
    assert.throws(() => assertStatusFilterSupported("PUBLISHED"), ReviewSchemaNotProvisionedError);
  }
  assert.throws(() => adminListQuerySchema.parse({ status: "DELETED" }));
});

test("status transitions are idempotent and normalise unknown values", () => {
  assert.deepEqual(nextReviewStatus("PUBLISHED", "PUBLISHED"), { status: "PUBLISHED", changed: false });
  assert.deepEqual(nextReviewStatus("HIDDEN", "HIDDEN"), { status: "HIDDEN", changed: false });
  assert.deepEqual(nextReviewStatus("PUBLISHED", "HIDDEN"), { status: "HIDDEN", changed: true });
  assert.deepEqual(nextReviewStatus("HIDDEN", "PUBLISHED"), { status: "PUBLISHED", changed: true });
  // A row whose status cannot be read (legacy/NULL) is treated as published.
  assert.deepEqual(nextReviewStatus("SOMETHING", "PUBLISHED"), { status: "PUBLISHED", changed: false });
});

test("status body validation rejects unknown values and long reasons", () => {
  assert.throws(() => adminStatusSchema.parse({ status: "ARCHIVED" }));
  assert.throws(() => adminStatusSchema.parse({ status: "HIDDEN", reason: "x".repeat(281) }));
  assert.deepEqual(adminStatusSchema.parse({ status: "HIDDEN" }), { status: "HIDDEN" });
});

test("comment parenting: one level, same review", () => {
  assert.deepEqual(validateCommentParent({ parentId: null, reviewId: "r1" }), { ok: true });
  assert.deepEqual(
    validateCommentParent({ parentId: "c1", parentReviewId: "r2", reviewId: "r1" }),
    { ok: false, reason: "PARENT_OTHER_REVIEW" }
  );
  assert.deepEqual(
    validateCommentParent({ parentId: "c1", parentReviewId: "r1", parentParentId: "c0", reviewId: "r1" }),
    { ok: false, reason: "REPLY_DEPTH_EXCEEDED" }
  );
  assert.deepEqual(
    validateCommentParent({ parentId: "missing", parentReviewId: null, reviewId: "r1" }),
    { ok: false, reason: "PARENT_NOT_FOUND" }
  );
  assert.deepEqual(
    validateCommentParent({ parentId: "c1", parentReviewId: "r1", reviewId: "r1" }),
    { ok: true }
  );
});

test("comment body validation bounds the text", () => {
  assert.throws(() => commentBodySchema.parse({ body: "   " }));
  assert.throws(() => commentBodySchema.parse({ body: "x".repeat(1001) }));
  assert.deepEqual(commentBodySchema.parse({ body: "Nice", parentId: "c1" }), {
    body: "Nice",
    parentId: "c1",
  });
});

test("controller.list is admin-only and returns the paginated envelope", async () => {
  const denied = fakeRes();
  await ReviewAdminController.list(adminReq({ user: { rawId: "v", vendorId: "v1", role: "VENDOR" } }), denied);
  assert.equal(denied.statusCode, 403);

  const original = ReviewAdminService.list;
  (ReviewAdminService as any).list = async () => ({
    items: [],
    pagination: { currentPage: 1, totalPages: 1, totalItems: 0, hasNext: false, hasPrevious: false, limit: 10 },
    meta: moderationMeta(),
  });
  try {
    const res = fakeRes();
    await ReviewAdminController.list(adminReq(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.meta.schemaReady, REVIEW_SCHEMA_READY);
  } finally {
    (ReviewAdminService as any).list = original;
  }
});

test("controller.setStatus: role, validation and missing-review handling", async () => {
  const denied = fakeRes();
  await ReviewAdminController.setStatus(adminReq({ user: { rawId: "e", role: "EMPLOYEE" }, body: { status: "HIDDEN" } }), denied);
  assert.equal(denied.statusCode, 403);

  const invalid = fakeRes();
  await ReviewAdminController.setStatus(adminReq({ params: { reviewId: "r1" }, body: { status: "NOPE" } }), invalid);
  assert.equal(invalid.statusCode, 422, "zod failures use the project's 422 envelope");

  const original = ReviewAdminService.setStatus;
  (ReviewAdminService as any).setStatus = async () => ({ reviewId: "r1", status: "PUBLISHED", changed: false });
  try {
    const res = fakeRes();
    await ReviewAdminController.setStatus(
      adminReq({ params: { reviewId: "r1" }, body: { status: "PUBLISHED" } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.changed, false);
  } finally {
    (ReviewAdminService as any).setStatus = original;
  }
});

test("the real moderation path updates the status and recomputes both aggregates", async () => {
  const originalFind = (prisma as any).review.findFirst;
  const originalQuery = (prisma as any).$queryRaw;
  const originalExecute = (prisma as any).$executeRaw;
  const originalProductUpdate = (prisma as any).product.update;
  const originalVpFind = (prisma as any).vendorPerformance.findUnique;
  const originalVpUpdate = (prisma as any).vendorPerformance.update;

  const writes: any[] = [];
  let productWritten: any = null;
  let vendorWritten: any = null;

  (prisma as any).review.findFirst = async () => ({
    id: "r1",
    productId: "p1",
    product: { vendorId: "v1" },
  });
  (prisma as any).$queryRaw = async (strings: any) => {
    const sql = strings.join("?");
    if (sql.includes('SELECT "status"')) return [{ status: "PUBLISHED" }];
    if (sql.includes('AVG(r."rating")')) return [{ avg: 4.2 }];
    if (sql.includes('AVG("rating")::float8')) return [{ avg: 4.5, total: 2 }];
    throw new Error("unexpected SQL: " + sql.slice(0, 80));
  };
  (prisma as any).$executeRaw = async (strings: any, ...values: any[]) => {
    writes.push({ sql: strings.join("?"), values });
    return 1;
  };
  (prisma as any).product.update = async (args: any) => {
    productWritten = args.data;
    return args;
  };
  (prisma as any).vendorPerformance.findUnique = async () => ({ id: "vp1" });
  (prisma as any).vendorPerformance.update = async (args: any) => {
    vendorWritten = args.data;
    return args;
  };

  try {
    const res = fakeRes();
    await ReviewAdminController.setStatus(
      adminReq({ params: { reviewId: "r1" }, body: { status: "HIDDEN", reason: "spam link" } }),
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.changed, true);
    assert.equal(res.body.data.status, "HIDDEN");

    // One UPDATE, carrying the requested status.
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /UPDATE "reviews" SET "status"/);
    assert.deepEqual(writes[0].values, ["HIDDEN", "r1"], "status + the targeted review id are parameterised");

    // Both aggregates were recomputed from published rows only.
    assert.deepEqual(productWritten, { avgRating: 4.5, reviewCount: 2 });
    assert.equal(vendorWritten.avgRating, 4.2);
    assert.ok(vendorWritten.lastCalculatedAt instanceof Date);
  } finally {
    (prisma as any).review.findFirst = originalFind;
    (prisma as any).$queryRaw = originalQuery;
    (prisma as any).$executeRaw = originalExecute;
    (prisma as any).product.update = originalProductUpdate;
    (prisma as any).vendorPerformance.findUnique = originalVpFind;
    (prisma as any).vendorPerformance.update = originalVpUpdate;
  }
});

test("repeating the same status is a no-op: no UPDATE, no aggregate recompute", async () => {
  const originalFind = (prisma as any).review.findFirst;
  const originalQuery = (prisma as any).$queryRaw;
  const originalExecute = (prisma as any).$executeRaw;
  const originalProductUpdate = (prisma as any).product.update;
  let writes = 0;
  let productWrites = 0;

  (prisma as any).review.findFirst = async () => ({
    id: "r1",
    productId: "p1",
    product: { vendorId: "v1" },
  });
  (prisma as any).$queryRaw = async (strings: any) => {
    if (strings.join("?").includes('SELECT "status"')) return [{ status: "HIDDEN" }];
    throw new Error("no aggregate should be read for a no-op");
  };
  (prisma as any).$executeRaw = async () => {
    writes += 1;
    return 1;
  };
  (prisma as any).product.update = async () => {
    productWrites += 1;
    return {};
  };

  try {
    const res = fakeRes();
    await ReviewAdminController.setStatus(
      adminReq({ params: { reviewId: "r1" }, body: { status: "HIDDEN" } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.changed, false);
    assert.equal(writes, 0, "idempotent status change must not write");
    assert.equal(productWrites, 0, "and must not touch the product aggregates");
  } finally {
    (prisma as any).review.findFirst = originalFind;
    (prisma as any).$queryRaw = originalQuery;
    (prisma as any).$executeRaw = originalExecute;
    (prisma as any).product.update = originalProductUpdate;
  }
});

test("a missing review is a 404", async () => {
  const originalFind = (prisma as any).review.findFirst;
  (prisma as any).review.findFirst = async () => null;
  try {
    const res = fakeRes();
    await ReviewAdminController.setStatus(
      adminReq({ params: { reviewId: "nope" }, body: { status: "HIDDEN" } }),
      res
    );
    assert.equal(res.statusCode, 404);
  } finally {
    (prisma as any).review.findFirst = originalFind;
  }
});
