// tests/agent-rules.test.ts
//
// Admin-managed commission rules: rate resolution (precedence comes from
// settings), the immutable commission snapshot, levels (ladder validation,
// delete protection), overrides (one active per target, replace = end + new,
// audited), bonus rules (validation, frozen once awarded, no default
// re-application on partial updates).
//
//   npx tsx --test tests/agent-rules.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const rate = await import("../src/modules/agent/services/agent-rate.service.ts");
const config = await import("../src/modules/agent/services/agent-config.service.ts");
const settings = await import("../src/modules/agent/services/agent-settings.service.ts");
const v = await import("../src/modules/agent/validators/agent-config.validators.ts");
const { installAgentFakeDb } = await import("./support/agent-fake-db.ts");

const actor = { userId: "U_ADMIN", name: "Admin", ip: null, userAgent: null };
let fake: ReturnType<typeof installAgentFakeDb>;
beforeEach(() => {
  settings.invalidateAgentSettingsCache();
  fake = installAgentFakeDb();
});
afterEach(() => fake.restore());

const baseInputs = {
  precedence: ["VENDOR", "AGENT", "LEVEL", "GLOBAL"] as any,
  defaultCommissionPercent: "2.0000",
  vendorOverride: { id: "OV_V", ratePercent: "8" },
  agentOverride: { id: "OV_A", ratePercent: "6" },
  categoryOverride: { id: "OV_C", ratePercent: "9" },
  level: { id: "L_GOLD", name: "Gold", isActive: true, commissionPercent: "4.5" },
};

// ── Resolution ────────────────────────────────────────────────────────────

test("precedence vendor > agent > level > global, each falling through when absent", () => {
  const r1 = rate.resolveAgentCommissionRate(baseInputs);
  assert.deepEqual([r1.status, (r1 as any).source, (r1 as any).ratePercent, (r1 as any).refId], ["RESOLVED", "VENDOR", "8.0000", "OV_V"]);
  const r2 = rate.resolveAgentCommissionRate({ ...baseInputs, vendorOverride: null });
  assert.equal((r2 as any).source, "AGENT");
  const r3 = rate.resolveAgentCommissionRate({ ...baseInputs, vendorOverride: null, agentOverride: null });
  assert.deepEqual([(r3 as any).source, (r3 as any).ratePercent], ["LEVEL", "4.5000"]);
  const r4 = rate.resolveAgentCommissionRate({ ...baseInputs, vendorOverride: null, agentOverride: null, level: null });
  assert.deepEqual([(r4 as any).source, (r4 as any).ratePercent, (r4 as any).refId], ["GLOBAL", "2.0000", null]);
});

test("CATEGORY overrides are ignored unless an admin placed CATEGORY in the precedence", () => {
  const r = rate.resolveAgentCommissionRate({ ...baseInputs, vendorOverride: null, agentOverride: null });
  assert.equal((r as any).source, "LEVEL");
  assert.ok(!r.trace.some((t) => t.source === "CATEGORY"));
  const withCat = rate.resolveAgentCommissionRate({ ...baseInputs, precedence: ["VENDOR", "AGENT", "CATEGORY", "LEVEL", "GLOBAL"], vendorOverride: null, agentOverride: null });
  assert.equal((withCat as any).source, "CATEGORY");
});

test("the order comes from settings, not code", () => {
  const r = rate.resolveAgentCommissionRate({ ...baseInputs, precedence: ["AGENT", "VENDOR", "LEVEL", "GLOBAL"] });
  assert.equal((r as any).source, "AGENT");
});

test("inactive level or a level without a rate falls through to GLOBAL", () => {
  const inactive = rate.resolveAgentCommissionRate({ ...baseInputs, vendorOverride: null, agentOverride: null, level: { ...baseInputs.level, isActive: false } });
  assert.equal((inactive as any).source, "GLOBAL");
  assert.equal(inactive.trace.find((t) => t.source === "LEVEL")!.outcome, "SKIPPED");
  const noRate = rate.resolveAgentCommissionRate({ ...baseInputs, vendorOverride: null, agentOverride: null, level: { ...baseInputs.level, commissionPercent: null } });
  assert.equal((noRate as any).source, "GLOBAL");
});

