// src/modules/agent/services/agent-level.service.ts
//
// Phase 9 — automatic level evaluation (docs/agent-system-plan.md §2A.4, C9).
//
// Every rule comes from the admin-managed agent_levels rows:
//   minActiveVendors     open links whose vendor is ACTIVE (now)
//   minDeliveredSales    lifetime delivered sales of attributed lines (৳, net of returns)
//   minPerformanceScore  the 0–100 performance score; a level that sets it can
//                        only be reached once the score weights are configured
// v1 is UPGRADE ONLY: an agent moves to the highest active level whose
// thresholds are all met and whose rank is above the current one; nobody is
// ever moved down (an admin can still set a level by hand).
// Each level passed on the way up pays its optional bonusAmount once, as a
// BONUS_CREDIT ledger entry (ref AgentLevelBonus / "<agentId>:<levelId>").
// The change is a guarded update on the agent's previous levelId and is
// audited (AGENT / UPDATE) in the same transaction.
//
// Schedule: the agent:growth job evaluates every ACTIVE agent once per Asia/Dhaka
// month (marker row "levelEvaluationLastRun" in agent_settings); admins can run
// it at any time ("Run evaluation now").

import Decimal from "decimal.js";
import { agentDb, agentTransaction } from "../agent-db.ts";
import { notFound } from "../agent-http.ts";
import { writeConfigAudit, type AdminActor } from "./agent-audit.service.ts";
import { activeVendorCount, deliveredStats, dhakaMonthKey, performanceScoreOf } from "./agent-growth.service.ts";
import { LEDGER_REF_BONUS } from "./agent-bonus.service.ts";
import { lockWallet, postLedger, saveWallet } from "./agent-wallet.service.ts";

export const LEVEL_EVALUATION_ACTOR: AdminActor = { userId: "system:level-evaluation", name: "Monthly level evaluation", ip: null, userAgent: null };
export const LEVEL_EVALUATION_MARKER = "levelEvaluationLastRun";

const dec = (v: unknown) => new Decimal(v == null ? 0 : (v as any).toString());

type LevelRow = {
  id: string;
  name: string;
  rank: number;
  minActiveVendors: number;
  minDeliveredSales: unknown;
  minPerformanceScore: unknown | null;
  commissionPercent: unknown | null;
  bonusAmount: unknown | null;
  perks: unknown;
  isActive: boolean;
};

const LEVEL_SELECT = {
  id: true,
  name: true,
  rank: true,
  minActiveVendors: true,
  minDeliveredSales: true,
  minPerformanceScore: true,
  commissionPercent: true,
  bonusAmount: true,
  perks: true,
  isActive: true,
} as const;

export type LevelMetrics = { activeVendors: number; deliveredSales: Decimal; performanceScore: number | null };

export async function levelMetrics(agentId: string, now: Date = new Date()): Promise<LevelMetrics> {
  const [activeVendors, sales, performanceScore] = await Promise.all([
    activeVendorCount(agentId),
    deliveredStats({ agentIds: [agentId] }),
    performanceScoreOf(agentId, now),
  ]);
  return { activeVendors, deliveredSales: sales.get(agentId)?.sales ?? new Decimal(0), performanceScore };
}

/** Per-threshold progress of `metrics` against one level. */
export function levelProgress(level: LevelRow, m: LevelMetrics) {
  const out = [
    { key: "activeVendors", label: "Active vendors", current: m.activeVendors, target: level.minActiveVendors, met: m.activeVendors >= level.minActiveVendors },
    {
      key: "deliveredSales",
      label: "Delivered sales (৳)",
      current: m.deliveredSales.toFixed(2),
      target: dec(level.minDeliveredSales).toFixed(2),
      met: m.deliveredSales.gte(dec(level.minDeliveredSales)),
    },
  ] as Array<{ key: string; label: string; current: number | string | null; target: number | string; met: boolean }>;
  if (level.minPerformanceScore != null) {
    const target = dec(level.minPerformanceScore).toNumber();
    out.push({ key: "performanceScore", label: "Performance score", current: m.performanceScore, target, met: m.performanceScore != null && m.performanceScore >= target });
  }
  return out;
}

