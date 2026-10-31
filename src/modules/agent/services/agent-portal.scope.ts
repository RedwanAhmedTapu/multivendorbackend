// src/modules/agent/services/agent-portal.scope.ts
//
// Pure, DB-free rules for the agent portal (unit-tested directly).
//
// SCOPE: an agent sees only vendors with an OPEN link to it, and only those
// vendors' orders placed ON OR AFTER the link started ("tenure"). The scope
// always comes from the authenticated agent — never from a query or path.
//
// PRIVACY: agent responses never include customer identity (name, email,
// phone, address, user id). Selects below are explicit allow-lists.

import Decimal from "decimal.js";

export type OpenLink = { vendorId: string; startedAt: Date };

/** Prisma `where` for VendorOrder rows inside the agent's tenure. */
export function tenureOrderWhere(links: OpenLink[], vendorId?: string): Record<string, unknown> {
  const scoped = vendorId ? links.filter((l) => l.vendorId === vendorId) : links;
  if (!scoped.length) return { id: "__no_vendor_in_scope__" };
  return { OR: scoped.map((l) => ({ vendorId: l.vendorId, createdAt: { gte: l.startedAt } })) };
}

// ── Vendor health labels (DISPLAY ONLY) ──────────────────────────────────
// These labels drive filters and badges on the monitoring screens. They never
// affect money (commission, bonus, payout) — those come from admin settings.
export const HEALTH_WINDOW_DAYS = 30;
export const HEALTH_GROWTH_BAND = 0.1; // ±10% vs the previous window

export type VendorHealth = "ACTIVE" | "GROWING" | "DECLINING" | "INACTIVE";

export function vendorHealth(s: { orders30: number; sales30: string; salesPrev30: string }): VendorHealth {
  if (s.orders30 === 0) return "INACTIVE";
  const cur = new Decimal(s.sales30);
  const prev = new Decimal(s.salesPrev30);
  if (prev.isZero()) return cur.gt(0) ? "GROWING" : "ACTIVE";
  if (cur.gt(prev.times(1 + HEALTH_GROWTH_BAND))) return "GROWING";
  if (cur.lt(prev.times(1 - HEALTH_GROWTH_BAND))) return "DECLINING";
  return "ACTIVE";
}

/** Percentage change, 1 decimal; null when there is no base. */
export function growthPercent(current: string | number, previous: string | number): number | null {
  const prev = new Decimal(previous);
  if (prev.isZero()) return null;
  return new Decimal(current).minus(prev).dividedBy(prev).times(100).toDecimalPlaces(1).toNumber();
}

/** Ratio as a percentage with 1 decimal; null when the denominator is 0. */
export function ratePercent(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** Selling price rule (Phase 1): specialPrice when 0 < specialPrice < price, else price. */
export function effectivePrice(price: string | number, specialPrice: string | number | null | undefined): string {
  const p = new Decimal(price.toString());
  if (specialPrice != null) {
    const sp = new Decimal(specialPrice.toString());
    if (sp.gt(0) && sp.lt(p)) return sp.toFixed(2);
  }
  return p.toFixed(2);
}

export type StockState = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
/** Uses the vendor's own reorder levels (ProductVariant.reorderLevel). */
export function stockState(totalStock: number, totalReorderLevel: number): StockState {
  if (totalStock <= 0) return "OUT_OF_STOCK";
  if (totalStock <= totalReorderLevel) return "LOW_STOCK";
  return "IN_STOCK";
}

// ── Time buckets (Asia/Dhaka, UTC+6, no DST) ─────────────────────────────
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/** "YYYY-MM-DD" or "YYYY-MM" label of a UTC instant in Dhaka local time. */
export function dhakaBucket(date: Date, unit: "day" | "month"): string {
  const local = new Date(date.getTime() + DHAKA_OFFSET_MS).toISOString();
  return unit === "day" ? local.slice(0, 10) : local.slice(0, 7);
}

/** Start (UTC instant) of the Dhaka-local day/month containing `date`. */
export function dhakaStartOf(date: Date, unit: "day" | "month"): Date {
  const local = new Date(date.getTime() + DHAKA_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = unit === "day" ? local.getUTCDate() : 1;
  return new Date(Date.UTC(y, m, d) - DHAKA_OFFSET_MS);
}

/** Consecutive bucket labels ending at `now` (inclusive). */
export function bucketLabels(now: Date, unit: "day" | "month", count: number): string[] {
  const labels: string[] = [];
  const start = dhakaStartOf(now, unit);
  for (let i = count - 1; i >= 0; i--) {
    let d: Date;
    if (unit === "day") d = new Date(start.getTime() - i * 24 * 60 * 60 * 1000);
    else {
      const local = new Date(start.getTime() + DHAKA_OFFSET_MS);
      d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - i, 1) - DHAKA_OFFSET_MS);
    }
    labels.push(dhakaBucket(d, unit));
  }
  return labels;
}

/** Fill a sparse series so every bucket appears (missing → "0.00"). */
export function fillSeries(labels: string[], rows: Array<{ bucket: string; value: string }>): Array<{ bucket: string; value: string }> {
  const map = new Map(rows.map((r) => [r.bucket, r.value]));
  return labels.map((bucket) => ({ bucket, value: new Decimal(map.get(bucket) ?? 0).toFixed(2) }));
}

export const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
