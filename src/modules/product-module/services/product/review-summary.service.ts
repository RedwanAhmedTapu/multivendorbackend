// services/product/review-summary.service.ts
import { prisma } from "../../../../config/prisma.ts";
// Star breakdown counts PUBLISHED reviews only — same predicate as the rating
// average, so the two numbers can never disagree. Degrades to { productId }
// until Review.status is in the generated client.
import { publishedReviewWhere } from "./review-moderation.scope.ts";

/**
 * averageRating/totalReviews come straight off the Product row —
 * avgRating/reviewCount are denormalized columns kept in sync by
 * ProductRatingService on every review create/update/delete/moderation
 * (see product-rating.service.ts), so this never has to load review rows
 * just to compute a mean.
 *
 * The 1-5 star breakdown genuinely needs a per-rating count, but that's a
 * `GROUP BY rating` aggregate done in Postgres (`review.groupBy`) — never
 * a `findMany` that pulls every review row into app memory. A product with
 * 50,000 reviews costs the same 5-row aggregate as one with 5.
 */
/**
 * averageRating/totalReviews are the Product row's denormalized
 * avgRating/reviewCount — kept in sync by ProductRatingService on every
 * review create/update/delete/moderation (see product-rating.service.ts).
 * Callers that already have the product loaded (e.g. getDetailBySlug,
 * which pulls the whole detailInclude shape) should pass those two values
 * in directly via `known` — avoids a second `product.findUnique` for data
 * already in hand.
 *
 * The 1-5 star breakdown genuinely needs a per-rating count, which is a
 * `GROUP BY rating` aggregate (`review.groupBy`) — never a `findMany` that
 * pulls every review row into app memory. A product with 50,000 reviews
 * costs the same 5-row aggregate as one with 5.
 */
export const ReviewSummaryService = {
  async getSummary(productId: string, known?: { avgRating: number; reviewCount: number }) {
    const [product, grouped] = await Promise.all([
      known
        ? Promise.resolve(known)
        : prisma.product.findUnique({
            where: { id: productId },
            select: { avgRating: true, reviewCount: true },
          }),
      prisma.review.groupBy({
        by: ["rating"],
        where: publishedReviewWhere(productId) as any,
        _count: { rating: true },
      }),
    ]);

    const averageRating = product?.avgRating ?? 0;
    const totalReviews = product?.reviewCount ?? 0;

    const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;
    for (const g of grouped) {
      const rating = Math.min(5, Math.max(1, Math.round(g.rating))) as 1 | 2 | 3 | 4 | 5;
      breakdown[rating] += g._count.rating;
    }

    const ratingDistribution = Object.entries(breakdown).map(([star, count]) => ({
      star: Number(star),
      count,
      percentage: totalReviews ? Math.round((count / totalReviews) * 100) : 0,
    }));

    return { averageRating, totalReviews, ratingDistribution };
  },
};