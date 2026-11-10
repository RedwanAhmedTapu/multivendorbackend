// tests/business-advisor-analytics.test.ts
//
// Business Advisor analytics — event contract, recorder, ingestion, queries,
// authorization and the cart / order instrumentation. No database: the
// analytics_events table is an in-memory fake implementing the Prisma
// operations the code uses (createMany skipDuplicates, groupBy with
// _count/_sum/_max/_min, orderBy, skip/take, findMany, aggregate). Routes run
// on the real Express router with the real authenticateUser /
// requirePermission (prisma.user / prisma.employee / prisma.vendor stubbed).
//   npx tsx --test tests/business-advisor-analytics.test.ts   (ACCESS_TOKEN_SECRET set)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";

const C = await import("../src/modules/analytics/analytics.contract.ts");
const { createAnalyticsRecorder } = await import("../src/modules/analytics/analytics.recorder.ts");
const { createBusinessAdvisorService, resolveRange, previousRange, InvalidRangeError } = await import("../src/modules/analytics/business-advisor.service.ts");
const { createAnalyticsRouter } = await import("../src/modules/analytics/analytics.routes.ts");
const { analyticsContext } = await import("../src/modules/analytics/analytics.context.ts");
const { prisma } = await import("../src/config/prisma.ts");

type Row = Record<string, any>;
const SECRET = process.env.ACCESS_TOKEN_SECRET ?? "";

// ── in-memory analytics_events ──────────────────────────────────────────
const cmp = (a: any) => (a instanceof Date ? a.getTime() : a);
function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v && !(v.in as any[]).includes(r[k])) return false;
      if ("notIn" in v && (v.notIn as any[]).includes(r[k])) return false;
      if ("gte" in v && !(cmp(r[k]) >= cmp(v.gte))) return false;
      if ("lte" in v && !(cmp(r[k]) <= cmp(v.lte))) return false;
      if ("gt" in v && !(cmp(r[k]) > cmp(v.gt))) return false;
      if ("lt" in v && !(cmp(r[k]) < cmp(v.lt))) return false;
      return true;
    }
    return cmp(r[k] ?? null) === cmp(v);
  });
}
function makeTable(opts: { failWrites?: boolean } = {}) {
  const rows: Row[] = [];
  const keyOf = (v: any) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    rows,
    async createMany({ data, skipDuplicates }: Row) {
      if (opts.failWrites) throw Object.assign(new Error("boom"), { code: "P1001" });
      let count = 0;
      for (const d of data) {
        if (rows.some((r) => r.dedupKey === d.dedupKey)) {
          if (!skipDuplicates) throw new Error("unique");
          continue;
        }
        rows.push({ id: `E${rows.length + 1}`, createdAt: new Date(), ...d });
        count++;
      }
      return { count };
    },
    async groupBy({ by, where, _count, _sum, _max, _min, orderBy, skip, take }: Row) {
      const groups = new Map<string, Row[]>();
      for (const r of rows.filter((x) => matches(x, where))) {
        const k = by.map((b: string) => keyOf(r[b])).join("¦");
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }
      let out = [...groups.values()].map((members) => {
        const g: Row = {};
        for (const b of by) g[b] = members[0][b] ?? null;
        if (_count) g._count = { _all: members.length };
        for (const [agg, spec, fn] of [
          ["_sum", _sum, (vals: any[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) : null)],
          ["_max", _max, (vals: any[]) => (vals.length ? vals.reduce((a, b) => (cmp(b) > cmp(a) ? b : a)) : null)],
          ["_min", _min, (vals: any[]) => (vals.length ? vals.reduce((a, b) => (cmp(b) < cmp(a) ? b : a)) : null)],
        ] as const) {
          if (!spec) continue;
          g[agg] = {};
          for (const f of Object.keys(spec)) g[agg][f] = (fn as any)(members.map((m) => m[f]).filter((v) => v !== null && v !== undefined));
        }
        return g;
      });
      const orders = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
      out.sort((a, b) => {
        for (const o of orders) {
          const [field, dir] = Object.entries(o)[0] as [string, any];
          const [va, vb] = typeof dir === "object" ? [a[field]?.[Object.keys(dir)[0]], b[field]?.[Object.keys(dir)[0]]] : [a[field], b[field]];
          const d = typeof dir === "object" ? Object.values(dir)[0] : dir;
          if (cmp(va) < cmp(vb)) return d === "desc" ? 1 : -1;
          if (cmp(va) > cmp(vb)) return d === "desc" ? -1 : 1;
        }
        return 0;
      });
      if (skip) out = out.slice(skip);
      if (take) out = out.slice(0, take);
      return out;
    },
    async findMany({ where, orderBy, take }: Row) {
      let out = rows.filter((x) => matches(x, where));
      if (orderBy?.occurredAt) out = [...out].sort((a, b) => (cmp(a.occurredAt) - cmp(b.occurredAt)) * (orderBy.occurredAt === "desc" ? -1 : 1));
      return take ? out.slice(0, take) : out;
    },
    async aggregate({ where, _min }: Row) {
      const m = rows.filter((x) => matches(x, where));
      return { _min: { occurredAt: _min ? (m.length ? m.reduce((a, b) => (cmp(b.occurredAt) < cmp(a.occurredAt) ? b : a)).occurredAt : null) : undefined } };
    },
  };
}

const NOW = new Date("2026-10-21T06:00:00.000Z"); // 12:00 in Dhaka
const ctxA = { actorKey: "v:visitor-aaaaaaaaaaaaaaaa", sessionKey: "s:session-aaaaaaaaaaaaaaaa" };
const ctxB = { actorKey: "u:customer-b", sessionKey: "s:session-bbbbbbbbbbbbbbbb" };

