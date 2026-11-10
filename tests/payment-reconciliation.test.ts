// tests/payment-reconciliation.test.ts
//
// Phase 5 / Step 2: a verified payment is never silently discarded.
//   - classification under the order lock: the payment itself already applied
//     or recorded (duplicate callback) → converge; another payment already paid
//     the order / the order cancelled / moved on → RECORD it
//     (meta.reconciliation + one audit row), never apply it;
//   - recorded money: no Event 0a, the order, its sub-orders and the payment's
//     status untouched (refund flows read PAID rows as the order's payment);
//     repeated callbacks record nothing twice;
//   - SSLCommerz, EPS and PayStation alike; EPS/PayStation no longer overwrite
//     a cancelled or shipped order's status;
//   - a verified success on a row marked FAILED is applied when the order still
//     awaits payment;
//   - fail/cancel handlers never downgrade recorded money;
//   - the payment result says UNAPPLIED; admins can list these payments;
//   - /payment/init and Pay Now share one duplicate-session window.
// DB-free; no gateway is called (validation/status checks are stubbed):
//   npx tsx --test tests/payment-reconciliation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

const { paymentService, paymentServiceDb, paymentResultState } = await import("../src/services/payment.service.ts");
const { paymentGatewayService, paymentGatewayDb } = await import("../src/services/payment-gateway.service.ts");
const { OrderService } = await import("../src/services/order.service.ts");
const { AccountingService } = await import("../src/services/accounting.services.ts");
const { epsService } = await import("../src/services/eps.service.ts");
const { paystationService } = await import("../src/services/paystation.service.ts");
const { prisma: sharedDb } = await import("../src/config/prisma.ts");
const { classifyVerifiedPayment, PAYMENT_UNAPPLIED_AUDIT } = await import("../src/services/payment-reconciliation.ts");
const { openOrderGatewaySession, payNowDeps, PayNowError } = await import("../src/services/pay-now.service.ts");
const { AdminOrderService } = await import("../src/services/admin.order.service.ts");
const { AdminOrderController } = await import("../src/controllers/admin.order.controller.ts");

type Row = Record<string, any>;
const VALID = (tran: string, amount = "1500.00") => ({ status: "VALID", tran_id: tran, val_id: `VAL_${tran}`, amount, currency: "BDT", currency_type: "BDT", currency_amount: amount, bank_tran_id: `BANK_${tran}` });

/** One order with two payment sessions A (PAY_A / T_A) and B (PAY_B / T_B). */
function world(over: { order?: Row; a?: Row; b?: Row } = {}) {
  return {
    order: { id: "O1", userId: "U1", status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", totalAmount: 1500, reservationReleasedAt: null, ...over.order } as Row,
    vendorOrders: [{ id: "VO1", orderId: "O1", status: "PENDING", items: [{ id: "OI1", allocations: [{ id: "AL1" }] }] }] as Row[],
    payments: {
      PAY_A: { id: "PAY_A", orderId: "O1", status: "PENDING", amount: 1500, method: "SSLCOMMERZ", meta: { type: "order_payment" }, paymentProviderId: null, ...over.a },
      PAY_B: { id: "PAY_B", orderId: "O1", status: "PENDING", amount: 1500, method: "SSLCOMMERZ", meta: { type: "order_payment" }, paymentProviderId: null, ...over.b },
    } as Record<string, Row>,
    txns: { T_A: { tranId: "T_A", paymentId: "PAY_A", status: "PENDING" }, T_B: { tranId: "T_B", paymentId: "PAY_B", status: "PENDING" } } as Record<string, Row>,
    events: [] as string[],
    audits: [] as string[],
    released: [] as string[],
  };
}
type World = ReturnType<typeof world>;
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => row[k] === v);

