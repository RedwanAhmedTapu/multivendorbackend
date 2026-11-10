// services/product/review.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { AppError } from "../../utils/response.ts";
import { ProductRatingService } from "./product-rating.service.ts";
import { ReviewEligibilityService } from "./review-eligibility.service.ts";
import { decideReviewWrite, REVIEW_WRITE_MODE } from "./review-write-rules.ts";
import { publishedReviewFilter } from "./review-moderation.scope.ts";
import { invalidateProductCache } from "../../../../config/cache.ts";
import type { CreateReviewInput, UpdateReviewInput, ListReviewsQuery } from "../../validators/review.validator.ts";

const reviewCardSelect = {
  id: true,
  rating: true,
  comment: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  productId: true,
  user: { select: { id: true, name: true } },
} satisfies Record<string, any>;

/**
 * Projection for the write-time duplicate check.
 *
 * `orderItemId` is selected so the post_migration rule can tell a legacy review
 * (null link) from one already attached to the delivered line. In pre_migration
 * mode the decision ignores it, so behaviour is unchanged.
 */
const reviewRefSelect = { id: true, orderItemId: true } satisfies Record<string, any>;

function sortToOrderBy(sortBy: ListReviewsQuery["sortBy"]) {
  switch (sortBy) {
    case "oldest":
      return { createdAt: "asc" as const };
    case "highest_rating":
      return { rating: "desc" as const };
    case "lowest_rating":
      return { rating: "asc" as const };
    case "newest":
    default:
      return { createdAt: "desc" as const };
  }
}

export const ReviewService = {
  async create(userId: string, input: CreateReviewInput) {
    const product = await prisma.product.findFirst({
      where: { id: input.productId, isDeleted: false },
      select: { id: true, slug: true, vendorId: true },
    });
    if (!product) throw new AppError("Product not found", 404);

    // Duplicate rule — see review-write-rules.ts for the two modes.
    // While the generated client has no `reviews.orderItemId`, the mode is
    // "pre_migration": at most one review per (user, product). The target rule
    // (one per delivered order item, legacy rows allowed to coexist) is
    // implemented and tested there and switches on with the migration — this is
    // a documented transitional guard, not a return to the old rule.
    const existingForProduct = await prisma.review.findMany({
      where: { userId, productId: input.productId },
      select: reviewRefSelect,
      orderBy: { createdAt: "desc" },
    });

    // Pre-migration rule: at most one review per (user, product), backed by the
    // still-present reviews_userId_productId_key index. Unchanged ordering: this
    // check still runs before eligibility, exactly as it did before Increment 2.
    if (REVIEW_WRITE_MODE === "pre_migration") {
      const decision = decideReviewWrite({ mode: REVIEW_WRITE_MODE, existingForProduct });
      if (decision.action !== "create") {
        throw new AppError("You have already reviewed this product. Edit your existing review instead.", 409);
      }
    }

    // Phase 1: server-enforced purchase eligibility — only a delivered, kept
    // order line of THIS product for the authenticated user may be reviewed.
    const eligibility = await ReviewEligibilityService.assert(userId, input.productId);

    // Target rule (inactive until REVIEW_WRITE_MODE flips with Migration B): the
    // delivered order line is the unit of uniqueness, and a review already
    // attached to that line blocks a second one.
    if (REVIEW_WRITE_MODE === "post_migration") {
      const existingForOrderItem = eligibility.orderItemId
        ? await prisma.review.findFirst({
            where: { orderItemId: eligibility.orderItemId },
            select: reviewRefSelect,
          })
        : null;

      const decision = decideReviewWrite({
        mode: REVIEW_WRITE_MODE,
        orderItemId: eligibility.orderItemId,
        existingForOrderItem,
        existingForProduct,
      });

      if (decision.action === "reject_duplicate_line") {
        throw new AppError("You have already reviewed this purchase. Edit that review instead.", 409);
      }
      if (decision.action === "reject_missing_purchase_link") {
        throw new AppError("This review must be linked to a delivered order line", 400);
      }
    }

    const review = await prisma.review.create({
      data: {
        userId,
        productId: input.productId,
        rating: input.rating,
        comment: input.comment,
      },
      select: reviewCardSelect,
    });

    await ProductRatingService.recalculate(input.productId);
    await invalidateProductCache({ productId: product.id, slug: product.slug, vendorId: product.vendorId });

    return review;
  },

  async update(userId: string, reviewId: string, input: UpdateReviewInput) {
    const existing = await prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true, userId: true, productId: true },
    });
    if (!existing) throw new AppError("Review not found", 404);
    if (existing.userId !== userId) throw new AppError("You can only edit your own review", 403);

    const updated = await prisma.review.update({
      where: { id: reviewId },
      data: {
        ...(input.rating !== undefined ? { rating: input.rating } : {}),
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
      },
      select: reviewCardSelect,
    });

    if (input.rating !== undefined) {
      await ProductRatingService.recalculate(existing.productId);
    }
    await invalidateProductCache({ productId: existing.productId });

    return updated;
  },

  async remove(userId: string, reviewId: string) {
    const existing = await prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true, userId: true, productId: true },
    });
    if (!existing) throw new AppError("Review not found", 404);
    if (existing.userId !== userId) throw new AppError("You can only delete your own review", 403);

    await prisma.review.delete({ where: { id: reviewId } });
    await ProductRatingService.recalculate(existing.productId);
    await invalidateProductCache({ productId: existing.productId });

    return { id: reviewId };
  },

  async listByProduct(productId: string, query: ListReviewsQuery) {
    // Public list + count: hidden reviews are excluded as soon as the readiness
    // switch is on. While it is off the spread adds nothing, so the query is
    // byte-identical to the pre-Increment-2 behaviour.
    const where: any = { productId, ...publishedReviewFilter() };
    if (query.rating) where.rating = query.rating;

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        select: reviewCardSelect,
        orderBy: sortToOrderBy(query.sortBy),
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.review.count({ where }),
    ]);

    return {
      items: reviews,
      pagination: {
        currentPage: query.page,
        totalPages: Math.ceil(total / query.limit),
        totalItems: total,
        hasNext: query.page * query.limit < total,
        hasPrevious: query.page > 1,
        limit: query.limit,
      },
    };
  },

  /**
   * Every review this customer has for the product, newest first.
   *
   * A list, not an arbitrary single row: once the per-delivered-order-item rule
   * lands, a customer can legitimately hold more than one review for the same
   * product (a second purchase), and the API must not silently pick one.
   */
  async listByUserAndProduct(userId: string, productId: string) {
    return prisma.review.findMany({
      where: { userId, productId },
      select: reviewCardSelect,
      orderBy: { createdAt: "desc" },
    });
  },
};
