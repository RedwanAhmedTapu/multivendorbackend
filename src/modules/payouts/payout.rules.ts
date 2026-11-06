// src/modules/payouts/payout.rules.ts
//
// Pure payout rules (no I/O, unit-tested):
//   - the platform payout policy and its per-vendor overrides;
//   - the next payout date for weekly / bi-weekly / monthly / quarterly /
//     custom cycles (calendar days in Asia/Dhaka, UTC+6, no DST; no fixed dates);
//   - how much of a vendor's ledger balance may be paid out now.
// Eligibility starts from VendorPayable.balance, which the voucher engine keeps
// in sync with the vendor's "Receivable from Platform" ledger account (sales on
// delivery, commission, refunds, returns, chargebacks and earlier payouts are
// already netted there). Nothing here recomputes commission or sales.

import { Decimal } from "@prisma/client/runtime/library";

export type PayoutCycleKind = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "CUSTOM";

export interface PayoutPolicy {
  cycle: PayoutCycleKind;
  weekday: number; // 0 = Sunday … 6 = Saturday (WEEKLY, BIWEEKLY)
  monthDays: number[]; // 1-31, clamped to month end (MONTHLY, QUARTERLY uses the first)
  customIntervalDays: number | null; // CUSTOM
  anchorDate: string | null; // YYYY-MM-DD: BIWEEKLY / CUSTOM start
  minThreshold: string; // ৳, decimal string
  settlementDelayDays: number; // ledger credits newer than this are not yet payable
  refundWindowDays: number; // the hold window is max(settlementDelayDays, refundWindowDays)
  autoPropose: boolean; // the job drafts a batch on payout days (never pays)
  requireApproval: boolean; // informational in v1: every batch is approved by an admin before "mark paid"
  holdAll: boolean; // platform-wide hold: nothing is proposed
}

export const DEFAULT_PAYOUT_POLICY: PayoutPolicy = {
  cycle: "WEEKLY",
  weekday: 0,
  monthDays: [1],
  customIntervalDays: null,
  anchorDate: null,
  minThreshold: "500",
  settlementDelayDays: 7,
  refundWindowDays: 7,
  autoPropose: false,
  requireApproval: true,
  holdAll: false,
};

export const PAYOUT_SETTING_KEY = "payout.policy";

export interface VendorRuleRow {
  cycle: PayoutCycleKind | null;
  weekday: number | null;
  monthDays: number[];
  customIntervalDays: number | null;
  anchorDate: Date | null;
  minThreshold: Decimal.Value | null;
  settlementDelayDays: number | null;
  requireApproval: boolean | null;
  paused: boolean;
  holdUntil: Date | null;
  holdReason: string | null;
}

