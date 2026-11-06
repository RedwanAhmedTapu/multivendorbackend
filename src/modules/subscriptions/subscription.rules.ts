// src/modules/subscriptions/subscription.rules.ts
//
// Pure rules for the plan subscription platform (no I/O, fully unit-tested):
//   - subscription state at a moment (ACTIVE / GRACE / EXPIRED / ...);
//   - price of a plan for a cycle, with the plan's promo / discount and an
//     optional vendor special offer (never below 0, rounded to 2 dp);
//   - which source grants a feature (plan, free-plan offer, free-feature
//     offer) and the most generous limits among them;
//   - the paid period a payment buys; limit-definition and limit-value
//     validation; usage period keys (Asia/Dhaka).
// Billing (what a vendor pays FinixMart) is a separate flow from vendor
// earnings / payouts (what FinixMart owes a vendor): nothing here reads or
// writes vendor balances.

import { Decimal } from "@prisma/client/runtime/library";

export type SubState = "NONE" | "PENDING" | "ACTIVE" | "GRACE" | "EXPIRED" | "CANCELLED" | "SUSPENDED";
export const OPERATIVE_STATES: readonly SubState[] = ["ACTIVE", "GRACE"];

export interface SubRow {
  status: string | null;
  packageId: string | null;
  expiresAt: Date | null;
  graceDays: number | null;
}

export interface SubEvaluation {
  state: SubState;
  packageId: string | null;
  expiresAt: string | null;
  graceEndsAt: string | null;
  daysLeft: number | null;
}

const DAY = 86_400_000;

export function evaluateSubscription(sub: SubRow | null, now: Date, defaultGraceDays: number): SubEvaluation {
  const none: SubEvaluation = { state: "NONE", packageId: null, expiresAt: null, graceEndsAt: null, daysLeft: null };
  if (!sub || !sub.status || !sub.packageId) return none;
  const graceDays = Math.max(0, sub.graceDays ?? defaultGraceDays);
  const expiresAt = sub.expiresAt ? sub.expiresAt.toISOString() : null;
  const graceEnd = sub.expiresAt ? new Date(sub.expiresAt.getTime() + graceDays * DAY) : null;
  const base = { packageId: sub.packageId, expiresAt, graceEndsAt: graceEnd ? graceEnd.toISOString() : null };
  const daysLeft = sub.expiresAt ? Math.max(0, Math.ceil((sub.expiresAt.getTime() - now.getTime()) / DAY)) : null;
  switch (sub.status) {
    case "SUSPENDED":
      return { ...base, state: "SUSPENDED", daysLeft };
    case "CANCELLED":
      return { ...base, state: "CANCELLED", daysLeft: null };
    case "PENDING":
      return { ...base, state: "PENDING", daysLeft: null };
    case "EXPIRED":
      return { ...base, state: "EXPIRED", daysLeft: 0 };
    case "ACTIVE": {
      if (!sub.expiresAt || now < sub.expiresAt) return { ...base, state: "ACTIVE", daysLeft };
      if (graceEnd && now < graceEnd) return { ...base, state: "GRACE", daysLeft: 0 };
      return { ...base, state: "EXPIRED", daysLeft: 0 };
    }
    default:
      return none;
  }
}

// ─── pricing ────────────────────────────────────────────────────────────────

export type Money = Decimal;
const ZERO = new Decimal(0);
export const money = (v: Decimal.Value | null | undefined): Decimal => (v === null || v === undefined ? ZERO : new Decimal(v.toString()));
const round2 = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const clamp0 = (v: Decimal) => (v.lessThan(0) ? ZERO : v);

export interface PriceRow {
  price: Decimal.Value;
  promoPrice?: Decimal.Value | null;
  discountPercent?: Decimal.Value | null;
}

export interface OfferRow {
  id: string;
  kind: "PRICE_OVERRIDE" | "PERCENT_DISCOUNT" | "FIXED_DISCOUNT" | "FREE_PLAN" | "FREE_FEATURE" | string;
  status: string;
  packageId: string | null;
  cycleId: string | null;
  featureId: string | null;
  value: Decimal.Value | null;
  startsAt: Date;
  endsAt: Date;
}

export interface Quote {
  listPrice: string; // the plan's regular price for the cycle
  basePrice: string; // after the plan's own promo price / discount %
  finalPrice: string; // after the vendor's special offer
  savings: string; // listPrice - finalPrice
  offerId: string | null;
  offerKind: string | null;
}

