// tests/agent-commission.test.ts
//
// Phase 6 commission engine, DB-free (in-memory agentDb fake):
// duplicate courier callbacks, partial and multi-warehouse delivery, return
// reversal, rate priority, snapshot immutability, the cap at FinixMart's own
// commission, attribution by order date, clearance, the never-throw hooks and
// the Commission Dashboard reads / CSV.
//
//   npx tsx --test tests/agent-commission.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";

const { installAgentFakeDb, makeTable } = await import("./support/agent-fake-db.ts");
const engine = await import("../src/modules/agent/services/agent-commission.service.ts");
const read = await import("../src/modules/agent/services/agent-commission-read.service.ts");
const { invalidateAgentSettingsCache } = await import("../src/modules/agent/services/agent-settings.service.ts");
const { assertNoSnapshotMutation, COMMISSION_SNAPSHOT_FIELDS } = await import("../src/modules/agent/services/agent-rate.service.ts");
const { agentCommissionJobs } = await import("../src/modules/agent/agent.jobs.ts");

let fake: ReturnType<typeof installAgentFakeDb>;
const DAY = 24 * 3600_000;
const T0 = new Date("2026-10-01T06:00:00Z"); // order placed
const DELIVERED = new Date("2026-10-05T06:00:00Z");
const NOW = new Date("2026-10-06T06:00:00Z");
const PLATFORM_10 = { resolvePlatformRate: async () => ({ rate: "0.10", source: "GLOBAL_DEFAULT" }), now: () => NOW };

/** A unique check on several columns, like @@unique([a, b]). */
function compositeUnique(table: any, keys: string[]) {
  const create = table.create;
  table.create = async (args: any) => {
    if (table.rows.some((r: any) => keys.every((k) => r[k] === args.data[k]))) {
      const err: any = new Error(`Unique constraint failed on (${keys.join(", ")})`);
      err.code = "P2002";
      throw err;
    }
    return create(args);
  };
}

/** Decimal-safe { increment } (the shared fake adds with JS +). */
function decimalIncrements(table: any) {
  const updateMany = table.updateMany;
  table.updateMany = async ({ where, data }: any) => {
    const fixed: any = { ...data };
    const inc: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as any) && typeof (v as any).increment === "string") {
        inc[k] = (v as any).increment;
        delete fixed[k];
      }
    }
    const before = table.rows.filter((r: any) => Object.entries(where).every(([k, c]) => (c === null ? r[k] == null : typeof c === "object" ? true : r[k] === c)));
    const res = await updateMany({ where, data: fixed });
    if (res.count) for (const r of before) for (const [k, v] of Object.entries(inc)) r[k] = new Decimal(r[k] ?? 0).plus(v).toFixed(2);
    return res;
  };
}

let vendorOrders: Map<string, any>;
let vendorReturns: Map<string, any>;

