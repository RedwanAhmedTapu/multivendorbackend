// src/modules/agent/services/agent-config.service.ts
//
// Admin-managed agent configuration: levels, rate overrides and milestone
// bonus rules (docs/agent-system-plan.md §2A). Every write:
//   • is validated (zod at the controller + the rules below),
//   • runs in a Serializable transaction holding an advisory lock for its
//     area, so concurrent admins can't produce an inconsistent state,
//   • writes an agent_config_audits row in the same transaction.

import Decimal from "decimal.js";
import { z } from "zod";
import { agentDb, agentTransaction, lockConfigArea, type AgentTx } from "../agent-db.ts";
import { AgentError, conflict, notFound } from "../agent-http.ts";
import {
  bonusRuleCreateSchema,
  bonusRuleIssues,
  bonusRuleUpdateSchema,
  levelCreateSchema,
  levelUpdateSchema,
  overrideCreateSchema,
  overrideListQuery,
} from "../validators/agent-config.validators.ts";
import { writeConfigAudit, type AdminActor } from "./agent-audit.service.ts";

const levelPublic = (l: any) => ({
  id: l.id,
  name: l.name,
  rank: l.rank,
  minActiveVendors: l.minActiveVendors,
  minDeliveredSales: l.minDeliveredSales?.toString() ?? "0.00",
  minPerformanceScore: l.minPerformanceScore == null ? null : Number(l.minPerformanceScore.toString()),
  commissionPercent: l.commissionPercent == null ? null : l.commissionPercent.toString(),
  bonusAmount: l.bonusAmount == null ? null : l.bonusAmount.toString(),
  perks: Array.isArray(l.perks) ? l.perks : [],
  isActive: l.isActive,
  agentCount: l._count?.agents ?? undefined,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
});

// ═══ Levels ═══════════════════════════════════════════════════════════════

/**
 * Thresholds must not decrease as rank rises (among ACTIVE levels), so the
 * tiers stay meaningful. Returns a message or null.
 */
export function levelLadderProblem(levels: Array<{ name: string; rank: number; isActive: boolean; minActiveVendors: number; minDeliveredSales: string; minPerformanceScore: number | null }>): string | null {
  const active = levels.filter((l) => l.isActive).sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < active.length; i++) {
    const lower = active[i - 1];
    const higher = active[i];
    if (higher.minActiveVendors < lower.minActiveVendors) {
      return `"${higher.name}" (rank ${higher.rank}) needs fewer active vendors than "${lower.name}" (rank ${lower.rank})`;
    }
    if (new Decimal(higher.minDeliveredSales).lt(lower.minDeliveredSales)) {
      return `"${higher.name}" (rank ${higher.rank}) needs less delivered sales than "${lower.name}" (rank ${lower.rank})`;
    }
    if (higher.minPerformanceScore != null && lower.minPerformanceScore != null && higher.minPerformanceScore < lower.minPerformanceScore) {
      return `"${higher.name}" (rank ${higher.rank}) needs a lower performance score than "${lower.name}" (rank ${lower.rank})`;
    }
  }
  return null;
}

async function assertLadder(tx: AgentTx): Promise<void> {
  const rows = await tx.agentLevel.findMany({
    select: { name: true, rank: true, isActive: true, minActiveVendors: true, minDeliveredSales: true, minPerformanceScore: true },
  });
  const problem = levelLadderProblem(
    rows.map((r: any) => ({
      ...r,
      minDeliveredSales: r.minDeliveredSales.toString(),
      minPerformanceScore: r.minPerformanceScore == null ? null : Number(r.minPerformanceScore.toString()),
    })),
  );
  if (problem) throw new AgentError(`Level thresholds must not decrease as rank rises: ${problem}`, 400, "LEVEL_LADDER_INVALID");
}