// ── 1. contract ─────────────────────────────────────────────────────────
test("contract: failure categories never depend on storing the message; dates are Dhaka days; ranges are validated", () => {
  assert.equal(C.classifyCheckoutFailure({ message: "Insufficient stock. Available: 0" }), "STOCK_UNAVAILABLE");
  assert.equal(C.classifyCheckoutFailure({ message: "No courier available for this delivery route" }), "SHIPPING_UNAVAILABLE");
  assert.equal(C.classifyCheckoutFailure({ message: "Shipping address not found" }), "ADDRESS_INVALID");
  assert.equal(C.classifyCheckoutFailure({ code: "CHECKOUT_CHANGED", reason: "PRICE_ACK_REQUIRED" }), "PRICE_CHANGED");
  assert.equal(C.classifyCheckoutFailure({ code: "QUOTE_REQUIRED" }), "QUOTE_REVIEW_REQUIRED");
  assert.equal(C.classifyCheckoutFailure({ message: "Cart changed during checkout; please review" }), "CART_CHANGED");
  assert.equal(C.classifyCheckoutFailure(new Error("Something odd at 10.0.0.5")), "OTHER");
  assert.equal(C.isoDay(C.dhakaDay(new Date("2026-10-20T18:00:00Z"))), "2026-10-21", "midnight in Dhaka is 18:00 UTC");
  assert.equal(C.isoDay(C.dhakaDay(new Date("2026-10-20T17:59:59Z"))), "2026-10-20");
  assert.equal(C.parseDay("2026-02-30"), null);
  assert.equal(C.parseDay("21-10-2026"), null);
  const r = resolveRange({}, NOW);
  assert.deepEqual([C.isoDay(r.from), C.isoDay(r.to), r.days], ["2026-09-22", "2026-10-21", 30]);
  const p = previousRange(resolveRange({ from: "2026-10-15", to: "2026-10-21" }, NOW));
  assert.deepEqual([C.isoDay(p.from), C.isoDay(p.to)], ["2026-10-08", "2026-10-14"]);
  for (const bad of [{ from: "2026-10-22", to: "2026-10-01" }, { from: "2026-01-01", to: "2026-10-21" }, { from: "nope" }, { to: "2027-01-01" }]) {
    assert.throws(() => resolveRange(bad, NOW), InvalidRangeError, JSON.stringify(bad));
  }
  const actor = C.actorKeyFor("user-123", null)!;
  assert.ok(actor.startsWith("u:") && !actor.includes("user-123"), "the user id is never stored raw");
  assert.equal(C.actorKeyFor(null, "visitor-xxxxxxxxxxxxxxxx"), "v:visitor-xxxxxxxxxxxxxxxx");
  assert.equal(C.safeClientId("short"), null);
  assert.equal(C.safeClientId("<script>alert(1)</script>"), null);
  assert.ok(C.looksLikeBot("Googlebot/2.1") && C.looksLikeBot(undefined) && !C.looksLikeBot("Mozilla/5.0 (Windows NT 10.0) Chrome/130"));
  assert.ok(C.journeyLabel("s:abc").startsWith("J-") && !C.journeyLabel("s:abc").includes("abc"));
});

test("context: staff accounts are never recorded; a signed-in customer is keyed by a hash", () => {
  const headers = { "x-fm-analytics-visitor": "visitor-xxxxxxxxxxxxxxxx", "x-fm-analytics-session": "session-yyyyyyyyyyyyyyyy" };
  assert.equal(analyticsContext({ headers, user: { role: "VENDOR", id: "V1" } }), null);
  assert.equal(analyticsContext({ headers, user: { role: "ADMIN", id: "A1" } }), null);
  const anon = analyticsContext({ headers })!;
  assert.deepEqual(anon, { actorKey: "v:visitor-xxxxxxxxxxxxxxxx", sessionKey: "s:session-yyyyyyyyyyyyyyyy" });
  const cust = analyticsContext({ headers, user: { role: "CUSTOMER", id: "U1", rawId: "U1" } })!;
  assert.ok(cust.actorKey.startsWith("u:") && cust.sessionKey === "s:session-yyyyyyyyyyyyyyyy");
  assert.equal(analyticsContext({ headers: {} }), null, "no browser id and no user → nothing to attribute");
  assert.ok(analyticsContext({ headers: {}, user: { role: "CUSTOMER", id: "U1" } })!.sessionKey.startsWith("d:"), "no session header → per-day journey");
});

// ── 2. recorder ─────────────────────────────────────────────────────────
function recorderWith(table: ReturnType<typeof makeTable> | undefined, cart: Row[] = [], now = () => NOW, logs: string[] = []) {
  const db: any = {
    analyticsEvent: table,
    carts: { findFirst: async ({ where }: Row) => (where.userId === "U_B" ? { cart_items: cart } : null) },
    cart_items: { findUnique: async ({ where }: Row) => cart.find((c) => c.id === where.id) ?? null },
    product: { findUnique: async () => null },
  };
  return createAnalyticsRecorder(db, { now, log: (m) => logs.push(m) });
}
const CART = [
  { id: "CI1", productId: "P_A1", variantId: "VR1", quantity: 2, products: { vendorId: "VA" } },
  { id: "CI2", productId: "P_B1", variantId: "VR2", quantity: 1, products: { vendorId: "VB" } },
];

