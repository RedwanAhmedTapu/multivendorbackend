// src/modules/agent/services/agent-rate.service.ts
//
// Commission-rate resolution (docs/agent-system-plan.md §2A.3) and the
// snapshot copied onto every commission row (§2A.5).
//
// resolveAgentCommissionRate is PURE: given the precedence list from the
// settings, the active overrides, the agent's level and the global rate, it
// walks the list and returns the first source with a value, plus a trace of
// every source it considered. Nothing about the order of sources or the
// rates is hardcoded — all of it comes from admin-managed data.

import Decimal from "decimal.js";
import { agentDb } from "../agent-db.ts";
import type { AgentSettingsSnapshot, RateSource } from "./agent-settings.service.ts";

export type RateCandidate = { id: string; ratePercent: string } | null;
export type LevelCandidate = { id: string; name: string; isActive: boolean; commissionPercent: string | null } | null;

export type RateInputs = {
  precedence: RateSource[] | null;
  defaultCommissionPercent: string | null;
  vendorOverride: RateCandidate;
  agentOverride: RateCandidate;
  categoryOverride: RateCandidate;
  level: LevelCandidate;
};

export type RateTraceStep = { source: RateSource; outcome: "USED" | "NO_VALUE" | "SKIPPED"; detail: string };

export type RateResolution =
  | { status: "RESOLVED"; source: RateSource; refId: string | null; ratePercent: string; trace: RateTraceStep[] }
  | { status: "NOT_CONFIGURED"; reason: string; trace: RateTraceStep[] };

export function resolveAgentCommissionRate(input: RateInputs): RateResolution {
  const trace: RateTraceStep[] = [];
  if (!input.precedence || input.precedence.length === 0) {
    return { status: "NOT_CONFIGURED", reason: "Rate precedence is not configured", trace };
  }
  for (const source of input.precedence) {
    switch (source) {
      case "VENDOR":
      case "AGENT":
      case "CATEGORY": {
        const candidate =
          source === "VENDOR" ? input.vendorOverride : source === "AGENT" ? input.agentOverride : input.categoryOverride;
        if (candidate) {
          trace.push({ source, outcome: "USED", detail: `Active ${source.toLowerCase()} override ${candidate.id}` });
          return { status: "RESOLVED", source, refId: candidate.id, ratePercent: normalizePercent(candidate.ratePercent), trace };
        }
        trace.push({ source, outcome: "NO_VALUE", detail: `No active ${source.toLowerCase()} override` });
        break;
      }
      case "LEVEL": {
        const level = input.level;
        if (!level) {
          trace.push({ source, outcome: "NO_VALUE", detail: "Agent has no level" });
        } else if (!level.isActive) {
          trace.push({ source, outcome: "SKIPPED", detail: `Level "${level.name}" is inactive` });
        } else if (level.commissionPercent == null) {
          trace.push({ source, outcome: "NO_VALUE", detail: `Level "${level.name}" has no commission %` });
        } else {
          trace.push({ source, outcome: "USED", detail: `Level "${level.name}"` });
          return { status: "RESOLVED", source, refId: level.id, ratePercent: normalizePercent(level.commissionPercent), trace };
        }
        break;
      }
      case "GLOBAL": {
        if (input.defaultCommissionPercent == null) {
          trace.push({ source, outcome: "NO_VALUE", detail: "Default commission % is not configured" });
          return { status: "NOT_CONFIGURED", reason: "Default commission % is not configured", trace };
        }
        trace.push({ source, outcome: "USED", detail: "Default commission %" });
        return { status: "RESOLVED", source, refId: null, ratePercent: normalizePercent(input.defaultCommissionPercent), trace };
      }
    }
  }
  return { status: "NOT_CONFIGURED", reason: "No source in the precedence list produced a rate", trace };
}

function normalizePercent(v: string | number | { toString(): string }): string {
  return new Decimal(v.toString()).toFixed(4);
}