function install(w: World) {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const snapshot = () => JSON.stringify({ order: w.order, vendorOrders: w.vendorOrders, payments: w.payments, txns: w.txns, audits: w.audits });
  for (const db of [paymentServiceDb, paymentGatewayDb, sharedDb] as any[]) {
    for (const model of ["warehouseStock", "productVariant", "stockMovement", "orderItemAllocation"]) {
      for (const m of ["update", "updateMany", "create", "upsert", "delete", "deleteMany"]) set(db[model], m, async () => assert.fail(`unexpected ${model}.${m}`));
    }
    set(db.order, "update", async () => assert.fail("unguarded order.update"));
    set(db.order, "updateMany", async ({ where, data }: Row) => (matches(w.order, where) ? (Object.assign(w.order, data), { count: 1 }) : { count: 0 }));
    set(db.order, "findUnique", async (a: Row = {}) => ({
      ...w.order,
      vendorOrders: w.vendorOrders.filter((v) => a.select?.vendorOrders?.where?.status?.not === undefined || v.status !== "CANCELLED").map((v) => ({ items: v.items })),
    }));
    set(db, "$executeRaw", async () => 1);
    set(db.auditLog, "create", async ({ data }: Row) => (w.audits.push(data.action), data));
    set(db.notification, "create", async ({ data }: Row) => data);
    set(db.vendorOrder, "updateMany", async ({ where, data }: Row) => {
      const rows = w.vendorOrders.filter((v) => matches(v, where));
      rows.forEach((v) => Object.assign(v, data));
      return { count: rows.length };
    });
    set(db.payment, "findUnique", async ({ where }: Row) => (w.payments[where.id] ? { ...w.payments[where.id] } : null));
    set(db.payment, "findUniqueOrThrow", async ({ where }: Row) => ({ ...w.payments[where.id] }));
    set(db.payment, "findMany", async ({ where }: Row) => Object.values(w.payments).filter((p) => p.orderId === where?.orderId).map((p) => ({ ...p })));
    set(db.payment, "update", async ({ where, data }: Row) => (Object.assign(w.payments[where.id], data), { ...w.payments[where.id] }));
    set(db, "$transaction", async (fn: any) => {
      const before = snapshot();
      try {
        return await fn(db);
      } catch (e) {
        Object.assign(w, JSON.parse(before));
        throw e;
      }
    });
  }
  set(paymentServiceDb.sSLCommerzTransaction, "findUnique", async ({ where }: Row) => {
    const t = w.txns[where.tranId];
    if (!t) return null;
    return { ...t, payment: { ...w.payments[t.paymentId], order: { ...w.order, vendorOrders: [] } } };
  });
  set(paymentGatewayDb.sSLCommerzTransaction, "findUnique", async ({ where }: Row) => (w.txns[where.tranId] ? { ...w.txns[where.tranId] } : null));
  set(paymentServiceDb.sSLCommerzTransaction, "update", async ({ where, data }: Row) => (Object.assign(w.txns[where.tranId], data), { ...w.txns[where.tranId] }));
  set(paymentServiceDb.payment, "findFirst", async ({ where }: Row) => {
    const t = Object.values(w.txns).find((x) => x.tranId === where?.sslCommerzDetail?.tranId) ?? w.txns.T_B;
    const p = w.payments[t.paymentId];
    return { id: p.id, status: p.status, orderId: p.orderId, meta: p.meta };
  });
  set(paymentGatewayDb.payment, "findFirst", async ({ where }: Row) => {
    const p = Object.values(w.payments).find((x) => x.meta?.[where.meta.path[0]] === where.meta.equals);
    return p ? { ...p, paymentProvider: { id: "GW1", payment_credentials: [{ environment: "SANDBOX" }, { environment: "PRODUCTION" }] } } : null;
  });
  set(AccountingService.prototype, "createEvent0aOnlinePayment", async (d: Row) => (w.events.push(`0a:${d.orderId}`), { id: "V0A" }));
  set(sharedDb.user, "findFirst", async () => ({ id: "U_SYSTEM" }));
  set(OrderService.prototype, "releaseStockForOrder", async (orderId: string) => (w.released.push(orderId), { released: 1, skipped: false }));
  return { set, restore: () => restores.reverse().forEach((r) => r()) };
}
const A_PAID = { status: "PAID", meta: { type: "order_payment" } };

