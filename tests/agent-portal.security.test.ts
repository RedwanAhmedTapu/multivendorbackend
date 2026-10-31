// tests/agent-portal.security.test.ts
//
// Agent portal (read-only monitoring): scope and privacy.
//   • only vendors with an OPEN link to the authenticated agent,
//   • only orders placed on/after the link started (tenure),
//   • a vendor/order outside the scope answers 404 (no existence leak),
//   • no customer identity is ever selected,
//   • pure display rules (health labels, growth, stock state, Dhaka buckets).
//
//   npx tsx --test tests/agent-portal.security.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

const scope = await import("../src/modules/agent/services/agent-portal.scope.ts");
const portal = await import("../src/modules/agent/services/agent-portal.service.ts");
const settingsSvc = await import("../src/modules/agent/services/agent-settings.service.ts");
const { programInfo } = await import("../src/modules/agent/controllers/agent-portal.controller.ts");
const { installAgentFakeDb } = await import("./support/agent-fake-db.ts");

let fake: ReturnType<typeof installAgentFakeDb>;
const T0 = new Date("2026-09-01T00:00:00Z");

beforeEach(async () => {
  settingsSvc.invalidateAgentSettingsCache();
  fake = installAgentFakeDb();
  await fake.db.agentVendorLink.create({ data: { agentId: "A1", vendorId: "V1", startedAt: T0 } });
  await fake.db.agentVendorLink.create({ data: { agentId: "A1", vendorId: "V_OLD", startedAt: T0, endedAt: new Date("2026-10-01T00:00:00Z") } });
  await fake.db.agentVendorLink.create({ data: { agentId: "A2", vendorId: "V2", startedAt: T0 } });
});
afterEach(() => fake.restore());

/** Collect every key of a Prisma select/include tree. */
function selectKeys(sel: any, out = new Set<string>()): Set<string> {
  if (!sel || typeof sel !== "object") return out;
  for (const [k, v] of Object.entries(sel)) {
    out.add(k);
    if (v && typeof v === "object") selectKeys((v as any).select ?? (v as any).include ?? v, out);
  }
  return out;
}
const CUSTOMER_KEYS = ["user", "userId", "address", "email", "phone", "customer", "OrderAddress"];

test("tenure filter: each open link scopes its vendor from the link start", () => {
  const links = [{ vendorId: "V1", startedAt: T0 }, { vendorId: "V3", startedAt: new Date("2026-10-15T00:00:00Z") }];
  assert.deepEqual(scope.tenureOrderWhere(links), {
    OR: [
      { vendorId: "V1", createdAt: { gte: T0 } },
      { vendorId: "V3", createdAt: { gte: new Date("2026-10-15T00:00:00Z") } },
    ],
  });
  assert.deepEqual(scope.tenureOrderWhere(links, "V3"), { OR: [{ vendorId: "V3", createdAt: { gte: new Date("2026-10-15T00:00:00Z") } }] });
  assert.deepEqual(scope.tenureOrderWhere([]), { id: "__no_vendor_in_scope__" }, "no links → matches nothing");
  assert.deepEqual(scope.tenureOrderWhere(links, "V_OTHER"), { id: "__no_vendor_in_scope__" });
});

test("getOpenLinks ignores ended links and other agents' links", async () => {
  const links = await portal.getOpenLinks("A1");
  assert.deepEqual(links.map((l) => l.vendorId), ["V1"]);
});

test("a vendor outside the scope (ended link, other agent, unknown) is 404", async () => {
  for (const vendorId of ["V_OLD", "V2", "NOPE"]) {
    await assert.rejects(portal.assertVendorInScope("A1", vendorId), (e: any) => e.statusCode === 404, vendorId);
  }
  assert.equal((await portal.assertVendorInScope("A1", "V1")).vendorId, "V1");
});

