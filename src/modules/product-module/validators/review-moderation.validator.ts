// validators/review-moderation.validator.ts
//
// Query/body contracts for the vendor and admin review routes. Same zod style
// as review.validator.ts: defaults are applied here, so controllers and
// services receive already-normalised values.

import { z } from "zod";

export const MODERATION_SORT_VALUES = [
  "newest",
  "oldest",
  "highest_rating",
  "lowest_rating",
] as const;

export const MODERATION_STATUS_VALUES = ["ALL", "PUBLISHED", "HIDDEN"] as const;

/** Shared pagination + rating + search + sort block. */
const listBase = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  status: z.enum(MODERATION_STATUS_VALUES).default("ALL"),
  search: z.string().trim().max(120).optional(),
  sortBy: z.enum(MODERATION_SORT_VALUES).default("newest"),
};

/**
 * Vendor feed. There is deliberately no `vendorId` field: the vendor scope
 * comes from the authenticated session and nothing else.
 */
export const vendorListQuerySchema = z.object(listBase);

export const adminListQuerySchema = z.object({
  ...listBase,
  vendorId: z.string().min(1).optional(),
});

export const vendorReplySchema = z.object({
  reply: z
    .string()
    .trim()
    .min(1, "Reply cannot be empty")
    .max(2000, "Reply is too long (2000 characters max)"),
});

export const adminStatusSchema = z.object({
  status: z.enum(["PUBLISHED", "HIDDEN"]),
  reason: z.string().trim().max(280, "Reason is too long (280 characters max)").optional(),
});

/** Comments: one level of replies, so a parentId is optional but never nested. */
export const commentBodySchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty").max(1000),
  parentId: z.string().min(1).optional(),
});

export type VendorListQuery = z.infer<typeof vendorListQuerySchema>;
export type AdminListQuery = z.infer<typeof adminListQuerySchema>;
export type VendorReplyInput = z.infer<typeof vendorReplySchema>;
export type AdminStatusInput = z.infer<typeof adminStatusSchema>;
export type CommentBodyInput = z.infer<typeof commentBodySchema>;
