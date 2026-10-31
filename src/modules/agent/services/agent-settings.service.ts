// src/modules/agent/services/agent-settings.service.ts
//
// Admin-controlled agent settings (docs/agent-system-plan.md §2A.1).
//
//   • NOTHING is seeded or defaulted in code: a key that was never saved reads
//     as null ("not configured"); features that need it refuse with 409.
//     The single fail-safe is registrationRequiresApproval → true when unset
//     (new agents wait for approval — the safe direction, not a business value).
//   • Every value is validated server-side (zod + decimal.js), cross-field
//     rules are checked against the MERGED state (saved + update).
//   • Writes are serialized (advisory lock inside a Serializable transaction),
//     re-validated against the latest saved state, and audited in the same
//     transaction (agent_config_audits).
//   • Reads go through a 30 s in-process cache, invalidated on save in this
//     process; money-critical callers pass { fresh: true }.

import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { agentDb, agentTransaction, lockConfigArea } from "../agent-db.ts";
import { AgentError } from "../agent-http.ts";
import { money, percent } from "../validators/agent-primitives.ts";
import { writeConfigAudit, type AdminActor } from "./agent-audit.service.ts";

export const PAYOUT_METHODS = ["BKASH", "NAGAD", "BANK"] as const;
export const RATE_SOURCES = ["VENDOR", "AGENT", "CATEGORY", "LEVEL", "GLOBAL"] as const;
export type RateSource = (typeof RATE_SOURCES)[number];
/** Sources that must always be present in the precedence list. */
export const REQUIRED_RATE_SOURCES: RateSource[] = ["VENDOR", "AGENT", "LEVEL", "GLOBAL"];

const withdrawalFeeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NONE") }).strict(),
  z.object({ type: z.literal("FLAT"), amount: money({ label: "Withdrawal fee" }) }).strict(),
  z.object({ type: z.literal("PERCENT"), percent: percent("Withdrawal fee") }).strict(),
]);

const precedenceSchema = z
  .array(z.enum(RATE_SOURCES))
  .min(4)
  .max(5)
  .superRefine((list, ctx) => {
    if (new Set(list).size !== list.length) ctx.addIssue({ code: "custom", message: "Each source may appear only once" });
    for (const s of REQUIRED_RATE_SOURCES) {
      if (!list.includes(s)) ctx.addIssue({ code: "custom", message: `${s} must be included` });
    }
    if (list[list.length - 1] !== "GLOBAL") ctx.addIssue({ code: "custom", message: "GLOBAL must be last" });
  });