export function offerIsLive(o: Pick<OfferRow, "status" | "startsAt" | "endsAt">, now: Date): boolean {
  return o.status === "ACTIVE" && o.startsAt <= now && now < o.endsAt;
}

/** A price offer applies to this plan (and to this cycle, when the offer names one). */
export function offerAppliesToPrice(o: OfferRow, packageId: string, cycleId: string, now: Date): boolean {
  // FREE_PLAN / FREE_FEATURE are access overlays (decideFeature), not prices:
  // they never make a paid period free and never outlive their end date.
  if (!offerIsLive(o, now) || o.kind === "FREE_FEATURE" || o.kind === "FREE_PLAN") return false;
  if (o.packageId !== packageId) return false;
  return !o.cycleId || o.cycleId === cycleId;
}

export function planBasePrice(row: PriceRow): Decimal {
  const list = money(row.price);
  if (row.promoPrice !== null && row.promoPrice !== undefined) return round2(clamp0(Decimal.min(list, money(row.promoPrice))));
  if (row.discountPercent !== null && row.discountPercent !== undefined) {
    const pct = Decimal.min(100, Decimal.max(0, money(row.discountPercent)));
    return round2(list.times(new Decimal(100).minus(pct)).dividedBy(100));
  }
  return round2(list);
}

export function applyOfferToBase(base: Decimal, offer: OfferRow | null): Decimal {
  if (!offer) return base;
  const v = money(offer.value);
  switch (offer.kind) {
    case "PRICE_OVERRIDE":
      return round2(clamp0(v));
    case "PERCENT_DISCOUNT":
      return round2(clamp0(base.times(new Decimal(100).minus(Decimal.min(100, v))).dividedBy(100)));
    case "FIXED_DISCOUNT":
      return round2(clamp0(base.minus(v)));
    case "FREE_PLAN":
      return ZERO;
    default:
      return base;
  }
}

/**
 * The vendor's price for one plan + cycle. When several live offers apply,
 * the cheapest result wins (deterministic: then the earliest-ending offer).
 */
export function quote(row: PriceRow, offers: OfferRow[], packageId: string, cycleId: string, now: Date): Quote {
  const list = round2(money(row.price));
  const base = planBasePrice(row);
  let best: { price: Decimal; offer: OfferRow | null } = { price: base, offer: null };
  const candidates = offers
    .filter((o) => offerAppliesToPrice(o, packageId, cycleId, now))
    .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime() || a.id.localeCompare(b.id));
  for (const o of candidates) {
    const p = applyOfferToBase(base, o);
    if (p.lessThan(best.price)) best = { price: p, offer: o };
  }
  return {
    listPrice: list.toFixed(2),
    basePrice: base.toFixed(2),
    finalPrice: best.price.toFixed(2),
    savings: clamp0(list.minus(best.price)).toFixed(2),
    offerId: best.offer?.id ?? null,
    offerKind: best.offer?.kind ?? null,
  };
}

// ─── features and limits ────────────────────────────────────────────────────

export type LimitType = "number" | "boolean";
export interface LimitDef {
  key: string;
  label: string;
  type: LimitType;
  unit?: string;
  period?: "MONTH";
}
/** limitKey → number (cap) | boolean | null (= unlimited). */
export type LimitConfig = Record<string, number | boolean | null>;

const KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;
export const isFeatureKey = (v: unknown): v is string => typeof v === "string" && KEY_RE.test(v);
export const isSlug = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) && v.length <= 60;

export function validateLimitDefs(raw: unknown): { ok: true; value: LimitDef[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "limitDefs must be a list" };
  if (raw.length > 20) return { ok: false, message: "At most 20 limits per feature" };
  const seen = new Set<string>();
  const out: LimitDef[] = [];
  for (const d of raw) {
    const key = (d as any)?.key;
    const label = String((d as any)?.label ?? "").trim();
    const type = (d as any)?.type;
    if (!isFeatureKey(key)) return { ok: false, message: `Invalid limit key "${String(key)}" (lowercase letters, digits, _)` };
    if (seen.has(key)) return { ok: false, message: `Duplicate limit key "${key}"` };
    if (!label || label.length > 80) return { ok: false, message: `Limit "${key}" needs a label (max 80)` };
    if (type !== "number" && type !== "boolean") return { ok: false, message: `Limit "${key}" type must be number or boolean` };
    const period = (d as any)?.period;
    if (period !== undefined && period !== null && period !== "MONTH") return { ok: false, message: `Limit "${key}" period must be MONTH or empty` };
    if (period === "MONTH" && type !== "number") return { ok: false, message: `Only number limits can reset monthly ("${key}")` };
    const unit = (d as any)?.unit ? String((d as any).unit).slice(0, 30) : undefined;
    seen.add(key);
    out.push({ key, label, type, ...(unit ? { unit } : {}), ...(period === "MONTH" ? { period: "MONTH" as const } : {}) });
  }
  return { ok: true, value: out };
}

