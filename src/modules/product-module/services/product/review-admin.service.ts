// services/product/review-admin.service.ts
//
// Admin review queue + status moderation.
//
// READ path works now. WRITE path (PUBLISHED ↔ HIDDEN) needs reviews.status,
// which is not provisioned: it answers 503 with the exact steps until the
// Increment-2 migration is applied, then performs the update and recomputes the
// product and vendor aggregates with parameterised SQL.
//
// Repeated changes are safe: a request that asks for the status a review already
// has returns changed:false and touches no aggregate.

import { prisma } from "../../../../config/prisma.ts";
import { invalidateProductCache } from "../../../../config/cache.ts";
import { AppError } from "../../utils/response.ts";
import type { AdminListQuery } from "../../validators/review-moderation.validator.ts";
import {
  assertSchemaReady,
  assertStatusFilterSupported,
  buildAdminReviewWhere,
  moderationMeta,
  moderationOrderBy,
  moderationSkipTake,
  nextReviewStatus,
} from "./review-moderation.scope.ts";

const adminReviewSelect = {
  id: true,
  rating: true,
  comment: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  productId: true,
  // Moderation view: status drives the Published/Hidden tab, orderItemId says
  // whether it is a verified purchase, and the reply fields show the seller's
  // response inline.
  orderItemId: true,
  status: true,
  vendorReply: true,
  vendorReplyAt: true,
  vendorReplyByUserId: true,
  images: { select: { id: true, url: true, position: true } },
  user: { select: { id: true, name: true, email: true } },
  product: {
    select: {
      id: true,
      name: true,
      slug: true,
      vendor: { select: { id: true, storeName: true } },
    },
  },
} satisfies Record<string, any>;

type ProductAggregate = { avg: number | null; total: number };
type VendorAggregate = { avg: number | null };

export const ReviewAdminService = {
  async list(query: AdminListQuery) {
    assertStatusFilterSupported(query.status);

    const where = buildAdminReviewWhere(query);
    const { skip, take } = moderationSkipTake(query.page, query.limit);

    const [items, totalItems] = await Promise.all([
      prisma.review.findMany({
        where: where as any,
        select: adminReviewSelect,
        orderBy: moderationOrderBy(query.sortBy),
        skip,
        take,
      }),
      prisma.review.count({ where: where as any }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalItems / take));
    return {
      items,
      pagination: {
        currentPage: query.page,
        totalPages,
        totalItems,
        hasNext: query.page * take < totalItems,
        hasPrevious: query.page > 1,
        limit: take,
      },
      meta: moderationMeta(),
    };
  },

  /**
   * Hide or publish one review, then rebuild the numbers the customer sees.
   * Product scope is read first so a missing id is a clean 404 before any
   * provisioning check (an operator should not see 503 for a typo).
   */
  async setStatus(reviewId: string, status: "PUBLISHED" | "HIDDEN", reason?: string) {
    const review = await prisma.review.findFirst({
      where: { id: reviewId },
      select: { id: true, productId: true, product: { select: { vendorId: true, slug: true } } },
    });
    if (!review) throw new AppError("Review not found", 404);

    assertSchemaReady("changing a review status");

    const currentRows = await prisma.$queryRaw<{ status: string }[]>`
      SELECT "status"::text AS status FROM "reviews" WHERE "id" = ${review.id} LIMIT 1
    `;
    const transition = nextReviewStatus(currentRows[0]?.status ?? "PUBLISHED", status);

    if (!transition.changed) {
      return {
        reviewId: review.id,
        status: transition.status,
        changed: false as const,
        reason: reason ?? null,
        productRating: null,
        vendorRating: null,
        // Nothing was written, so nothing was recomputed or invalidated.
        aggregates: { product: "unchanged" as const, vendor: "unchanged" as const },
      };
    }

    await prisma.$executeRaw`
      UPDATE "reviews" SET "status" = ${status}::"ReviewStatus" WHERE "id" = ${review.id}
    `;

    const productRating = await recomputeProductRating(review.productId);

    // The storefront product payload embeds avgRating/reviewCount, so its cache is
    // dropped as soon as those numbers are consistent — before the vendor
    // aggregate, whose persistence can legitimately be skipped.
    await invalidateProductCache({
      productId: review.productId,
      slug: review.product?.slug ?? undefined,
      vendorId: review.product?.vendorId ?? undefined,
    });

    const vendorRating = review.product?.vendorId
      ? await recomputeVendorRating(review.product.vendorId)
      : null;

    return {
      reviewId: review.id,
      status: transition.status,
      changed: true as const,
      reason: reason ?? null,
      productRating,
      vendorRating,
      // An explicit outcome so a skipped vendor aggregate cannot read as success.
      aggregates: {
        product: "persisted" as const,
        vendor: !vendorRating
          ? ("not_applicable" as const)
          : vendorRating.persisted
            ? ("persisted" as const)
            : ("skipped_missing_vendor_performance_row" as const),
      },
    };
  },
};

/**
 * Only PUBLISHED rows count. This is the SQL mirror of publishedReviewWhere()
 * in review-moderation.scope.ts — both must change together.
 */
async function recomputeProductRating(productId: string) {
  const [agg] = await prisma.$queryRaw<ProductAggregate[]>`
    SELECT AVG("rating")::float8 AS avg, COUNT(*)::int AS total
      FROM "reviews"
     WHERE "productId" = ${productId} AND "status" = 'PUBLISHED'
  `;
  const avgRating = Math.round((agg?.avg ?? 0) * 10) / 10;
  const reviewCount = agg?.total ?? 0;

  await prisma.product.update({
    where: { id: productId },
    data: { avgRating, reviewCount },
  });
  return { avgRating, reviewCount };
}

async function recomputeVendorRating(vendorId: string) {
  const [agg] = await prisma.$queryRaw<VendorAggregate[]>`
    SELECT AVG(r."rating")::float8 AS avg
      FROM "reviews" r
      JOIN "products" p ON p."id" = r."productId"
     WHERE p."vendorId" = ${vendorId} AND r."status" = 'PUBLISHED'
  `;
  const avgRating = Math.round((agg?.avg ?? 0) * 10) / 10;

  const existing = await prisma.vendorPerformance.findUnique({
    where: { vendorId },
    select: { id: true },
  });
  if (!existing) return { avgRating, persisted: false as const };

  await prisma.vendorPerformance.update({
    where: { vendorId },
    data: { avgRating, lastCalculatedAt: new Date() },
  });
  return { avgRating, persisted: true as const };
}