test("nothing configured → NOT_CONFIGURED (no commission is ever invented)", () => {
  assert.equal(rate.resolveAgentCommissionRate({ ...baseInputs, precedence: null }).status, "NOT_CONFIGURED");
  const r = rate.resolveAgentCommissionRate({ ...baseInputs, vendorOverride: null, agentOverride: null, level: null, defaultCommissionPercent: null });
  assert.equal(r.status, "NOT_CONFIGURED");
});

test("loadRateInputs only uses active overrides inside their window", async () => {
  const now = new Date();
  await fake.db.agentCommissionOverride.create({ data: { scope: "VENDOR", vendorId: "V1", ratePercent: "7", isActive: false } });
  await fake.db.agentCommissionOverride.create({ data: { scope: "VENDOR", vendorId: "V1", ratePercent: "8", effectiveFrom: new Date(now.getTime() + 86_400_000) } });
  await fake.db.agentCommissionOverride.create({ data: { scope: "AGENT", agentId: "A1", ratePercent: "6", effectiveTo: new Date(now.getTime() - 1000) } });
  await fake.db.agentCommissionOverride.create({ data: { scope: "AGENT", agentId: "A1", ratePercent: "5.25", effectiveFrom: new Date(now.getTime() - 1000) } });
  fake.db.agent.findUnique = async () => ({ level: null });
  const snap = await settings.getAgentSettings();
  const inputs = await rate.loadRateInputs({ agentId: "A1", vendorId: "V1", categoryId: null, at: now }, snap);
  assert.equal(inputs.vendorOverride, null, "inactive and future overrides ignored");
  assert.equal(inputs.agentOverride!.ratePercent, "5.25");
});

// ── Snapshot ──────────────────────────────────────────────────────────────

const snapSettings = () => ({
  values: { ...((null as any) ?? {}), holdDays: 7, commissionDurationMonths: 12, ratePrecedence: ["VENDOR", "AGENT", "LEVEL", "GLOBAL"], defaultCommissionPercent: "2.0000" } as any,
  missing: [],
  meta: {},
});

test("the snapshot carries source, rate, level, hold/duration and the full trace — and is frozen", () => {
  const resolution = rate.resolveAgentCommissionRate({ ...baseInputs, vendorOverride: null, agentOverride: null }) as any;
  const s = snapSettings();
  const snap = rate.buildCommissionSnapshot(resolution, { ...baseInputs, vendorOverride: null, agentOverride: null }, s as any, new Date("2026-10-31T00:00:00Z"));
  for (const f of rate.COMMISSION_SNAPSHOT_FIELDS) assert.ok(f in snap, f);
  assert.equal(snap.rateSource, "LEVEL");
  assert.equal(snap.ratePercent, "4.5000");
  assert.equal(snap.levelName, "Gold");
  assert.equal(snap.holdDays, 7);
  assert.equal(snap.durationMonths, 12);
  assert.equal((snap.ruleSnapshot as any).trace.length, 3);
  assert.ok(Object.isFrozen(snap));
  // later admin edits do not reach an existing snapshot
  s.values.holdDays = 30;
  s.values.defaultCommissionPercent = "9.0000";
  assert.equal(snap.holdDays, 7);
  assert.equal((snap.ruleSnapshot as any).defaultCommissionPercent, "2.0000");
});

test("snapshot columns are guarded against updates; hold days must be configured", () => {
  assert.throws(() => rate.assertNoSnapshotMutation({ status: "AVAILABLE", ratePercent: "1" }), /immutable: ratePercent/);
  assert.doesNotThrow(() => rate.assertNoSnapshotMutation({ status: "AVAILABLE", reversedQty: 1 }));
  const resolution = rate.resolveAgentCommissionRate(baseInputs) as any;
  const s: any = snapSettings();
  s.values.holdDays = null;
  assert.throws(() => rate.buildCommissionSnapshot(resolution, baseInputs, s, new Date()), /holdDays/);
});

test("commission arithmetic is exact, half-up to paisa", () => {
  assert.equal(rate.commissionAmount("1250.0000", "2.0000"), "25.00");
  assert.equal(rate.commissionAmount("89.0000", "2.0000"), "1.78");
  assert.equal(rate.commissionAmount("333.3300", "4.5000"), "15.00");
  assert.equal(rate.commissionAmount("0.1100", "50.0000"), "0.06");
});

// ── Levels ────────────────────────────────────────────────────────────────

