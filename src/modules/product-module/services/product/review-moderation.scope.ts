// services/product/review-moderation.scope.ts
//
// Pure, DB-free rules for the vendor/admin review surfaces. Everything here is
// unit-testable without Prisma — which matters, because the Increment-2 columns
// (status / vendorReply / review_images / review_comments) are not provisioned
// yet: Migration A is unapplied and the generated client predates the schema.
//
// Nothing in this file fakes a write. A route that needs an absent column calls
// assertSchemaReady() and the controller answers 503 with the exact steps.

import { AppError } from "../../utils/response.ts";
import type {
  AdminListQuery,
  VendorListQuery,
} from "../../validators/review-moderation.validator.ts";

/**
 * Single switch for the whole moderation surface.
 *
 * Flip to true only after BOTH:
 *   1. `prisma migrate deploy` has applied
 *      20261019120000_review_system_increment_2_additive, and
 *   2. `npx prisma generate` has been run so the client exposes
 *      reviews.status / orderItemId / vendorReply* and the two new models.
 *
 * While false, reads work with today's columns and every write that depends on
 * the new schema answers 503 instead of pretending to persist.
 */
export const REVIEW_SCHEMA_READY = true;

/** Returned in the 503 envelope so an operator can act without reading code. */
export const REVIEW_PROVISIONING_STEPS = [
  "Apply prisma/migrations/20261019120000_review_system_increment_2_additive (prisma migrate deploy).",
  "Regenerate the Prisma client (npx prisma generate) so reviews.status, reviews.vendorReply*, review_images and review_comments exist.",
  "Flip REVIEW_SCHEMA_READY to true and re-run the review suites.",
] as const;

/** Columns/relations that do not exist yet, used for response meta. */
export const REVIEW_MISSING_COLUMNS = [
  "reviews.status",
  "reviews.vendorReply",
  "reviews.vendorReplyAt",
  "reviews.vendorReplyByUserId",
  "review_images",
  "review_comments",
] as const;

export class ReviewSchemaNotProvisionedError extends AppError {
  code = "REVIEW_SCHEMA_NOT_PROVISIONED";
  steps: readonly string[];

  constructor(operation: string) {
    super(
      `Review schema is not provisioned: ${operation} needs the Increment-2 migration and a regenerated Prisma client.`,
      503
    );
    this.name = "ReviewSchemaNotProvisionedError";
    this.steps = REVIEW_PROVISIONING_STEPS;
  }
}

export function assertSchemaReady(operation: string): void {
  if (!REVIEW_SCHEMA_READY) throw new ReviewSchemaNotProvisionedError(operation);
}

/**
 * A status filter can only be honoured once the column exists. "ALL" is the
 * default and is always valid; PUBLISHED/HIDDEN are refused loudly rather than
 * silently returning everything (which would look like a working filter).
 */
export function assertStatusFilterSupported(status: string): void {
  if (status !== "ALL" && !REVIEW_SCHEMA_READY) {
    throw new ReviewSchemaNotProvisionedError(`filtering by status "${status}"`);
  }
}

/** Sort → Prisma orderBy. Newest-first is the tiebreaker on every option. */
export function moderationOrderBy(sortBy: string): Record<string, "asc" | "desc">[] {
  switch (sortBy) {
    case "oldest":
      return [{ createdAt: "asc" }];
    case "highest_rating":
      return [{ rating: "desc" }, { createdAt: "desc" }];
    case "lowest_rating":
      return [{ rating: "asc" }, { createdAt: "desc" }];
    default:
      return [{ createdAt: "desc" }];
  }
}

export function moderationSkipTake(page: number, limit: number): { skip: number; take: number } {
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit) || 10));
  return { skip: (safePage - 1) * safeLimit, take: safeLimit };
}

/** Case-insensitive search across review text and the joined display fields. */
function searchClause(search?: string) {
  const value = search?.trim();
  if (!value) return undefined;
  return [
    { comment: { contains: value, mode: "insensitive" } },
    { product: { name: { contains: value, mode: "insensitive" } } },
    { user: { name: { contains: value, mode: "insensitive" } } },
  ];
}

/**
 * The publication filter for list queries. "ALL" never constrains; PUBLISHED /
 * HIDDEN only apply once the column exists, which keeps today's behaviour
 * identical while making the switch a one-line flip.
 */
