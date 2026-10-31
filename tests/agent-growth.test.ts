// tests/agent-growth.test.ts
//
// Phase 9 growth features and the P8–9 extras, DB-free:
// settings validation (weights add up to 100, alert thresholds), the
// performance score (not configured / weighted / percentiles), level
// evaluation (upgrade only, skip-level bonuses paid once, audited, monthly
// marker), milestone bonuses (idempotent, per vendor, monthly, wallet
// ledger), leaderboard privacy, vendor alerts, training, wallet adjustment
// and the payable report.
//
//   npx tsx --test tests/agent-growth.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";

const { installAgentFakeDb, makeTable, matches } = await import("./support/agent-fake-db.ts");
const { aggregates, compositeUnique, installWalletTables } = await import("./support/agent-wallet-fake.ts");
const settings = await import("../src/modules/agent/services/agent-settings.service.ts");
const growth = await import("../src/modules/agent/services/agent-growth.service.ts");
const levels = await import("../src/modules/agent/services/agent-level.service.ts");
const bonus = await import("../src/modules/agent/services/agent-bonus.service.ts");
const alerts = await import("../src/modules/agent/services/agent-alerts.service.ts");
const training = await import("../src/modules/agent/services/agent-training.service.ts");
const walletAdmin = await import("../src/modules/agent/services/agent-wallet-admin.service.ts");

let fake: ReturnType<typeof installAgentFakeDb>;
const NOW = new Date("2026-11-15T06:00:00Z"); // Asia/Dhaka 2026-11-15 12:00
const ADMIN = { userId: "U-ADMIN", name: "Admin", ip: null, userAgent: null };

let reviews: any[];
let vendorOrders: any[];
let variants: any[];