export const qualifies = (level: LevelRow, m: LevelMetrics) => levelProgress(level, m).every((p) => p.met);

export type EvaluationResult =
  | { status: "UPGRADED"; agentId: string; from: { id: string; name: string } | null; to: { id: string; name: string }; bonuses: string[] }
  | { status: "UNCHANGED"; agentId: string; reason: "NOT_ACTIVE" | "NO_HIGHER_LEVEL" | "THRESHOLDS_NOT_MET" | "CHANGED_MEANWHILE" };

export async function evaluateAgentLevel(agentId: string, actor: AdminActor = LEVEL_EVALUATION_ACTOR, now: Date = new Date()): Promise<EvaluationResult> {
  const db = agentDb.prisma as any;
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, status: true, levelId: true } });
  if (!agent) throw notFound("Agent");
  if (agent.status !== "ACTIVE") return { status: "UNCHANGED", agentId, reason: "NOT_ACTIVE" };
  const levels: LevelRow[] = await db.agentLevel.findMany({ where: { isActive: true }, orderBy: { rank: "asc" }, select: LEVEL_SELECT });
  levels.sort((a, b) => a.rank - b.rank);
  const current: LevelRow | null = agent.levelId ? await db.agentLevel.findUnique({ where: { id: agent.levelId }, select: LEVEL_SELECT }) : null;
  const currentRank = current?.rank ?? Number.NEGATIVE_INFINITY;
  const higher = levels.filter((l) => l.rank > currentRank);
  if (!higher.length) return { status: "UNCHANGED", agentId, reason: "NO_HIGHER_LEVEL" };

  const m = await levelMetrics(agentId, now);
  const target = [...higher].reverse().find((l) => qualifies(l, m));
  if (!target) return { status: "UNCHANGED", agentId, reason: "THRESHOLDS_NOT_MET" };
  const passed = higher.filter((l) => l.rank <= target.rank);

  return agentTransaction(async (tx: any) => {
    const upd = await tx.agent.updateMany({ where: { id: agentId, levelId: agent.levelId, status: "ACTIVE" }, data: { levelId: target.id } });
    if (upd.count !== 1) return { status: "UNCHANGED", agentId, reason: "CHANGED_MEANWHILE" } as const;
    await writeConfigAudit(tx, {
      entity: "AGENT",
      entityId: agentId,
      action: "UPDATE",
      oldValue: { levelId: current?.id ?? null, levelName: current?.name ?? null },
      newValue: {
        levelId: target.id,
        levelName: target.name,
        reason: "automatic level evaluation (upgrade only)",
        metrics: { activeVendors: m.activeVendors, deliveredSales: m.deliveredSales.toFixed(2), performanceScore: m.performanceScore },
      },
      actor,
    });
    const bonuses: string[] = [];
    const paying = passed.filter((l) => dec(l.bonusAmount).gt(0));
    if (paying.length) {
      const w = await lockWallet(tx, agentId);
      for (const l of paying) {
        const refId = `${agentId}:${l.id}`;
        const seen = await tx.agentWalletTransaction.findFirst({ where: { type: "BONUS_CREDIT", refType: LEDGER_REF_BONUS.level, refId }, select: { id: true } });
        if (seen) continue; // a level is paid once, even if the agent was set back by hand and climbs again
        await postLedger(tx, w, { type: "BONUS_CREDIT", amount: dec(l.bonusAmount), refType: LEDGER_REF_BONUS.level, refId, note: `Level bonus: ${l.name}` });
        await writeConfigAudit(tx, {
          entity: "BONUS_AWARD",
          entityId: refId,
          action: "CREATE",
          newValue: { kind: "LEVEL_BONUS", agentId, levelId: l.id, levelName: l.name, amount: dec(l.bonusAmount).toFixed(2) },
          actor,
        });
        bonuses.push(l.name);
      }
      await saveWallet(tx, w);
    }
    return { status: "UPGRADED", agentId, from: current ? { id: current.id, name: current.name } : null, to: { id: target.id, name: target.name }, bonuses } as const;
  });
}

