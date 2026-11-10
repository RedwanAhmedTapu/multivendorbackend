// src/modules/marketing/campaign.rules.ts
//
// Marketing Center — pure campaign rules (no I/O, fully unit-tested):
//   - date windows (registration before live, end after start);
//   - classifying a rule change on a published campaign as loosening or
//     tightening (loosening is refused once vendors registered);
//   - evaluating one registration against the campaign rules at review time.
// Money is compared with Decimal, never floats.

import { Decimal } from "@prisma/client/runtime/library";

export type CampaignStatus = "DRAFT" | "PUBLISHED" | "ENDED" | "CANCELLED";
export type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
type Money = Decimal | number | string;

const dec = (v: Money) => (v instanceof Decimal ? v : new Decimal(v as any));

// ── dates ───────────────────────────────────────────────────────────────────

export interface CampaignWindows {
  registrationStartAt: Date;
  registrationEndAt: Date;
  startAt: Date;
  endAt: Date;
}

/** Returns field → message. `now` checks apply to create/publish. */
export function validateCampaignWindows(w: CampaignWindows, now: Date, opts: { requireFuture?: boolean } = {}): Record<string, string> {
  const e: Record<string, string> = {};
  const bad = (d: Date) => !(d instanceof Date) || Number.isNaN(d.getTime());
  for (const k of ["registrationStartAt", "registrationEndAt", "startAt", "endAt"] as const) if (bad(w[k])) e[k] = "Must be a valid date";
  if (Object.keys(e).length) return e;
  if (w.registrationStartAt >= w.registrationEndAt) e.registrationEndAt = "Registration must end after it starts";
  if (w.registrationEndAt > w.startAt) e.startAt = "The campaign must start after registration closes";
  if (w.startAt >= w.endAt) e.endAt = "The campaign must end after it starts";
  if (opts.requireFuture) {
    if (w.registrationEndAt <= now) e.registrationEndAt ??= "Registration must close in the future";
    if (w.endAt <= now) e.endAt ??= "The campaign must end in the future";
  }
  return e;
}

/** Where a campaign is in its life, from its windows (status aside). */
export function campaignPhase(c: CampaignWindows & { status: CampaignStatus }, now: Date) {
  if (c.status === "DRAFT" || c.status === "CANCELLED") return c.status;
  if (c.status === "ENDED" || now >= c.endAt) return "ENDED";
  if (now < c.registrationStartAt) return "UPCOMING";
  if (now < c.registrationEndAt) return "REGISTRATION_OPEN";
  if (now < c.startAt) return "REGISTRATION_CLOSED";
  return "LIVE";
}

// ── rule changes ────────────────────────────────────────────────────────────

export interface CampaignRules {
  minDiscountPercent: Money;
  minStock: number;
  maxProductsPerVendor: number | null;
  categoryIds: string[];
}

/** Which changes make it EASIER to qualify (loosened) or HARDER (tightened). */
export function classifyRuleChanges(before: CampaignRules, after: CampaignRules) {
  const loosened: string[] = [];
  const tightened: string[] = [];
  const d = dec(after.minDiscountPercent).comparedTo(dec(before.minDiscountPercent));
  if (d < 0) loosened.push("minDiscountPercent");
  if (d > 0) tightened.push("minDiscountPercent");
  if (after.minStock < before.minStock) loosened.push("minStock");
  if (after.minStock > before.minStock) tightened.push("minStock");
  const b = before.maxProductsPerVendor;
  const a = after.maxProductsPerVendor;
  if (b !== a) {
    if (a === null || (b !== null && a > b)) loosened.push("maxProductsPerVendor");
    else tightened.push("maxProductsPerVendor");
  }
  // Eligible categories: an empty list means "every category".
  const bs = new Set(before.categoryIds);
  const as = new Set(after.categoryIds);
  if (bs.size !== as.size || [...as].some((x) => !bs.has(x))) {
    if (as.size === 0 && bs.size > 0) loosened.push("categoryIds");
    else if (bs.size === 0 && as.size > 0) tightened.push("categoryIds");
    else {
      if ([...as].some((x) => !bs.has(x))) loosened.push("categoryIds");
      if ([...bs].some((x) => !as.has(x))) tightened.push("categoryIds");
    }
  }
  return { loosened, tightened };
}

// ── registration evaluation ─────────────────────────────────────────────────