beforeEach(async () => {
  settings.invalidateAgentSettingsCache();
  growth.invalidatePerformanceCache();
  fake = installAgentFakeDb();
  const db = fake.db;
  db.agentCommission = makeTable("commission", { defaults: () => ({ reversedQty: 0, reversedAmount: "0.00", walletCreditedAt: null }) });
  aggregates(db.agentCommission);
  db.agentCommissionReversal = makeTable("reversal", { defaults: () => ({ walletPostedAt: null }) });
  db.orderItem = makeTable("item");
  db.agentBonusAward = makeTable("award");
  compositeUnique(db.agentBonusAward, ["ruleId", "agentId", "vendorKey", "periodKey"]);
  aggregates(db.agentBonusAward);
  const awardFindUnique = db.agentBonusAward.findUnique;
  db.agentBonusAward.findUnique = (args: any) => awardFindUnique({ ...args, where: args.where.ruleId_agentId_vendorKey_periodKey ?? args.where });
  db.agentTrainingResource = makeTable("training", { defaults: () => ({ isFeatured: false, isPublished: false, summary: null, body: null, url: null, coverImage: null }) });
  db.agentTrainingResource.groupBy = async ({ where }: any) => {
    const m = new Map<string, number>();
    for (const r of db.agentTrainingResource.rows.filter((x: any) => matches(x, where))) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    return [...m].map(([category, n]) => ({ category, _count: { _all: n } }));
  };
  installWalletTables(db);
  aggregates(db.agentWalletTransaction);
  // links with the vendor relation (status filter + storeName select)
  const vendorOf = (l: any) => db.vendor.rows.find((v: any) => v.id === l.vendorId);
  db.agentVendorLink.count = async ({ where }: any) => {
    const { vendor: vw, ...rest } = where;
    return db.agentVendorLink.rows.filter((l: any) => matches(l, rest) && (!vw || matches(vendorOf(l) ?? {}, vw))).length;
  };
  const linkFindMany = db.agentVendorLink.findMany;
  db.agentVendorLink.findMany = async (args: any = {}) => {
    const list = await linkFindMany({ ...args, select: undefined });
    return list.map((l: any) => ({ ...l, vendor: { storeName: vendorOf(l)?.storeName, status: vendorOf(l)?.status } }));
  };
  reviews = [];
  vendorOrders = [];
  variants = [];
  db.review = {
    findMany: async ({ where }: any) =>
      reviews.filter((r) => where.product.vendorId.in.includes(r.product.vendorId) && r.createdAt >= where.createdAt.gte && (!where.rating || r.rating <= where.rating.lte)),
  };
  db.vendorOrder = {
    groupBy: async ({ where, _max }: any) => {
      const m = new Map<string, any[]>();
      for (const o of vendorOrders.filter((o) => matches(o, where))) m.set(o.vendorId, [...(m.get(o.vendorId) ?? []), o]);
      return [...m].map(([vendorId, os]) => ({ vendorId, _count: { _all: os.length }, ...(_max ? { _max: { createdAt: new Date(Math.max(...os.map((o) => o.createdAt.getTime()))) } } : {}) }));
    },
  };
  db.productVariant = { findMany: async ({ where }: any) => variants.filter((v) => v.stock <= where.stock.lte && where.product.vendorId.in.includes(v.product.vendorId)) };

  for (const [id, name, status] of [["A1", "Rahim", "ACTIVE"], ["A2", "Karim", "ACTIVE"], ["A3", "Salma", "SUSPENDED"], ["A4", "Jamal", "DEACTIVATED"]] as const) {
    await db.agent.create({ data: { id, agentCode: `AG-${id}`, referralCode: `REF-${id}XXXX`, name, email: `${id}@x.com`, passwordHash: "x", status, avatar: null, levelId: null } });
  }
  for (const [id, status] of [["V1", "ACTIVE"], ["V2", "ACTIVE"], ["V3", "PENDING"]] as const) await db.vendor.create({ data: { id, storeName: `Store ${id}`, status } });
  await db.agentVendorLink.create({ data: { agentId: "A1", vendorId: "V1", source: "ADMIN_ASSIGNED", startedAt: new Date("2026-08-01T00:00:00Z") } });
  await db.agentVendorLink.create({ data: { agentId: "A1", vendorId: "V2", source: "REFERRAL_CODE", startedAt: new Date("2026-11-02T00:00:00Z") } });
  await db.agentVendorLink.create({ data: { agentId: "A1", vendorId: "V3", source: "ADMIN_ASSIGNED", startedAt: new Date("2026-08-01T00:00:00Z") } });
  await db.agentVendorLink.create({ data: { agentId: "A2", vendorId: "V9", source: "ADMIN_ASSIGNED", startedAt: new Date("2026-08-01T00:00:00Z") } });
});
afterEach(() => fake.restore());

let seq = 0;
/** One delivered commission line: `units` × `price` sales, `amount` commission. */
async function delivered(agentId: string, vendorId: string, opts: { units?: number; price?: string; amount?: string; at?: Date; vendorOrderId?: string; reversedQty?: number } = {}) {
  const i = ++seq;
  await fake.db.orderItem.create({ data: { id: `OI${i}`, price: opts.price ?? "1000.0000" } });
  await fake.db.agentCommission.create({
    data: {
      id: `C${i}`,
      agentId,
      vendorId,
      vendorOrderId: opts.vendorOrderId ?? `VO${i}`,
      orderItemId: `OI${i}`,
      quantity: opts.units ?? 1,
      reversedQty: opts.reversedQty ?? 0,
      amount: opts.amount ?? "20.00",
      reversedAmount: "0.00",
      earnedAt: opts.at ?? NOW,
      availableAt: new Date(NOW.getTime() + 7 * 864e5),
    },
  });
}

async function saveSettings(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    const row = fake.db.agentSetting.rows.find((r: any) => r.key === key);
    if (row) row.value = { value };
    else await fake.db.agentSetting.create({ data: { key, value: { value }, updatedById: "U", updatedAt: new Date() } });
  }
  settings.invalidateAgentSettingsCache();
  growth.invalidatePerformanceCache();
}