async function assertLevelUnique(tx: AgentTx, data: { name?: string; rank?: number }, exceptId?: string) {
  if (data.name) {
    const clash = await tx.agentLevel.findFirst({ where: { name: { equals: data.name, mode: "insensitive" }, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { id: true } });
    if (clash) throw conflict(`A level named "${data.name}" already exists`, "LEVEL_NAME_TAKEN");
  }
  if (data.rank != null) {
    const clash = await tx.agentLevel.findFirst({ where: { rank: data.rank, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { id: true, name: true } });
    if (clash) throw conflict(`Rank ${data.rank} is already used by "${clash.name}"`, "LEVEL_RANK_TAKEN");
  }
}

export async function listLevels() {
  const rows = await agentDb.prisma.agentLevel.findMany({ orderBy: { rank: "asc" }, include: { _count: { select: { agents: true } } } });
  return rows.map(levelPublic);
}

export async function createLevel(input: unknown, actor: AdminActor) {
  const data = levelCreateSchema.parse(input);
  const created = await agentTransaction(async (tx) => {
    await lockConfigArea(tx, "levels");
    await assertLevelUnique(tx, data);
    const level = await tx.agentLevel.create({
      data: {
        name: data.name,
        rank: data.rank,
        minActiveVendors: data.minActiveVendors,
        minDeliveredSales: data.minDeliveredSales,
        minPerformanceScore: data.minPerformanceScore,
        commissionPercent: data.commissionPercent,
        bonusAmount: data.bonusAmount,
        perks: data.perks,
        isActive: data.isActive,
        createdById: actor.userId,
      },
    });
    await assertLadder(tx);
    await writeConfigAudit(tx, { entity: "LEVEL", entityId: level.id, action: "CREATE", newValue: levelPublic(level), actor });
    return level;
  });
  return levelPublic(created);
}

export async function updateLevel(id: string, input: unknown, actor: AdminActor) {
  const data = levelUpdateSchema.parse(input);
  const updated = await agentTransaction(async (tx) => {
    await lockConfigArea(tx, "levels");
    const before = await tx.agentLevel.findUnique({ where: { id } });
    if (!before) throw notFound("Level");
    await assertLevelUnique(tx, { name: data.name, rank: data.rank }, id);
    const after = await tx.agentLevel.update({ where: { id }, data: { ...data, perks: data.perks, updatedById: actor.userId } as any });
    await assertLadder(tx);
    const action = data.isActive === false && before.isActive ? "DEACTIVATE" : data.isActive === true && !before.isActive ? "ACTIVATE" : "UPDATE";
    await writeConfigAudit(tx, { entity: "LEVEL", entityId: id, action, oldValue: levelPublic(before), newValue: levelPublic(after), actor });
    return after;
  });
  return levelPublic(updated);
}

export async function deleteLevel(id: string, actor: AdminActor) {
  await agentTransaction(async (tx) => {
    await lockConfigArea(tx, "levels");
    const before = await tx.agentLevel.findUnique({ where: { id }, include: { _count: { select: { agents: true } } } });
    if (!before) throw notFound("Level");
    if (before._count.agents > 0) {
      throw conflict(`${before._count.agents} agent(s) are on this level — deactivate it instead of deleting`, "LEVEL_IN_USE");
    }
    await tx.agentLevel.delete({ where: { id } });
    await writeConfigAudit(tx, { entity: "LEVEL", entityId: id, action: "DELETE", oldValue: levelPublic(before), actor });
  });
}

// ═══ Rate overrides ═══════════════════════════════════════════════════════

const overridePublic = (o: any) => ({
  id: o.id,
  scope: o.scope,
  vendorId: o.vendorId,
  agentId: o.agentId,
  categoryId: o.categoryId,
  targetName: o.vendor?.storeName ?? o.agent?.name ?? o.category?.name ?? null,
  ratePercent: o.ratePercent.toString(),
  effectiveFrom: o.effectiveFrom,
  effectiveTo: o.effectiveTo,
  isActive: o.isActive,
  note: o.note,
  createdById: o.createdById,
  endedById: o.endedById,
  endedAt: o.endedAt,
  createdAt: o.createdAt,
});

const targetField = (scope: "VENDOR" | "AGENT" | "CATEGORY") =>
  scope === "VENDOR" ? "vendorId" : scope === "AGENT" ? "agentId" : "categoryId";

export async function listOverrides(query: unknown) {
  const q = overrideListQuery.parse(query);
  const where: any = {};
  if (q.scope) where.scope = q.scope;
  if (q.active) where.isActive = q.active === "true";
  if (q.targetId) where.OR = [{ vendorId: q.targetId }, { agentId: q.targetId }, { categoryId: q.targetId }];
  const [rows, total] = await Promise.all([
    agentDb.prisma.agentCommissionOverride.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: { vendor: { select: { storeName: true } }, agent: { select: { name: true } }, category: { select: { name: true } } },
    }),
    agentDb.prisma.agentCommissionOverride.count({ where }),
  ]);
  return { items: rows.map(overridePublic), total, page: q.page, limit: q.limit };
}

