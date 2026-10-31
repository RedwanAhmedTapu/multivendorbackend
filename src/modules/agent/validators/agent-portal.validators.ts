// src/modules/agent/validators/agent-portal.validators.ts
import { z } from "zod";
import { idSchema, pageQuery } from "./agent-primitives.ts";

export const VENDOR_HEALTH = ["ACTIVE", "GROWING", "DECLINING", "INACTIVE"] as const;
export const AGENT_ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "PACKAGING",
  "SHIPPED",
  "DELIVERED",
  "RETURNED",
  "FAILED_TO_DELIVER",
  "CANCELLED",
  "REFUNDED",
] as const;

export const salesTrendQuery = z.object({ range: z.enum(["7d", "30d", "6m", "12m"]).default("7d") });
export const commissionTrendQuery = z.object({ range: z.enum(["6m", "12m"]).default("6m") });

export const vendorListQuery = z.object({
  filter: z.enum(["ALL", ...VENDOR_HEALTH]).default("ALL"),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});

export const vendorParams = z.object({ vendorId: idSchema });
export const orderParams = z.object({ vendorOrderId: idSchema });

export const orderListQuery = z.object({
  status: z.enum(["ALL", ...AGENT_ORDER_STATUSES]).default("ALL"),
  vendorId: idSchema.optional(),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});

export const productListQuery = z.object({
  stock: z.enum(["ALL", "IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"]).default("ALL"),
  approval: z.enum(["ALL", "PENDING", "ACTIVE", "REJECTED", "DRAFT", "INACTIVE"]).default("ALL"),
  vendorId: idSchema.optional(),
  categoryId: idSchema.optional(),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});

export const reviewListQuery = z.object({
  vendorId: idSchema.optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  range: z.enum(["7d", "30d", "90d", "365d", "all"]).default("30d"),
  ...pageQuery,
});

export const performanceQuery = z.object({ range: z.enum(["7d", "30d", "90d", "365d"]).default("30d") });