const ledger = (agentId = "A1") => (fake.db.agentWalletTransaction.rows as any[]).filter((r) => r.agentId === agentId);
const walletRow = (agentId = "A1") => (fake.db.agentWallet.rows as any[]).find((r) => r.agentId === agentId);
function assertLedger(agentId = "A1") {
  const w = walletRow(agentId);
  const sum = ledger(agentId).reduce((s, e) => s.plus(e.amount), new Decimal(0));
  assert.equal(new Decimal(w?.available ?? 0).toFixed(2), sum.toFixed(2), "wallet.available = Σ ledger");
}

// ── settings ─────────────────────────────────────────────────────────────

test("settings: performance weights must be whole numbers adding up to 100; alert thresholds are range-checked", () => {
  const w = settings.SETTING_DEFINITIONS.performanceWeights.schema;
  assert.equal(w.safeParse({ vendorActivity: 25, sales: 25, growth: 25, satisfaction: 25 }).success, true);
  assert.equal(w.safeParse({ vendorActivity: 0, sales: 100, growth: 0, satisfaction: 0 }).success, true);
  const sum = w.safeParse({ vendorActivity: 30, sales: 30, growth: 30, satisfaction: 30 });
  assert.equal(sum.success, false);
  assert.match(sum.error!.issues[0].message, /add up to 100/);
  for (const bad of [{ vendorActivity: 25.5, sales: 24.5, growth: 25, satisfaction: 25 }, { vendorActivity: -10, sales: 60, growth: 25, satisfaction: 25 }, { sales: 100 }, { vendorActivity: 25, sales: 25, growth: 25, satisfaction: 25, extra: 0 }]) {
    assert.equal(w.safeParse(bad).success, false, JSON.stringify(bad));
  }
  const a = settings.SETTING_DEFINITIONS.vendorAlertRules.schema;
  const ok = { inactivityDays: 14, lowRatingMax: 1, lowStockUnits: 5, growthPercent: 30, lookbackDays: 30 };
  assert.equal(a.safeParse(ok).success, true);
  for (const [k, v] of [["inactivityDays", 0], ["lowRatingMax", 6], ["lowStockUnits", -1], ["growthPercent", 0], ["lookbackDays", 91]] as const) {
    assert.equal(a.safeParse({ ...ok, [k]: v }).success, false, k);
  }
});

test("settings: the admin save path validates the new keys and audits them", async () => {
  await assert.rejects(settings.updateAgentSettings({ performanceWeights: { vendorActivity: 50, sales: 50, growth: 50, satisfaction: 0 } }, ADMIN), (e: any) => e.code === "VALIDATION_ERROR" && /100/.test(e.details.errors.performanceWeights));
  const { snapshot } = await settings.updateAgentSettings({ performanceWeights: { vendorActivity: 40, sales: 30, growth: 20, satisfaction: 10 } }, ADMIN);
  assert.deepEqual(snapshot.values.performanceWeights, { vendorActivity: 40, sales: 30, growth: 20, satisfaction: 10 });
  assert.equal(fake.db.agentConfigAudit.rows.at(-1).entityId, "performanceWeights");
});

// ── performance ──────────────────────────────────────────────────────────

test("performance: 'not configured' until the weights are saved; nothing is computed", async () => {
  const p = await growth.performanceFor("A1", NOW);
  assert.equal(p.configured, false);
  assert.match((p as any).message, /not set up|isn't|hasn't/i);
});

test("performance: pure helpers — percentiles and weights re-normalized over factors with data", () => {
  assert.equal(growth.percentileOf(5, [5]), 100);
  assert.equal(growth.percentileOf(0, [0]), 0);
  assert.equal(growth.percentileOf(10, [1, 5, 10]), 100);
  assert.equal(growth.percentileOf(1, [1, 5, 10]), 0);
  assert.equal(growth.percentileOf(5, [5, 5]), 50);
  const w = { vendorActivity: 40, sales: 30, growth: 20, satisfaction: 10 };
  assert.equal(growth.weightedScore({ vendorActivity: 50, sales: 100, growth: 0, satisfaction: 80 }, w), 58);
  assert.equal(growth.weightedScore({ vendorActivity: 50, sales: null, growth: null, satisfaction: null }, w), 50, "missing factors don't drag the score down");
  assert.equal(growth.weightedScore({ vendorActivity: null, sales: null, growth: null, satisfaction: null }, w), null);
});