export interface EffectiveRule extends PayoutPolicy {
  paused: boolean;
  holdUntil: string | null;
  holdReason: string | null;
  overridden: string[]; // fields taken from the vendor rule
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function validatePayoutPolicy(input: unknown): { ok: true; value: PayoutPolicy } | { ok: false; message: string } {
  const i = { ...DEFAULT_PAYOUT_POLICY, ...((input ?? {}) as Record<string, unknown>) } as Record<string, unknown>;
  const cycles: PayoutCycleKind[] = ["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "CUSTOM"];
  if (!cycles.includes(i.cycle as PayoutCycleKind)) return { ok: false, message: "Unknown payout cycle" };
  if (!isInt(i.weekday, 0, 6)) return { ok: false, message: "Weekday must be 0 (Sunday) to 6 (Saturday)" };
  if (!Array.isArray(i.monthDays) || i.monthDays.length === 0 || i.monthDays.length > 4 || !i.monthDays.every((d) => isInt(d, 1, 31)))
    return { ok: false, message: "Month days: 1 to 4 days between 1 and 31" };
  const custom = i.customIntervalDays === null || i.customIntervalDays === undefined ? null : i.customIntervalDays;
  if (i.cycle === "CUSTOM" && !isInt(custom, 1, 365)) return { ok: false, message: "A custom cycle needs an interval of 1 to 365 days" };
  if (custom !== null && !isInt(custom, 1, 365)) return { ok: false, message: "Custom interval must be 1 to 365 days" };
  const anchor = i.anchorDate === null || i.anchorDate === undefined || i.anchorDate === "" ? null : String(i.anchorDate);
  if (anchor !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || Number.isNaN(Date.parse(`${anchor}T00:00:00Z`)))) return { ok: false, message: "Anchor date must be YYYY-MM-DD" };
  if (i.cycle === "CUSTOM" && anchor === null) return { ok: false, message: "A custom cycle needs an anchor (start) date" };
  let threshold: Decimal;
  try { threshold = new Decimal(String(i.minThreshold)); } catch { return { ok: false, message: "Minimum threshold must be a number" }; }
  if (threshold.isNaN() || threshold.lessThan(0) || threshold.greaterThan(10_000_000)) return { ok: false, message: "Minimum threshold must be 0 to 10,000,000" };
  if (!isInt(i.settlementDelayDays, 0, 365)) return { ok: false, message: "Settlement delay must be 0 to 365 days" };
  if (!isInt(i.refundWindowDays, 0, 365)) return { ok: false, message: "Refund window must be 0 to 365 days" };
  for (const k of ["autoPropose", "requireApproval", "holdAll"] as const) if (typeof i[k] !== "boolean") return { ok: false, message: `${k} must be true or false` };
  return {
    ok: true,
    value: {
      cycle: i.cycle as PayoutCycleKind,
      weekday: i.weekday as number,
      monthDays: [...new Set(i.monthDays as number[])].sort((a, b) => a - b),
      customIntervalDays: custom as number | null,
      anchorDate: anchor,
      minThreshold: threshold.toDecimalPlaces(2).toFixed(2),
      settlementDelayDays: i.settlementDelayDays as number,
      refundWindowDays: i.refundWindowDays as number,
      autoPropose: i.autoPropose as boolean,
      requireApproval: i.requireApproval as boolean,
      holdAll: i.holdAll as boolean,
    },
  };
}

export function parsePayoutPolicy(raw: string | null | undefined): PayoutPolicy {
  if (!raw) return { ...DEFAULT_PAYOUT_POLICY };
  try {
    const v = validatePayoutPolicy(JSON.parse(raw));
    return v.ok ? v.value : { ...DEFAULT_PAYOUT_POLICY };
  } catch {
    return { ...DEFAULT_PAYOUT_POLICY };
  }
}

export function effectiveRule(policy: PayoutPolicy, rule: VendorRuleRow | null): EffectiveRule {
  const out: EffectiveRule = { ...policy, paused: false, holdUntil: null, holdReason: null, overridden: [] };
  if (!rule) return out;
  const take = <K extends keyof PayoutPolicy>(k: K, v: PayoutPolicy[K] | null | undefined) => {
    if (v === null || v === undefined) return;
    (out as any)[k] = v;
    out.overridden.push(k);
  };
  take("cycle", rule.cycle);
  take("weekday", rule.weekday);
  if (rule.monthDays.length) take("monthDays", rule.monthDays);
  take("customIntervalDays", rule.customIntervalDays);
  take("anchorDate", rule.anchorDate ? ymd(rule.anchorDate) : null);
  take("minThreshold", rule.minThreshold === null ? null : new Decimal(rule.minThreshold.toString()).toFixed(2));
  take("settlementDelayDays", rule.settlementDelayDays);
  take("requireApproval", rule.requireApproval);
  out.paused = rule.paused;
  out.holdUntil = rule.holdUntil ? rule.holdUntil.toISOString() : null;
  out.holdReason = rule.holdReason;
  return out;
}

// ─── schedule ───────────────────────────────────────────────────────────────

const OFFSET = 6 * 3_600_000; // Asia/Dhaka
const DAY = 86_400_000;
/** Dhaka calendar day number (days since 1970-01-01 in Dhaka). */
const dayNo = (d: Date) => Math.floor((d.getTime() + OFFSET) / DAY);
/** Midnight Dhaka of a day number, as a UTC instant. */
const fromDayNo = (n: number) => new Date(n * DAY - OFFSET);
const parts = (n: number) => {
  const d = new Date(n * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), wd: d.getUTCDay() };
};
const dayNoOf = (y: number, m: number, day: number) => {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(y, m, Math.min(day, last)) / DAY);
};
const anchorDayNo = (anchor: string | null) => (anchor ? Math.floor(Date.parse(`${anchor}T00:00:00Z`) / DAY) : null);

