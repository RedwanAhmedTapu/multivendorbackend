// src/modules/pos-subscription/entitlement.ts
//
// Pure POS entitlement rules — no I/O. Access is decided from the PERSISTED
// subscription row and the server clock at request time; the expiry sweep job
// only tidies `status` and sends reminders, so a late or skipped job can never
// extend anyone's access.
//
// States (in order of precedence):
//   NONE        no subscription row
//   INVALID     TRIAL/PAID row without an end date (data error)
//   SUSPENDED   admin suspension
//   CANCELLED   admin revocation
//   ACTIVE      now < expiresAt, or open-ended COMPLIMENTARY / LEGACY access
//   GRACE       expiresAt <= now < expiresAt + grace (only if an admin set grace)
//   EXPIRED     past the grace period
//
// Capability: canOperate — every operational POS mutation (sales, refunds,
// voids, due collection, customer writes, settings/bank changes) — is true
// ONLY in ACTIVE and GRACE. Every other state blocks all of them; nothing
// "post-sale" survives expiry. Subscription status, renewal/checkout and the
// vendor's own historical read-only views are not gated by entitlement (they
// stay behind the vendor-scoped session gate).

export type PosSubscriptionSource = "TRIAL" | "PAID" | "COMPLIMENTARY" | "LEGACY";
export type PosSubStatus = "ACTIVE" | "EXPIRED" | "CANCELLED" | "SUSPENDED";
export type EntitlementState = "NONE" | "INVALID" | "SUSPENDED" | "CANCELLED" | "ACTIVE" | "GRACE" | "EXPIRED";

export interface SubscriptionSnapshot {
  status: PosSubStatus | string;
  source?: PosSubscriptionSource | string | null;
  expiresAt?: Date | string | null;
}

export interface Entitlement {
  state: EntitlementState;
  canOperate: boolean;
  expiresAt: string | null;
  graceEndsAt: string | null;
  /** Whole days until operation stops; null when open-ended or already blocked. */
  daysLeft: number | null;
}

const DAY_MS = 86_400_000;
const OPEN_ENDED_SOURCES = new Set(["COMPLIMENTARY", "LEGACY"]);

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function result(state: EntitlementState, canOperate: boolean, expiresAt: Date | null, graceEndsAt: Date | null, now: Date): Entitlement {
  const end = graceEndsAt ?? expiresAt;
  return {
    state,
    canOperate,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    graceEndsAt: graceEndsAt ? graceEndsAt.toISOString() : null,
    daysLeft: canOperate && end ? Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS)) : null,
  };
}

/** Grace days must be a whole number 0–30; anything else counts as 0. */
export function normalizeGraceDays(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 30 ? n : 0;
}

export function evaluateEntitlement(sub: SubscriptionSnapshot | null | undefined, now: Date, graceDays = 0): Entitlement {
  if (!sub) return result("NONE", false, null, null, now);
  const expiresAt = toDate(sub.expiresAt);
  const source = String(sub.source ?? "");

  if (sub.status === "SUSPENDED") return result("SUSPENDED", false, expiresAt, null, now);
  if (sub.status === "CANCELLED") return result("CANCELLED", false, expiresAt, null, now);
  // A row marked EXPIRED stays blocked whatever its date says; only a verified
  // payment or an audited admin action sets it back to ACTIVE.
  if (sub.status === "EXPIRED") return result("EXPIRED", false, expiresAt, null, now);
  if (sub.status !== "ACTIVE") return result("INVALID", false, expiresAt, null, now);

  if (!expiresAt) {
    if (OPEN_ENDED_SOURCES.has(source) && sub.status === "ACTIVE") return result("ACTIVE", true, null, null, now);
    return result("INVALID", false, null, null, now);
  }

  const grace = normalizeGraceDays(graceDays);
  const graceEndsAt = grace > 0 ? new Date(expiresAt.getTime() + grace * DAY_MS) : null;
  if (now.getTime() < expiresAt.getTime()) return result("ACTIVE", true, expiresAt, graceEndsAt, now);
  if (graceEndsAt && now.getTime() < graceEndsAt.getTime()) return result("GRACE", true, expiresAt, graceEndsAt, now);
  return result("EXPIRED", false, expiresAt, graceEndsAt, now);
}

/**
 * New end date for a paid or admin extension: periods stack on the current
 * end when it is still in the future, otherwise start now. Never shortens.
 */
export function extendFrom(currentExpiresAt: Date | null | undefined, now: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw new Error("Extension must be 1–3660 whole days");
  const base = currentExpiresAt && currentExpiresAt.getTime() > now.getTime() ? currentExpiresAt : now;
  return new Date(base.getTime() + days * DAY_MS);
}

// ─── policy settings (PlatformSettings key/value rows) ─────────────────────

export const POS_POLICY_KEYS = {
  trialEnabled: "pos.trial.enabled",
  trialDays: "pos.trial.days",
  graceDays: "pos.grace.days",
} as const;

export interface PosPolicy {
  /** No automatic trial unless an admin turns it on AND sets a duration. */
  trialEnabled: boolean;
  trialDays: number | null;
  graceDays: number;
}

/** Parse stored strings; unset or malformed values fall back to "off". */
export function parsePosPolicy(raw: Partial<Record<keyof typeof POS_POLICY_KEYS, string | null | undefined>>): PosPolicy {
  const days = Number(raw.trialDays);
  const trialDays = Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
  return {
    trialEnabled: raw.trialEnabled === "true" && trialDays !== null,
    trialDays,
    graceDays: normalizeGraceDays(raw.graceDays),
  };
}

export type PolicyValidation = { ok: true; value: { trialEnabled: boolean; trialDays: number | null; graceDays: number } } | { ok: false; message: string };

export function validatePolicyInput(v: unknown): PolicyValidation {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, message: "Expected an object" };
  const o = v as Record<string, unknown>;
  if (typeof o.trialEnabled !== "boolean") return { ok: false, message: "trialEnabled must be true or false" };
  let trialDays: number | null = null;
  if (o.trialDays !== undefined && o.trialDays !== null) {
    if (!Number.isInteger(o.trialDays) || (o.trialDays as number) < 1 || (o.trialDays as number) > 365) {
      return { ok: false, message: "trialDays must be a whole number between 1 and 365" };
    }
    trialDays = o.trialDays as number;
  }
  if (o.trialEnabled && trialDays === null) return { ok: false, message: "Set trialDays to enable the automatic trial" };
  const graceDays = o.graceDays === undefined ? 0 : (o.graceDays as number);
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 30) return { ok: false, message: "graceDays must be a whole number between 0 and 30" };
  return { ok: true, value: { trialEnabled: o.trialEnabled, trialDays, graceDays } };
}

// ─── money (plan prices, payments) ─────────────────────────────────────────

/** "1500", "1500.5", 1500 → "1500.00"; null for anything not a positive amount with ≤ 2 decimals. */
export function normalizeAmount(v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(s)) return null;
  const [int, frac = ""] = s.split(".");
  if (frac.length > 2 && !/^0+$/.test(frac.slice(2))) return null; // gateways may send 1500.0000
  const out = `${BigInt(int).toString()}.${frac.slice(0, 2).padEnd(2, "0")}`;
  return out === "0.00" ? null : out;
}

/** Exact comparison of two money strings/numbers at 2 decimals (no float drift). */
export function sameAmount(a: unknown, b: unknown): boolean {
  const x = normalizeAmount(a);
  const y = normalizeAmount(b);
  return x !== null && x === y;
}