export interface RegistrationFacts {
  campaign: CampaignRules & { status: CampaignStatus; endAt: Date };
  registration: { campaignPrice: Money; committedStock: number };
  /** Current state at review time. */
  current: {
    sellingPrice: Money;
    stock: number;
    productApproved: boolean;
    productDeleted: boolean;
    vendorActive: boolean;
    /** The product's category followed by its ancestors. */
    categoryChain: string[];
    /** Already-APPROVED registrations of this vendor in this campaign (excluding this one). */
    approvedForVendor: number;
  };
  now: Date;
}

export interface RuleViolation {
  rule: string;
  message: string;
}

/** Every rule this registration breaks right now (empty = may be approved). */
export function evaluateRegistration(f: RegistrationFacts): RuleViolation[] {
  const v: RuleViolation[] = [];
  const { campaign: c, registration: r, current: cur } = f;
  if (c.status !== "PUBLISHED") v.push({ rule: "campaignStatus", message: "The campaign is not published" });
  if (f.now >= c.endAt) v.push({ rule: "campaignEnded", message: "The campaign has ended" });
  if (!cur.productApproved || cur.productDeleted) v.push({ rule: "productStatus", message: "The product is not approved for sale" });
  if (!cur.vendorActive) v.push({ rule: "vendorStatus", message: "The store is not active" });
  if (c.categoryIds.length > 0 && !cur.categoryChain.some((id) => c.categoryIds.includes(id))) {
    v.push({ rule: "category", message: "The product's category is not eligible for this campaign" });
  }

  const price = dec(r.campaignPrice);
  const selling = dec(cur.sellingPrice);
  if (price.lte(0)) v.push({ rule: "campaignPrice", message: "The campaign price must be greater than zero" });
  else if (price.gte(selling)) v.push({ rule: "campaignPrice", message: "The campaign price must be lower than the current selling price" });
  else {
    const pct = selling.minus(price).dividedBy(selling).times(100);
    if (pct.lessThan(dec(c.minDiscountPercent))) {
      v.push({ rule: "minDiscountPercent", message: `Discount is ${pct.toDecimalPlaces(2, Decimal.ROUND_DOWN).toString()}% — the campaign requires at least ${dec(c.minDiscountPercent).toString()}%` });
    }
  }

  if (!Number.isInteger(r.committedStock) || r.committedStock < 1) v.push({ rule: "committedStock", message: "At least one unit must be committed" });
  else {
    if (r.committedStock < c.minStock) v.push({ rule: "minStock", message: `At least ${c.minStock} units must be committed` });
    if (r.committedStock > cur.stock) v.push({ rule: "stock", message: `Only ${cur.stock} units are in stock` });
  }
  if (c.maxProductsPerVendor !== null && cur.approvedForVendor >= c.maxProductsPerVendor) {
    v.push({ rule: "maxProductsPerVendor", message: `The store already has ${cur.approvedForVendor} approved products (limit ${c.maxProductsPerVendor})` });
  }
  return v;
}

/** Vendors may register or edit only while the registration window is open. */
export function registrationWindowViolation(w: { registrationStartAt: Date; registrationEndAt: Date }, now: Date): RuleViolation | null {
  if (now < new Date(w.registrationStartAt)) return { rule: "registrationWindow", message: "Registration for this campaign has not opened yet" };
  if (now >= new Date(w.registrationEndAt)) return { rule: "registrationWindow", message: "Registration for this campaign has closed" };
  return null;
}

/**
 * Highest campaign price that still meets the minimum discount, in whole
 * paisa (2 decimals, rounded DOWN so the price itself always passes
 * evaluateRegistration). The campaign price must also be strictly below the
 * selling price, so with a 0% minimum it is one paisa below. null when the
 * selling price is too low to discount.
 */
export function maxCampaignPrice(sellingPrice: Money, minDiscountPercent: Money): Decimal | null {
  const selling = dec(sellingPrice);
  const pct = dec(minDiscountPercent);
  let max = selling.times(new Decimal(100).minus(pct)).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  if (max.gte(selling)) max = selling.minus("0.01").toDecimalPlaces(2, Decimal.ROUND_DOWN);
  return max.gt(0) ? max : null;
}

/** Slug from a campaign name (unicode letters kept, so Bangla names work). */
export function slugifyCampaignName(name: string) {
  const s = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-") // \p{M}: keep Bangla vowel signs (combining marks)
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "campaign";
}
