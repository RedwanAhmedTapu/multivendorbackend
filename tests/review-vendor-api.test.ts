// tests/review-vendor-api.test.ts
//
// Vendor review API: scoping, filters, pagination, validation and the honest
// 503 for the reply write (reviews.vendorReply* is not provisioned).
//
// DB-free: the pure rules are called directly; the controller is driven with a
// fake req/res and its service stubbed; the one integration case stubs
// prisma.review.findFirst and proves no raw write is attempted.
//
//   npx tsx --test tests/review-vendor-api.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../src/config/prisma.ts";
import { ReviewVendorService } from "../src/modules/product-module/services/product/review-vendor.service.ts";
import { ReviewVendorController } from "../src/modules/product-module/controllers/review-vendor.controller.ts";
import {
  REVIEW_SCHEMA_READY,
  ReviewSchemaNotProvisionedError,
  assertStatusFilterSupported,
  buildVendorReviewWhere,
  canVendorReply,
  moderationMeta,
  moderationOrderBy,
  moderationSkipTake,
  publishedReviewWhere,
} from "../src/modules/product-module/services/product/review-moderation.scope.ts";
import {
  vendorListQuerySchema,
  vendorReplySchema,
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

const vendorReq = (over: any = {}) =>
  ({
    user: { rawId: "user-v1", vendorId: "vendor-1", role: "VENDOR" },
    query: {},
    params: {},
    body: {},
    ...over,
  }) as any;

const q = (over: any = {}) => vendorListQuerySchema.parse(over);

test("vendor scope comes from the session, never from the query", () => {
  // A hostile query object with a vendorId field must not widen the scope.
  const where = buildVendorReviewWhere("vendor-1", q({ vendorId: "vendor-evil" } as any));
  assert.deepEqual(where.product, { vendorId: "vendor-1" });
  assert.equal((where as any).vendorId, undefined);
});

test("rating filter, search OR shape, and the absence of OR without a search", () => {
  const plain = buildVendorReviewWhere("v1", q({}));
  assert.equal((plain as any).rating, undefined);
  assert.equal((plain as any).OR, undefined);

  const filtered = buildVendorReviewWhere("v1", q({ rating: "4", search: "  battery " }));
  assert.equal((filtered as any).rating, 4);
  const or = (filtered as any).OR;
  assert.equal(or.length, 3);
  assert.deepEqual(or[0], { comment: { contains: "battery", mode: "insensitive" } });
  assert.deepEqual(or[1], { product: { name: { contains: "battery", mode: "insensitive" } } });
  assert.deepEqual(or[2], { user: { name: { contains: "battery", mode: "insensitive" } } });
});

test("pagination is clamped and sortBy maps to a deterministic order", () => {
  assert.deepEqual(moderationSkipTake(1, 10), { skip: 0, take: 10 });
  assert.deepEqual(moderationSkipTake(3, 10), { skip: 20, take: 10 });
  assert.deepEqual(moderationSkipTake(0, 999), { skip: 0, take: 50 });

  assert.deepEqual(moderationOrderBy("newest"), [{ createdAt: "desc" }]);
  assert.deepEqual(moderationOrderBy("oldest"), [{ createdAt: "asc" }]);
  assert.deepEqual(moderationOrderBy("highest_rating"), [{ rating: "desc" }, { createdAt: "desc" }]);
  assert.deepEqual(moderationOrderBy("lowest_rating"), [{ rating: "asc" }, { createdAt: "desc" }]);
});

test("ALL is always permitted; PUBLISHED/HIDDEN are accepted once provisioned", () => {
  assert.doesNotThrow(() => assertStatusFilterSupported("ALL"));
  if (!REVIEW_SCHEMA_READY) {
    assert.throws(() => assertStatusFilterSupported("HIDDEN"), ReviewSchemaNotProvisionedError);
    assert.throws(() => assertStatusFilterSupported("PUBLISHED"), ReviewSchemaNotProvisionedError);
  }
});

test("one reply per review is a predicate, not a comment", () => {
  assert.equal(canVendorReply(null), true);
  assert.equal(canVendorReply(undefined), true);
  assert.equal(canVendorReply("   "), true);
  assert.equal(canVendorReply("Thanks!"), false);
});

test("predicate: bare product scope when disabled, PUBLISHED-only when enabled", () => {
  assert.deepEqual(publishedReviewWhere("p1"), { productId: "p1", status: "PUBLISHED" });
  assert.equal((publishedReviewWhere("p1") as any).status, "PUBLISHED");
  assert.deepEqual(publishedReviewWhere("p1", false), { productId: "p1" });
  assert.equal((publishedReviewWhere("p1", false) as any).status, undefined);
});

test("response meta reports the provisioned schema", () => {
  const meta = moderationMeta();
  assert.equal(meta.schemaReady, REVIEW_SCHEMA_READY);
  assert.equal(meta.schemaReady, true);
  assert.deepEqual(meta.missing, []);
});

test("reply body validation: empty, whitespace-only and overlong are rejected", () => {
  assert.throws(() => vendorReplySchema.parse({ reply: "" }));
  assert.throws(() => vendorReplySchema.parse({ reply: "   " }));
  assert.throws(() => vendorReplySchema.parse({ reply: "x".repeat(2001) }));
  assert.deepEqual(vendorReplySchema.parse({ reply: "  Thanks  " }), { reply: "Thanks" });
});

test("query defaults match the frontend contract", () => {
  const defaults = vendorListQuerySchema.parse({});
  assert.equal(defaults.page, 1);
  assert.equal(defaults.limit, 10);
  assert.equal(defaults.status, "ALL");
  assert.equal(defaults.sortBy, "newest");
  assert.throws(() => vendorListQuerySchema.parse({ limit: 51 }));
  assert.throws(() => vendorListQuerySchema.parse({ rating: 6 }));
});

test("controller.list: 403 without a vendor, 400 on an invalid query, 200 with pagination", async () => {
  const noVendor = fakeRes();
  await ReviewVendorController.list(vendorReq({ user: { rawId: "u", vendorId: null, role: "VENDOR" } }), noVendor);
  assert.equal(noVendor.statusCode, 403);
  assert.equal(noVendor.body.success, false);

  const badQuery = fakeRes();
  await ReviewVendorController.list(vendorReq({ query: { page: "0" } }), badQuery);
  assert.equal(badQuery.statusCode, 422, "zod failures use the project's 422 envelope");

  const original = ReviewVendorService.list;
  (ReviewVendorService as any).list = async (vendorId: string) => {
    assert.equal(vendorId, "vendor-1");
    return {
      items: [{ id: "r1", rating: 5 }],
      pagination: { currentPage: 1, totalPages: 1, totalItems: 1, hasNext: false, hasPrevious: false, limit: 10 },
      meta: moderationMeta(),
    };
  };
  try {
    const res = fakeRes();
    await ReviewVendorController.list(vendorReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.pagination.totalItems, 1);
    assert.equal(res.body.meta.schemaReady, REVIEW_SCHEMA_READY);
  } finally {
    (ReviewVendorService as any).list = original;
  }
});

test("controller.reply: another vendor's review is a 404, not a 503", async () => {
  const original = ReviewVendorService.reply;
  (ReviewVendorService as any).reply = async () => {
    const { AppError } = await import("../src/modules/product-module/utils/response.ts");
    throw new AppError("Review not found", 404);
  };
  try {
    const res = fakeRes();
    await ReviewVendorController.reply(vendorReq({ params: { reviewId: "other" }, body: { reply: "hi" } }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
  } finally {
    (ReviewVendorService as any).reply = original;
  }
});

test("controller.reply: empty body is a 422 before any service call", async () => {
  const res = fakeRes();
  await ReviewVendorController.reply(vendorReq({ params: { reviewId: "r1" }, body: { reply: "  " } }), res);
  assert.equal(res.statusCode, 422);
});

test("the real reply path writes through when provisioned, with ownership and a one-reply guard", async () => {
  const originalFind = (prisma as any).review.findFirst;
  const originalExecute = (prisma as any).$executeRaw;
  const calls: any[] = [];
  let writeResult = 1;

  (prisma as any).review.findFirst = async (args: any) => {
    calls.push(args);
    return { id: "r1" };
  };
  (prisma as any).$executeRaw = async (strings: any, ...values: any[]) => {
    calls.push({ sql: strings.join("?"), values });
    return writeResult;
  };

  try {
    const res = fakeRes();
    await ReviewVendorController.reply(
      vendorReq({ params: { reviewId: "r1" }, body: { reply: "Thanks for the review" } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.data, { reviewId: "r1", replied: true });

    // Ownership is part of the lookup, so another vendor's review never resolves.
    assert.deepEqual(calls[0].where, { id: "r1", product: { vendorId: "vendor-1" } });

    // The statement itself carries the one-reply guard and the authenticated actor.
    assert.match(calls[1].sql, /UPDATE "reviews"/);
    assert.match(calls[1].sql, /vendorReply/);
    assert.match(calls[1].sql, /btrim/);
    assert.deepEqual(calls[1].values, ["Thanks for the review", "user-v1", "r1"]);

    // Zero rows updated = already answered → 409.
    writeResult = 0;
    const conflict = fakeRes();
    await ReviewVendorController.reply(
      vendorReq({ params: { reviewId: "r1" }, body: { reply: "Again" } }),
      conflict
    );
    assert.equal(conflict.statusCode, 409);
  } finally {
    (prisma as any).review.findFirst = originalFind;
    (prisma as any).$executeRaw = originalExecute;
  }
});