/** First payout day on or after `from` (Dhaka midnight), per the rule. */
export function nextPayoutDate(rule: Pick<PayoutPolicy, "cycle" | "weekday" | "monthDays" | "customIntervalDays" | "anchorDate">, from: Date): Date {
  const start = dayNo(from);
  switch (rule.cycle) {
    case "WEEKLY": {
      const wd = parts(start).wd;
      return fromDayNo(start + ((rule.weekday - wd + 7) % 7));
    }
    case "BIWEEKLY": {
      // Every 14 days from the anchor; without one, from the first matching weekday on or after 2026-01-01.
      let anchor = anchorDayNo(rule.anchorDate);
      if (anchor === null) {
        const base = Math.floor(Date.UTC(2026, 0, 1) / DAY);
        anchor = base + ((rule.weekday - parts(base).wd + 7) % 7);
      }
      if (start <= anchor) return fromDayNo(anchor);
      return fromDayNo(anchor + Math.ceil((start - anchor) / 14) * 14);
    }
    case "CUSTOM": {
      const every = rule.customIntervalDays ?? 30;
      const anchor = anchorDayNo(rule.anchorDate) ?? start;
      if (start <= anchor) return fromDayNo(anchor);
      return fromDayNo(anchor + Math.ceil((start - anchor) / every) * every);
    }
    case "MONTHLY":
    case "QUARTERLY": {
      const days = rule.cycle === "QUARTERLY" ? [rule.monthDays[0] ?? 1] : rule.monthDays.length ? rule.monthDays : [1];
      const p = parts(start);
      for (let k = 0; k < 15; k++) {
        const m = p.m + k;
        const y = p.y + Math.floor(m / 12);
        const mm = ((m % 12) + 12) % 12;
        if (rule.cycle === "QUARTERLY" && mm % 3 !== 0) continue;
        for (const d of [...days].sort((a, b) => a - b)) {
          const n = dayNoOf(y, mm, d);
          if (n >= start) return fromDayNo(n);
        }
      }
      return fromDayNo(start);
    }
  }
}

export function isPayoutDay(rule: Parameters<typeof nextPayoutDate>[0], day: Date): boolean {
  return dayNo(nextPayoutDate(rule, day)) === dayNo(day);
}

/** Start of the hold window: ledger credits dated on/after this are not payable yet. */
export function holdWindowStart(rule: Pick<PayoutPolicy, "settlementDelayDays" | "refundWindowDays">, now: Date): Date {
  return new Date(now.getTime() - Math.max(rule.settlementDelayDays, rule.refundWindowDays) * DAY);
}

// ─── eligibility ────────────────────────────────────────────────────────────

export interface EligibilityInput {
  balance: Decimal.Value; // VendorPayable.balance (ledger-derived)
  recentNet: Decimal.Value; // net movement on Receivable from Platform inside the hold window
  openItems: Decimal.Value; // amounts already in DRAFT/APPROVED payout batch items
  rule: EffectiveRule;
  now: Date;
}

export type IneligibleReason = "PAUSED" | "ON_HOLD" | "PLATFORM_HOLD" | "NOTHING_DUE" | "BELOW_THRESHOLD";

export interface Eligibility {
  balance: string;
  pendingInWindow: string; // not yet payable (inside settlement delay / refund window)
  inOpenBatches: string;
  available: string; // max(0, balance − pending − open)
  payable: boolean;
  amount: string; // what a batch would include (0 when not payable)
  reasons: IneligibleReason[];
}

export function computeEligibility(i: EligibilityInput): Eligibility {
  const zero = new Decimal(0);
  const balance = new Decimal(i.balance.toString());
  const pending = Decimal.max(zero, new Decimal(i.recentNet.toString()));
  const open = Decimal.max(zero, new Decimal(i.openItems.toString()));
  const available = Decimal.max(zero, balance.minus(pending).minus(open)).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const reasons: IneligibleReason[] = [];
  if (i.rule.holdAll) reasons.push("PLATFORM_HOLD");
  if (i.rule.paused) reasons.push("PAUSED");
  if (i.rule.holdUntil && new Date(i.rule.holdUntil) > i.now) reasons.push("ON_HOLD");
  if (available.lessThanOrEqualTo(0)) reasons.push("NOTHING_DUE");
  else if (available.lessThan(new Decimal(i.rule.minThreshold))) reasons.push("BELOW_THRESHOLD");
  const payable = reasons.length === 0;
  return {
    balance: balance.toFixed(2),
    pendingInWindow: pending.toFixed(2),
    inOpenBatches: open.toFixed(2),
    available: available.toFixed(2),
    payable,
    amount: payable ? available.toFixed(2) : "0.00",
    reasons,
  };
}

export function batchNumberFor(day: Date, seq: number): string {
  const p = parts(dayNo(day));
  return `PO-${p.y}${String(p.m + 1).padStart(2, "0")}${String(p.day).padStart(2, "0")}-${String(seq).padStart(3, "0")}`;
}
