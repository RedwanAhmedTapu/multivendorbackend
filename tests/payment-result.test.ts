// tests/payment-result.test.ts
//
// GET /api/payment/result/:transactionId — the customer's payment result
// screen after a gateway redirect.
//   - state comes ONLY from persisted payment + order state (never the redirect);
//   - only the order's own customer gets an answer: unknown, malformed and
//     other customers' transactions are all 404 (indistinguishable);
//   - SSLCommerz (own table), EPS (meta.merchantTransactionId) and PayStation
//     (meta.invoiceNumber) transactions are found; no gateway is ever called;
//   - the response carries only what the screen needs (no PII, no raw meta).
// DB-free (the payment service's Prisma client is stubbed); run with
// ACCESS_TOKEN_SECRET set for the route check:
//   npx tsx --test tests/payment-result.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";

process.env.SSLCOMMERZ_STORE_ID ??= "test-store";
process.env.SSLCOMMERZ_STORE_PASSWORD ??= "test-store-secret";
const axios = (await import("axios")).default;
const { paymentService, paymentServiceDb, paymentResultState } = await import("../src/services/payment.service.ts");
const { PaymentController } = await import("../src/controllers/payment.controller.ts");
const paymentRoutes = (await import("../src/routes/payment.routes.ts")).default;
const { fakeRes, run, routeHandles, requestFor, stubAuth } = await import("./support/phase1-auth.ts");

type Row = Record<string, any>;

function stubber() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  return { set, restore: () => restores.reverse().forEach((r) => r()) };
}

const payment = (over: Row = {}, order: Row = {}) => ({
  id: "PAY1", method: "SSLCOMMERZ", status: "PAID", amount: new Decimal("1560"), paidAt: new Date("2026-10-18T10:00:00Z"),
  meta: { type: "order_payment" },
  order: { id: "O1", orderNumber: "ORD-1", status: "CONFIRMED", paymentStatus: "PAID", userId: "U_OWNER", ...order },
  ...over,
});

/** In-memory lookups: SSLCommerz table by tranId, EPS/PayStation by meta. */
function stubDb(rows: { ssl?: Record<string, { status: string; payment: Row }>; meta?: Row[] }) {
  const s = stubber();
  const calls: string[] = [];
  s.set(paymentServiceDb.sSLCommerzTransaction, "findUnique", async ({ where }: Row) => (calls.push(`ssl:${where.tranId}`), rows.ssl?.[where.tranId] ?? null));
  s.set(paymentServiceDb.payment, "findFirst", async ({ where }: Row) => {
    calls.push("meta");
    return (rows.meta ?? []).find((p) => where.OR.some((c: Row) => p.meta?.[c.meta.path[0]] === c.meta.equals)) ?? null;
  });
  s.set(axios, "get", async () => assert.fail("no gateway call"));
  s.set(axios, "post", async () => assert.fail("no gateway call"));
  return { calls, restore: s.restore };
}

// ── the one state mapping ───────────────────────────────────────────────────