/** Values for a plan↔feature assignment, checked against the feature's definitions. Missing keys = unlimited / allowed. */
export function validateLimitConfig(defs: LimitDef[], raw: unknown): { ok: true; value: LimitConfig } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "Limits must be an object" };
  const out: LimitConfig = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const def = defs.find((d) => d.key === k);
    if (!def) return { ok: false, message: `Unknown limit "${k}" for this feature` };
    if (v === null) out[k] = null;
    else if (def.type === "number") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1_000_000_000) return { ok: false, message: `Limit "${k}" must be a whole number ≥ 0, or unlimited` };
      out[k] = v;
    } else {
      if (typeof v !== "boolean") return { ok: false, message: `Limit "${k}" must be true or false` };
      out[k] = v;
    }
  }
  return { ok: true, value: out };
}

/** Most generous of several limit sets: unlimited (null or missing) > bigger number; true > false. */
export function mergeLimits(defs: LimitDef[], sets: LimitConfig[]): LimitConfig {
  const out: LimitConfig = {};
  for (const d of defs) {
    let best: number | boolean | null | undefined;
    for (const s of sets) {
      const v = d.key in s ? s[d.key] : null;
      if (v === null) { best = null; break; }
      if (best === undefined) best = v;
      else if (typeof v === "number" && typeof best === "number") best = Math.max(best, v);
      else if (typeof v === "boolean" && typeof best === "boolean") best = best || v;
    }
    out[d.key] = best === undefined ? null : best;
  }
  return out;
}

export type GrantSource = "PLAN" | "OFFER_FREE_PLAN" | "OFFER_FREE_FEATURE" | "UNGATED";
export type DenyReason = "FEATURE_UNKNOWN" | "SUBSCRIPTION_INACTIVE" | "FEATURE_NOT_IN_PLAN";

export interface FeatureInputs {
  feature: { id: string; key: string; isActive: boolean; enforced: boolean; limitDefs: LimitDef[] } | null;
  subState: SubState;
  /** Assignment of this feature on the vendor's current plan (if any). */
  planAssignment: { enabled: boolean; config: LimitConfig } | null;
  /** Assignments of this feature on plans granted by live FREE_PLAN offers. */
  freePlanAssignments: { offerId: string; enabled: boolean; config: LimitConfig }[];
  /** Live FREE_FEATURE offers for this feature. */
  freeFeatureOfferIds: string[];
}

export interface FeatureDecision {
  allowed: boolean; // after enforcement mode
  granted: boolean; // what the subscription data alone says
  enforced: boolean;
  reason: DenyReason | null;
  sources: GrantSource[];
  offerIds: string[];
  limits: LimitConfig;
}

export function decideFeature(i: FeatureInputs): FeatureDecision {
  if (!i.feature) return { allowed: false, granted: false, enforced: true, reason: "FEATURE_UNKNOWN", sources: [], offerIds: [], limits: {} };
  const f = i.feature;
  // A deactivated feature is not for sale: nothing is gated on it.
  if (!f.isActive) return { allowed: true, granted: true, enforced: false, reason: null, sources: ["UNGATED"], offerIds: [], limits: mergeLimits(f.limitDefs, [{}]) };
  const sources: GrantSource[] = [];
  const offerIds: string[] = [];
  const sets: LimitConfig[] = [];
  const operative = OPERATIVE_STATES.includes(i.subState);
  if (operative && i.planAssignment?.enabled) { sources.push("PLAN"); sets.push(i.planAssignment.config); }
  for (const a of i.freePlanAssignments) if (a.enabled) { sources.push("OFFER_FREE_PLAN"); offerIds.push(a.offerId); sets.push(a.config); }
  for (const id of i.freeFeatureOfferIds) { sources.push("OFFER_FREE_FEATURE"); offerIds.push(id); sets.push({}); }
  const granted = sources.length > 0;
  const reason: DenyReason | null = granted ? null : operative ? "FEATURE_NOT_IN_PLAN" : "SUBSCRIPTION_INACTIVE";
  return {
    allowed: granted || !f.enforced,
    granted,
    enforced: f.enforced,
    reason,
    sources: [...new Set(sources)],
    offerIds: [...new Set(offerIds)],
    limits: granted ? mergeLimits(f.limitDefs, sets) : {},
  };
}