test("orders: list is tenure-scoped, never selects customer data; vendor filter outside scope → 404", async () => {
  const calls: any[] = [];
  fake.db.vendorOrder = {
    findMany: async (args: any) => (calls.push(args), []),
    count: async () => 0,
    groupBy: async () => [],
  };
  fake.db.agentCommission = { groupBy: async () => [], aggregate: async () => ({ _sum: { amount: null, reversedAmount: null } }) };
  const res = await portal.listOrders("A1", { status: "DELIVERED", q: "ORD", page: 1, limit: 20 });
  assert.equal(res.total, 0);
  const where = calls[0].where;
  assert.deepEqual(where.AND[0], { OR: [{ vendorId: "V1", createdAt: { gte: T0 } }] });
  assert.deepEqual(where.AND[1], { status: "DELIVERED" });
  const keys = selectKeys(calls[0].select);
  for (const k of CUSTOMER_KEYS) assert.ok(!keys.has(k), `order list must not select ${k}`);
  await assert.rejects(portal.listOrders("A1", { status: "ALL", vendorId: "V2", page: 1, limit: 20 }), (e: any) => e.statusCode === 404);
});

test("order detail: outside the tenure → 404; select carries no customer data", async () => {
  let args: any;
  fake.db.vendorOrder = { findFirst: async (a: any) => ((args = a), null) };
  await assert.rejects(portal.orderDetail("A1", "VO_X"), (e: any) => e.statusCode === 404);
  assert.deepEqual(args.where.AND[1], { OR: [{ vendorId: "V1", createdAt: { gte: T0 } }] });
  const keys = selectKeys(args.select);
  for (const k of CUSTOMER_KEYS) assert.ok(!keys.has(k), `order detail must not select ${k}`);
});

test("reviews: only PUBLISHED reviews of in-scope vendors; reviewer identity never selected", async () => {
  const calls: any[] = [];
  fake.db.review = {
    findMany: async (a: any) => (calls.push(a), []),
    count: async () => 0,
    aggregate: async () => ({ _avg: { rating: null }, _count: { _all: 0 } }),
    groupBy: async () => [],
  };
  await portal.listReviews("A1", { range: "30d", page: 1, limit: 10 });
  assert.equal(calls[0].where.status, "PUBLISHED");
  assert.deepEqual(calls[0].where.product, { vendorId: { in: ["V1"] } });
  const keys = selectKeys(calls[0].select);
  for (const k of CUSTOMER_KEYS) assert.ok(!keys.has(k), `reviews must not select ${k}`);
  await assert.rejects(portal.listReviews("A1", { vendorId: "V2", range: "all", page: 1, limit: 10 }), (e: any) => e.statusCode === 404);
});

test("an agent with no open links sees nothing (no query widening)", async () => {
  const reviewCalls: any[] = [];
  fake.db.review = {
    findMany: async (a: any) => (reviewCalls.push(a), []),
    count: async () => 0,
    aggregate: async () => ({ _avg: { rating: null }, _count: { _all: 0 } }),
    groupBy: async () => [],
  };
  await portal.listReviews("A_NONE", { range: "all", page: 1, limit: 10 });
  assert.deepEqual(reviewCalls[0].where.product, { vendorId: { in: ["__none__"] } });
  const products = await portal.listProducts("A_NONE", { stock: "ALL", approval: "ALL", page: 1, limit: 10 });
  assert.equal(products.total, 0);
  await assert.rejects(portal.listProducts("A1", { stock: "ALL", approval: "ALL", vendorId: "V2", page: 1, limit: 10 }), (e: any) => e.statusCode === 404);
});

test("SQL tenure join: raw queries bind the authenticated agent id (never a client value)", async () => {
  const seen: any[] = [];
  fake.db.$queryRaw = async (strings: any, ...values: any[]) => {
    const composed = Prisma.sql(strings, ...values); // flattens nested fragments
    seen.push({ sql: composed.sql, values: composed.values });
    return [];
  };
  await portal.salesTrend("A1", "7d", new Date("2026-10-31T12:00:00Z"));
  const q = seen[0];
  assert.match(q.sql, /JOIN agent_vendor_links l/);
  assert.match(q.sql, /l\."endedAt" IS NULL/);
  assert.match(q.sql, /vo\."createdAt" >= l\."startedAt"/);
  assert.ok(q.values.includes("A1"));
});

