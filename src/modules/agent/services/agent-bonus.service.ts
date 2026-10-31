// src/modules/agent/services/agent-bonus.service.ts
//
// Phase 9 — Activation Bonus: admin-managed milestone rules (agent_bonus_rules)
// evaluated after every accrual and by the agent:growth job.
//
//   PER_VENDOR  (DELIVERED_ORDERS | DELIVERED_SALES)  per vendor the agent earns on
//   PER_AGENT   (+ ACTIVE_VENDORS | NEW_VENDORS)       across the agent's vendors
//   ONE_TIME    period "ALL", counted from validFrom (to validTo)
//   MONTHLY     period "YYYY-MM" (Asia/Dhaka), the current and the previous month
// Delivered orders/sales come from the agent's commission rows (net of returns);
// ACTIVE_VENDORS is the current count of open links to ACTIVE vendors (MONTHLY:
// awarded for the month it is reached); NEW_VENDORS counts links started in the period.
//
// Idempotent twice over: agent_bonus_awards @@unique([ruleId, agentId,
// vendorKey, periodKey]) and the ledger's @@unique([type, refType, refId]).
// An award snapshots its rule and credits the wallet at once (BONUS_CREDIT,
// no hold period; later returns don't claw a bonus back). ACTIVE and
// SUSPENDED agents earn bonuses (like commission); DEACTIVATED agents don't.

import Decimal from "decimal.js";
import { agentDb, agentTransaction } from "../agent-db.ts";
import { writeConfigAudit, type AdminActor } from "./agent-audit.service.ts";
import { activeVendorCount, deliveredStats, dhakaMonthKey, dhakaMonthRange } from "./agent-growth.service.ts";
import { lockWallet, postLedger, saveWallet } from "./agent-wallet.service.ts";

export const LEDGER_REF_BONUS = { award: "AgentBonusAward", level: "AgentLevelBonus" } as const;
export const BONUS_ACTOR: AdminActor = { userId: "system:bonus-evaluation", name: "Bonus evaluation", ip: null, userAgent: null };

const dec = (v: unknown) => new Decimal(v == null ? 0 : (v as any).toString());

type Rule = {
  id: string;
  name: string;
  description: string | null;
  scope: "PER_VENDOR" | "PER_AGENT";
  metric: "DELIVERED_ORDERS" | "DELIVERED_SALES" | "ACTIVE_VENDORS" | "NEW_VENDORS";
  threshold: unknown;
  amount: unknown;
  recurrence: "ONE_TIME" | "MONTHLY";
  validFrom: Date;
  validTo: Date | null;
};
const RULE_SELECT = { id: true, name: true, description: true, scope: true, metric: true, threshold: true, amount: true, recurrence: true, validFrom: true, validTo: true } as const;

/** Periods to evaluate for a rule at `now` (clipped to its validity window). */
export function rulePeriods(rule: Pick<Rule, "recurrence" | "validFrom" | "validTo">, now: Date): Array<{ key: string; from: Date; to: Date }> {
  const clip = (from: Date, to: Date) => {
    const f = new Date(Math.max(from.getTime(), rule.validFrom.getTime()));
    // `to` is exclusive: +1 ms so a line earned at exactly `now` counts.
    const t = new Date(Math.min(to.getTime(), rule.validTo?.getTime() ?? Infinity, now.getTime() + 1));
    return f < t ? { from: f, to: t } : null;
  };
  if (rule.recurrence === "ONE_TIME") {
    const r = clip(rule.validFrom, new Date(now.getTime() + 1));
    return r ? [{ key: "ALL", ...r }] : [];
  }
  const thisMonth = dhakaMonthKey(now);
  const lastMonth = dhakaMonthKey(new Date(dhakaMonthRange(thisMonth).from.getTime() - 1));
  const out: Array<{ key: string; from: Date; to: Date }> = [];
  for (const key of [lastMonth, thisMonth]) {
    const m = dhakaMonthRange(key);
    const r = clip(m.from, m.to);
    if (r) out.push({ key, ...r });
  }
  return out;
}