/** Load the resolver inputs from the database for one agent/vendor/category at time `at`. */
export async function loadRateInputs(
  params: { agentId: string | null; vendorId: string | null; categoryId: string | null; at?: Date },
  settings: AgentSettingsSnapshot,
  db: any = agentDb.prisma,
): Promise<RateInputs> {
  const at = params.at ?? new Date();
  const window = {
    isActive: true,
    effectiveFrom: { lte: at },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
  };
  const pick = (row: any): RateCandidate => (row ? { id: row.id, ratePercent: row.ratePercent.toString() } : null);
  const [vendorOverride, agentOverride, categoryOverride, agent] = await Promise.all([
    params.vendorId
      ? db.agentCommissionOverride.findFirst({ where: { ...window, scope: "VENDOR", vendorId: params.vendorId }, select: { id: true, ratePercent: true } })
      : null,
    params.agentId
      ? db.agentCommissionOverride.findFirst({ where: { ...window, scope: "AGENT", agentId: params.agentId }, select: { id: true, ratePercent: true } })
      : null,
    params.categoryId
      ? db.agentCommissionOverride.findFirst({ where: { ...window, scope: "CATEGORY", categoryId: params.categoryId }, select: { id: true, ratePercent: true } })
      : null,
    params.agentId
      ? db.agent.findUnique({
          where: { id: params.agentId },
          select: { level: { select: { id: true, name: true, isActive: true, commissionPercent: true } } },
        })
      : null,
  ]);
  const level = agent?.level
    ? {
        id: agent.level.id,
        name: agent.level.name,
        isActive: agent.level.isActive,
        commissionPercent: agent.level.commissionPercent == null ? null : agent.level.commissionPercent.toString(),
      }
    : null;
  return {
    precedence: settings.values.ratePrecedence,
    defaultCommissionPercent: settings.values.defaultCommissionPercent,
    vendorOverride: pick(vendorOverride),
    agentOverride: pick(agentOverride),
    categoryOverride: pick(categoryOverride),
    level,
  };
}

/**
 * The immutable snapshot columns for an agent_commissions row (§2A.5). Built
 * once from the resolution and the settings in force; the commission engine
 * (Phase 6) writes it verbatim and no code path ever updates these columns.
 */
export const COMMISSION_SNAPSHOT_FIELDS = [
  "rateSource",
  "rateRefId",
  "ratePercent",
  "levelId",
  "levelName",
  "holdDays",
  "durationMonths",
  "ruleSnapshot",
] as const;

export function buildCommissionSnapshot(
  resolution: Extract<RateResolution, { status: "RESOLVED" }>,
  inputs: RateInputs,
  settings: AgentSettingsSnapshot,
  resolvedAt: Date,
) {
  if (settings.values.holdDays == null) {
    throw new Error("holdDays is not configured");
  }
  return Object.freeze({
    rateSource: resolution.source,
    rateRefId: resolution.refId,
    ratePercent: resolution.ratePercent,
    levelId: inputs.level?.id ?? null,
    levelName: inputs.level?.name ?? null,
    holdDays: settings.values.holdDays,
    durationMonths: settings.values.commissionDurationMonths,
    ruleSnapshot: {
      resolvedAt: resolvedAt.toISOString(),
      precedence: inputs.precedence,
      defaultCommissionPercent: inputs.defaultCommissionPercent,
      candidates: {
        vendorOverride: inputs.vendorOverride,
        agentOverride: inputs.agentOverride,
        categoryOverride: inputs.categoryOverride,
        level: inputs.level,
      },
      trace: resolution.trace,
    },
  });
}

/** Guard for any future update path on agent_commissions. */
export function assertNoSnapshotMutation(data: Record<string, unknown>): void {
  const touched = COMMISSION_SNAPSHOT_FIELDS.filter((f) => f in data);
  if (touched.length) throw new Error(`Commission snapshot fields are immutable: ${touched.join(", ")}`);
}

/** Commission amount for a base and a rate: base × rate / 100, half-up to paisa. */
export function commissionAmount(baseAmount: string, ratePercent: string): string {
  return new Decimal(baseAmount).times(ratePercent).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