beforeEach(async () => {
  invalidateAgentSettingsCache();
  fake = installAgentFakeDb();
  const db = fake.db;
  db.agentCommission = makeTable("commission", { defaults: () => ({ reversedQty: 0, reversedAmount: "0.00", status: "PENDING_CLEARANCE" }) });
  compositeUnique(db.agentCommission, ["deliveryId", "orderItemId"]);
  decimalIncrements(db.agentCommission);
  db.agentCommissionReversal = makeTable("reversal");
  compositeUnique(db.agentCommissionReversal, ["commissionId", "vendorReturnId"]);
  db.commissionRecord = makeTable("crec");
  db.orderItemDiscount = makeTable("oid");
  db.auditLog = makeTable("audit");
  db.order = makeTable("order");
  vendorOrders = new Map();
  vendorReturns = new Map();
  db.vendorOrder = { findUnique: async ({ where }: any) => vendorOrders.get(where.id) ?? null };
  db.vendorReturn = { findUnique: async ({ where }: any) => vendorReturns.get(where.id) ?? null };
  // agentVendorLink rows carry the agent status relation used in the snapshot
  db.agentVendorLink.findFirst = async ({ where }: any) => {
    const at = where.startedAt.lte as Date;
    const rows = db.agentVendorLink.rows
      .filter((l: any) => l.vendorId === where.vendorId && l.startedAt <= at && (l.endedAt == null || l.endedAt > at))
      .sort((a: any, b: any) => b.startedAt - a.startedAt);
    const l = rows[0];
    if (!l) return null;
    return { id: l.id, agentId: l.agentId, source: l.source, startedAt: l.startedAt, agent: { status: db.agent.rows.find((a: any) => a.id === l.agentId)?.status ?? null } };
  };

  await db.agent.create({ data: { id: "A1", agentCode: "AG-AAAAAA", referralCode: "REF-A", name: "Rahim", email: "a1@x.com", passwordHash: "x", status: "ACTIVE" } });
  await db.agent.create({ data: { id: "A2", agentCode: "AG-BBBBBB", referralCode: "REF-B", name: "Karim", email: "a2@x.com", passwordHash: "x", status: "ACTIVE" } });
  await db.vendor.create({ data: { id: "V1", storeName: "Dhaka Fashion" } });
  await db.order.create({ data: { id: "O1", orderNumber: "FM-1001" } });
  await db.agentVendorLink.create({ data: { id: "L1", agentId: "A1", vendorId: "V1", source: "ADMIN_ASSIGNED", startedAt: new Date("2026-09-01T00:00:00Z"), endedAt: null } });
  await settings({ ratePrecedence: ["VENDOR", "AGENT", "CATEGORY", "LEVEL", "GLOBAL"], defaultCommissionPercent: "20", holdDays: 7, commissionDurationMonths: null });
  vendorOrders.set("VO1", {
    id: "VO1",
    orderId: "O1",
    vendorId: "V1",
    order: { createdAt: T0 },
    items: [
      { id: "IA", quantity: 5, price: "200.0000", variant: { product: { categoryId: "CAT1" } } },
      { id: "IB", quantity: 1, price: "1000.0000", variant: { product: { categoryId: "CAT2" } } },
    ],
  });
});
afterEach(() => fake.restore());

async function settings(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    const row = fake.db.agentSetting.rows.find((r: any) => r.key === key);
    if (row) row.value = { value };
    else await fake.db.agentSetting.create({ data: { key, value: { value }, updatedById: "U", updatedAt: new Date() } });
  }
  invalidateAgentSettingsCache();
}

const accrue = (deliveryId: string, lineScope?: Array<{ orderItemId: string; quantity: number }>, deps: any = PLATFORM_10) =>
  engine.accrueAgentCommissionForDelivery({ vendorOrderId: "VO1", deliveryId, lineScope, deliveredAt: DELIVERED }, deps);
const rows = () => fake.db.agentCommission.rows as any[];

// ── accrual ──────────────────────────────────────────────────────────────

test("C1/C3: base is FinixMart's commission on the charged line; agent earns its % of that", async () => {
  const r = await accrue("D1");
  assert.deepEqual(r, { status: "DONE", created: 2, existing: 0 });
  const a = rows().find((x) => x.orderItemId === "IA");
  assert.equal(a.baseAmount, "100.0000", "200 × 5 × 10% platform commission");
  assert.equal(a.amount, "20.00", "20% of FinixMart's 100, not of the 1,000 sale");
  assert.equal(a.agentId, "A1");
  assert.equal(a.availableAt.getTime(), DELIVERED.getTime() + 7 * DAY, "holdDays after delivery");
  assert.equal(a.status, "PENDING_CLEARANCE");
  assert.equal(a.ruleSnapshot.base.source, "LINE_RESOLVER");
  assert.equal(a.ruleSnapshot.attribution.orderPlacedAt, T0.toISOString());
});