test("performance: computed on read from vendor activity, sales/growth percentiles and reviews", async () => {
  await saveSettings({ performanceWeights: { vendorActivity: 25, sales: 25, growth: 25, satisfaction: 25 } });
  vendorOrders.push({ vendorId: "V1", createdAt: new Date(NOW.getTime() - 3 * 864e5), status: "PENDING" });
  reviews.push({ rating: 4, createdAt: new Date(NOW.getTime() - 864e5), product: { vendorId: "V1" } });
  await delivered("A1", "V1", { price: "3000.0000" });
  await delivered("A2", "V9", { price: "1000.0000" });
  await delivered("A2", "V9", { price: "1000.0000", at: new Date(NOW.getTime() - 40 * 864e5) });
  const p: any = await growth.performanceFor("A1", NOW);
  assert.equal(p.configured, true);
  assert.equal(p.factors.vendorActivity, 33.3, "1 of 3 open vendors ordered");
  assert.equal(p.factors.sales, 100, "top seller of 2 active agents");
  assert.equal(p.factors.satisfaction, 80, "4★ → 80");
  assert.equal(p.factors.growth, 100, "new sales from zero ranks above flat");
  assert.equal(p.score, Math.round(((33.3 + 100 + 100 + 80) / 4) * 10) / 10);
});

// ── levels ───────────────────────────────────────────────────────────────

async function level(id: string, rank: number, extra: Record<string, unknown> = {}) {
  await fake.db.agentLevel.create({ data: { id, name: `Level ${rank}`, rank, minActiveVendors: 0, minDeliveredSales: "0.00", minPerformanceScore: null, commissionPercent: null, bonusAmount: null, perks: [], isActive: true, createdById: "U", ...extra } });
}

test("levels: upgrade to the highest qualifying level, pay every passed level's bonus once, audit it", async () => {
  await level("L1", 1, { minActiveVendors: 1, bonusAmount: "100.00" });
  await level("L2", 2, { minActiveVendors: 2, minDeliveredSales: "5000.00", bonusAmount: "250.00" });
  await level("L3", 3, { minActiveVendors: 2, minDeliveredSales: "999999.00", bonusAmount: "1000.00" });
  await delivered("A1", "V1", { units: 3, price: "2000.0000" }); // 6000 delivered
  const r: any = await levels.evaluateAgentLevel("A1", levels.LEVEL_EVALUATION_ACTOR, NOW);
  assert.equal(r.status, "UPGRADED");
  assert.equal(r.to.id, "L2");
  assert.deepEqual(r.bonuses, ["Level 1", "Level 2"]);
  assert.equal(fake.db.agent.rows.find((a: any) => a.id === "A1").levelId, "L2");
  assert.equal(walletRow().available, "350.00");
  assertLedger();
  const audit = fake.db.agentConfigAudit.rows.filter((a: any) => a.entity === "AGENT" && a.entityId === "A1");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorUserId, "system:level-evaluation");

  const again: any = await levels.evaluateAgentLevel("A1", levels.LEVEL_EVALUATION_ACTOR, NOW);
  assert.equal(again.status, "UNCHANGED");
  assert.equal(ledger().length, 2, "no second bonus");
});