test("recorder: views dedup per session·product·30 min; checkout start reads the SERVER cart and dedups; orders are idempotent per line", async () => {
  const t = makeTable();
  let clock = NOW;
  const rec = recorderWith(t, CART, () => clock);
  assert.equal(await rec.productViews(ctxA, [{ id: "P_A1", vendorId: "VA" }]), 1);
  assert.equal(await rec.productViews(ctxA, [{ id: "P_A1", vendorId: "VA" }]), 0, "re-render / Strict Mode double effect");
  assert.equal(await rec.productViews(ctxB, [{ id: "P_A1", vendorId: "VA" }]), 1, "another session counts");
  clock = new Date(NOW.getTime() + 31 * 60_000);
  assert.equal(await rec.productViews(ctxA, [{ id: "P_A1", vendorId: "VA", source: "EVIL" }]), 1, "a later visit counts again");
  assert.equal(t.rows.at(-1)!.source, "PRODUCT_PAGE", "unknown sources are not stored");

  clock = NOW;
  assert.equal(await rec.checkoutStarted(ctxB, "U_B"), 2, "one row per selected line");
  assert.equal(await rec.checkoutStarted(ctxB, "U_B"), 0, "the same checkout within 30 minutes counts once");
  const starts = t.rows.filter((r) => r.type === "CHECKOUT_STARTED");
  assert.deepEqual(starts.map((r) => [r.productId, r.vendorId]).sort(), [["P_A1", "VA"], ["P_B1", "VB"]], "vendor from the cart's product, per line");
  assert.equal(new Set(starts.map((r) => r.groupKey)).size, 1);
  assert.equal(await rec.checkoutStarted(ctxB, "U_NO_CART"), 0);

  assert.equal(await rec.checkoutFailed(ctxB, "U_B", "SHIPPING_UNAVAILABLE", ["VB"]), 1, "attributed to the failing vendor only");
  assert.equal(t.rows.find((r) => r.type === "CHECKOUT_FAILED")!.vendorId, "VB");

  const order = { id: "O1", vendorOrders: [{ vendor: { id: "VA" }, items: [{ id: "OI1", quantity: 2, price: "499.50", variant: { id: "VR1", product: { id: "P_A1", vendorId: "VA" } } }] }] };
  assert.equal(await rec.orderPlaced(ctxB, order), 1);
  assert.equal(await rec.orderPlaced(ctxB, order), 0, "a retried request can't double-count the order");
  const placed = t.rows.find((r) => r.type === "ORDER_PLACED")!;
  assert.deepEqual([placed.orderId, placed.quantity, placed.valueMinor, placed.vendorId], ["O1", 2, 99900, "VA"]);
  for (const r of t.rows) {
    for (const k of Object.keys(r)) assert.ok(["id", "createdAt", "type", "occurredAt", "day", "vendorId", "productId", "variantId", "sessionKey", "actorKey", "groupKey", "orderId", "quantity", "valueMinor", "source", "reason", "dedupKey"].includes(k), `unexpected field ${k}`);
  }
});

test("recorder: never throws — missing table (migration not applied) or a failing write are silent no-ops", async () => {
  const none = recorderWith(undefined, CART);
  assert.equal(await none.productViews(ctxA, [{ id: "P", vendorId: "V" }]), 0);
  assert.equal(await none.orderPlaced(ctxA, { id: "O", vendorOrders: [] }), 0);
  const logs: string[] = [];
  const failing = recorderWith(makeTable({ failWrites: true }), CART, () => NOW, logs);
  assert.equal(await failing.checkoutStarted(ctxB, "U_B"), 0);
  assert.deepEqual(logs, ["[analytics] write skipped: P1001"], "only the error code is logged");
});