/** The registry: every setting key, its validator and its admin-page metadata. */
export const SETTING_DEFINITIONS = {
  defaultCommissionPercent: {
    group: "commission",
    label: "Default (global) commission %",
    description: "Used when no vendor, agent or level rate applies.",
    kind: "percent",
    schema: percent("Default commission"),
  },
  ratePrecedence: {
    group: "commission",
    label: "Rate precedence",
    description: "Order in which rate sources are checked. CATEGORY overrides apply only when CATEGORY is in this list.",
    kind: "precedence",
    schema: precedenceSchema,
  },
  holdDays: {
    group: "commission",
    label: "Hold days",
    description: "Days after delivery before a commission becomes withdrawable.",
    kind: "integer",
    schema: z.number({ error: "Hold days must be a whole number" }).int({ error: "Hold days must be a whole number" }).min(0).max(365),
  },
  commissionDurationMonths: {
    group: "commission",
    label: "Commission duration (months)",
    description: "How long after a vendor is linked the agent earns on it. Empty = for the life of the link.",
    kind: "integerOrNull",
    schema: z.number().int().min(1).max(240).nullable(),
  },
  minWithdrawalAmount: {
    group: "withdrawal",
    label: "Minimum withdrawal (৳)",
    description: "Smallest amount an agent can request.",
    kind: "money",
    schema: money({ label: "Minimum withdrawal" }),
  },
  maxWithdrawalAmount: {
    group: "withdrawal",
    label: "Maximum withdrawal (৳)",
    description: "Largest amount per request.",
    kind: "money",
    schema: money({ label: "Maximum withdrawal", positive: true }),
  },
  withdrawalFee: {
    group: "withdrawal",
    label: "Withdrawal fee",
    description: "None, a flat ৳ amount, or a percentage of the requested amount.",
    kind: "fee",
    schema: withdrawalFeeSchema,
  },
  enabledPayoutMethods: {
    group: "withdrawal",
    label: "Enabled payout methods",
    description: "Methods agents may choose for withdrawals.",
    kind: "methods",
    schema: z
      .array(z.enum(PAYOUT_METHODS))
      .min(1, { error: "Enable at least one payout method" })
      .refine((l) => new Set(l).size === l.length, { error: "Duplicate payout method" }),
  },
  autoApproveWithdrawalLimit: {
    group: "withdrawal",
    label: "Auto-approve limit (৳)",
    description: "Requests up to this amount are approved automatically (still paid manually). 0 = never.",
    kind: "money",
    schema: money({ label: "Auto-approve limit" }),
  },
  registrationRequiresApproval: {
    group: "registration",
    label: "New agent registrations need admin approval",
    description: "When on, self-registered agents start as Pending.",
    kind: "boolean",
    schema: z.boolean(),
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

export type WithdrawalFee = { type: "NONE" } | { type: "FLAT"; amount: string } | { type: "PERCENT"; percent: string };

export type AgentSettingsValues = {
  defaultCommissionPercent: string | null;
  ratePrecedence: RateSource[] | null;
  holdDays: number | null;
  commissionDurationMonths: number | null;
  minWithdrawalAmount: string | null;
  maxWithdrawalAmount: string | null;
  withdrawalFee: WithdrawalFee | null;
  enabledPayoutMethods: (typeof PAYOUT_METHODS)[number][] | null;
  autoApproveWithdrawalLimit: string | null;
  registrationRequiresApproval: boolean | null;
};

export type AgentSettingsSnapshot = {
  values: AgentSettingsValues;
  /** Keys that have never been saved. commissionDurationMonths is "configured"
   *  once saved, even when the saved value is null (= lifetime). */
  missing: SettingKey[];
  meta: Partial<Record<SettingKey, { updatedAt: string; updatedById: string | null }>>;
};

const EMPTY_VALUES: AgentSettingsValues = {
  defaultCommissionPercent: null,
  ratePrecedence: null,
  holdDays: null,
  commissionDurationMonths: null,
  minWithdrawalAmount: null,
  maxWithdrawalAmount: null,
  withdrawalFee: null,
  enabledPayoutMethods: null,
  autoApproveWithdrawalLimit: null,
  registrationRequiresApproval: null,
};

/** Cross-field rules over a merged settings state. Returns field → message. */
export function crossFieldErrors(v: AgentSettingsValues): Record<string, string> {
  const errors: Record<string, string> = {};
  const min = v.minWithdrawalAmount != null ? new Decimal(v.minWithdrawalAmount) : null;
  const max = v.maxWithdrawalAmount != null ? new Decimal(v.maxWithdrawalAmount) : null;
  if (min && max && max.lt(min)) errors.maxWithdrawalAmount = "Maximum withdrawal must be at least the minimum withdrawal";
  if (v.autoApproveWithdrawalLimit != null && max && new Decimal(v.autoApproveWithdrawalLimit).gt(max)) {
    errors.autoApproveWithdrawalLimit = "Auto-approve limit cannot exceed the maximum withdrawal";
  }
  if (v.withdrawalFee?.type === "FLAT" && min) {
    const fee = new Decimal(v.withdrawalFee.amount);
    // A request of exactly the minimum must still pay out something.
    if (fee.gt(0) && fee.gte(min)) errors.withdrawalFee = "A flat fee must be smaller than the minimum withdrawal";
  }
  return errors;
}

/** Validate one raw value for a key; throws ZodError on failure. */
export function parseSettingValue<K extends SettingKey>(key: K, raw: unknown): AgentSettingsValues[K] {
  return (SETTING_DEFINITIONS[key].schema as z.ZodType).parse(raw) as AgentSettingsValues[K];
}

function rowsToSnapshot(rows: Array<{ key: string; value: unknown; updatedAt: Date; updatedById: string | null }>): AgentSettingsSnapshot {
  const values: AgentSettingsValues = { ...EMPTY_VALUES };
  const meta: AgentSettingsSnapshot["meta"] = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (!(row.key in SETTING_DEFINITIONS)) continue; // unknown/legacy key: ignored
    const key = row.key as SettingKey;
    // Stored as { "value": X } (so a legitimate null — e.g. lifetime duration —
    // never depends on JSON-null handling). Values were validated on write;
    // re-parse defensively so a hand edit can never smuggle an invalid value in.
    const box = row.value as Record<string, unknown> | null;
    if (!box || typeof box !== "object" || Array.isArray(box) || !("value" in box)) {
      console.error(`[agent-settings] stored value for "${key}" is malformed and is treated as not configured`);
      continue;
    }
    const parsed = (SETTING_DEFINITIONS[key].schema as z.ZodType).safeParse(box.value);
    if (!parsed.success) {
      console.error(`[agent-settings] stored value for "${key}" is invalid and is treated as not configured`);
      continue;
    }
    (values as any)[key] = parsed.data;
    meta[key] = { updatedAt: row.updatedAt.toISOString(), updatedById: row.updatedById };
    seen.add(key);
  }
  return { values, missing: SETTING_KEYS.filter((k) => !seen.has(k)), meta };
}

// ── cache ────────────────────────────────────────────────────────────────
export const SETTINGS_CACHE_TTL_MS = 30_000;
let cache: { snapshot: AgentSettingsSnapshot; expiresAt: number } | null = null;

export function invalidateAgentSettingsCache(): void {
  cache = null;
}

export async function getAgentSettings(opts: { fresh?: boolean; db?: any } = {}): Promise<AgentSettingsSnapshot> {
  const now = Date.now();
  if (!opts.fresh && !opts.db && cache && cache.expiresAt > now) return cache.snapshot;
  const client = opts.db ?? agentDb.prisma;
  const rows = await client.agentSetting.findMany({ select: { key: true, value: true, updatedAt: true, updatedById: true } });
  const snapshot = rowsToSnapshot(rows);
  if (!opts.db) cache = { snapshot, expiresAt: now + SETTINGS_CACHE_TTL_MS };
  return snapshot;
}

/** Fail-safe read of the registration approval switch. */
export async function registrationRequiresApproval(): Promise<boolean> {
  const { values } = await getAgentSettings();
  return values.registrationRequiresApproval ?? true;
}

/** Throws 409 listing the keys a feature needs but that are not configured. */
export function requireConfigured(snapshot: AgentSettingsSnapshot, keys: SettingKey[], feature: string): void {
  const missing = keys.filter((k) => snapshot.missing.includes(k));
  if (missing.length) {
    throw new AgentError(`${feature} is not available until an admin configures: ${missing.join(", ")}`, 409, "SETTINGS_NOT_CONFIGURED", { missing });
  }
}

/** Public metadata for the admin settings page (no validators). */
export function settingDefinitionsForClient() {
  return SETTING_KEYS.map((key) => {
    const d = SETTING_DEFINITIONS[key];
    return { key, group: d.group, label: d.label, description: d.description, kind: d.kind };
  });
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Validate and save a partial update. Unknown keys → 400. Per-field and
 * cross-field errors → 400 VALIDATION_ERROR with field messages. Unchanged
 * keys are skipped (no write, no audit row).
 */
export async function updateAgentSettings(input: unknown, actor: AdminActor): Promise<{ snapshot: AgentSettingsSnapshot; changed: SettingKey[] }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AgentError("Body must be an object of setting values", 400, "VALIDATION_ERROR");
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (!entries.length) throw new AgentError("No settings to update", 400, "VALIDATION_ERROR");

  const fieldErrors: Record<string, string> = {};
  const parsed: Partial<AgentSettingsValues> = {};
  for (const [key, raw] of entries) {
    if (!(key in SETTING_DEFINITIONS)) {
      fieldErrors[key] = "Unknown setting";
      continue;
    }
    const result = (SETTING_DEFINITIONS[key as SettingKey].schema as z.ZodType).safeParse(raw);
    if (!result.success) fieldErrors[key] = result.error.issues[0]?.message ?? "Invalid value";
    else (parsed as any)[key] = result.data;
  }
  if (Object.keys(fieldErrors).length) {
    throw new AgentError("Validation failed", 400, "VALIDATION_ERROR", { errors: fieldErrors });
  }

  const changed = await agentTransaction(async (tx) => {
    await lockConfigArea(tx, "settings");
    const current = await getAgentSettings({ db: tx });
    const merged: AgentSettingsValues = { ...current.values, ...parsed };
    const cross = crossFieldErrors(merged);
    if (Object.keys(cross).length) {
      throw new AgentError("Validation failed", 400, "VALIDATION_ERROR", { errors: cross });
    }
    const changedKeys: SettingKey[] = [];
    for (const key of Object.keys(parsed) as SettingKey[]) {
      const newValue = (parsed as any)[key];
      const wasConfigured = !current.missing.includes(key);
      const oldValue = wasConfigured ? (current.values as any)[key] : undefined;
      if (wasConfigured && sameJson(oldValue, newValue)) continue;
      const stored = { value: newValue } as Prisma.InputJsonObject;
      await tx.agentSetting.upsert({
        where: { key },
        create: { key, value: stored, updatedById: actor.userId },
        update: { value: stored, updatedById: actor.userId },
      });
      await writeConfigAudit(tx, {
        entity: "SETTING",
        entityId: key,
        action: wasConfigured ? "UPDATE" : "CREATE",
        oldValue: wasConfigured ? { value: oldValue } : null,
        newValue: { value: newValue },
        actor,
      });
      changedKeys.push(key);
    }
    return changedKeys;
  });

  invalidateAgentSettingsCache();
  const snapshot = await getAgentSettings({ fresh: true });
  return { snapshot, changed };
}

/** Fee for a withdrawal amount under the given settings (exact decimals). */
export function withdrawalFeeFor(amount: string, fee: WithdrawalFee | null): string {
  if (!fee || fee.type === "NONE") return "0.00";
  if (fee.type === "FLAT") return new Decimal(fee.amount).toFixed(2);
  return new Decimal(amount).times(fee.percent).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
