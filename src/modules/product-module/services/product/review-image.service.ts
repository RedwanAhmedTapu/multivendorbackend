// services/product/review-image.service.ts
//
// Review photos: at most three per review, positions 0–2 (the unique
// (reviewId, position) index and the CHECK constraint are the database guard).
//
// Ownership is derived from the session user: a review is only reachable through
// `where: { id, userId }`, so another customer's review id simply does not exist.
// Storage happens first, then the row; if the row insert fails the object is
// removed again so a failed request never leaves an orphan in the bucket.
//
// The uploader is injectable so the behaviour can be tested without R2.

import { prisma } from "../../../../config/prisma.ts";
import { AppError } from "../../utils/response.ts";
import {
  REVIEW_IMAGE_MAX_BYTES,
  REVIEW_IMAGE_MIME_TYPES,
  deleteReviewImage,
  uploadReviewImage,
} from "../../../../lib/r2-review-media.ts";

export const MAX_REVIEW_IMAGES = 3;

export interface ReviewImageDeps {
  upload: typeof uploadReviewImage;
  remove: typeof deleteReviewImage;
}

const defaultDeps: ReviewImageDeps = { upload: uploadReviewImage, remove: deleteReviewImage };

export function validateImageFile(file?: { size?: number; mimetype?: string }) {
  if (!file) throw new AppError("Image file is required (multipart field `file`)", 400);
  if (typeof file.size === "number" && file.size > REVIEW_IMAGE_MAX_BYTES) {
    throw new AppError("File size must not exceed 5MB", 400);
  }
  if (file.mimetype && !(REVIEW_IMAGE_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
    throw new AppError(`Invalid file type. Allowed: ${REVIEW_IMAGE_MIME_TYPES.join(", ")}`, 400);
  }
}

/** Next free slot 0–2, so a deleted middle image can be reused. */
export function nextPosition(used: number[]): number {
  for (let position = 0; position < MAX_REVIEW_IMAGES; position += 1) {
    if (!used.includes(position)) return position;
  }
  throw new AppError(`A review can have at most ${MAX_REVIEW_IMAGES} photos`, 409);
}

export const ReviewImageService = {
  async add(
    userId: string,
    reviewId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size?: number },
    deps: ReviewImageDeps = defaultDeps
  ) {
    validateImageFile(file);

    const review = await prisma.review.findFirst({
      where: { id: reviewId, userId },
      select: { id: true },
    });
    if (!review) throw new AppError("Review not found", 404);

    const existing = await prisma.reviewImage.findMany({
      where: { reviewId },
      select: { position: true },
    });
    const position = nextPosition(existing.map((row) => row.position));

    const uploaded = await deps.upload({
      reviewId,
      file: file.buffer,
      fileName: file.originalname,
      contentType: file.mimetype,
    });

    try {
      const image = await prisma.reviewImage.create({
        data: { reviewId, url: uploaded.url, position },
        select: { id: true, url: true, position: true },
      });
      return image;
    } catch (error) {
      // Roll the object back so a failed insert cannot leave an orphan.
      try {
        await deps.remove(uploaded.key);
      } catch (cleanupError) {
        console.error("Failed to remove orphaned review image", cleanupError);
      }
      throw error;
    }
  },

  async remove(userId: string, reviewId: string, imageId: string, deps: ReviewImageDeps = defaultDeps) {
    const review = await prisma.review.findFirst({
      where: { id: reviewId, userId },
      select: { id: true },
    });
    if (!review) throw new AppError("Review not found", 404);

    const image = await prisma.reviewImage.findFirst({
      where: { id: imageId, reviewId },
      select: { id: true, url: true },
    });
    if (!image) throw new AppError("Image not found", 404);

    const { reviewImageKeyFromUrl } = await import("../../../../lib/r2-review-media.ts");
    const key = reviewImageKeyFromUrl(image.url);
    if (key) await deps.remove(key);

    await prisma.reviewImage.delete({ where: { id: image.id } });
    return { id: image.id };
  },
};
