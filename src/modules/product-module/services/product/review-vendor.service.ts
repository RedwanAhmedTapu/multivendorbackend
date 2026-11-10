// services/product/review-vendor.service.ts
//
// Vendor review feed + single seller response.
//
// READ path works against today's columns (id/rating/comment/dates/user/product).
// WRITE path (reply) needs reviews.vendorReply* which the Increment-2 migration
// has not applied and the generated client does not know about — so it goes
// through assertSchemaReady() and the vendor gets 503 + the exact steps, never a
// false success. Once the columns exist the same code performs the write with
// parameterised SQL, so no client regeneration is required for it.
//
// Authorization is by session, not by request: `vendorId` is always resolved
// from the authenticated user and the review is looked up *inside* that scope,
// so another vendor's review id simply does not exist for this caller.

import { prisma } from "../../../../config/prisma.ts";
import { AppError } from "../../utils/response.ts";
import type { VendorListQuery } from "../../validators/review-moderation.validator.ts";
import {
  assertSchemaReady,
  assertStatusFilterSupported,
  buildVendorReviewWhere,
  canVendorReply,
  moderationMeta,
  moderationOrderBy,
  moderationSkipTake,
} from "./review-moderation.scope.ts";

const vendorReviewSelect = {
  id: true,
  rating: true,
  comment: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  productId: true,
  // Increment-2 fields the vendor dashboard renders (status badge, the single
  // seller response, its timestamp/author, and the up-to-three photos).
  orderItemId: true,
  status: true,
  vendorReply: true,
  vendorReplyAt: true,
  vendorReplyByUserId: true,
  images: { select: { id: true, url: true, position: true } },
  user: { select: { id: true, name: true } },
  product: { select: { id: true, name: true, slug: true } },
} satisfies Record<string, any>;

export const ReviewVendorService = {
  async list(vendorId: string, query: VendorListQuery) {
    assertStatusFilterSupported(query.status);

    const where = buildVendorReviewWhere(vendorId, query);
    const { skip, take } = moderationSkipTake(query.page, query.limit);

    const [items, totalItems] = await Promise.all([
      prisma.review.findMany({
        where: where as any,
        select: vendorReviewSelect,
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
   * One seller response per review. Ownership is checked first so a vendor gets
   * 404 — not 503 and not 403 — for a review that is not theirs, which keeps
   * review ids unprobeable across vendors.
   */
  async reply(
    vendorId: string,
    actorUserId: string,
    reviewId: string,
    reply: string
  ) {
    const review = await prisma.review.findFirst({
      where: { id: reviewId, product: { vendorId } },
      select: { id: true },
    });
    if (!review) throw new AppError("Review not found", 404);

    assertSchemaReady("posting a seller response");

    // Parameterised and atomic: the WHERE clause is the one-reply rule, so two
    // concurrent requests cannot both win.
    const updated = await prisma.$executeRaw`
      UPDATE "reviews"
         SET "vendorReply" = ${reply},
             "vendorReplyAt" = NOW(),
             "vendorReplyByUserId" = ${actorUserId}
       WHERE "id" = ${review.id}
         AND ("vendorReply" IS NULL OR btrim("vendorReply") = '')
    `;

    if (updated === 0) {
      throw new AppError("This review already has a seller response", 409);
    }
    return { reviewId: review.id, replied: true as const };
  },

  /** Guard used by the controller before it trusts a reply body. */
  assertCanReply(existingReply: string | null | undefined) {
    if (!canVendorReply(existingReply)) {
      throw new AppError("This review already has a seller response", 409);
    }
  },
};
