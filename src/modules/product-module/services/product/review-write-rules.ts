// services/product/review-write-rules.ts
//
// The review WRITE rules, as pure functions — no Prisma, no HTTP, no dates.
//
// Increment 2 changes the duplicate rule from "one review per user+product" to
// "one review per eligible delivered order item". That needs `reviews.orderItemId`,
// which is NOT in the generated Prisma client yet (the client is frozen until the
// Increment-2 migration is approved and applied). So the rule lives here, with
// both modes implemented and tested, and the service switches mode in one line
// when the column lands.
//
//   pre_migration  → the transitional guard that is live today: at most one review
//                    per (user, product). It exists only to stop duplicate spam
//                    while the column is missing; it is NOT the target rule.
//   post_migration → the target rule: one review per delivered order item; a
//                    legacy review (orderItemId NULL) may coexist with a new,
//                    linked one, and a repeat purchase is a legitimate new review.

export type ReviewWriteMode = "pre_migration" | "post_migration";

/** Flip to "post_migration" in the same change that applies the migration. */
export const REVIEW_WRITE_MODE: ReviewWriteMode = "pre_migration";

/** The minimum a decision needs to know about an existing review row. */
export interface ExistingReviewRef {
  id: string;
  /** Present once the migration lands; legacy rows are null. */
  orderItemId?: string | null;
}

export type ReviewWriteDecision =
  | { action: "create" }
  | { action: "reject_duplicate_line"; reviewId: string }
  | { action: "reject_existing_product_review"; reviewId: string }
  | { action: "reject_missing_purchase_link" };

/**
 * Decides whether a new review may be created.
 *
 * `existingForOrderItem` is the review already attached to the same delivered
 * line (null until the column exists). `existingForProduct` is every review the
 * customer already has for this product (queryable today).
 */
export function decideReviewWrite(input: {
  mode: ReviewWriteMode;
  orderItemId?: string | null;
  existingForOrderItem?: ExistingReviewRef | null;
  existingForProduct: readonly ExistingReviewRef[];
}): ReviewWriteDecision {
  if (input.mode === "pre_migration") {
    const existing = input.existingForProduct[0];
    return existing
      ? { action: "reject_existing_product_review", reviewId: existing.id }
      : { action: "create" };
  }

  // Target rule: the delivered line is the unit of uniqueness.
  if (!input.orderItemId) return { action: "reject_missing_purchase_link" };
  if (input.existingForOrderItem) {
    return { action: "reject_duplicate_line", reviewId: input.existingForOrderItem.id };
  }
  return { action: "create" };
}

/* ── discussion replies ─────────────────────────────────────────────────────── */

export type ReplyTargetRejection =
  | "SELF_PARENT"
  | "PARENT_NOT_IN_REVIEW"
  | "DEPTH_LIMIT";

export type ReplyTargetCheck = { ok: true } | { ok: false; reason: ReplyTargetRejection };

/** The reply depth the product allows: one level of replies under a review comment. */
export const MAX_REPLY_DEPTH = 1;

/**
 * Validates a comment's parent BEFORE inserting it.
 *
 * The database enforces that the parent belongs to the same review (composite FK
 * on (parentId, reviewId)); it cannot express a depth limit, so depth is checked
 * here: a reply may only hang off a top-level comment.
 */
export function validateReplyTarget(input: {
  reviewId: string;
  parentId: string | null | undefined;
  /** The parent row, when it exists (undefined/null = not found). */
  parent?: { id: string; reviewId: string; parentId: string | null } | null;
}): ReplyTargetCheck {
  if (!input.parentId) return { ok: true }; // top-level comment
  if (input.parentId === input.reviewId) return { ok: false, reason: "SELF_PARENT" };
  if (!input.parent) return { ok: false, reason: "PARENT_NOT_IN_REVIEW" };
  if (input.parent.reviewId !== input.reviewId) return { ok: false, reason: "PARENT_NOT_IN_REVIEW" };
  // Depth: a parent that itself has a parent would be a second level of replies.
  if (input.parent.parentId !== null) return { ok: false, reason: "DEPTH_LIMIT" };
  return { ok: true };
}

/* ── review images ─────────────────────────────────────────────────────────── */

/** Strict maximum, mirrored by the DB's unique(reviewId, position) + CHECK. */
export const MAX_REVIEW_IMAGES = 3;

export type ReviewImageRejection = "TOO_MANY" | "INVALID_URL";

export interface NormalizedReviewImage {
  url: string;
  position: 0 | 1 | 2;
}

export type ReviewImageResult =
  | { ok: true; images: NormalizedReviewImage[] }
  | { ok: false; reason: ReviewImageRejection };

/**
 * Normalises the images a customer submitted: trims, drops blanks, de-duplicates,
 * rejects anything that is not an http(s) URL or a project-relative upload path,
 * and assigns positions 0..2 — the only values the DB accepts.
 */
export function normalizeReviewImages(urls: readonly string[]): ReviewImageResult {
  const cleaned: string[] = [];
  for (const raw of urls) {
    const url = String(raw ?? "").trim();
    if (!url) continue;
    const valid = /^https?:\/\/\S+$/i.test(url) || /^\/uploads\/[\w./-]+$/i.test(url);
    if (!valid) return { ok: false, reason: "INVALID_URL" };
    if (!cleaned.includes(url)) cleaned.push(url);
  }
  if (cleaned.length > MAX_REVIEW_IMAGES) return { ok: false, reason: "TOO_MANY" };
  return {
    ok: true,
    images: cleaned.map((url, index) => ({ url, position: index as 0 | 1 | 2 })),
  };
}

/* ── publication filter ────────────────────────────────────────────────────── */

/**
 * The filter both rating aggregates must use once `Review.status` exists:
 * only PUBLISHED reviews count toward Product.avgRating / reviewCount and the
 * 1–5 distribution. Kept as one constant so the two services cannot drift.
 *
 * NOT WIRED YET: the generated client has no `status` field, so spreading this
 * into a Prisma query would fail today. Wire it in product-rating.service.ts and
 * review-summary.service.ts in the same change that regenerates the client.
 */
export const PUBLISHED_REVIEW_FILTER = { status: "PUBLISHED" } as const;