test("levels: never downgrades, and a set-back agent climbing again isn't paid twice", async () => {
  await level("L1", 1, { minActiveVendors: 1, bonusAmount: "100.00" });
  await level("L2", 2, { minActiveVendors: 50 });
  fake.db.agent.rows.find((a: any) => a.id === "A1").levelId = "L2"; // set by hand above what the metrics justify
  assert.equal((await levels.evaluateAgentLevel("A1", ADMIN, NOW)).status, "UNCHANGED");
  assert.equal(fake.db.agent.rows.find((a: any) => a.id === "A1").levelId, "L2", "no downgrade");

  fake.db.agent.rows.find((a: any) => a.id === "A1").levelId = null;
  await levels.evaluateAgentLevel("A1", ADMIN, NOW);
  fake.db.agent.rows.find((a: any) => a.id === "A1").levelId = null;
  await levels.evaluateAgentLevel("A1", ADMIN, NOW);
  assert.equal(ledger().filter((e) => e.type === "BONUS_CREDIT").length, 1, "a level bonus is paid once per agent");
});

test("levels: a performance threshold is unreachable until the weights are configured; non-active agents are skipped", async () => {
  await level("L1", 1, { minPerformanceScore: "10.00" });
  assert.equal((await levels.evaluateAgentLevel("A1", ADMIN, NOW)).status, "UNCHANGED");
  assert.deepEqual(await levels.evaluateAgentLevel("A3", ADMIN, NOW), { status: "UNCHANGED", agentId: "A3", reason: "NOT_ACTIVE" });
});

test("levels: the monthly job runs once per Asia/Dhaka month; /levels/me shows tiers and progress", async () => {
  await level("L1", 1, { minActiveVendors: 1, perks: ["Priority support"] });
  await level("L2", 2, { minActiveVendors: 9 });
  const first = await levels.monthlyLevelEvaluation(NOW);
  assert.equal(first?.upgraded, 1);
  assert.equal(await levels.monthlyLevelEvaluation(new Date(NOW.getTime() + 864e5)), null, "same month: skipped");
  assert.ok(await levels.monthlyLevelEvaluation(new Date("2026-12-01T00:00:00Z")), "next Dhaka month runs");
  const me = await levels.myLevel("A1", NOW);
  assert.equal(me.current?.id, "L1");
  assert.equal(me.next?.id, "L2");
  assert.deepEqual(me.next?.progress[0], { key: "activeVendors", label: "Active vendors", current: 2, target: 9, met: false });
  assert.deepEqual(me.tiers.map((t: any) => [t.id, t.isCurrent, t.reached]), [["L1", true, true], ["L2", false, false]]);
});

// ── bonuses ──────────────────────────────────────────────────────────────

async function rule(id: string, extra: Record<string, unknown>) {
  await fake.db.agentBonusRule.create({
    data: { id, name: `Rule ${id}`, description: null, scope: "PER_AGENT", metric: "DELIVERED_ORDERS", threshold: "2.00", amount: "500.00", recurrence: "ONE_TIME", validFrom: new Date("2026-10-01T00:00:00Z"), validTo: null, isActive: true, createdById: "U", ...extra },
  });
}

test("bonuses: awarded once when the threshold is reached, credited to the wallet with a rule snapshot", async () => {
  await rule("B1", {});
  await delivered("A1", "V1");
  assert.equal((await bonus.evaluateBonusesForAgent("A1", NOW)).awarded, 0, "1 of 2 orders");
  await delivered("A1", "V2");
  assert.equal((await bonus.evaluateBonusesForAgent("A1", NOW)).awarded, 1);
  assert.equal((await bonus.evaluateBonusesForAgent("A1", NOW)).awarded, 0, "idempotent");
  const [a, b] = await Promise.all([bonus.evaluateBonusesForAgent("A1", NOW), bonus.evaluateBonusesForAgent("A1", NOW)]);
  assert.equal(a.awarded + b.awarded, 0);
  assert.equal(fake.db.agentBonusAward.rows.length, 1);
  const award = fake.db.agentBonusAward.rows[0];
  assert.equal(award.ruleSnapshot.achieved, "2.00");
  assert.equal(award.ruleSnapshot.threshold, "2.00");
  fake.db.agentBonusRule.rows[0].amount = "9999.00"; // a later rule edit doesn't touch the award
  assert.equal(award.amount, "500.00");
  assert.deepEqual(ledger().map((e) => [e.type, e.amount, e.refType]), [["BONUS_CREDIT", "500.00", "AgentBonusAward"]]);
  assertLedger();
  assert.equal(fake.db.agentConfigAudit.rows.filter((r: any) => r.entity === "BONUS_AWARD").length, 1);
});