test("paymentResultState: persisted payment + order state → screen state", () => {
  const S = (p: Row, o: Row, opts?: Row) => paymentResultState(p as any, { status: "PENDING", paymentStatus: "PENDING", ...o } as any, opts as any);
  assert.equal(S({ status: "PAID" }, { status: "CONFIRMED", paymentStatus: "PAID" }), "CONFIRMED");
  assert.equal(S({ status: "PAID" }, { status: "PACKAGING", paymentStatus: "PAID" }), "CONFIRMED");
  assert.equal(S({ status: "PAID", meta: { stockHold: { reason: "x" } } }, { status: "PENDING", paymentStatus: "PAID" }), "HELD", "H1 stock hold");
  assert.equal(S({ status: "PAID" }, { status: "PENDING", paymentStatus: "PENDING" }), "HELD", "paid but order not updated — never shown as confirmed");
  assert.equal(S({ status: "PENDING" }, {}), "PENDING");
  assert.equal(S({ status: "PENDING" }, { status: "CANCELLED" }), "ORDER_CANCELLED");
  assert.equal(S({ status: "PAID" }, { status: "CANCELLED", paymentStatus: "PAID" }), "ORDER_CANCELLED");
  assert.equal(S({ status: "FAILED" }, {}), "FAILED");
  assert.equal(S({ status: "FAILED", meta: { cancelReason: "cancelled_by_customer" } }, {}), "CANCELLED");
  assert.equal(S({ status: "FAILED", meta: { epsOutcome: "CANCELLED" } }, {}), "CANCELLED");
  assert.equal(S({ status: "FAILED", meta: { paystationOutcome: "CANCELLED" } }, {}), "CANCELLED");
  assert.equal(S({ status: "FAILED" }, {}, { gatewayCancelled: true }), "CANCELLED");
  assert.equal(S({ status: "REFUNDED" }, { status: "REFUNDED" }), "REFUNDED");
  assert.equal(S({ status: "PAID", meta: { type: "delivery_fee" } }, { status: "CONFIRMED", paymentStatus: "PENDING" }), "CONFIRMED", "a paid delivery fee");
});

// ── service: ownership, gateways, minimal fields ───────────────────────────

test("the owner gets the persisted result — only the fields the screen needs", async () => {
  const env = stubDb({ ssl: { TXN_1_O1: { status: "SUCCESS", payment: payment() } } });
  try {
    const r: any = await paymentService.getCustomerPaymentResult("TXN_1_O1", "U_OWNER");
    assert.deepEqual(r, {
      transactionId: "TXN_1_O1", state: "CONFIRMED", purpose: "order_payment", holdReason: null, unappliedReason: null, gatewayReport: null,
      amount: "1560", method: "SSLCOMMERZ", paidAt: new Date("2026-10-18T10:00:00Z"),
      order: { id: "O1", orderNumber: "ORD-1", status: "CONFIRMED" },
    });
    assert.ok(!JSON.stringify(r).includes("U_OWNER"), "no user id");
  } finally {
    env.restore();
  }
});

test("another customer's, an unknown and a malformed transaction are all null (404) — malformed ids are not even looked up", async () => {
  const env = stubDb({ ssl: { TXN_1_O1: { status: "SUCCESS", payment: payment() } } });
  try {
    assert.equal(await paymentService.getCustomerPaymentResult("TXN_1_O1", "U_ATTACKER"), null);
    assert.equal(await paymentService.getCustomerPaymentResult("TXN_UNKNOWN", "U_OWNER"), null);
    const before = env.calls.length;
    for (const bad of ["", "x".repeat(121), "TXN_1'; DROP", "../etc", "TXN 1"]) assert.equal(await paymentService.getCustomerPaymentResult(bad, "U_OWNER"), null, bad);
    assert.equal(env.calls.length, before, "no lookup for malformed ids");
    assert.equal(await paymentService.getCustomerPaymentResult("TXN_1_O1", ""), null, "no user");
  } finally {
    env.restore();
  }
});

test("EPS and PayStation transactions are found by their own ids; held and cancelled states carry no internals", async () => {
  const eps = payment({ id: "PE", method: "EPS", status: "PAID", meta: { merchantTransactionId: "EPS123", stockHold: { reason: "STOCK_RESERVATION_RELEASED" }, epsRaw: { secret: "x" } } }, { status: "PENDING", paymentStatus: "PAID" });
  const ps = payment({ id: "PP", method: "SSLCOMMERZ", status: "FAILED", meta: { invoiceNumber: "INV9", paystationOutcome: "CANCELLED", paystationRaw: { x: 1 } } }, { status: "PENDING", paymentStatus: "PENDING" });
  const env = stubDb({ meta: [eps, ps] });
  try {
    const a: any = await paymentService.getCustomerPaymentResult("EPS123", "U_OWNER");
    assert.deepEqual([a.state, a.holdReason], ["HELD", "STOCK"]);
    const b: any = await paymentService.getCustomerPaymentResult("INV9", "U_OWNER");
    assert.deepEqual([b.state, b.holdReason], ["CANCELLED", null]);
    assert.ok(!JSON.stringify([a, b]).includes("Raw") && !JSON.stringify([a, b]).includes("secret"), "no raw gateway payloads");
  } finally {
    env.restore();
  }
});