test("C1: an existing CommissionRecord for the line is the base; C3: only the platform-funded discount share lowers it", async () => {
  await fake.db.commissionRecord.create({ data: { orderItemId: "IB", quantity: 1, commissionAmount: "150.00", commissionRate: "15.00", status: "RECOGNIZED" } });
  await fake.db.orderItemDiscount.create({ data: { orderItemId: "IA", amount: "100.0000", platformFunded: "50.0000", sellerFunded: "50.0000", reversedAmount: "0" } });
  await accrue("D1");
  const b = rows().find((x) => x.orderItemId === "IB");
  assert.equal(b.baseAmount, "150.0000");
  assert.equal(b.ruleSnapshot.base.source, "COMMISSION_RECORD");
  const a = rows().find((x) => x.orderItemId === "IA");
  assert.equal(a.baseAmount, "95.0000", "(1000 − 50 platform-funded) × 10%; the seller-funded 50 doesn't count");
  assert.equal(a.amount, "19.00");
});

test("duplicate courier callback: the same consignment never accrues twice (sequential and concurrent)", async () => {
  await accrue("D1");
  assert.deepEqual(await accrue("D1"), { status: "DONE", created: 0, existing: 2 });
  await Promise.all([accrue("D2", [{ orderItemId: "IA", quantity: 1 }]), accrue("D2", [{ orderItemId: "IA", quantity: 1 }])]);
  assert.equal(rows().filter((x) => x.deliveryId === "D2").length, 1, "a concurrent duplicate hits the unique key and is treated as done");
  assert.equal(rows().length, 3);
});

test("partial delivery: only the consignment's units earn", async () => {
  await accrue("D1", [{ orderItemId: "IA", quantity: 2 }]);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].quantity, 2);
  assert.equal(rows()[0].baseAmount, "40.0000", "200 × 2 × 10%");
  assert.equal(rows()[0].amount, "8.00");
});

test("multi-warehouse: each consignment earns its own share, together exactly the line", async () => {
  await accrue("D-WH1", [{ orderItemId: "IA", quantity: 2 }]);
  await accrue("D-WH2", [{ orderItemId: "IA", quantity: 3 }, { orderItemId: "IB", quantity: 1 }]);
  const ia = rows().filter((x) => x.orderItemId === "IA");
  assert.equal(ia.length, 2);
  assert.equal(ia.reduce((s, x) => s + x.quantity, 0), 5);
  assert.equal(ia.reduce((s, x) => s.plus(x.amount), new Decimal(0)).toFixed(2), "20.00", "same total as one full delivery");
  assert.deepEqual(await accrue("D-WH3", [{ orderItemId: "IA", quantity: 0 }]), { status: "SKIPPED", reason: "NOTHING_DELIVERED" });
});

test("C6: the agent linked when the ORDER was placed earns, even after a reassignment before delivery", async () => {
  fake.db.agentVendorLink.rows[0].endedAt = new Date("2026-10-03T00:00:00Z");
  await fake.db.agentVendorLink.create({ data: { id: "L2", agentId: "A2", vendorId: "V1", source: "ADMIN_ASSIGNED", startedAt: new Date("2026-10-03T00:00:00Z"), endedAt: null } });
  await accrue("D1");
  assert.ok(rows().every((x) => x.agentId === "A1"), "old agent keeps the order placed under its link");
});

test("C6: no link at the order date, or past commissionDurationMonths → nothing accrues", async () => {
  fake.db.agentVendorLink.rows[0].startedAt = new Date("2026-10-02T00:00:00Z"); // linked after the order
  assert.deepEqual(await accrue("D1"), { status: "SKIPPED", reason: "NO_AGENT" });
  fake.db.agentVendorLink.rows[0].startedAt = new Date("2026-08-01T00:00:00Z");
  await settings({ commissionDurationMonths: 1 }); // ended 2026-09-01, order 2026-10-01
  const r = await accrue("D1");
  assert.equal(r.status, "SKIPPED");
  assert.equal((r as any).reason, "DURATION_ENDED");
  assert.equal(rows().length, 0);
});

// ── rate priority & snapshot ──────────────────────────────────────────────