test("bonuses: concurrent first awards still pay once (unique key + wallet lock)", async () => {
  await rule("B1", { threshold: "1.00" });
  await delivered("A1", "V1");
  const out = await Promise.all([bonus.evaluateBonusesForAgent("A1", NOW), bonus.evaluateBonusesForAgent("A1", NOW), bonus.evaluateBonusesForAgent("A1", NOW)]);
  assert.equal(out.reduce((s, o) => s + o.awarded, 0), 1);
  assert.equal(ledger().length, 1);
});

test("bonuses: PER_VENDOR awards per vendor; MONTHLY per Dhaka month; DELIVERED_SALES nets returns", async () => {
  await rule("PV", { scope: "PER_VENDOR", metric: "DELIVERED_SALES", threshold: "1500.00", amount: "50.00" });
  await rule("MO", { metric: "DELIVERED_ORDERS", threshold: "1.00", amount: "10.00", recurrence: "MONTHLY" });
  await delivered("A1", "V1", { units: 2, price: "1000.0000" }); // 2000 ✓
  await delivered("A1", "V2", { units: 2, price: "1000.0000", reversedQty: 1 }); // 1000 net ✗
  await delivered("A1", "V1", { at: new Date("2026-10-20T00:00:00Z") }); // last month (V1 is past the threshold anyway)
  await bonus.evaluateBonusesForAgent("A1", NOW);
  const awards = fake.db.agentBonusAward.rows.map((r: any) => [r.ruleId, r.vendorKey, r.periodKey]).sort();
  assert.deepEqual(awards, [["MO", "", "2026-10"], ["MO", "", "2026-11"], ["PV", "V1", "ALL"]]);
  assertLedger();
});

test("bonuses: deactivated agents earn none; suspended agents still do (like commission)", async () => {
  await rule("B1", { threshold: "1.00" });
  await delivered("A4", "V1");
  await delivered("A3", "V1");
  assert.equal((await bonus.evaluateBonusesForAgent("A4", NOW)).awarded, 0);
  assert.equal((await bonus.evaluateBonusesForAgent("A3", NOW)).awarded, 1);
});

test("bonuses: progress and history for the agent", async () => {
  await rule("B1", { threshold: "4.00" });
  await delivered("A1", "V1");
  const p = await bonus.bonusProgress("A1", NOW);
  assert.equal(p.items[0].current, "1.00");
  assert.equal(p.items[0].percent, 25);
  const h = await bonus.bonusHistory("A1", { page: 1, limit: 10 });
  assert.equal(h.total, 0);
  assert.equal(h.totals.milestones, "0.00");
});

// ── leaderboard ──────────────────────────────────────────────────────────

test("leaderboard: ranks ACTIVE agents by net commission; others see only name, avatar, rank and a relative score", async () => {
  await delivered("A1", "V1", { amount: "50.00" });
  await delivered("A2", "V9", { amount: "100.00" });
  await delivered("A3", "V1", { amount: "500.00" }); // suspended: excluded
  await delivered("A1", "V1", { amount: "999.00", at: new Date("2026-10-01T00:00:00Z") }); // outside "monthly"
  const lb = await growth.leaderboard("A1", "monthly", NOW);
  assert.deepEqual(lb.entries, [
    { rank: 1, name: "Karim", avatar: null, score: 100, isMe: false },
    { rank: 2, name: "Rahim", avatar: null, score: 50, isMe: true },
  ]);
  assert.deepEqual(lb.me, { rank: 2, score: 50, earned: "50.00" });
  const json = JSON.stringify(lb.entries);
  for (const leak of ["100.00", "agentId", "email", "A2", "earned"]) assert.ok(!json.includes(leak), `no ${leak} in other agents' rows`);
  const all = await growth.leaderboard("A1", "all", NOW);
  assert.equal(all.entries[0].name, "Rahim", "all time: 1049 beats 100");
});