const level = (over: Record<string, unknown> = {}) => ({ name: "Silver", rank: 2, minActiveVendors: 6, minDeliveredSales: 5000, commissionPercent: 7, ...over });

test("levels: validated, audited, unique name/rank, thresholds must not decrease with rank", async () => {
  const bronze = await config.createLevel(level({ name: "Bronze", rank: 1, minActiveVendors: 1, minDeliveredSales: 0, commissionPercent: 5 }), actor);
  assert.equal(bronze.commissionPercent, "5.0000");
  await config.createLevel(level(), actor);
  await assert.rejects(config.createLevel(level({ rank: 3 }), actor), (e: any) => e.code === "LEVEL_NAME_TAKEN");
  await assert.rejects(config.createLevel(level({ name: "Gold" }), actor), (e: any) => e.code === "LEVEL_RANK_TAKEN");
  fake.db.agentLevel.findMany = async () => fake.db.agentLevel.rows.map((r: any) => ({ ...r, minDeliveredSales: { toString: () => String(r.minDeliveredSales) } }));
  await assert.rejects(
    config.createLevel(level({ name: "Gold", rank: 3, minActiveVendors: 3 }), actor),
    (e: any) => e.code === "LEVEL_LADDER_INVALID" && /fewer active vendors/.test(e.message),
  );
  assert.equal(fake.db.agentConfigAudit.rows.filter((a: any) => a.entity === "LEVEL" && a.action === "CREATE").length, 2);
});

test("level ladder ignores inactive levels", () => {
  const problem = config.levelLadderProblem([
    { name: "A", rank: 1, isActive: true, minActiveVendors: 5, minDeliveredSales: "100", minPerformanceScore: null },
    { name: "B", rank: 2, isActive: false, minActiveVendors: 1, minDeliveredSales: "0", minPerformanceScore: null },
    { name: "C", rank: 3, isActive: true, minActiveVendors: 5, minDeliveredSales: "100", minPerformanceScore: null },
  ]);
  assert.equal(problem, null);
});

test("level validation rejects bad values", () => {
  for (const bad of [
    level({ commissionPercent: 120 }),
    level({ minDeliveredSales: -1 }),
    level({ minDeliveredSales: "10.123" }),
    level({ rank: 0 }),
    level({ name: "x" }),
    level({ minPerformanceScore: 101 }),
    level({ perks: ["x".repeat(121)] }),
    level({ unexpected: true }),
  ]) {
    assert.throws(() => v.levelCreateSchema.parse(bad), JSON.stringify(bad).slice(0, 60));
  }
  assert.throws(() => v.levelUpdateSchema.parse({}), "empty update");
});

test("a level used by agents can't be deleted", async () => {
  fake.db.agentLevel.findUnique = async () => ({ id: "L1", name: "Gold", _count: { agents: 3 } });
  await assert.rejects(config.deleteLevel("L1", actor), (e: any) => e.code === "LEVEL_IN_USE" && e.statusCode === 409);
});

// ── Overrides ─────────────────────────────────────────────────────────────

test("overrides: target must exist; one active per target; replace ends the old one (both audited)", async () => {
  await fake.db.vendor.create({ data: { id: "V1", storeName: "Shop" } });
  await assert.rejects(config.createOverride({ scope: "VENDOR", targetId: "NOPE", ratePercent: 5 }, actor), (e: any) => e.statusCode === 404);
  const first = await config.createOverride({ scope: "VENDOR", targetId: "V1", ratePercent: "5.5" }, actor);
  assert.equal(first.ratePercent, "5.5000");
  await assert.rejects(config.createOverride({ scope: "VENDOR", targetId: "V1", ratePercent: 6 }, actor), (e: any) => e.code === "OVERRIDE_EXISTS");
  const second = await config.createOverride({ scope: "VENDOR", targetId: "V1", ratePercent: 6, replaceExisting: true }, actor);
  const rows = fake.db.agentCommissionOverride.rows;
  assert.equal(rows.find((r: any) => r.id === first.id).isActive, false);
  assert.ok(rows.find((r: any) => r.id === first.id).endedAt);
  assert.equal(rows.find((r: any) => r.id === second.id).isActive, true);
  const audits = fake.db.agentConfigAudit.rows.filter((a: any) => a.entity === "OVERRIDE").map((a: any) => a.action);
  assert.deepEqual(audits, ["CREATE", "DEACTIVATE", "CREATE"]);
});