// ── classification ──────────────────────────────────────────────────────────

test("classification: self applied / recorded converge; other paid, cancelled or moved-on orders are recorded; otherwise apply", async () => {
  const cases: [Parameters<typeof world>[0], string | null][] = [
    [{ b: { status: "PAID" } }, "SELF_APPLIED"],
    [{ b: { meta: { reconciliation: { state: "NEEDS_REVIEW", reason: "ORDER_CANCELLED" } } } }, "SELF_RECORDED"],
    [{ order: { status: "CANCELLED" } }, "ORDER_CANCELLED"],
    [{ order: { status: "REFUNDED" } }, "ORDER_CANCELLED"],
    [{ a: A_PAID, order: { status: "CONFIRMED", paymentStatus: "PAID" } }, "ORDER_ALREADY_PAID"],
    [{ a: { status: "PARTIALLY_REFUNDED" }, order: { status: "CONFIRMED", paymentStatus: "PARTIALLY_REFUNDED" } }, "ORDER_ALREADY_PAID"],
    [{ order: { paymentStatus: "PAID" } }, "ORDER_ALREADY_PAID"], // H1 hold by another session
    [{ order: { status: "CONFIRMED" } }, "ORDER_NOT_PAYABLE"], // legacy: confirmed without payment
    [{ a: { status: "PAID", meta: { type: "delivery_fee" } } }, null], // a delivery fee is not the order's payment
    [{ a: { status: "FAILED" } }, null],
    [{}, null],
  ];
  for (const [over, want] of cases) {
    const w = world(over);
    const s = install(w);
    try {
      assert.equal(await classifyVerifiedPayment(paymentServiceDb, "O1", "PAY_B"), want, JSON.stringify(over));
    } finally {
      s.restore();
    }
  }
});

// ── SSLCommerz ──────────────────────────────────────────────────────────────

test("concurrent sessions: A confirmed the order; B's verified money is recorded once — order untouched, B not PAID, no Event 0a", async () => {
  const w = world({ a: A_PAID, order: { status: "CONFIRMED", paymentStatus: "PAID" } });
  w.vendorOrders[0].status = "CONFIRMED";
  const s = install(w);
  try {
    await paymentService.confirmPayment("T_B", VALID("T_B") as any);
    assert.deepEqual([w.order.status, w.order.paymentStatus, w.vendorOrders[0].status], ["CONFIRMED", "PAID", "CONFIRMED"]);
    assert.equal(w.payments.PAY_B.status, "PENDING");
    assert.deepEqual(
      { ...w.payments.PAY_B.meta.reconciliation, receivedAt: "x" },
      { state: "NEEDS_REVIEW", reason: "ORDER_ALREADY_PAID", receivedAt: "x", gateway: "SSLCOMMERZ", gatewayRef: "BANK_T_B", amount: "1500" },
    );
    assert.deepEqual(w.events, [], "no Event 0a for B");
    assert.deepEqual(w.audits, [PAYMENT_UNAPPLIED_AUDIT]);
    // duplicate callbacks for B (browser return + IPN): nothing recorded twice
    await paymentService.confirmPayment("T_B", VALID("T_B") as any);
    await paymentService.confirmPayment("T_B", VALID("T_B") as any);
    assert.deepEqual(w.audits, [PAYMENT_UNAPPLIED_AUDIT]);
    assert.deepEqual(w.events, []);
  } finally {
    s.restore();
  }
});