/** Usage counter period for a limit: calendar month in Asia/Dhaka (UTC+6, no DST), or one lifetime bucket. */
export function usagePeriodKey(def: Pick<LimitDef, "period"> | undefined, now: Date): string {
  if (def?.period !== "MONTH") return "ALL";
  const dhaka = new Date(now.getTime() + 6 * 3_600_000);
  return `${dhaka.getUTCFullYear()}-${String(dhaka.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ─── periods ────────────────────────────────────────────────────────────────

/** Calendar months, clamped to the target month's last day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export type ChangeStartsFrom = "NOW" | "CURRENT_END";

/**
 * The period a new payment / activation buys.
 *   Same plan, still ACTIVE/GRACE with a future end → renewal: starts at the current end (no lost days).
 *   Different plan: "NOW" (default) starts immediately; "CURRENT_END" starts after the current paid end.
 *   Otherwise starts now.
 */
export function periodFor(
  current: { state: SubState; packageId: string | null; expiresAt: Date | null } | null,
  packageId: string,
  months: number,
  now: Date,
  changeStartsFrom: ChangeStartsFrom = "NOW",
): { start: Date; end: Date; kind: "NEW" | "RENEWAL" | "CHANGE" } {
  const live = current && OPERATIVE_STATES.includes(current.state) && current.expiresAt && current.expiresAt > now;
  if (live && current!.packageId === packageId) return { start: current!.expiresAt!, end: addMonths(current!.expiresAt!, months), kind: "RENEWAL" };
  if (live && current!.packageId && current!.packageId !== packageId) {
    const start = changeStartsFrom === "CURRENT_END" ? current!.expiresAt! : now;
    return { start, end: addMonths(start, months), kind: "CHANGE" };
  }
  return { start: now, end: addMonths(now, months), kind: current?.packageId && current.packageId !== packageId ? "CHANGE" : "NEW" };
}

// ─── subscription settings (platform_settings) ─────────────────────────────

export const SUBS_SETTING_KEYS = {
  graceDays: "subs.graceDays",
  reminderDays: "subs.reminderDays",
  changeStartsFrom: "subs.changeStartsFrom",
  enforcement: "subs.enforcement", // "enforce" | "monitor" — global kill switch over per-feature `enforced`
} as const;

export interface SubsSettings {
  graceDays: number;
  reminderDays: number;
  changeStartsFrom: ChangeStartsFrom;
  enforcement: "enforce" | "monitor";
}

export const DEFAULT_SUBS_SETTINGS: SubsSettings = { graceDays: 3, reminderDays: 7, changeStartsFrom: "NOW", enforcement: "enforce" };

const intIn = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

export function parseSubsSettings(raw: Partial<Record<keyof SubsSettings, string | undefined>>): SubsSettings {
  return {
    graceDays: intIn(raw.graceDays, 0, 60) ?? DEFAULT_SUBS_SETTINGS.graceDays,
    reminderDays: intIn(raw.reminderDays, 0, 60) ?? DEFAULT_SUBS_SETTINGS.reminderDays,
    changeStartsFrom: raw.changeStartsFrom === "CURRENT_END" ? "CURRENT_END" : "NOW",
    enforcement: raw.enforcement === "monitor" ? "monitor" : "enforce",
  };
}

export function validateSubsSettings(input: unknown): { ok: true; value: SubsSettings } | { ok: false; message: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const graceDays = intIn(i.graceDays, 0, 60);
  const reminderDays = intIn(i.reminderDays, 0, 60);
  if (graceDays === null) return { ok: false, message: "Grace days must be a whole number from 0 to 60" };
  if (reminderDays === null) return { ok: false, message: "Reminder days must be a whole number from 0 to 60" };
  if (i.changeStartsFrom !== "NOW" && i.changeStartsFrom !== "CURRENT_END") return { ok: false, message: "Plan change timing must be NOW or CURRENT_END" };
  if (i.enforcement !== "enforce" && i.enforcement !== "monitor") return { ok: false, message: "Enforcement must be enforce or monitor" };
  return { ok: true, value: { graceDays, reminderDays, changeStartsFrom: i.changeStartsFrom, enforcement: i.enforcement } };
}