test("program info exposes only agent-facing terms (no rates, precedence or approval settings)", async () => {
  await fake.db.agentSetting.create({ data: { key: "minWithdrawalAmount", value: { value: "500.00" } } });
  await fake.db.agentSetting.create({ data: { key: "defaultCommissionPercent", value: { value: "5.0000" } } });
  await fake.db.agentSetting.create({ data: { key: "autoApproveWithdrawalLimit", value: { value: "1000.00" } } });
  const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
  await new Promise<void>((resolve) => {
    res.json = (b: any) => ((res.body = b), resolve(), res);
    programInfo({ agent: { id: "A1" } } as any, res, () => {});
  });
  const keys = Object.keys(res.body.data);
  for (const hidden of ["defaultCommissionPercent", "ratePrecedence", "autoApproveWithdrawalLimit", "registrationRequiresApproval"]) {
    assert.ok(!keys.includes(hidden), `${hidden} must not be exposed to agents`);
  }
  assert.equal(res.body.data.minWithdrawalAmount, "500.00");
  assert.equal(res.body.data.configured.withdrawals, false);
});

// ── Pure display rules ────────────────────────────────────────────────────

test("vendor health labels (display only)", () => {
  assert.equal(scope.vendorHealth({ orders30: 0, sales30: "0", salesPrev30: "500" }), "INACTIVE");
  assert.equal(scope.vendorHealth({ orders30: 3, sales30: "1200", salesPrev30: "1000" }), "GROWING");
  assert.equal(scope.vendorHealth({ orders30: 3, sales30: "850", salesPrev30: "1000" }), "DECLINING");
  assert.equal(scope.vendorHealth({ orders30: 3, sales30: "1050", salesPrev30: "1000" }), "ACTIVE");
  assert.equal(scope.vendorHealth({ orders30: 2, sales30: "100", salesPrev30: "0" }), "GROWING");
  assert.equal(scope.vendorHealth({ orders30: 2, sales30: "0", salesPrev30: "0" }), "ACTIVE");
});

test("growth, rates, effective price and stock state", () => {
  assert.equal(scope.growthPercent("1185", "1000"), 18.5);
  assert.equal(scope.growthPercent("5", "0"), null);
  assert.equal(scope.ratePercent(1, 3), 33.3);
  assert.equal(scope.ratePercent(1, 0), null);
  assert.equal(scope.effectivePrice("100", "80"), "80.00");
  assert.equal(scope.effectivePrice("100", "0"), "100.00");
  assert.equal(scope.effectivePrice("100", "120"), "100.00");
  assert.equal(scope.effectivePrice("100", null), "100.00");
  assert.equal(scope.stockState(0, 10), "OUT_OF_STOCK");
  assert.equal(scope.stockState(8, 10), "LOW_STOCK");
  assert.equal(scope.stockState(11, 10), "IN_STOCK");
});

test("time buckets are Asia/Dhaka local days and months", () => {
  // 2026-10-31 20:30 UTC is already 1 November in Dhaka (UTC+6)
  const lateUtc = new Date("2026-10-31T20:30:00Z");
  assert.equal(scope.dhakaBucket(lateUtc, "day"), "2026-11-01");
  assert.equal(scope.dhakaBucket(lateUtc, "month"), "2026-11");
  assert.equal(scope.dhakaStartOf(lateUtc, "day").toISOString(), "2026-10-31T18:00:00.000Z");
  assert.deepEqual(scope.bucketLabels(new Date("2026-03-15T00:00:00Z"), "month", 3), ["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(scope.bucketLabels(new Date("2026-03-01T03:00:00Z"), "day", 2), ["2026-02-28", "2026-03-01"]);
  assert.deepEqual(scope.fillSeries(["a", "b"], [{ bucket: "b", value: "12.5" }]), [{ bucket: "a", value: "0.00" }, { bucket: "b", value: "12.50" }]);
});