test("SSLCommerz: a cancelled transaction (its own table says CANCELLED) reads as cancelled", async () => {
  const env = stubDb({ ssl: { TXN_2_O1: { status: "CANCELLED", payment: payment({ status: "FAILED", meta: { type: "order_payment" } }, { status: "PENDING", paymentStatus: "PENDING" }) } } });
  try {
    assert.equal(((await paymentService.getCustomerPaymentResult("TXN_2_O1", "U_OWNER")) as any).state, "CANCELLED");
  } finally {
    env.restore();
  }
});

// ── controller + route ──────────────────────────────────────────────────────

test("controller: owner 200 (no-store), anyone else 404 with a neutral message, no user 401, internal error 500 without details", async () => {
  const env = stubDb({ ssl: { TXN_1_O1: { status: "SUCCESS", payment: payment() } } });
  try {
    const call = async (user: Row | undefined, id = "TXN_1_O1") => {
      const res: any = fakeRes();
      const headers: Record<string, string> = {};
      res.setHeader = (k: string, v: string) => ((headers[k] = v), res);
      await PaymentController.getPaymentResult({ user, params: { transactionId: id } } as any, res);
      return { res, headers };
    };
    const owner = await call({ rawId: "U_OWNER", role: "CUSTOMER" });
    assert.deepEqual([owner.res.statusCode, owner.res.body.data.state, owner.headers["Cache-Control"]], [200, "CONFIRMED", "no-store"]);
    const other = await call({ rawId: "U_ATTACKER", role: "CUSTOMER" });
    assert.deepEqual([other.res.statusCode, other.res.body], [404, { success: false, message: "Payment not found" }]);
    assert.equal((await call({ rawId: "U_OWNER" }, "TXN_UNKNOWN")).res.statusCode, 404, "unknown looks the same");
    assert.equal((await call(undefined)).res.statusCode, 401);
  } finally {
    env.restore();
  }
  const boom = stubber();
  boom.set(paymentServiceDb.sSLCommerzTransaction, "findUnique", async () => {
    throw new Error("connection refused at 10.0.0.5");
  });
  try {
    const res: any = fakeRes();
    res.setHeader = () => res;
    await PaymentController.getPaymentResult({ user: { rawId: "U_OWNER" }, params: { transactionId: "TXN_1_O1" } } as any, res);
    assert.deepEqual([res.statusCode, res.body.message], [500, "Could not load the payment result"], "no internal details leaked");
  } finally {
    boom.restore();
  }
});

test("route: GET /result/:transactionId is mounted behind authenticateUser (anonymous → 401)", async () => {
  const restore = stubAuth();
  try {
    const stack = (paymentRoutes as any).stack as any[];
    const routeIndex = stack.findIndex((l) => l.route?.path === "/result/:transactionId" && l.route.methods.get);
    const authIndex = stack.findIndex((l) => !l.route && l.handle?.name === "authenticateUser");
    assert.ok(routeIndex > 0 && authIndex >= 0 && authIndex < routeIndex, "authenticated route");
    const req = requestFor("ANONYMOUS", { params: { transactionId: "TXN_1_O1" } });
    const res: any = fakeRes();
    for (const l of stack.slice(0, routeIndex).filter((x) => !x.route)) if ((await run(l.handle, req, res)) === "ended") break;
    assert.equal(res.statusCode, 401);
    assert.equal(routeHandles(paymentRoutes, "get", "/result/:transactionId").length, 1, "only the controller after the router guard");
  } finally {
    restore();
  }
});