test("rate priority VENDOR > AGENT > CATEGORY > LEVEL > GLOBAL, overrides as of the order date", async () => {
  const db = fake.db;
  await db.agentLevel.create({ data: { id: "LV1", name: "Gold", rank: 1, isActive: true, commissionPercent: "12.0000" } });
  db.agent.rows.find((a: any) => a.id === "A1").levelId = "LV1";
  const ov = (scope: string, ratePercent: string, extra: Record<string, unknown>, from = new Date("2026-09-01T00:00:00Z")) =>
    db.agentCommissionOverride.create({ data: { scope, ratePercent, effectiveFrom: from, isActive: true, ...extra } });
  await ov("CATEGORY", "11.0000", { categoryId: "CAT1" });
  await ov("AGENT", "15.0000", { agentId: "A1" });
  await ov("VENDOR", "25.0000", { vendorId: "V1" });
  await ov("VENDOR", "99.0000", { vendorId: "V1" }, new Date("2026-10-02T00:00:00Z")); // starts after the order — ignored

  const rateFor = async (deliveryId: string) => {
    await accrue(deliveryId, [{ orderItemId: "IA", quantity: 1 }]);
    const r = rows().find((x) => x.deliveryId === deliveryId);
    return [r.rateSource, r.ratePercent];
  };
  assert.deepEqual(await rateFor("D1"), ["VENDOR", "25.0000"]);
  db.agentCommissionOverride.rows.filter((o: any) => o.scope === "VENDOR").forEach((o: any) => (o.isActive = false));
  assert.deepEqual(await rateFor("D2"), ["AGENT", "15.0000"]);
  db.agentCommissionOverride.rows.find((o: any) => o.scope === "AGENT").isActive = false;
  assert.deepEqual(await rateFor("D3"), ["CATEGORY", "11.0000"]);
  db.agentCommissionOverride.rows.find((o: any) => o.scope === "CATEGORY").isActive = false;
  assert.deepEqual(await rateFor("D4"), ["LEVEL", "12.0000"]);
  db.agentLevel.rows[0].isActive = false;
  assert.deepEqual(await rateFor("D5"), ["GLOBAL", "20.0000"]);
});

test("admin can change the precedence: LEVEL before VENDOR is honoured", async () => {
  await fake.db.agentLevel.create({ data: { id: "LV1", name: "Gold", rank: 1, isActive: true, commissionPercent: "12.0000" } });
  fake.db.agent.rows.find((a: any) => a.id === "A1").levelId = "LV1";
  await fake.db.agentCommissionOverride.create({ data: { scope: "VENDOR", vendorId: "V1", ratePercent: "25.0000", effectiveFrom: new Date("2026-09-01T00:00:00Z"), isActive: true } });
  await settings({ ratePrecedence: ["LEVEL", "VENDOR", "AGENT", "CATEGORY", "GLOBAL"] });
  await accrue("D1", [{ orderItemId: "IA", quantity: 1 }]);
  assert.equal(rows()[0].rateSource, "LEVEL");
});

test("snapshot immutability: later rule changes, clearance and reversals never touch the snapshot columns", async () => {
  await accrue("D1");
  const pick = (r: any) => Object.fromEntries(COMMISSION_SNAPSHOT_FIELDS.map((f) => [f, JSON.stringify(r[f])]));
  const before = rows().map(pick);
  const writes: any[] = [];
  const orig = fake.db.agentCommission.updateMany;
  fake.db.agentCommission.updateMany = async (args: any) => (writes.push(args.data), orig(args));

  await settings({ defaultCommissionPercent: "50", holdDays: 1, commissionDurationMonths: 3 });
  await fake.db.agentCommissionOverride.create({ data: { scope: "VENDOR", vendorId: "V1", ratePercent: "40.0000", effectiveFrom: new Date("2026-01-01T00:00:00Z"), isActive: true } });
  await engine.clearMaturedAgentCommissions(new Date(NOW.getTime() + 30 * DAY));
  vendorReturns.set("R1", { id: "R1", items: [{ orderItemId: "IA", quantity: 1 }] });
  await engine.reverseAgentCommissionForReturn("R1");

  assert.deepEqual(rows().map(pick), before, "snapshot unchanged");
  assert.ok(writes.length >= 2);
  for (const data of writes) for (const f of COMMISSION_SNAPSHOT_FIELDS) assert.ok(!(f in data), `update wrote ${f}`);
  assert.throws(() => assertNoSnapshotMutation({ ratePercent: "1" }), /immutable/);
  assert.equal(rows().find((x) => x.orderItemId === "IA").ratePercent, "20.0000");
});