/** Evaluate every ACTIVE agent; one agent's failure never stops the run. */
export async function evaluateAllAgentLevels(actor: AdminActor = LEVEL_EVALUATION_ACTOR, now: Date = new Date()) {
  const db = agentDb.prisma as any;
  const agents: Array<{ id: string }> = await db.agent.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const out = { evaluated: 0, upgraded: 0, failed: 0, upgrades: [] as Array<{ agentId: string; to: string }> };
  for (const a of agents) {
    try {
      const r = await evaluateAgentLevel(a.id, actor, now);
      out.evaluated += 1;
      if (r.status === "UPGRADED") {
        out.upgraded += 1;
        out.upgrades.push({ agentId: a.id, to: r.to.name });
      }
    } catch (err: any) {
      out.failed += 1;
      console.error(`[agent-level] evaluation failed for ${a.id}: ${String(err?.message ?? err).slice(0, 300)}`);
    }
  }
  await db.agentSetting.upsert({
    where: { key: LEVEL_EVALUATION_MARKER },
    create: { key: LEVEL_EVALUATION_MARKER, value: { value: dhakaMonthKey(now), at: now.toISOString() }, updatedById: actor.userId },
    update: { value: { value: dhakaMonthKey(now), at: now.toISOString() }, updatedById: actor.userId },
  });
  return out;
}

/** Job body: run once per Asia/Dhaka month. */
export async function monthlyLevelEvaluation(now: Date = new Date()) {
  const db = agentDb.prisma as any;
  const marker = await db.agentSetting.findUnique({ where: { key: LEVEL_EVALUATION_MARKER } });
  if ((marker?.value as any)?.value === dhakaMonthKey(now)) return null;
  return evaluateAllAgentLevels(LEVEL_EVALUATION_ACTOR, now);
}

// ── agent portal ──────────────────────────────────────────────────────────

const levelJson = (l: LevelRow) => ({
  id: l.id,
  name: l.name,
  rank: l.rank,
  minActiveVendors: l.minActiveVendors,
  minDeliveredSales: dec(l.minDeliveredSales).toFixed(2),
  minPerformanceScore: l.minPerformanceScore == null ? null : dec(l.minPerformanceScore).toNumber(),
  commissionPercent: l.commissionPercent == null ? null : dec(l.commissionPercent).toFixed(4),
  bonusAmount: l.bonusAmount == null ? null : dec(l.bonusAmount).toFixed(2),
  perks: Array.isArray(l.perks) ? (l.perks as string[]) : [],
});

export async function myLevel(agentId: string, now: Date = new Date()) {
  const db = agentDb.prisma as any;
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { levelId: true } });
  if (!agent) throw notFound("Agent");
  const levels: LevelRow[] = await db.agentLevel.findMany({ where: { isActive: true }, orderBy: { rank: "asc" }, select: LEVEL_SELECT });
  levels.sort((a, b) => a.rank - b.rank);
  const current: LevelRow | null = agent.levelId ? await db.agentLevel.findUnique({ where: { id: agent.levelId }, select: LEVEL_SELECT }) : null;
  const m = await levelMetrics(agentId, now);
  const next = levels.find((l) => l.rank > (current?.rank ?? Number.NEGATIVE_INFINITY)) ?? null;
  const marker = await db.agentSetting.findUnique({ where: { key: LEVEL_EVALUATION_MARKER } });
  return {
    current: current ? levelJson(current) : null,
    next: next ? { ...levelJson(next), progress: levelProgress(next, m) } : null,
    metrics: { activeVendors: m.activeVendors, deliveredSales: m.deliveredSales.toFixed(2), performanceScore: m.performanceScore },
    tiers: levels.map((l) => ({ ...levelJson(l), isCurrent: l.id === current?.id, reached: !!current && l.rank <= current.rank })),
    lastEvaluatedAt: (marker?.value as any)?.at ?? null,
    rule: "Levels are checked automatically once a month and only ever go up.",
  };
}
