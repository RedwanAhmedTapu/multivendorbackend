// src/modules/marketing/campaign.validators.ts
// Server-side request validation for the admin vendor-programme API (zod).

import { z } from "zod";

const date = z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), "Must be a valid date");
const percent = z.coerce.number().min(0).max(100).multipleOf(0.01);
const id = z.string().trim().min(1).max(64);

const programmeFields = {
  registrationStartAt: date,
  registrationEndAt: date,
  minDiscountPercent: percent,
  minStock: z.coerce.number().int().min(0).max(1_000_000),
  maxProductsPerVendor: z.coerce.number().int().min(1).max(10_000).nullable().optional(),
  categoryIds: z.array(id).max(500).default([]),
};

export const createProgrammeSchema = z.strictObject(programmeFields);

export const updateProgrammeSchema = z
  .strictObject({
    ...Object.fromEntries(Object.entries(programmeFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
    categoryIds: z.array(id).max(500).optional(),
    acknowledgeTightening: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== "acknowledgeTightening"), "Nothing to update");

export const cancelSchema = z.strictObject({ reason: z.string().trim().min(1, "A cancellation reason is required").max(500) });

export const rejectSchema = z.strictObject({ reason: z.string().trim().min(1, "A rejection reason is required").max(500) });

export const bulkReviewSchema = z
  .strictObject({
    action: z.enum(["approve", "reject"]),
    registrationIds: z.array(id).max(1000).optional(),
    reason: z.string().trim().max(500).optional(),
    confirm: z.boolean().optional(),
    expectedCount: z.number().int().min(0).optional(),
  })
  .refine((b) => !b.confirm || b.expectedCount !== undefined, { message: "expectedCount is required with confirm", path: ["expectedCount"] });

export const listPagesQuery = z.object({
  search: z.string().trim().max(150).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const listRegistrationsQuery = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]).optional(),
  vendorId: id.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ── vendor side (vendor-campaign.routes.ts) ─────────────────────────────────

/** Money as a string with at most 2 decimals (number or numeric string accepted), > 0. */
const campaignPrice = z
  .union([z.number(), z.string()])
  .transform((v) => String(v).trim())
  .refine((s) => /^\d{1,14}(\.\d{1,2})?$/.test(s), "Enter a price with at most 2 decimals")
  .refine((s) => Number(s) > 0, "The campaign price must be greater than zero");
const committedStock = z.coerce.number().int().min(1).max(1_000_000);

export const vendorListCampaignsQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const vendorCampaignDetailQuery = z.object({
  search: z.string().trim().max(150).optional(),
  eligibleOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const vendorRegisterSchema = z.strictObject({
  items: z.array(z.strictObject({ variantId: id, campaignPrice, committedStock })).min(1, "Choose at least one variant").max(50),
});

export const vendorEditRegistrationSchema = z
  .strictObject({ campaignPrice: campaignPrice.optional(), committedStock: committedStock.optional() })
  .refine((b) => b.campaignPrice !== undefined || b.committedStock !== undefined, "Nothing to update");

export const vendorWithdrawSchema = z.strictObject({ reason: z.string().trim().max(500).optional() });

export const vendorListRegistrationsQuery = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]).optional(),
  campaignId: id.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