// ── cap ───────────────────────────────────────────────────────────────────

test("an agent commission never exceeds FinixMart's commission on the line (100% rate, rounding edges, random)", async () => {
  await settings({ defaultCommissionPercent: "100" });
  await accrue("D1");
  for (const r of rows()) assert.ok(new Decimal(r.amount).lte(r.baseAmount), `${r.amount} ≤ ${r.baseAmount}`);
  assert.equal(engine.cappedAgentAmount("1.2350", "100.0000"), "1.23", "half-up would give 1.24 > base");
  assert.equal(engine.cappedAgentAmount("0.0049", "100.0000"), "0.00");
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) {
    const base = new Decimal(Math.floor(rnd() * 10_000_000)).dividedBy(10_000).toFixed(4);
    const rate = new Decimal(Math.floor(rnd() * 1_000_001)).dividedBy(10_000).toFixed(4); // 0–100%
    assert.ok(new Decimal(engine.cappedAgentAmount(base, rate)).lte(base), `${base} @ ${rate}%`);
  }
});

// ── reversal ──────────────────────────────────────────────────────────────

test("return reversal: oldest consignment first, never more than earned, idempotent per return", async () => {
  await accrue("D-WH1", [{ orderItemId: "IA", quantity: 2 }]); // 8.00
  await accrue("D-WH2", [{ orderItemId: "IA", quantity: 3 }]); // 12.00
  fake.db.agentCommission.rows.find((x: any) => x.deliveryId === "D-WH1").earnedAt = new Date(DELIVERED.getTime() - DAY);
  vendorReturns.set("R1", { id: "R1", items: [{ orderItemId: "IA", quantity: 3 }] });

  const r = await engine.reverseAgentCommissionForReturn("R1");
  assert.deepEqual(r, { reversedRows: 2, reversedQuantity: 3, reversedAmount: "12.00" });
  const wh1 = rows().find((x) => x.deliveryId === "D-WH1");
  const wh2 = rows().find((x) => x.deliveryId === "D-WH2");
  assert.deepEqual([wh1.reversedQty, wh1.reversedAmount, wh1.status], [2, "8.00", "REVERSED"]);
  assert.deepEqual([wh2.reversedQty, wh2.reversedAmount, wh2.status], [1, "4.00", "PARTIALLY_REVERSED"]);

  assert.deepEqual(await engine.reverseAgentCommissionForReturn("R1"), { reversedRows: 0, reversedQuantity: 0, reversedAmount: "0.00" }, "re-run of the same refund");
  vendorReturns.set("R2", { id: "R2", items: [{ orderItemId: "IA", quantity: 10 }] }); // more than is left
  const r2 = await engine.reverseAgentCommissionForReturn("R2");
  assert.equal(r2.reversedQuantity, 2);
  assert.deepEqual([wh2.reversedQty, wh2.reversedAmount, wh2.status], [3, "12.00", "REVERSED"]);
  const totalReversed = rows().reduce((s, x) => s.plus(x.reversedAmount), new Decimal(0));
  assert.equal(totalReversed.toFixed(2), "20.00", "exactly what was earned, no more");
});

test("reversal of an odd split leaves no rounding residue", () => {
  const row = { quantity: 3, amount: "10.00", reversedQty: 0, reversedAmount: "0.00" };
  const first = engine.reversalAmount(row, 1);
  const second = engine.reversalAmount({ ...row, reversedQty: 1, reversedAmount: first }, 1);
  const third = engine.reversalAmount({ ...row, reversedQty: 2, reversedAmount: new Decimal(first).plus(second).toFixed(2) }, 1);
  assert.equal(new Decimal(first).plus(second).plus(third).toFixed(2), "10.00");
});