test("delayed callback after the order moved on (SHIPPED) or was cancelled: recorded, status never moved back", async () => {
  for (const order of [{ status: "SHIPPED", paymentStatus: "PAID" }, { status: "CANCELLED", paymentStatus: "PENDING" }]) {
    const w = world({ a: order.paymentStatus === "PAID" ? A_PAID : {}, order });
    w.vendorOrders[0].status = order.status;
    const s = install(w);
    try {
      await paymentService.confirmPayment("T_B", VALID("T_B") as any);
      assert.deepEqual([w.order.status, w.vendorOrders[0].status], [order.status, order.status]);
      assert.equal(w.payments.PAY_B.status, "PENDING");
      assert.ok(w.payments.PAY_B.meta.reconciliation, order.status);
      assert.deepEqual(w.events, []);
    } finally {
      s.restore();
    }
  }
});

test("duplicate callback for the payment that already confirmed the order: converges, nothing written", async () => {
  const w = world({ a: A_PAID, order: { status: "CONFIRMED", paymentStatus: "PAID" } });
  const s = install(w);
  try {
    await paymentService.confirmPayment("T_A", VALID("T_A") as any);
    assert.deepEqual(w.audits, []);
    assert.equal(w.payments.PAY_A.meta.reconciliation, undefined);
    assert.deepEqual(w.events, []);
  } finally {
    s.restore();
  }
});

test("a row marked FAILED (timed out / stray fail) whose payment the gateway verifies is APPLIED while the order still awaits payment", async () => {
  const w = world({ b: { status: "FAILED" } });
  const s = install(w);
  try {
    await paymentService.confirmPayment("T_B", VALID("T_B") as any);
    assert.deepEqual([w.order.status, w.order.paymentStatus, w.payments.PAY_B.status], ["CONFIRMED", "PAID", "PAID"]);
    assert.deepEqual(w.events, ["0a:O1"]);
  } finally {
    s.restore();
  }
});

test("a first payment still confirms the order exactly as before", async () => {
  const w = world();
  const s = install(w);
  try {
    await paymentService.confirmPayment("T_A", VALID("T_A") as any);
    assert.deepEqual([w.order.status, w.order.paymentStatus, w.payments.PAY_A.status, w.vendorOrders[0].status], ["CONFIRMED", "PAID", "PAID", "CONFIRMED"]);
    assert.deepEqual(w.audits, []);
  } finally {
    s.restore();
  }
});

// ── EPS / PayStation ────────────────────────────────────────────────────────

test("EPS: a second verified payment is recorded; the shipped order's status is never overwritten and the payment is not marked PAID", async () => {
  const w = world({ a: A_PAID, b: { method: "EPS", meta: { type: "order_payment", merchantTransactionId: "EPS_B" } }, order: { status: "SHIPPED", paymentStatus: "PAID" } });
  const s = install(w);
  s.set(epsService, "checkTransactionStatus", async () => ({ status: "Success", raw: { ok: 1 } }));
  try {
    await paymentGatewayService.verifyAndConfirmByTransactionId("EPS_B");
    assert.equal(w.order.status, "SHIPPED");
    assert.equal(w.payments.PAY_B.status, "PENDING");
    assert.equal(w.payments.PAY_B.meta.reconciliation.reason, "ORDER_ALREADY_PAID");
    assert.equal(w.payments.PAY_B.meta.reconciliation.gateway, "EPS");
    await paymentGatewayService.verifyAndConfirmByTransactionId("EPS_B");
    assert.deepEqual(w.audits, [PAYMENT_UNAPPLIED_AUDIT], "idempotent");
  } finally {
    s.restore();
  }
});

test("EPS: a first verified payment is still applied (CONFIRMED + PAID)", async () => {
  const w = world({ b: { method: "EPS", meta: { type: "order_payment", merchantTransactionId: "EPS_B" } } });
  const s = install(w);
  s.set(epsService, "checkTransactionStatus", async () => ({ status: "Success", raw: {} }));
  try {
    await paymentGatewayService.verifyAndConfirmByTransactionId("EPS_B");
    assert.deepEqual([w.order.status, w.order.paymentStatus, w.payments.PAY_B.status], ["CONFIRMED", "PAID", "PAID"]);
  } finally {
    s.restore();
  }
});

