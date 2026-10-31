// src/modules/agent/validators/agent-primitives.ts
//
// Reusable server-side validators. Money and percentages are validated as
// exact decimals (decimal.js), never as floats, and normalized to canonical
// strings ("1250.00", "7.5000") — the same precision as the columns they end
// up in (Decimal(18,2) money, Decimal(9,4) percent).

import Decimal from "decimal.js";
import { z } from "zod";

const MAX_MONEY = new Decimal("9999999999999999.99"); // Decimal(18,2)

function decimalFrom(value: unknown): Decimal | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return new Decimal(String(value));
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    return new Decimal(t);
  }
  return null;
}

/** Money in ৳ with at most 2 decimals; output canonical "123.40". */
export function money(opts: { min?: string; positive?: boolean; label?: string } = {}) {
  const label = opts.label ?? "Amount";
  return z.union([z.number(), z.string()]).transform((value, ctx) => {
    const d = decimalFrom(value);
    if (!d) {
      ctx.addIssue({ code: "custom", message: `${label} must be a number` });
      return z.NEVER;
    }
    if (d.decimalPlaces() > 2) {
      ctx.addIssue({ code: "custom", message: `${label} can have at most 2 decimal places` });
      return z.NEVER;
    }
    if (opts.positive ? d.lte(0) : d.lt(opts.min ?? 0)) {
      ctx.addIssue({ code: "custom", message: opts.positive ? `${label} must be greater than 0` : `${label} must be at least ${opts.min ?? 0}` });
      return z.NEVER;
    }
    if (d.gt(MAX_MONEY)) {
      ctx.addIssue({ code: "custom", message: `${label} is too large` });
      return z.NEVER;
    }
    return d.toFixed(2);
  });
}

/** Percentage 0–100 with at most 4 decimals; output canonical "7.5000". */
export function percent(label = "Percentage") {
  return z.union([z.number(), z.string()]).transform((value, ctx) => {
    const d = decimalFrom(value);
    if (!d) {
      ctx.addIssue({ code: "custom", message: `${label} must be a number` });
      return z.NEVER;
    }
    if (d.decimalPlaces() > 4) {
      ctx.addIssue({ code: "custom", message: `${label} can have at most 4 decimal places` });
      return z.NEVER;
    }
    if (d.lt(0) || d.gt(100)) {
      ctx.addIssue({ code: "custom", message: `${label} must be between 0 and 100` });
      return z.NEVER;
    }
    return d.toFixed(4);
  });
}

export const emailSchema = z
  .string({ error: "Email is required" })
  .trim()
  .toLowerCase()
  .max(254, { error: "Email is too long" })
  .pipe(z.email({ error: "Enter a valid email address" }));

/** Bangladeshi mobile number → "01XXXXXXXXX". Accepts +880 / 880 prefixes. */
export const bdPhoneSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const digits = v.replace(/[\s-]/g, "").replace(/^\+?880/, "0");
    if (!/^01[3-9]\d{8}$/.test(digits)) {
      ctx.addIssue({ code: "custom", message: "Enter a valid Bangladeshi mobile number (01XXXXXXXXX)" });
      return z.NEVER;
    }
    return digits;
  });

export const passwordSchema = z
  .string({ error: "Password is required" })
  .min(8, { error: "Password must be at least 8 characters" })
  .max(128, { error: "Password is too long" })
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), { error: "Password must contain letters and numbers" });

export const nameSchema = z
  .string({ error: "Name is required" })
  .trim()
  .min(2, { error: "Name must be at least 2 characters" })
  .max(100, { error: "Name is too long" });

export const idSchema = z.string().trim().min(1).max(64);

export const pageQuery = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const optionalDate = z
  .union([z.string(), z.date()])
  .transform((v, ctx) => {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid date" });
      return z.NEVER;
    }
    return d;
  });

export { Decimal };