test("leaderboard: Asia/Dhaka period starts and tied ranks", async () => {
  assert.equal(growth.dhakaPeriodStart(new Date("2026-11-15T20:00:00Z"), "daily").toISOString(), "2026-11-15T18:00:00.000Z", "02:00 Dhaka on the 16th");
  assert.equal(growth.dhakaPeriodStart(NOW, "weekly").toISOString(), "2026-11-08T18:00:00.000Z", "Monday 9 Nov, Dhaka");
  assert.equal(growth.dhakaPeriodStart(NOW, "monthly").toISOString(), "2026-10-31T18:00:00.000Z");
  await delivered("A1", "V1", { amount: "70.00" });
  await delivered("A2", "V9", { amount: "70.00" });
  const lb = await growth.leaderboard("A2", "daily", NOW);
  assert.deepEqual(lb.entries.map((e) => e.rank), [1, 1]);
});

// ── alerts ───────────────────────────────────────────────────────────────

test("alerts: 'not configured' without thresholds; then inactivity, low rating, low stock and growth with no reviewer data", async () => {
  const none: any = await alerts.vendorAlerts("A1", { page: 1, limit: 50 }, NOW);
  assert.equal(none.configured, false);
  await saveSettings({ vendorAlertRules: { inactivityDays: 14, lowRatingMax: 2, lowStockUnits: 3, growthPercent: 50, lookbackDays: 7 } });
  vendorOrders.push(
    { vendorId: "V1", createdAt: new Date(NOW.getTime() - 30 * 864e5), status: "DELIVERED" }, // V1 inactive 30 days
    { vendorId: "V3", createdAt: new Date(NOW.getTime() - 2 * 864e5), status: "PENDING" },
    { vendorId: "V3", createdAt: new Date(NOW.getTime() - 3 * 864e5), status: "PENDING" },
    { vendorId: "V3", createdAt: new Date(NOW.getTime() - 10 * 864e5), status: "PENDING" },
  );
  reviews.push({ id: "R1", rating: 1, comment: "Broken on arrival", createdAt: new Date(NOW.getTime() - 864e5), product: { name: "Kettle", vendorId: "V1" }, user: { name: "SECRET CUSTOMER" } });
  variants.push({ id: "PV1", sku: "K-1", stock: 0, product: { name: "Kettle", vendorId: "V1" } });
  const out: any = await alerts.vendorAlerts("A1", { page: 1, limit: 50 }, NOW);
  assert.equal(out.configured, true);
  const types = out.items.map((a: any) => `${a.type}:${a.vendorId}`).sort();
  assert.deepEqual(types, ["GROWTH_UP:V3", "INACTIVITY:V1", "LOW_RATING:V1", "LOW_STOCK:V1"], "V2 linked too recently to be inactive");
  assert.ok(!JSON.stringify(out).includes("SECRET CUSTOMER"), "no reviewer data");
  assert.equal(out.counts.LOW_STOCK, 1);
  const filtered: any = await alerts.vendorAlerts("A1", { type: "LOW_STOCK", page: 1, limit: 50 }, NOW);
  assert.equal(filtered.total, 1);
});

// ── training ─────────────────────────────────────────────────────────────