// ── 3. queries ──────────────────────────────────────────────────────────
function seed() {
  const t = makeTable();
  const at = (iso: string) => new Date(iso);
  const add = (r: Row) => t.rows.push({ id: `E${t.rows.length}`, createdAt: new Date(), variantId: null, groupKey: null, orderId: null, quantity: null, valueMinor: null, source: null, reason: null, dedupKey: `k${t.rows.length}`, ...r, day: C.dhakaDay(r.occurredAt) });
  // vendor A: journey 1 — view → cart → checkout → order (paid)
  add({ type: "PRODUCT_VIEW", occurredAt: at("2026-10-19T04:00:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:j1", actorKey: "u:c1" });
  add({ type: "ADD_TO_CART", occurredAt: at("2026-10-19T04:02:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:j1", actorKey: "u:c1", quantity: 1, source: "PRODUCT_PAGE" });
  add({ type: "CHECKOUT_STARTED", occurredAt: at("2026-10-19T04:05:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:j1", actorKey: "u:c1", groupKey: "co:1" });
  add({ type: "ORDER_PLACED", occurredAt: at("2026-10-19T04:07:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:j1", actorKey: "u:c1", orderId: "O_PAID", quantity: 1, valueMinor: 50000, groupKey: "order:O_PAID" });
  // journey 2 — Buy Now → checkout → abandoned (> 24 h ago)
  add({ type: "PRODUCT_VIEW", occurredAt: at("2026-10-18T10:00:00Z"), vendorId: "VA", productId: "P_A2", sessionKey: "s:j2", actorKey: "u:c2" });
  add({ type: "ADD_TO_CART", occurredAt: at("2026-10-18T10:01:00Z"), vendorId: "VA", productId: "P_A2", sessionKey: "s:j2", actorKey: "u:c2", source: "BUY_NOW" });
  add({ type: "CHECKOUT_STARTED", occurredAt: at("2026-10-18T10:03:00Z"), vendorId: "VA", productId: "P_A2", sessionKey: "s:j2", actorKey: "u:c2", groupKey: "co:2" });
  // journey 3 — checkout failed (shipping), recent
  add({ type: "CHECKOUT_STARTED", occurredAt: at("2026-10-21T05:00:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:j3", actorKey: "u:c3", groupKey: "co:3" });
  add({ type: "CHECKOUT_FAILED", occurredAt: at("2026-10-21T05:01:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:j3", actorKey: "u:c3", groupKey: "cf:3", reason: "SHIPPING_UNAVAILABLE" });
  // journey 4 — just browsing, old
  add({ type: "PRODUCT_VIEW", occurredAt: at("2026-10-10T03:00:00Z"), vendorId: "VA", productId: "P_A2", sessionKey: "s:j4", actorKey: "v:anon" });
  // previous period view for comparison
  add({ type: "PRODUCT_VIEW", occurredAt: at("2026-09-01T03:00:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:old", actorKey: "v:old" });
  // vendor B (must never leak into A), same session as journey 1 (multi-vendor cart)
  add({ type: "PRODUCT_VIEW", occurredAt: at("2026-10-19T04:01:00Z"), vendorId: "VB", productId: "P_B1", sessionKey: "s:j1", actorKey: "u:c1" });
  add({ type: "ADD_TO_CART", occurredAt: at("2026-10-19T04:03:00Z"), vendorId: "VB", productId: "P_B1", sessionKey: "s:j1", actorKey: "u:c1" });
  return t;
}
const PRODUCTS = [
  { id: "P_A1", name: "Cotton Saree", slug: "cotton-saree", vendorId: "VA", images: [{ url: "https://cdn/a1.jpg" }] },
  { id: "P_A2", name: "Leather Wallet", slug: "leather-wallet", vendorId: "VA", images: [] },
  { id: "P_B1", name: "Vendor B Secret Product", slug: "b", vendorId: "VB", images: [] },
];
function advisorWith(t: ReturnType<typeof makeTable> | undefined) {
  const db: any = {
    analyticsEvent: t,
    product: { findMany: async ({ where }: Row) => PRODUCTS.filter((p) => matches(p, where)).map((p) => ({ ...p })) },
    order: { findMany: async ({ where }: Row) => [{ id: "O_PAID", status: "CONFIRMED", paymentStatus: "PAID", paymentmethod: "SSLCOMMERZ" }].filter((o) => where.id.in.includes(o.id)) },
    vendorOrder: {
      count: async ({ where }: Row) => (where.vendorId === "VA" ? (where.status === "CANCELLED" ? 1 : where.order?.paymentStatus === "PAID" ? 3 : where.order?.paymentStatus === "FAILED" ? 1 : where.order?.paymentmethod === "COD" ? 2 : 6) : 99),
      aggregate: async ({ where }: Row) => ({ _sum: { subtotal: where.vendorId === "VA" ? "12345.67" : "999999" } }),
    },
  };
  return createBusinessAdvisorService(db, { now: () => NOW });
}

test("overview: event KPIs, journey funnel with Buy-Now path, daily trend, failures, abandonment, authoritative orders — vendor-scoped", async () => {
  const svc = advisorWith(seed());
  const o: any = await svc.overview({ vendorId: "VA" }, { from: "2026-10-15", to: "2026-10-21" });
  assert.deepEqual(o.range, { from: "2026-10-15", to: "2026-10-21", days: 7, timezone: "Asia/Dhaka" });
  assert.equal(o.kpis.views.value, 2, "B's view in the same session is excluded");
  assert.equal(o.kpis.addToCart.value, 2);
  assert.equal(o.kpis.checkoutStarts.value, 3);
  assert.equal(o.kpis.orders.value, 1);
  assert.equal(o.kpis.orderedValueMinor.value, 50000);
  assert.equal(o.kpis.viewToCart.value, 100);
  assert.equal(o.kpis.checkoutToOrder.value, 33.33);
  assert.equal(o.kpis.views.previous, 1, "journey 4's view (10-10) is in the comparison period 10-08…10-14");
  assert.equal(o.kpis.views.change, 100);
  assert.equal(o.kpis.viewToCart.change, null, "rates report percentage points, not % change");
  const [views, cart, checkout, order] = o.funnel.stages;
  assert.deepEqual([views.journeys, cart.journeys, checkout.journeys, order.journeys], [2, 2, 3, 1]);
  assert.equal(o.funnel.basis, "journeys");
  assert.deepEqual(o.funnel.paths.buyNow.stages.map((s: any) => s.journeys), [1, 1, 0], "Buy Now journey j2: cart, checkout, no order");
  assert.equal(o.series.length, 7);
  assert.deepEqual(o.series.find((d: any) => d.day === "2026-10-19"), { day: "2026-10-19", views: 1, addToCart: 1, checkoutStarts: 1, orders: 1 });
  assert.deepEqual(o.failureReasons, [{ reason: "SHIPPING_UNAVAILABLE", attempts: 1 }]);
  assert.equal(o.abandonment.customersStarted, 3);
  assert.equal(o.abandonment.converted, 1);
  assert.equal(o.abandonment.abandoned, 1, "c2's checkout is > 24 h old with no order");
  assert.equal(o.abandonment.inProgress, 1, "c3 started an hour ago");
  assert.equal(o.orders.current.revenueMinor, 1234567);
  assert.equal(o.trackingStartedAt, "2026-09-01T03:00:00.000Z");
  assert.ok(o.definitions.funnel.includes("Journey-based"));
  assert.ok(Array.isArray(o.insights));
});

test("overview: comparison period, product filter, empty data and the platform scope", async () => {
  const svc = advisorWith(seed());
  const sept: any = await svc.overview({ vendorId: "VA" }, { from: "2026-09-01", to: "2026-09-07" });
  assert.equal(sept.kpis.views.value, 1);
  const prod: any = await svc.overview({ vendorId: "VA" }, { from: "2026-10-15", to: "2026-10-21", productId: "P_A2" });
  assert.equal(prod.kpis.views.value, 1);
  assert.equal(prod.orders, null, "order totals aren't product-filtered — omitted rather than misattributed");
  const foreignProduct: any = await svc.overview({ vendorId: "VA" }, { from: "2026-10-15", to: "2026-10-21", productId: "P_B1" });
  assert.equal(foreignProduct.kpis.views.value, 0, "another vendor's product id yields nothing");
  const empty: any = await advisorWith(makeTable()).overview({ vendorId: "VA" }, {});
  assert.equal(empty.kpis.views.value, 0);
  assert.equal(empty.kpis.viewToCart.value, null, "no rate without a denominator");
  assert.equal(empty.trackingStartedAt, null);
  assert.deepEqual(empty.insights, [], "no insight without enough data");
  const platform: any = await svc.overview({ vendorId: null }, { from: "2026-10-15", to: "2026-10-21" });
  assert.equal(platform.kpis.views.value, 3, "platform scope includes every vendor");
  await assert.rejects(advisorWith(undefined).overview({ vendorId: "VA" }, {}), { code: "ANALYTICS_NOT_READY" });
  await assert.rejects(svc.overview({ vendorId: "VA" }, { from: "2026-12-01", to: "2026-01-01" }), InvalidRangeError);
});

test("products: own products only, sorted, searchable, paginated, with previous-period trend", async () => {
  const svc = advisorWith(seed());
  const res: any = await svc.products({ vendorId: "VA" }, { from: "2026-10-15", to: "2026-10-21", sort: "orders" });
  assert.deepEqual(res.items.map((i: any) => i.productId), ["P_A1", "P_A2"]);
  const a1 = res.items[0];
  assert.deepEqual([a1.name, a1.views, a1.addToCart, a1.checkoutStarts, a1.orders, a1.orderedValueMinor, a1.conversion, a1.thumbnail], ["Cotton Saree", 1, 1, 2, 1, 50000, 100, "https://cdn/a1.jpg"]);
  assert.ok(!JSON.stringify(res).includes("Vendor B"), "never another vendor's product");
  assert.deepEqual((await svc.products({ vendorId: "VA" }, { q: "wallet", from: "2026-10-15", to: "2026-10-21" }) as any).items.map((i: any) => i.productId), ["P_A2"]);
  const paged: any = await svc.products({ vendorId: "VA" }, { from: "2026-10-15", to: "2026-10-21", pageSize: 1, page: 2, sort: "views" });
  assert.deepEqual([paged.total, paged.totalPages, paged.items.length], [2, 2, 1]);
  const bad: any = await svc.products({ vendorId: "VA" }, { from: "2026-10-15", to: "2026-10-21", sort: "DROP TABLE", pageSize: 9999 });
  assert.equal(bad.sort, "views");
  assert.equal(bad.pageSize, 50);
});

test("journeys: outcomes from recorded events + the order's real payment status; vendor-only steps; no identity", async () => {
  const svc = advisorWith(seed());
  const res: any = await svc.journeys({ vendorId: "VA" }, { from: "2026-10-01", to: "2026-10-21" });
  const byFirstProduct = (outcome: string) => res.items.find((j: any) => j.outcome === outcome);
  assert.deepEqual(res.items.map((j: any) => j.outcome).sort(), ["ABANDONED_CHECKOUT", "BROWSED", "CHECKOUT_FAILED", "ORDERED_PAID"].sort());
  const paid = byFirstProduct("ORDERED_PAID");
  assert.deepEqual(paid.steps.map((s: any) => s.type), ["PRODUCT_VIEW", "ADD_TO_CART", "CHECKOUT_STARTED", "ORDER_PLACED"], "vendor B's steps in the same session are excluded");
  assert.equal(paid.steps[1].secondsSincePrevious, 120);
  assert.equal(paid.path, "CART");
  assert.equal(byFirstProduct("ABANDONED_CHECKOUT").path, "BUY_NOW");
  assert.equal(res.items[0].outcome, "CHECKOUT_FAILED", "most recent first; its last recorded step is the failure");
  assert.equal(res.items[0].steps.at(-1).reason, "SHIPPING_UNAVAILABLE");
  const text = JSON.stringify(res);
  for (const secret of ["u:c1", "s:j1", "actorKey", "sessionKey"]) assert.ok(!text.includes(secret), `no ${secret} in the response`);
  assert.ok(res.items.every((j: any) => /^J-[0-9A-F]{8}$/.test(j.id)));
  assert.match(res.replayNotice, /not a recording/);
  const other: any = await svc.journeys({ vendorId: "VB" }, { from: "2026-10-01", to: "2026-10-21" });
  assert.deepEqual(other.items.flatMap((j: any) => j.steps.map((s: any) => s.productId)), ["P_B1", "P_B1"], "vendor B sees only its own steps");
});

// ── 4. routes: ingestion + authorization ────────────────────────────────
const USERS: Record<string, Row> = {
  U_CUST: { id: "U_CUST", role: "CUSTOMER", isActive: true, vendorId: null, name: "C", email: null },
  U_VA: { id: "U_VA", role: "VENDOR", isActive: true, vendorId: "VA", name: "A", email: null },
  U_VSTAFF: { id: "U_VSTAFF", role: "EMPLOYEE", isActive: true, vendorId: null, name: "Staff", email: null },
  U_VSTAFF_NOPERM: { id: "U_VSTAFF_NOPERM", role: "EMPLOYEE", isActive: true, vendorId: null, name: "Staff2", email: null },
  U_ADMIN: { id: "U_ADMIN", role: "ADMIN", isActive: true, vendorId: null, name: "Admin", email: null },
};
const EMPLOYEES: Record<string, Row> = {
  E_VSTAFF: { id: "E_VSTAFF", userId: "U_VSTAFF", vendorId: "VA", isActive: true, permissions: { analytics: true } },
  E_VSTAFF_NOPERM: { id: "E_VSTAFF_NOPERM", userId: "U_VSTAFF_NOPERM", vendorId: "VA", isActive: true, permissions: {} },
  E_ADMIN: { id: "E_ADMIN", userId: "U_ADMIN", vendorId: null, isActive: true, permissions: {} },
};
const restores: (() => void)[] = [];
const swap = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
let server: http.Server;
let base = "";
const scopes: (string | null)[] = [];
const ingested: Row[] = [];
const publicWheres: Row[] = [];
before(async () => {
  swap(prisma.user, "findUnique", async ({ where }: Row) => (USERS[where.id] ? { ...USERS[where.id] } : null));
  swap(prisma.vendor, "findUnique", async ({ where }: Row) => (where.id === "VA" ? { id: "VA", storeName: "A", email: null } : null));
  swap(prisma.employee, "findFirst", async ({ where }: Row) => Object.values(EMPLOYEES).find((e) => e.userId === where.userId && e.isActive) ?? null);
  swap(prisma.employee, "findUnique", async ({ where }: Row) => EMPLOYEES[where.id] ?? null);
  swap(prisma.employee, "create", async () => EMPLOYEES.E_ADMIN);
  const recorder: any = {
    productViews: async (ctx: Row, products: Row[]) => (ingested.push({ kind: "views", ctx, products }), products.length),
    checkoutStarted: async (ctx: Row, userId: string) => (ingested.push({ kind: "checkout", ctx, userId }), 1),
  };
  const advisor: any = {
    overview: async (scope: Row) => (scopes.push(scope.vendorId), { ok: true }),
    products: async (scope: Row) => (scopes.push(scope.vendorId), { ok: true }),
    journeys: async (scope: Row) => (scopes.push(scope.vendorId), { ok: true }),
  };
  const db: any = {
    product: { findMany: async ({ where }: Row) => (publicWheres.push(where), [{ id: "P_PUBLIC", vendorId: "VA" }].filter((p) => where.id.in.includes(p.id))) },
    vendor: { findUnique: async ({ where }: Row) => (where.id === "VA" ? { id: "VA" } : null) },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/analytics", createAnalyticsRouter({ db, recorder, advisor, ingestLimit: 25 }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/analytics`;
});
after(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  restores.reverse().forEach((r) => r());
});
const tok = (id: string) => jwt.sign({ id, role: USERS[id].role }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
const BROWSER = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0", "x-fm-analytics-visitor": "visitor-1234567890abcdef", "x-fm-analytics-session": "session-1234567890abcdef", "content-type": "application/json" };
async function ingest(body: unknown, headers: Row = {}) {
  const res = await fetch(`${base}/events`, { method: "POST", headers: { ...BROWSER, ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("ingestion: strict body, public products only, bots / staff ignored, checkout start only for signed-in customers", async () => {
  ingested.length = 0;
  for (const bad of [{}, { events: [] }, { events: [{ type: "ORDER_PLACED", productId: "P" }] }, { events: [{ type: "PRODUCT_VIEW", productId: "P_PUBLIC", vendorId: "VB" }] }, { events: [{ type: "PRODUCT_VIEW" }] }]) {
    assert.equal((await ingest(bad)).status, 400, JSON.stringify(bad));
  }
  const ok = await ingest({ events: [{ type: "PRODUCT_VIEW", productId: "P_PUBLIC", source: "QUICK_VIEW" }, { type: "PRODUCT_VIEW", productId: "P_HIDDEN" }] });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.accepted, 1, "a non-public product is silently ignored (same 202)");
  assert.deepEqual(ingested[0].products, [{ id: "P_PUBLIC", vendorId: "VA", source: "QUICK_VIEW" }], "vendor from the database");
  assert.equal(publicWheres[0].approvalStatus ?? publicWheres[0].AND ?? "checked", publicWheres[0].approvalStatus ?? publicWheres[0].AND ?? "checked");
  assert.ok(JSON.stringify(publicWheres[0]).includes("ACTIVE"), "the public-product filter is applied");
  assert.equal((await ingest({ events: [{ type: "PRODUCT_VIEW", productId: "P_PUBLIC" }] }, { "user-agent": "Googlebot/2.1" })).body.accepted, 0);
  assert.equal((await ingest({ events: [{ type: "PRODUCT_VIEW", productId: "P_PUBLIC" }] }, { authorization: `Bearer ${tok("U_VA")}` })).body.accepted, 0, "a vendor viewing products isn't a customer view");
  assert.equal((await ingest({ events: [{ type: "CHECKOUT_STARTED" }] })).body.accepted, 0, "anonymous checkout start ignored");
  const signed = await ingest({ events: [{ type: "CHECKOUT_STARTED" }] }, { authorization: `Bearer ${tok("U_CUST")}` });
  assert.equal(signed.body.accepted, 1);
  assert.equal(ingested.at(-1)!.userId, "U_CUST");
  const expired = jwt.sign({ id: "U_CUST", role: "CUSTOMER" }, SECRET, { algorithm: "HS256", expiresIn: -10 });
  const asAnon = await ingest({ events: [{ type: "CHECKOUT_STARTED" }] }, { authorization: `Bearer ${expired}` });
  assert.equal(asAnon.status, 202, "an expired token is treated as anonymous, not a 401");
  assert.equal(asAnon.body.accepted, 0);
});

test("ingestion is rate-limited per client", async () => {
  let limited = false;
  for (let i = 0; i < 30; i++) if ((await ingest({ events: [{ type: "PRODUCT_VIEW", productId: "P_PUBLIC" }] })).status === 429) limited = true;
  assert.ok(limited);
});

async function get(who: string | null, path: string) {
  const res = await fetch(`${base}/business-advisor${path}`, { headers: who ? { authorization: `Bearer ${tok(who)}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("authorization: vendor scope from the session (query vendorId ignored); staff need the analytics grant; admins may scope; customers refused", async () => {
  scopes.length = 0;
  assert.equal((await get(null, "/overview")).status, 401);
  assert.equal((await get("U_CUST", "/overview")).status, 403);
  assert.equal((await get("U_VSTAFF_NOPERM", "/overview")).status, 403);
  assert.equal((await get("U_VA", "/overview?vendorId=VB")).status, 200);
  assert.equal((await get("U_VSTAFF", "/products?vendorId=VB")).status, 200);
  assert.equal((await get("U_ADMIN", "/journeys")).status, 200);
  assert.equal((await get("U_ADMIN", "/overview?vendorId=VA")).status, 200);
  assert.deepEqual(scopes, ["VA", "VA", null, "VA"]);
  assert.equal((await get("U_ADMIN", "/overview?vendorId=V_UNKNOWN")).status, 404);
  assert.equal((await get("U_ADMIN", "/overview?vendorId=%27%3B--")).status, 400);
});

// ── 5. instrumentation (controllers) ────────────────────────────────────
test("cart / order controllers record only after success, and analytics never changes the response", async () => {
  const { analyticsRecorder } = await import("../src/modules/analytics/analytics.recorder.ts");
  const cartWishService = (await import("../src/services/cartWish.service.ts")).default as any;
  const { CartWishController } = await import("../src/controllers/cartWish.controller.ts");
  const { OrderController } = await import("../src/controllers/order.controller.ts");
  const { OrderService } = await import("../src/services/order.service.ts");
  const calls: Row[] = [];
  swap(analyticsRecorder, "addToCart", async (...a: any[]) => (calls.push({ m: "addToCart", a }), 1));
  swap(analyticsRecorder, "orderPlaced", async (...a: any[]) => (calls.push({ m: "orderPlaced", a }), 1));
  swap(analyticsRecorder, "checkoutFailed", async (...a: any[]) => {
    calls.push({ m: "checkoutFailed", a });
    throw new Error("analytics exploded"); // must not matter
  });
  const res = () => {
    const r: any = { statusCode: 200, body: null };
    r.status = (c: number) => ((r.statusCode = c), r);
    r.json = (b: any) => ((r.body = b), r);
    return r;
  };
  const headers = { "x-fm-analytics-session": "session-1234567890abcdef" };
  const cart = new CartWishController();
  swap(cartWishService, "addToCart", async () => ({ id: "CI9", productId: "P_A1", variantId: "VR1", products: { vendorId: "VA" } }));
  let r = res();
  await cart.addToCart({ user: { id: "U1", rawId: "U1", role: "CUSTOMER" }, headers, body: { productId: "P_A1", variantId: "VR1", quantity: 2, source: "BUY_NOW" } } as any, r, () => {});
  assert.equal(r.statusCode, 201);
  assert.equal(calls[0].m, "addToCart");
  assert.deepEqual(calls[0].a[1], { productId: "P_A1", variantId: "VR1", vendorId: "VA", quantity: 2 }, "vendor from the stored cart line");
  assert.equal(calls[0].a[2], "BUY_NOW");
  calls.length = 0;
  swap(cartWishService, "addToCart", async () => {
    throw new Error("Insufficient stock");
  });
  let nextErr: any = null;
  await cart.addToCart({ user: { id: "U1", role: "CUSTOMER" }, headers, body: { productId: "P", variantId: "V", quantity: 1 } } as any, res(), (e: any) => (nextErr = e));
  assert.ok(nextErr, "the original error handling is unchanged");
  assert.deepEqual(calls, [], "a failed add is not an add-to-cart");

  const orders = new OrderController();
  const order = { id: "O7", vendorOrders: [] };
  swap(OrderService.prototype, "placeOrder", async () => order);
  r = res();
  await orders.placeOrder({ user: { id: "U1", rawId: "U1", role: "CUSTOMER" }, headers, body: { userAddressId: "A1", paymentMethod: "COD", quoteHash: "h" } } as any, r);
  assert.equal(r.statusCode, 201);
  assert.equal(r.body.data, order);
  assert.equal(calls.at(-1)!.m, "orderPlaced");
  swap(OrderService.prototype, "placeOrder", async () => {
    throw new Error("No courier available for this delivery route");
  });
  r = res();
  await orders.placeOrder({ user: { id: "U1", rawId: "U1", role: "CUSTOMER" }, headers, body: { userAddressId: "A1", paymentMethod: "COD", quoteHash: "h" } } as any, r);
  await new Promise((x) => setTimeout(x, 10));
  assert.equal(r.statusCode, 400, "same failure response as before, despite the recorder throwing");
  assert.equal(calls.at(-1)!.m, "checkoutFailed");
  assert.equal(calls.at(-1)!.a[2], "SHIPPING_UNAVAILABLE");
  calls.length = 0;
  swap(OrderService.prototype, "placeOrder", async () => order);
  await orders.placeOrder({ user: { id: "V1", rawId: "UV1", role: "VENDOR" }, headers, body: { userAddressId: "A1", paymentMethod: "COD", quoteHash: "h" } } as any, res());
  assert.deepEqual(calls, [], "staff test orders are not recorded");
});

// ── 6. not set up yet + retention ───────────────────────────────────────
test("before the migration: the Business Advisor answers 503 with a safe message (no unhandled rejection); retention is bounded", async () => {
  const { createBusinessAdvisorService } = await import("../src/modules/analytics/business-advisor.service.ts");
  const { purgeExpiredAnalyticsEvents, retentionDays } = await import("../src/modules/analytics/analytics.retention.ts");
  const notReady = createBusinessAdvisorService({ product: {}, vendorOrder: {}, order: {} } as any);
  const app = express();
  app.use("/a", createAnalyticsRouter({ db: { product: {}, vendor: {} } as any, recorder: {} as any, advisor: notReady }));
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    const url = `http://127.0.0.1:${(srv.address() as any).port}/a/business-advisor`;
    for (const p of ["/overview", "/products", "/journeys"]) {
      const res = await fetch(url + p, { headers: { authorization: `Bearer ${tok("U_VA")}` } });
      assert.equal(res.status, 503, p);
      assert.deepEqual(await res.json(), { success: false, code: "ANALYTICS_NOT_READY", error: "Analytics isn't set up yet." });
    }
  } finally {
    await new Promise((r) => srv.close(() => r(undefined)));
  }
  assert.equal(retentionDays("7"), 180, "below the minimum → default");
  assert.equal(retentionDays("365"), 365);
  assert.equal(retentionDays("abc"), 180);
  const t = makeTable();
  const deleted: Row[] = [];
  const db = { analyticsEvent: { deleteMany: async ({ where }: Row) => (deleted.push(where), { count: 3 }) } };
  assert.equal(await purgeExpiredAnalyticsEvents(db, NOW, 180), 3);
  assert.equal(deleted[0].occurredAt.lt.toISOString(), new Date(NOW.getTime() - 180 * 86_400_000).toISOString());
  assert.equal(await purgeExpiredAnalyticsEvents({}, NOW), 0, "no table → no-op");
  void t;
});

// ── 7. Phase 2 audit regressions ────────────────────────────────────────
function journeyTable(build: (add: (r: Row) => void) => void) {
  const t = makeTable();
  const add = (r: Row) => t.rows.push({ id: `E${t.rows.length}`, createdAt: new Date(), variantId: null, groupKey: null, orderId: null, quantity: null, valueMinor: null, source: null, reason: null, dedupKey: `k${t.rows.length}`, ...r, day: C.dhakaDay(r.occurredAt) });
  build(add);
  return t;
}

test("audit B1: a heavy journey can't starve the others — each journey keeps its latest steps (incl. the order)", async () => {
  const t = journeyTable((add) => {
    // an older browsing-heavy journey with 1,300 views
    for (let i = 0; i < 1300; i++) add({ type: "PRODUCT_VIEW", occurredAt: new Date(Date.parse("2026-10-18T00:00:00Z") + i * 1000), vendorId: "VA", productId: "P_A1", sessionKey: "s:heavy", actorKey: "v:heavy" });
    // a newer journey that ordered
    add({ type: "ADD_TO_CART", occurredAt: new Date("2026-10-19T04:02:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:buyer", actorKey: "u:buyer" });
    add({ type: "ORDER_PLACED", occurredAt: new Date("2026-10-19T04:07:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:buyer", actorKey: "u:buyer", orderId: "O_PAID", quantity: 1 });
  });
  const res: any = await advisorWith(t).journeys({ vendorId: "VA" }, { from: "2026-10-15", to: "2026-10-21" });
  const buyer = res.items[0];
  assert.deepEqual(buyer.steps.map((s: any) => s.type), ["ADD_TO_CART", "ORDER_PLACED"], "the most recent journey keeps its steps");
  assert.equal(buyer.outcome, "ORDERED_PAID");
  const heavy = res.items[1];
  assert.equal(heavy.steps.length, 60, "per-journey cap");
  assert.equal(heavy.stepsTruncated, true, "and it says so");
  assert.equal(heavy.steps.at(-1).at, new Date(Date.parse("2026-10-18T00:00:00Z") + 1299 * 1000).toISOString(), "the LATEST steps are kept");
});

test("audit B2: abandonment uses each customer's latest checkout INSIDE the range, even if they checked out again the day after", async () => {
  const t = journeyTable((add) => {
    add({ type: "CHECKOUT_STARTED", occurredAt: new Date("2026-10-10T05:00:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:x1", actorKey: "u:x", groupKey: "co:x1" });
    add({ type: "CHECKOUT_STARTED", occurredAt: new Date("2026-10-15T05:00:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:x2", actorKey: "u:x", groupKey: "co:x2" }); // day after the range
  });
  const o: any = await advisorWith(t).overview({ vendorId: "VA" }, { from: "2026-10-08", to: "2026-10-14" });
  assert.equal(o.abandonment.customersStarted, 1, "the customer who started checkout in the range is counted");
  assert.equal(o.abandonment.abandoned, 1);
});

test("audit B3: refunded / returned orders are not shown as 'payment pending'", async () => {
  const t = journeyTable((add) => {
    add({ type: "ORDER_PLACED", occurredAt: new Date("2026-10-19T04:07:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:r", actorKey: "u:r", orderId: "O_REFUNDED", quantity: 1 });
  });
  const db: any = {
    analyticsEvent: t,
    product: { findMany: async ({ where }: Row) => PRODUCTS.filter((p) => matches(p, where)) },
    order: { findMany: async () => [{ id: "O_REFUNDED", status: "REFUNDED", paymentStatus: "REFUNDED", paymentmethod: "SSLCOMMERZ" }] },
    vendorOrder: { count: async () => 0, aggregate: async () => ({ _sum: { subtotal: 0 } }) },
  };
  const res: any = await createBusinessAdvisorService(db, { now: () => NOW }).journeys({ vendorId: "VA" }, { from: "2026-10-15", to: "2026-10-21" });
  assert.equal(res.items[0].outcome, "ORDER_REFUNDED");
});

test("audit B1 (follow-up): a truncated journey's start, duration, outcome and path still reflect ALL its steps", async () => {
  const t = journeyTable((add) => {
    // cart add via Buy Now first, then 100 views; old enough to be past the abandonment window
    add({ type: "ADD_TO_CART", occurredAt: new Date("2026-10-17T00:00:00Z"), vendorId: "VA", productId: "P_A1", sessionKey: "s:long", actorKey: "u:long", source: "BUY_NOW" });
    for (let i = 1; i <= 100; i++) add({ type: "PRODUCT_VIEW", occurredAt: new Date(Date.parse("2026-10-17T00:00:00Z") + i * 60_000), vendorId: "VA", productId: "P_A2", sessionKey: "s:long", actorKey: "u:long" });
  });
  const res: any = await advisorWith(t).journeys({ vendorId: "VA" }, { from: "2026-10-15", to: "2026-10-21" });
  const j = res.items[0];
  assert.equal(j.stepsTruncated, true);
  assert.equal(j.steps.length, 60);
  assert.equal(j.startedAt, "2026-10-17T00:00:00.000Z", "the journey's real start, not the first displayed step");
  assert.equal(j.durationSeconds, 100 * 60);
  assert.equal(j.outcome, "ABANDONED_CART", "the add-to-cart outside the displayed window still counts");
  assert.equal(j.path, "BUY_NOW");
});
