// services/product/product-rating.service.ts
import { prisma } from "../../../../config/prisma.ts";
// Public aggregates must count PUBLISHED reviews only. The predicate degrades to
// { productId } until Review.status exists in the generated client, so this line
// changes no number today and needs no follow-up edit once the column lands.
import { publishedReviewWhere } from "./review-moderation.scope.ts";

/**
 * Keeps Product.avgRating / Product.reviewCount (denormalized columns) in
 * sync with the `reviews` table.
 *
 * Call `recalculate(productId)` after ANY write that changes a product's
 * reviews: create, update, delete, or moderation (approve/reject/flag) if
 * moderation affects which reviews count toward the average.
 *
 * Uses a single DB-side aggregate (AVG/COUNT) — never loads review rows
 * into app memory, so this stays cheap even for a product with thousands
 * of reviews.
 */
export const ProductRatingService = {
  async recalculate(productId: string) {
    const agg = await prisma.review.aggregate({
      where: publishedReviewWhere(productId) as any,
      _avg: { rating: true },
      _count: { rating: true },
    });

    const avgRating = Math.round((agg._avg.rating ?? 0) * 10) / 10; // 1 decimal place
    const reviewCount = agg._count.rating;

    await prisma.product.update({
      where: { id: productId },
      data: { avgRating, reviewCount },
    });

    return { avgRating, reviewCount };
  },

  /**
   * Batch variant for jobs/backfills — recalculates many products without
   * one round-trip per product where avoidable isn't possible for the
   * update itself (Prisma has no bulk "update from aggregate" yet), but at
   * least runs them concurrently instead of serially.
   */
  async recalculateMany(productIds: string[]) {
    await Promise.all(productIds.map((id) => this.recalculate(id)));
  },
};