/** Metric values for a rule and period: one entry per vendor (PER_VENDOR) or one with vendorKey "". */
export async function ruleValues(rule: Rule, agentId: string, period: { key: string; from: Date; to: Date }, now: Date): Promise<Array<{ vendorKey: string; value: Decimal }>> {
  const db = agentDb.prisma as any;
  if (rule.metric === "DELIVERED_ORDERS" || rule.metric === "DELIVERED_SALES") {
    const stats = await deliveredStats({ agentIds: [agentId], from: period.from, to: period.to }, { byVendor: rule.scope === "PER_VENDOR" });
    const pick = (s: { sales: Decimal; orders: number }) => (rule.metric === "DELIVERED_SALES" ? s.sales : new Decimal(s.orders));
    if (rule.scope === "PER_VENDOR") return [...stats].map(([k, s]) => ({ vendorKey: k.split(":")[1], value: pick(s) }));
    const s = stats.get(agentId);
    return [{ vendorKey: "", value: s ? pick(s) : new Decimal(0) }];
  }
  if (rule.metric === "ACTIVE_VENDORS") {
    // A current count: only meaningful for the period that contains "now".
    const current = rule.recurrence === "ONE_TIME" || period.key === dhakaMonthKey(now);
    return [{ vendorKey: "", value: new Decimal(current ? await activeVendorCount(agentId) : 0) }];
  }
  const n = await db.agentVendorLink.count({ where: { agentId, startedAt: { gte: period.from, lt: period.to } } });
  return [{ vendorKey: "", value: new Decimal(n) }];
}

/** Award one rule once; credits the wallet in the same transaction. Returns false if it already existed. */
export async function awardBonus(rule: Rule, agentId: string, vendorKey: string, periodKey: string, value: Decimal, now: Date): Promise<boolean> {
  try {
    return await agentTransaction(async (tx: any) => {
      const w = await lockWallet(tx, agentId);
      const existing = await tx.agentBonusAward.findUnique({
        where: { ruleId_agentId_vendorKey_periodKey: { ruleId: rule.id, agentId, vendorKey, periodKey } },
        select: { id: true },
      });
      if (existing) return false;
      const amount = dec(rule.amount);
      const award = await tx.agentBonusAward.create({
        data: {
          ruleId: rule.id,
          agentId,
          vendorKey,
          periodKey,
          amount: amount.toFixed(2),
          awardedAt: now,
          ruleSnapshot: {
            name: rule.name,
            scope: rule.scope,
            metric: rule.metric,
            threshold: dec(rule.threshold).toFixed(2),
            amount: amount.toFixed(2),
            recurrence: rule.recurrence,
            validFrom: rule.validFrom.toISOString(),
            validTo: rule.validTo?.toISOString() ?? null,
            achieved: value.toFixed(2),
            evaluatedAt: now.toISOString(),
          },
        },
        select: { id: true },
      });
      await postLedger(tx, w, { type: "BONUS_CREDIT", amount, refType: LEDGER_REF_BONUS.award, refId: award.id, note: rule.name });
      await saveWallet(tx, w);
      await writeConfigAudit(tx, {
        entity: "BONUS_AWARD",
        entityId: award.id,
        action: "CREATE",
        newValue: { kind: "MILESTONE", ruleId: rule.id, ruleName: rule.name, agentId, vendorKey, periodKey, amount: amount.toFixed(2), achieved: value.toFixed(2) },
        actor: BONUS_ACTOR,
      });
      return true;
    });
  } catch (err: any) {
    if (err?.code === "P2002") return false; // a concurrent evaluation awarded it first
    throw err;
  }
}

export async function evaluateBonusesForAgent(agentId: string, now: Date = new Date()): Promise<{ awarded: number }> {
  const db = agentDb.prisma as any;
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { status: true } });
  if (!agent || !["ACTIVE", "SUSPENDED"].includes(agent.status)) return { awarded: 0 };
  const rules: Rule[] = await db.agentBonusRule.findMany({ where: { isActive: true, validFrom: { lte: now } }, select: RULE_SELECT });
  let awarded = 0;
  for (const rule of rules) {
    for (const period of rulePeriods(rule, now)) {
      for (const { vendorKey, value } of await ruleValues(rule, agentId, period, now)) {
        if (value.gte(dec(rule.threshold)) && (await awardBonus(rule, agentId, vendorKey, period.key, value, now))) awarded += 1;
      }
    }
  }
  return { awarded };
}

/** Never throws: runs after accrual. */
export async function evaluateBonusesForAgentSafe(agentId: string, now: Date = new Date()): Promise<number> {
  try {
    return (await evaluateBonusesForAgent(agentId, now)).awarded;
  } catch (err: any) {
    console.error(`[agent-bonus] evaluation failed for ${agentId}: ${String(err?.message ?? err).slice(0, 300)}`);
    return 0;
  }
}