async function assertTargetExists(tx: AgentTx, scope: "VENDOR" | "AGENT" | "CATEGORY", id: string) {
  const found =
    scope === "VENDOR"
      ? await tx.vendor.findUnique({ where: { id }, select: { id: true } })
      : scope === "AGENT"
        ? await tx.agent.findUnique({ where: { id }, select: { id: true } })
        : await tx.category.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw notFound(scope === "VENDOR" ? "Vendor" : scope === "AGENT" ? "Agent" : "Category");
}

export async function createOverride(input: unknown, actor: AdminActor) {
  const data = overrideCreateSchema.parse(input) as z.infer<typeof overrideCreateSchema>;
  const field = targetField(data.scope);
  const now = new Date();
  const created = await agentTransaction(async (tx) => {
    await lockConfigArea(tx, `override:${data.scope}:${data.targetId}`);
    await assertTargetExists(tx, data.scope, data.targetId);
    const existing = await tx.agentCommissionOverride.findFirst({ where: { scope: data.scope, [field]: data.targetId, isActive: true } as any });
    if (existing) {
      if (!data.replaceExisting) {
        throw conflict("An active override already exists for this target", "OVERRIDE_EXISTS", { existing: overridePublic(existing) });
      }
      const ended = await tx.agentCommissionOverride.update({
        where: { id: existing.id },
        data: {
          isActive: false,
          endedAt: now,
          endedById: actor.userId,
          effectiveTo: existing.effectiveTo && existing.effectiveTo < now ? existing.effectiveTo : now,
        },
      });
      await writeConfigAudit(tx, { entity: "OVERRIDE", entityId: existing.id, action: "DEACTIVATE", oldValue: overridePublic(existing), newValue: overridePublic(ended), actor });
    }
    const override = await tx.agentCommissionOverride.create({
      data: {
        scope: data.scope,
        [field]: data.targetId,
        ratePercent: data.ratePercent,
        effectiveFrom: data.effectiveFrom ?? now,
        effectiveTo: data.effectiveTo ?? null,
        note: data.note ?? null,
        createdById: actor.userId,
      } as any,
    });
    await writeConfigAudit(tx, { entity: "OVERRIDE", entityId: override.id, action: "CREATE", newValue: overridePublic(override), actor });
    return override;
  });
  return overridePublic(created);
}

export async function endOverride(id: string, note: string | undefined, actor: AdminActor) {
  const now = new Date();
  const ended = await agentTransaction(async (tx) => {
    const before = await tx.agentCommissionOverride.findUnique({ where: { id } });
    if (!before) throw notFound("Override");
    if (!before.isActive) throw conflict("This override has already ended", "OVERRIDE_ENDED");
    const after = await tx.agentCommissionOverride.update({
      where: { id },
      data: {
        isActive: false,
        endedAt: now,
        endedById: actor.userId,
        effectiveTo: before.effectiveTo && before.effectiveTo < now ? before.effectiveTo : now,
        ...(note ? { note } : {}),
      },
    });
    await writeConfigAudit(tx, { entity: "OVERRIDE", entityId: id, action: "DEACTIVATE", oldValue: overridePublic(before), newValue: overridePublic(after), actor });
    return after;
  });
  return overridePublic(ended);
}