test("override validation: rate 0–100 with ≤4 decimals, end after start, no unknown keys", () => {
  assert.throws(() => v.overrideCreateSchema.parse({ scope: "VENDOR", targetId: "V1", ratePercent: 100.5 }));
  assert.throws(() => v.overrideCreateSchema.parse({ scope: "VENDOR", targetId: "V1", ratePercent: "1.23456" }));
  assert.throws(() => v.overrideCreateSchema.parse({ scope: "SHOP", targetId: "V1", ratePercent: 1 }));
  assert.throws(() => v.overrideCreateSchema.parse({ scope: "VENDOR", targetId: "V1", ratePercent: 1, effectiveFrom: "2026-11-02", effectiveTo: "2026-11-01" }));
  assert.throws(() => v.overrideCreateSchema.parse({ scope: "VENDOR", targetId: "V1", ratePercent: 1, vendorId: "X" }));
});

test("ending an override is audited and can't be repeated", async () => {
  await fake.db.agent.create({ data: { id: "A1", agentCode: "AG-1", referralCode: "R1", name: "A", email: "a@x.com", passwordHash: "x" } });
  const o = await config.createOverride({ scope: "AGENT", targetId: "A1", ratePercent: 3 }, actor);
  const ended = await config.endOverride(o.id, "season over", actor);
  assert.equal(ended.isActive, false);
  await assert.rejects(config.endOverride(o.id, undefined, actor), (e: any) => e.code === "OVERRIDE_ENDED");
});

// ── Bonus rules ───────────────────────────────────────────────────────────

const rule = (over: Record<string, unknown> = {}) => ({ name: "First 10 orders", scope: "PER_VENDOR", metric: "DELIVERED_ORDERS", threshold: 10, amount: 50, recurrence: "ONE_TIME", ...over });

test("bonus rules: validated (scope/metric pairing, whole-number counts, positive amounts)", () => {
  assert.ok(v.bonusRuleCreateSchema.parse(rule()));
  assert.throws(() => v.bonusRuleCreateSchema.parse(rule({ metric: "ACTIVE_VENDORS" })), "vendor-count metric needs PER_AGENT");
  assert.throws(() => v.bonusRuleCreateSchema.parse(rule({ threshold: 10.5 })), "whole-number count");
  assert.ok(v.bonusRuleCreateSchema.parse(rule({ metric: "DELIVERED_SALES", threshold: "10000.50" })));
  assert.throws(() => v.bonusRuleCreateSchema.parse(rule({ amount: 0 })));
  assert.throws(() => v.bonusRuleCreateSchema.parse(rule({ recurrence: "WEEKLY" })));
  assert.throws(() => v.bonusRuleCreateSchema.parse(rule({ validFrom: "2026-12-01", validTo: "2026-11-01" })));
});

test("a partial bonus-rule update never re-applies defaults (isActive stays as saved)", () => {
  assert.deepEqual(v.bonusRuleUpdateSchema.parse({ name: "Renamed" }), { name: "Renamed" });
  assert.throws(() => v.bonusRuleUpdateSchema.parse({}));
});

test("bonus rules: create/update audited; condition and amount frozen once awarded", async () => {
  const created = await config.createBonusRule(rule(), actor);
  assert.equal(created.amount, "50.00");
  fake.db.agentBonusRule.findUnique = async ({ where }: any) => ({ ...fake.db.agentBonusRule.rows.find((r: any) => r.id === where.id), _count: { awards: 2 } });
  await assert.rejects(config.updateBonusRule(created.id, { amount: 60 }, actor), (e: any) => e.code === "BONUS_RULE_AWARDED");
  fake.db.agentBonusRule.update = async ({ where, data }: any) => {
    const r = fake.db.agentBonusRule.rows.find((x: any) => x.id === where.id);
    Object.assign(r, data);
    return r;
  };
  const renamed = await config.updateBonusRule(created.id, { isActive: false }, actor);
  assert.equal(renamed.isActive, false);
  const audit = fake.db.agentConfigAudit.rows.filter((a: any) => a.entity === "BONUS_RULE").map((a: any) => a.action);
  assert.deepEqual(audit, ["CREATE", "DEACTIVATE"]);
  await assert.rejects(config.deleteBonusRule(created.id, actor), (e: any) => e.code === "BONUS_RULE_AWARDED");
});