/** Job body: every ACTIVE / SUSPENDED agent (catches up anything an accrual hook missed). */
export async function evaluateAllBonuses(now: Date = new Date()): Promise<{ agents: number; awarded: number }> {
  const db = agentDb.prisma as any;
  const rules = await db.agentBonusRule.count({ where: { isActive: true, validFrom: { lte: now } } });
  if (!rules) return { agents: 0, awarded: 0 };
  const agents: Array<{ id: string }> = await db.agent.findMany({ where: { status: { in: ["ACTIVE", "SUSPENDED"] } }, select: { id: true } });
  let awarded = 0;
  for (const a of agents) awarded += await evaluateBonusesForAgentSafe(a.id, now);
  return { agents: agents.length, awarded };
}

// ── agent portal ──────────────────────────────────────────────────────────

const METRIC_LABEL: Record<Rule["metric"], string> = {
  DELIVERED_ORDERS: "delivered orders",
  DELIVERED_SALES: "৳ delivered sales",
  ACTIVE_VENDORS: "active vendors",
  NEW_VENDORS: "new vendors",
};

export async function bonusProgress(agentId: string, now: Date = new Date()) {
  const db = agentDb.prisma as any;
  const rules: Rule[] = await db.agentBonusRule.findMany({
    where: { isActive: true, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    select: RULE_SELECT,
  });
  const items = [];
  for (const rule of rules) {
    const periods = rulePeriods(rule, now);
    const period = periods[periods.length - 1];
    if (!period) continue;
    const values = await ruleValues(rule, agentId, period, now);
    const awards: Array<{ vendorKey: string }> = await db.agentBonusAward.findMany({ where: { ruleId: rule.id, agentId, periodKey: period.key }, select: { vendorKey: true } });
    const best = values.reduce((m, v) => (v.value.gt(m) ? v.value : m), new Decimal(0));
    const threshold = dec(rule.threshold);
    items.push({
      ruleId: rule.id,
      name: rule.name,
      description: rule.description,
      scope: rule.scope,
      metric: rule.metric,
      metricLabel: METRIC_LABEL[rule.metric],
      recurrence: rule.recurrence,
      periodKey: period.key,
      threshold: threshold.toFixed(2),
      amount: dec(rule.amount).toFixed(2),
      current: best.toFixed(2),
      percent: threshold.gt(0) ? Math.min(100, best.dividedBy(threshold).times(100).toDecimalPlaces(0).toNumber()) : 100,
      awardedCount: awards.length,
      achieved: rule.scope === "PER_AGENT" ? awards.length > 0 : undefined,
      validTo: rule.validTo,
    });
  }
  return { items };
}

export async function bonusHistory(agentId: string, q: { page: number; limit: number }) {
  const db = agentDb.prisma as any;
  const [rows, total, sum] = await Promise.all([
    db.agentBonusAward.findMany({
      where: { agentId },
      orderBy: { awardedAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: { id: true, vendorKey: true, periodKey: true, amount: true, ruleSnapshot: true, awardedAt: true },
    }),
    db.agentBonusAward.count({ where: { agentId } }),
    db.agentBonusAward.aggregate({ where: { agentId }, _sum: { amount: true } }),
  ]);
  const vendorIds = [...new Set(rows.map((r: any) => r.vendorKey).filter(Boolean))];
  const vendors = vendorIds.length ? await db.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, storeName: true } }) : [];
  const store = new Map(vendors.map((v: any) => [v.id, v.storeName]));
  const levelBonus = await db.agentWalletTransaction.aggregate({ where: { agentId, type: "BONUS_CREDIT", refType: LEDGER_REF_BONUS.level }, _sum: { amount: true } });
  return {
    items: rows.map((r: any) => ({
      id: r.id,
      name: r.ruleSnapshot?.name ?? "Bonus",
      metricLabel: METRIC_LABEL[r.ruleSnapshot?.metric as Rule["metric"]] ?? "",
      threshold: r.ruleSnapshot?.threshold ?? null,
      achieved: r.ruleSnapshot?.achieved ?? null,
      periodKey: r.periodKey,
      storeName: r.vendorKey ? (store.get(r.vendorKey) ?? "—") : null,
      amount: dec(r.amount).toFixed(2),
      awardedAt: r.awardedAt,
    })),
    total,
    page: q.page,
    limit: q.limit,
    totals: { milestones: dec(sum._sum.amount).toFixed(2), levelBonuses: dec(levelBonus._sum.amount).toFixed(2) },
  };
}