// ═══ Bonus rules ══════════════════════════════════════════════════════════

const bonusPublic = (r: any) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  scope: r.scope,
  metric: r.metric,
  threshold: r.threshold.toString(),
  amount: r.amount.toString(),
  recurrence: r.recurrence,
  validFrom: r.validFrom,
  validTo: r.validTo,
  isActive: r.isActive,
  awardCount: r._count?.awards ?? undefined,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export async function listBonusRules() {
  const rows = await agentDb.prisma.agentBonusRule.findMany({
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    include: { _count: { select: { awards: true } } },
  });
  return rows.map(bonusPublic);
}

export async function createBonusRule(input: unknown, actor: AdminActor) {
  const data = bonusRuleCreateSchema.parse(input);
  const created = await agentTransaction(async (tx) => {
    const rule = await tx.agentBonusRule.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        scope: data.scope,
        metric: data.metric,
        threshold: data.threshold,
        amount: data.amount,
        recurrence: data.recurrence,
        validFrom: data.validFrom ?? new Date(),
        validTo: data.validTo ?? null,
        isActive: data.isActive,
        createdById: actor.userId,
      },
    });
    await writeConfigAudit(tx, { entity: "BONUS_RULE", entityId: rule.id, action: "CREATE", newValue: bonusPublic(rule), actor });
    return rule;
  });
  return bonusPublic(created);
}

export async function updateBonusRule(id: string, input: unknown, actor: AdminActor) {
  const data = bonusRuleUpdateSchema.parse(input);
  const updated = await agentTransaction(async (tx) => {
    const before = await tx.agentBonusRule.findUnique({ where: { id }, include: { _count: { select: { awards: true } } } });
    if (!before) throw notFound("Bonus rule");
    // Once a rule has paid out, its condition and amount are frozen (awards
    // snapshot them anyway); only the name, description, window and active
    // flag may change. Create a new rule for different terms.
    const frozen = ["scope", "metric", "threshold", "amount", "recurrence"] as const;
    if (before._count.awards > 0 && frozen.some((k) => k in data)) {
      throw conflict("This rule has already been awarded — its condition and amount can't change. Deactivate it and create a new rule.", "BONUS_RULE_AWARDED");
    }
    const merged = {
      scope: data.scope ?? before.scope,
      metric: data.metric ?? before.metric,
      threshold: data.threshold ?? before.threshold.toString(),
      validFrom: data.validFrom ?? before.validFrom,
      validTo: data.validTo === undefined ? before.validTo : data.validTo,
    };
    const issues = bonusRuleIssues(merged);
    if (issues.length) {
      throw new AgentError("Validation failed", 400, "VALIDATION_ERROR", { errors: Object.fromEntries(issues.map((i) => [i.path, i.message])) });
    }
    const after = await tx.agentBonusRule.update({ where: { id }, data: { ...data, updatedById: actor.userId } as any });
    const action = data.isActive === false && before.isActive ? "DEACTIVATE" : data.isActive === true && !before.isActive ? "ACTIVATE" : "UPDATE";
    await writeConfigAudit(tx, { entity: "BONUS_RULE", entityId: id, action, oldValue: bonusPublic(before), newValue: bonusPublic(after), actor });
    return after;
  });
  return bonusPublic(updated);
}

export async function deleteBonusRule(id: string, actor: AdminActor) {
  await agentTransaction(async (tx) => {
    const before = await tx.agentBonusRule.findUnique({ where: { id }, include: { _count: { select: { awards: true } } } });
    if (!before) throw notFound("Bonus rule");
    if (before._count.awards > 0) throw conflict("This rule has already been awarded — deactivate it instead of deleting", "BONUS_RULE_AWARDED");
    await tx.agentBonusRule.delete({ where: { id } });
    await writeConfigAudit(tx, { entity: "BONUS_RULE", entityId: id, action: "DELETE", oldValue: bonusPublic(before), actor });
  });
}