test("PayStation: verified money for a cancelled order is recorded (no Event 0a, order stays CANCELLED); the customer is sent to the result page", async () => {
  const w = world({ b: { method: "PAYSTATION", meta: { type: "order_payment", invoiceNumber: "INV_B" } }, order: { status: "CANCELLED" } });
  const s = install(w);
  let checks = 0;
  s.set(paystationService, "checkTransactionStatus", async () => (checks++, { status: "success", paymentAmount: 1500, trxId: "TRX_B", paymentMethod: "bkash", raw: {} }));
  try {
    assert.equal(await paymentGatewayService.handlePaystationCallback("INV_B", ""), "success");
    assert.equal(w.order.status, "CANCELLED");
    assert.equal(w.payments.PAY_B.status, "PENDING");
    assert.equal(w.payments.PAY_B.meta.reconciliation.reason, "ORDER_CANCELLED");
    assert.equal(w.payments.PAY_B.meta.reconciliation.gatewayRef, "TRX_B");
    assert.deepEqual(w.events, []);
    assert.equal(await paymentGatewayService.handlePaystationCallback("INV_B", ""), "success");
    assert.equal(checks, 1, "recorded → no second gateway check");
  } finally {
    s.restore();
  }
});

// ── fail / cancel never downgrade recorded money ───────────────────────────

test("fail / cancel callbacks leave recorded money alone (no FAILED, no stock release)", async () => {
  const recorded = { meta: { type: "order_payment", merchantTransactionId: "EPS_B", reconciliation: { state: "NEEDS_REVIEW", reason: "ORDER_ALREADY_PAID" } } };
  for (const call of [
    () => paymentService.handleFailedPayment("T_B"),
    () => paymentService.handleCancelledPayment("T_B"),
  ]) {
    const w = world({ b: recorded });
    const s = install(w);
    try {
      await call();
      assert.equal(w.payments.PAY_B.status, "PENDING");
      assert.deepEqual(w.released, []);
      assert.equal(w.txns.T_B.status, "PENDING");
    } finally {
      s.restore();
    }
  }
  const w = world({ b: { ...recorded, method: "EPS" } });
  delete (w.txns as Row).T_B;
  const s = install(w);
  try {
    await paymentGatewayService.markFailedOrCancelled("EPS_B", "FAILED");
    assert.equal(w.payments.PAY_B.status, "PENDING");
  } finally {
    s.restore();
  }
});

// ── result page / admin list ────────────────────────────────────────────────

test("payment result: recorded money is UNAPPLIED — never a success, never pending", () => {
  const meta = { reconciliation: { state: "NEEDS_REVIEW", reason: "ORDER_ALREADY_PAID" } };
  assert.equal(paymentResultState({ status: "PENDING", meta }, { status: "CONFIRMED", paymentStatus: "PAID" }), "UNAPPLIED");
  assert.equal(paymentResultState({ status: "FAILED", meta }, { status: "CANCELLED", paymentStatus: "PENDING" }), "UNAPPLIED");
  assert.equal(paymentResultState({ status: "PAID", meta: {} }, { status: "CONFIRMED", paymentStatus: "PAID" }), "CONFIRMED");
});