function statusClause(
  status: string,
  schemaReady: boolean
): { status: string } | undefined {
  return schemaReady && status !== "ALL" ? { status } : undefined;
}

/**
 * Vendor scope. `vendorId` is a parameter, never read from the query string —
 * the controller passes the authenticated vendor, so a client cannot widen its
 * own scope by adding `?vendorId=`.
 */
export function buildVendorReviewWhere(
  vendorId: string,
  query: VendorListQuery,
  schemaReady: boolean = REVIEW_SCHEMA_READY
): Record<string, unknown> {
  const where: Record<string, unknown> = { product: { vendorId } };
  if (query.rating) where.rating = query.rating;
  const status = statusClause(query.status, schemaReady);
  if (status) where.status = status.status;
  const or = searchClause(query.search);
  if (or) where.OR = or;
  return where;
}

/** Admin scope: every vendor, optionally narrowed to one. */
export function buildAdminReviewWhere(
  query: AdminListQuery,
  schemaReady: boolean = REVIEW_SCHEMA_READY
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (query.vendorId) where.product = { vendorId: query.vendorId };
  if (query.rating) where.rating = query.rating;
  const status = statusClause(query.status, schemaReady);
  if (status) where.status = status.status;
  const or = searchClause(query.search);
  if (or) where.OR = or;
  return where;
}

/**
 * Publication filter for list/aggregate queries.
 *
 * `{}` while the switch is off — byte-identical to today's queries — and
 * `{ status: "PUBLISHED" }` once the column and the switch are ready. Use it as a
 * spread so callers never branch: `where = { productId, ...publishedReviewFilter() }`.
 */
export function publishedReviewFilter(
  schemaReady: boolean = REVIEW_SCHEMA_READY
): Record<string, unknown> {
  return schemaReady ? { status: "PUBLISHED" } : {};
}

/**
 * Public-visibility filter for aggregates. While the column is absent the
 * predicate is just the product scope; after provisioning it also requires
 * status = PUBLISHED, which is what keeps hidden reviews out of the product
 * rating, the rating distribution and the vendor average.
 */
export function publishedReviewWhere(
  productId: string,
  schemaReady: boolean = REVIEW_SCHEMA_READY
): Record<string, unknown> {
  return { productId, ...publishedReviewFilter(schemaReady) };
}

/** One seller response per review. */
export function canVendorReply(existingReply: string | null | undefined): boolean {
  return !existingReply || existingReply.trim().length === 0;
}

/**
 * Status transition. HIDDEN → HIDDEN and PUBLISHED → PUBLISHED are no-ops, so a
 * double click (or a retried request) cannot flip anything twice or fire a
 * second aggregate recomputation that sees a different state.
 */
export function nextReviewStatus(
  current: string,
  requested: "PUBLISHED" | "HIDDEN"
): { status: "PUBLISHED" | "HIDDEN"; changed: boolean } {
  const normalised = current === "HIDDEN" ? "HIDDEN" : "PUBLISHED";
  return { status: requested, changed: normalised !== requested };
}

/** One level of replies: a reply may not itself be replied to. */
export function validateCommentParent(input: {
  parentId?: string | null;
  parentReviewId?: string | null;
  parentParentId?: string | null;
  reviewId: string;
}):
  | { ok: true }
  | { ok: false; reason: "PARENT_NOT_FOUND" | "PARENT_OTHER_REVIEW" | "REPLY_DEPTH_EXCEEDED" } {
  if (!input.parentId) return { ok: true };
  if (!input.parentReviewId) return { ok: false, reason: "PARENT_NOT_FOUND" };
  if (input.parentReviewId !== input.reviewId) return { ok: false, reason: "PARENT_OTHER_REVIEW" };
  if (input.parentParentId) return { ok: false, reason: "REPLY_DEPTH_EXCEEDED" };
  return { ok: true };
}

/** Response meta so the UI can show "schema pending" without guessing. */
export function moderationMeta() {
  return {
    schemaReady: REVIEW_SCHEMA_READY,
    missing: REVIEW_SCHEMA_READY ? [] : [...REVIEW_MISSING_COLUMNS],
  };
}