test("training: validated, audited CRUD; agents see published resources only", async () => {
  await assert.rejects(training.createTraining({ category: "Sales", title: "Pitching" }, ADMIN), (e: any) => e.name === "ZodError");
  await assert.rejects(training.createTraining({ category: "Sales", title: "Pitching", url: "javascript:alert(1)" }, ADMIN), (e: any) => e.name === "ZodError");
  const draft = await training.createTraining({ category: "Sales", title: "Pitching to shops", url: "https://example.com/pitch" }, ADMIN);
  const pub = await training.createTraining({ category: "Onboarding", title: "Your first vendor", body: "Step 1 …", isPublished: true, isFeatured: true }, ADMIN);
  const list = await training.listPublishedTraining({ page: 1, limit: 20 });
  assert.deepEqual(list.items.map((x: any) => x.id), [pub.id]);
  assert.equal("body" in list.items[0], false, "the list omits bodies");
  await assert.rejects(training.getPublishedTraining(draft.id), (e: any) => e.statusCode === 404);
  await training.updateTraining(draft.id, { isPublished: true }, ADMIN);
  await assert.rejects(training.updateTraining(draft.id, { url: null }, ADMIN), (e: any) => e.code === "VALIDATION_ERROR");
  await training.deleteTraining(pub.id, ADMIN);
  const audit = fake.db.agentConfigAudit.rows.filter((a: any) => a.entity === "TRAINING").map((a: any) => a.action);
  assert.deepEqual(audit, ["CREATE", "CREATE", "UPDATE", "DELETE"]);
});

// ── wallet adjustment and payable report ─────────────────────────────────

test("wallet adjustment: signed amount, mandatory reason, idempotent, ledger + audit; payable report totals", async () => {
  const req = { clientRequestId: "adj-0001-abcdef", amount: "250.50", reason: "Opening balance migration" };
  await assert.rejects(walletAdmin.adjustAgentWallet("A1", { ...req, reason: "" }, ADMIN, NOW), (e: any) => e.name === "ZodError");
  await assert.rejects(walletAdmin.adjustAgentWallet("A1", { ...req, amount: "0" }, ADMIN, NOW), (e: any) => e.name === "ZodError");
  const first = await walletAdmin.adjustAgentWallet("A1", req, ADMIN, NOW);
  const again = await walletAdmin.adjustAgentWallet("A1", req, ADMIN, NOW);
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  await assert.rejects(walletAdmin.adjustAgentWallet("A1", { ...req, amount: "1.00" }, ADMIN, NOW), (e: any) => e.code === "IDEMPOTENCY_KEY_REUSED");
  await walletAdmin.adjustAgentWallet("A1", { clientRequestId: "adj-0002-abcdef", amount: "-300.00", reason: "Paid out by bank after deactivation" }, ADMIN, NOW);
  assert.equal(walletRow().available, "-49.50", "a deduction may take the balance negative");
  assert.deepEqual(ledger().map((e) => [e.type, e.amount, e.createdById]), [["ADJUSTMENT", "250.50", "U-ADMIN"], ["ADJUSTMENT", "-300.00", "U-ADMIN"]]);
  assertLedger();
  assert.equal(fake.db.agentConfigAudit.rows.filter((a: any) => a.entity === "WALLET").length, 2);

  await walletAdmin.adjustAgentWallet("A2", { clientRequestId: "adj-0003-abcdef", amount: "100.00", reason: "Manual correction" }, ADMIN, NOW);
  const report = await walletAdmin.payableReport({ page: 1, limit: 20 });
  assert.equal(report.totals.availableToWithdraw, "100.00");
  assert.equal(report.totals.negativeBalances, "49.50");
  assert.equal(report.total, 2);
});

test("routes: new admin paths sit before /:id; portal growth routes are agent-scoped", () => {
  const routes = readFileSync(new URL("../src/modules/agent/agent.routes.ts", import.meta.url), "utf8");
  const idRoute = routes.indexOf('adminAgentRouter.get("/:id"');
  for (const r of ['post("/levels/evaluate"', 'get("/training"', 'get("/reports/payable"']) {
    const at = routes.indexOf(`adminAgentRouter.${r}`);
    assert.ok(at > 0 && at < idRoute, r);
  }
  for (const r of ["/levels/me", "/bonuses/progress", "/bonuses", "/performance", "/leaderboard", "/alerts", "/training"]) assert.ok(routes.includes(`agentPortalRouter.get("${r}"`), r);
  const c = readFileSync(new URL("../src/modules/agent/controllers/agent-growth.controller.ts", import.meta.url), "utf8");
  assert.ok(!/req\.(body|query)\.agentId/.test(c.slice(0, c.indexOf("// ── admin"))), "portal handlers never take an agent id from the client");
});