test("admin list of payments needing review: filtered on the marker, paged, behind the admin order router", async () => {
  const seen: Row[] = [];
  const restore: (() => void)[] = [];
  const set = (o: any, k: string, v: any) => {
    const orig = o[k];
    o[k] = v;
    restore.push(() => (o[k] = orig));
  };
  set(sharedDb.payment, "findMany", async (a: Row) => (seen.push(a), [{ id: "PAY_B", method: "SSLCOMMERZ", status: "PENDING", amount: 1500, createdAt: new Date(0), meta: { reconciliation: { state: "NEEDS_REVIEW", reason: "ORDER_CANCELLED" } }, order: { id: "O1", orderNumber: "ORD-1" } }]));
  set(sharedDb.payment, "count", async () => 1);
  try {
    const res: any = { statusCode: 200 };
    res.status = (c: number) => ((res.statusCode = c), res);
    res.json = (b: unknown) => ((res.body = b), res);
    await AdminOrderController.getUnappliedPayments({ query: { limit: "500" } } as any, res);
    assert.deepEqual(seen[0].where, { meta: { path: ["reconciliation", "state"], equals: "NEEDS_REVIEW" } });
    assert.equal(seen[0].take, 50);
    assert.equal(res.body.data[0].reconciliation.reason, "ORDER_CANCELLED");
    assert.equal(res.body.data[0].amount, "1500");
    const routes = (await import("node:fs")).readFileSync(new URL("../src/routes/admin.order.routes.ts", import.meta.url), "utf8");
    assert.match(routes, /router\.use\(authenticateUser, authorizeRoles\("ADMIN", "EMPLOYEE"\), blockVendorEmployees, requirePermission\("orderManagement"\)\);/);
    assert.ok(routes.indexOf('router.get("/payment-reconciliation"') > routes.indexOf("router.use(authenticateUser"), "registered after the guard");
    void AdminOrderService;
  } finally {
    restore.reverse().forEach((r) => r());
  }
});

// ── one duplicate-session window for /payment/init and Pay Now ─────────────

test("/payment/init and Pay Now share the session window: a session opened by either blocks the other for 5 minutes", async () => {
  const NOW = Date.parse("2026-10-19T10:00:00Z");
  const order: Row = { userId: "U1", status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", reservationReleasedAt: null, vendorOrders: [{ status: "PENDING", items: [{ allocations: [{ id: "A1" }] }] }], payments: [] };
  let chain = Promise.resolve();
  const db = {
    $transaction: (fn: any) => {
      const run = chain.then(() =>
        fn({
          $executeRaw: async () => 1,
          order: { findUnique: async (a: Row) => ({ ...order, payments: order.payments.filter((p: Row) => p.createdAt >= a.select.payments.where.createdAt.gte) }) },
        }),
      );
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  const restores: (() => void)[] = [];
  const set = (o: any, k: string, v: any) => {
    const orig = o[k];
    o[k] = v;
    restores.push(() => (o[k] = orig));
  };
  let opened = 0;
  set(payNowDeps, "db", db);
  set(payNowDeps, "now", () => NOW);
  set(payNowDeps, "initiate", async () => {
    opened++;
    order.payments.push({ status: "PENDING", meta: { type: "order_payment" }, createdAt: new Date(NOW) });
    return { gatewayPageURL: "https://gw.example/pay", transactionId: `T${opened}`, sessionKey: "k" };
  });
  const viaInit = () => openOrderGatewaySession({ orderId: "O1", gatewayCode: "", ownerId: null, rejectCod: false, requireReservation: false, requireHttps: false });
  const viaPayNow = () => openOrderGatewaySession({ orderId: "O1", gatewayCode: "", ownerId: "U1", rejectCod: true, requireReservation: true, requireHttps: true });
  try {
    await viaInit();
    await assert.rejects(viaPayNow(), (e: any) => e instanceof PayNowError && e.code === "PAYMENT_IN_PROGRESS");
    await assert.rejects(viaInit(), (e: any) => e.code === "PAYMENT_IN_PROGRESS");
    order.payments = [];
    const results = await Promise.allSettled([viaPayNow(), viaInit()]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "concurrent init + Pay Now: one session");
    assert.equal(opened, 2);
  } finally {
    restores.reverse().forEach((r) => r());
  }
});
