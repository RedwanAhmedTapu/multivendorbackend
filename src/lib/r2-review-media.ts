// lib/r2-review-media.ts
//
// Review photos live in the same R2 bucket as the rest of the project's media.
// The client and config are reused from lib/cloudflare-r2.ts — no second S3 setup.
//
// Key layout: reviews/{reviewId}/{uuid}.{ext}
// One key per upload (a review holds at most three), so deletes never touch a
// sibling image.

import { randomUUID } from "node:crypto";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_CONFIG } from "./cloudflare-r2.ts";

export const REVIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const REVIEW_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export function reviewImageKey(reviewId: string, fileName: string): string {
  const ext = (fileName.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `reviews/${reviewId}/${randomUUID()}.${ext || "jpg"}`;
}

export async function uploadReviewImage(params: {
  reviewId: string;
  file: Buffer;
  fileName: string;
  contentType: string;
}): Promise<{ url: string; key: string }> {
  const key = reviewImageKey(params.reviewId, params.fileName);

  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_CONFIG.bucket,
      Key: key,
      Body: params.file,
      ContentType: params.contentType,
      Metadata: { reviewId: params.reviewId, uploadedAt: new Date().toISOString() },
    })
  );

  const baseUrl = R2_CONFIG.publicDomain
    ? R2_CONFIG.publicDomain
    : `${R2_CONFIG.endpoint}/${R2_CONFIG.bucket}`;

  return { key, url: `${baseUrl}/${key}` };
}

export async function deleteReviewImage(key: string): Promise<void> {
  await r2Client.send(new DeleteObjectCommand({ Bucket: R2_CONFIG.bucket, Key: key }));
}

/** Recover the storage key from a stored public URL (for deletes). */
export function reviewImageKeyFromUrl(url: string): string | null {
  if (typeof url !== "string" || !url) return null;
  const marker = "/reviews/";
  const at = url.indexOf(marker);
  return at >= 0 ? url.slice(at + 1) : null;
}
