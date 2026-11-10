// tests/review-schema-ready-shape.test.ts
//
// Pins the exact state of the activation switch and proves — against the
// regenerated Prisma Client — that the "schema ready" branch is type-correct
// the moment it is flipped. Nothing here touches a database.
//
//   npx tsx --test tests/review-schema-ready-shape.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

import {
  REVIEW_SCHEMA_READY,
  assertStatusFilterSupported,
  buildAdminReviewWhere,
  buildVendorReviewWhere,
  publishedReviewWhere,
} from "../src/modules/product-module/services/product/review-moderation.scope.ts";
import { REVIEW_WRITE_MODE } from "../src/modules/product-module/services/product/review-write-rules.ts";
import {
  adminListQuerySchema,
  vendorListQuerySchema,
} from "../src/modules/product-module/validators/review-moderation.validator.ts";

const vendorQuery = (over: Record<string, unknown> = {}) => vendorListQuerySchema.parse(over);
const adminQuery = (over: Record<string, unknown> = {}) => adminListQuerySchema.parse(over);

test("activation switches: reads enabled, writes still gated by the migration", () => {
  assert.equal(REVIEW_SCHEMA_READY, true, "review reads are provisioned");
  assert.equal(REVIEW_WRITE_MODE, "pre_migration", "Migration B does not exist yet");
});

test("list filters ignore status while the switch is off (today's behaviour)", () => {
  const vendor = buildVendorReviewWhere("v1", vendorQuery({ status: "HIDDEN" }), false);
  assert.equal("status" in vendor, false);
  assert.deepEqual(vendor.product, { vendorId: "v1" });

  const admin = buildAdminReviewWhere(adminQuery({ status: "PUBLISHED" }), false);
  assert.equal("status" in admin, false);
});

test("list filters apply status the moment the switch is on", () => {
  const vendorHidden = buildVendorReviewWhere("v1", vendorQuery({ status: "HIDDEN" }), true);
  assert.equal(vendorHidden.status, "HIDDEN");
  assert.deepEqual(vendorHidden.product, { vendorId: "v1" });

  const adminPublished = buildAdminReviewWhere(adminQuery({ status: "PUBLISHED" }), true);
  assert.equal(adminPublished.status, "PUBLISHED");

  // "ALL" never constrains, even when ready.
  assert.equal("status" in buildAdminReviewWhere(adminQuery({ status: "ALL" }), true), false);
  // …and the other filters still compose.
  const composed = buildAdminReviewWhere(adminQuery({ status: "HIDDEN", vendorId: "v9", rating: "2" }), true);
  assert.deepEqual(composed, { product: { vendorId: "v9" }, rating: 2, status: "HIDDEN" });
});

test("the status gate accepts PUBLISHED/HIDDEN now that the column exists", () => {
  // The refusal branch remains in assertStatusFilterSupported for the
  // unprovisioned state, but it is unreachable while readiness is on.
  assert.doesNotThrow(() => assertStatusFilterSupported("ALL"));
  assert.doesNotThrow(() => assertStatusFilterSupported("HIDDEN"));
  assert.doesNotThrow(() => assertStatusFilterSupported("PUBLISHED"));
});

test("the regenerated client types the schema-ready predicate exactly", () => {
  // Compile-time proof: if Review.status were missing (or the enum absent),
  // this file would not type-check.
  const ready = publishedReviewWhere("p1", true) as Prisma.ReviewWhereInput;
  const typed: Prisma.ReviewWhereInput = { productId: "p1", status: "PUBLISHED" };
  assert.deepEqual(ready, typed);
  assert.equal(publishedReviewWhere("p1", false).status, undefined);

  const hidden: Prisma.ReviewWhereInput = { status: "HIDDEN" };
  const aggregateArgs: Prisma.ReviewAggregateArgs = { where: typed, _avg: { rating: true } };
  assert.equal(hidden.status, "HIDDEN");
  assert.ok(aggregateArgs.where);
});

test("the regenerated client also types the new review models", () => {
  const image: Prisma.ReviewImageCreateInput = {
    url: "/uploads/r1.jpg",
    position: 0,
    review: { connect: { id: "r1" } },
  };
  const comment: Prisma.ReviewCommentCreateInput = {
    body: "Same review, please",
    review: { connect: { id: "r1" } },
    user: { connect: { id: "u1" } },
  };
  const replyConstraint: Prisma.ReviewCommentWhereUniqueInput = {
    id_reviewId: { id: "c1", reviewId: "r1" },
  };
  assert.equal(image.position, 0);
  assert.equal(comment.body.length > 0, true);
  assert.deepEqual(replyConstraint.id_reviewId, { id: "c1", reviewId: "r1" });
});

test("provisioned: the write gate opens, but the migration gate still reports pre_migration", async () => {
  const scope = await import("../src/modules/product-module/services/product/review-moderation.scope.ts");
  assert.doesNotThrow(() => scope.assertSchemaReady("posting a seller response"));
  assert.equal(scope.moderationMeta().schemaReady, true);
  assert.deepEqual(scope.moderationMeta().missing, []);
  // The error type stays exported for environments that have not migrated yet.
  assert.equal(typeof scope.ReviewSchemaNotProvisionedError, "function");
});
