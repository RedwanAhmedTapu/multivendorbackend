// src/modules/agent/validators/agent-config.validators.ts
//
// Server-side validation for admin-managed agent configuration: levels,
// rate overrides, bonus rules, agent management and vendor links.

import { z } from "zod";
import Decimal from "decimal.js";
import { bdPhoneSchema, emailSchema, idSchema, money, nameSchema, optionalDate, pageQuery, percent } from "./agent-primitives.ts";

// ── Levels ────────────────────────────────────────────────────────────────
const perksSchema = z
  .array(z.string().trim().min(1).max(120, { error: "Each perk can be at most 120 characters" }))
  .max(20, { error: "At most 20 perks" });

export const levelCreateSchema = z
  .object({
    name: z.string().trim().min(2, { error: "Name must be at least 2 characters" }).max(60),
    rank: z.number({ error: "Rank must be a whole number" }).int().min(1).max(1000),
    minActiveVendors: z.number().int().min(0).max(1_000_000),
    minDeliveredSales: money({ label: "Minimum delivered sales" }),
    minPerformanceScore: z.number().min(0).max(100).multipleOf(0.01).nullable().default(null),
    commissionPercent: percent("Commission %").nullable().default(null),
    bonusAmount: money({ label: "Level bonus" }).nullable().default(null),
    perks: perksSchema.default([]),
    isActive: z.boolean().default(true),
  })
  .strict();

export const levelUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    rank: z.number().int().min(1).max(1000),
    minActiveVendors: z.number().int().min(0).max(1_000_000),
    minDeliveredSales: money({ label: "Minimum delivered sales" }),
    minPerformanceScore: z.number().min(0).max(100).multipleOf(0.01).nullable(),
    commissionPercent: percent("Commission %").nullable(),
    bonusAmount: money({ label: "Level bonus" }).nullable(),
    perks: perksSchema,
    isActive: z.boolean(),
  })
  .strict()
  .partial()
  .refine((v) => Object.keys(v).length > 0, { error: "Nothing to update" });

// ── Rate overrides ────────────────────────────────────────────────────────
export const overrideCreateSchema = z
  .object({
    scope: z.enum(["VENDOR", "AGENT", "CATEGORY"]),
    targetId: idSchema,
    ratePercent: percent("Rate"),
    effectiveFrom: optionalDate.optional(),
    effectiveTo: optionalDate.nullable().optional(),
    note: z.string().trim().max(500).optional(),
    replaceExisting: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    const from = v.effectiveFrom ?? new Date();
    if (v.effectiveTo && v.effectiveTo <= from) {
      ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "End date must be after the start date" });
    }
  });

export const overrideListQuery = z.object({
  scope: z.enum(["VENDOR", "AGENT", "CATEGORY"]).optional(),
  active: z.enum(["true", "false"]).optional(),
  targetId: idSchema.optional(),
  ...pageQuery,
});

export const overrideEndSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

// ── Bonus rules ───────────────────────────────────────────────────────────
const COUNT_METRICS = ["DELIVERED_ORDERS", "ACTIVE_VENDORS", "NEW_VENDORS"] as const;

const bonusRuleBase = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  scope: z.enum(["PER_VENDOR", "PER_AGENT"]),
  metric: z.enum(["DELIVERED_ORDERS", "DELIVERED_SALES", "ACTIVE_VENDORS", "NEW_VENDORS"]),
  threshold: money({ label: "Threshold", positive: true }),
  amount: money({ label: "Bonus amount", positive: true }),
  recurrence: z.enum(["ONE_TIME", "MONTHLY"]),
  validFrom: optionalDate.optional(),
  validTo: optionalDate.nullable().optional(),
  isActive: z.boolean().default(true),
});

export function bonusRuleIssues(v: {
  scope?: string;
  metric?: string;
  threshold?: string;
  validFrom?: Date;
  validTo?: Date | null;
}): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  if (v.scope === "PER_VENDOR" && (v.metric === "ACTIVE_VENDORS" || v.metric === "NEW_VENDORS")) {
    issues.push({ path: "metric", message: "Vendor-count metrics only apply to per-agent rules" });
  }
  if (v.metric && (COUNT_METRICS as readonly string[]).includes(v.metric) && v.threshold && !new Decimal(v.threshold).isInteger()) {
    issues.push({ path: "threshold", message: "This metric needs a whole-number threshold" });
  }
  if (v.validTo && v.validTo <= (v.validFrom ?? new Date(0))) {
    issues.push({ path: "validTo", message: "End date must be after the start date" });
  }
  return issues;
}

export const bonusRuleCreateSchema = bonusRuleBase.strict().superRefine((v, ctx) => {
  for (const i of bonusRuleIssues({ ...v, validFrom: v.validFrom ?? new Date() })) {
    ctx.addIssue({ code: "custom", path: [i.path], message: i.message });
  }
});

// No defaults here: a partial update must never re-apply a default value.
export const bonusRuleUpdateSchema = bonusRuleBase
  .extend({ isActive: z.boolean() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { error: "Nothing to update" });

// ── Agents (admin) ────────────────────────────────────────────────────────
export const AGENT_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "DEACTIVATED"] as const;

export const adminAgentListQuery = z.object({
  status: z.enum(AGENT_STATUSES).optional(),
  levelId: idSchema.optional(),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});

export const adminAgentCreateSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    phone: bdPhoneSchema.optional(),
    levelId: idSchema.nullable().optional(),
  })
  .strict();

export const adminAgentUpdateSchema = z
  .object({
    name: nameSchema,
    phone: bdPhoneSchema.nullable(),
    levelId: idSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { error: "Nothing to update" });

export const agentStatusActionSchema = z
  .object({ reason: z.string().trim().min(3, { error: "Give a reason (at least 3 characters)" }).max(500) })
  .strict();

export const optionalReasonSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

export const vendorLinkAssignSchema = z
  .object({
    vendorId: idSchema,
    note: z.string().trim().max(500).optional(),
    /** Move the vendor from its current agent to this one. */
    transfer: z.boolean().default(false),
  })
  .strict();

export const auditListQuery = z.object({
  entity: z.enum(["SETTING", "LEVEL", "OVERRIDE", "BONUS_RULE", "AGENT", "VENDOR_LINK", "WITHDRAWAL", "COMMISSION", "TRAINING", "WALLET", "BONUS_AWARD"]).optional(),
  entityId: idSchema.optional(),
  ...pageQuery,
});

export const ratePreviewQuery = z.object({
  agentId: idSchema.optional(),
  vendorId: idSchema.optional(),
  categoryId: idSchema.optional(),
});

export const lookupQuery = z.object({ q: z.string().trim().max(100).default("") });