// ── clearance ─────────────────────────────────────────────────────────────

test("clearance: PENDING_CLEARANCE → AVAILABLE only after availableAt; reads derive it either way", async () => {
  await accrue("D1");
  assert.equal(await engine.clearMaturedAgentCommissions(NOW), 0, "still on hold");
  const later = new Date(DELIVERED.getTime() + 7 * DAY);
  assert.equal(engine.effectiveCommissionStatus(rows()[0], later), "AVAILABLE", "derived before the job runs");
  assert.equal(await engine.clearMaturedAgentCommissions(later), 2);
  assert.ok(rows().every((x) => x.status === "AVAILABLE"));
  assert.equal(await engine.clearMaturedAgentCommissions(later), 0, "idempotent");
  const [job] = agentCommissionJobs(async () => 0);
  assert.equal(job.name, "agent:commission-clearance");
});

// ── never-throw hooks ─────────────────────────────────────────────────────

test("the accrual hook never throws: failures and missing settings are audited, nothing is written", async () => {
  const boom = { resolvePlatformRate: async () => { throw new Error("commission_default_rate missing"); }, now: () => NOW };
  const r = await engine.accrueAgentCommissionForDeliverySafe({ vendorOrderId: "VO1", deliveryId: "D1", deliveredAt: DELIVERED }, boom);
  assert.equal((r as any).status, "FAILED");
  assert.equal(fake.db.auditLog.rows.at(-1).action, "AGENT_COMMISSION_ACCRUAL_FAILED");
  assert.equal(rows().length, 0);

  const missing = await engine.accrueAgentCommissionForDeliverySafe({ vendorOrderId: "NOPE", deliveryId: "D9" }, PLATFORM_10);
  assert.equal((missing as any).status, "FAILED");

  fake.db.agentSetting.rows.splice(fake.db.agentSetting.rows.findIndex((s: any) => s.key === "defaultCommissionPercent"), 1);
  invalidateAgentSettingsCache();
  const nc = await engine.accrueAgentCommissionForDeliverySafe({ vendorOrderId: "VO1", deliveryId: "D1", deliveredAt: DELIVERED }, PLATFORM_10);
  assert.equal((nc as any).reason, "NOT_CONFIGURED");
  assert.equal(fake.db.auditLog.rows.at(-1).action, "AGENT_COMMISSION_ACCRUAL_SKIPPED");
  assert.equal(rows().length, 0);

  fake.db.auditLog.create = async () => { throw new Error("audit down"); };
  const still = await engine.accrueAgentCommissionForDeliverySafe({ vendorOrderId: "NOPE", deliveryId: "D9" }, PLATFORM_10);
  assert.equal((still as any).status, "FAILED", "even a failing audit write doesn't throw");
  const rev = await engine.reverseAgentCommissionForReturnSafe("NO-RETURN");
  assert.equal((rev as any).status, "FAILED");
});

test("hooks are wired after the delivery voucher and after each return voucher", () => {
  const admin = readFileSync(new URL("../src/services/admin.order.service.ts", import.meta.url), "utf8");
  const voucherAt = admin.indexOf("await postDeliveryVoucherForVendorOrder({", admin.indexOf("async processCourierStatusUpdate"));
  const hookAt = admin.indexOf("await accrueAgentCommissionForDeliverySafe({", voucherAt);
  assert.ok(voucherAt > 0 && hookAt > voucherAt, "accrual right after the voucher");
  assert.match(admin.slice(hookAt, hookAt + 300), /lineScope: hasAllocationScope \? lineScope : undefined/, "same consignment scope");
  const acc = readFileSync(new URL("../src/services/order-accounting.service.ts", import.meta.url), "utf8");
  const fn = acc.slice(acc.indexOf("export async function consumeVendorReturnsForRefund"));
  assert.ok(fn.indexOf("await reverseAgentCommissionForReturnSafe(vr.id)") > fn.indexOf("await postReturnVoucherForOrder({"), "reversal after the return voucher");
});

// ── reads ─────────────────────────────────────────────────────────────────

test("dashboard reads: summary nets reversals, history is scoped to the agent, CSV is formula-safe", async () => {
  await accrue("D1");
  await fake.db.agentCommission.create({
    data: { id: "OTHER", agentId: "A2", vendorId: "V1", orderId: "O1", vendorOrderId: "VO1", orderItemId: "IX", deliveryId: "DX", quantity: 1, baseAmount: "10.0000", amount: "5.00", rateSource: "GLOBAL", ratePercent: "50.0000", holdDays: 0, ruleSnapshot: {}, earnedAt: DELIVERED, availableAt: DELIVERED },
  });
  vendorReturns.set("R1", { id: "R1", items: [{ orderItemId: "IB", quantity: 1 }] });
  await engine.reverseAgentCommissionForReturn("R1");

  const s = await read.commissionSummary("A1", NOW);
  assert.deepEqual([s.totalEarned, s.pendingClearance, s.available, s.reversed], ["20.00", "20.00", "0.00", "20.00"]);
  const later = await read.commissionSummary("A1", new Date(DELIVERED.getTime() + 8 * DAY));
  assert.deepEqual([later.pendingClearance, later.available], ["0.00", "20.00"]);

  const list = await read.listCommissions({ status: "ALL", page: 1, limit: 20 }, { scopeAgentId: "A1", now: NOW });
  assert.equal(list.total, 2);
  assert.ok(list.items.every((i: any) => i.storeName === "Dhaka Fashion" && i.orderNumber === "FM-1001"));
  assert.ok(!list.items.some((i: any) => i.id === "OTHER"), "another agent's row never shows");
  const spoof = await read.listCommissions({ status: "ALL", agentId: "A2", page: 1, limit: 20 }, { scopeAgentId: "A1", now: NOW });
  assert.equal(spoof.total, 2, "the portal scope wins over any agentId filter");
  const rev = await read.listCommissions({ status: "REVERSED", page: 1, limit: 20 }, { scopeAgentId: "A1", now: NOW });
  assert.equal(rev.total, 1);
  const pending = await read.listCommissions({ status: "PENDING", page: 1, limit: 20 }, { scopeAgentId: "A1", now: NOW });
  assert.equal(pending.total, 1);
  const outOfRange = await read.listCommissions({ status: "ALL", from: "2026-11-01", to: "2026-11-30", page: 1, limit: 20 }, { scopeAgentId: "A1", now: NOW });
  assert.equal(outOfRange.total, 0);

  fake.db.vendor.rows[0].storeName = '=HYPERLINK("http://x")';
  const csv = await read.exportCommissionsCsv({ status: "ALL" }, { scopeAgentId: "A1", now: NOW });
  assert.ok(csv.csv.startsWith("﻿"), "BOM so Excel reads UTF-8");
  assert.match(csv.csv, /"'=HYPERLINK\(""http:\/\/x""\)"/, "formula neutralised and quoted");
  assert.match(csv.csv.split("\r\n")[0], /Earned \(BDT\)/);
  assert.ok(!csv.csv.includes("$"), "no dollar amounts");
});

test("trend buckets net commission per Dhaka day", async () => {
  await accrue("D1");
  const t = await read.commissionEarningsTrend("A1", "1m", NOW);
  assert.equal(t.series.length, 30);
  assert.equal(t.series.find((p: any) => p.bucket === "2026-10-05")!.value, "40.00", "IA 20 + IB 20 (20% of FinixMart's 100) earned on the delivery day");
  const y = await read.commissionEarningsTrend("A1", "1y", NOW);
  assert.equal(y.series.length, 12);
  assert.equal(y.series.at(-1)!.bucket, "2026-10");
});
