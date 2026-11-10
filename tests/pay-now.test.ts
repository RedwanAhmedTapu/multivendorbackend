// tests/pay-now.test.ts
//
// Customer Pay Now (POST /api/orders/:orderId/pay-now), the derived customer
// actions on the order detail, and the payable guard on POST /api/payment/init.
//   - Pay Now opens ONE session through the active gateway initialiser and
//     returns ITS page URL (https only); nothing is marked paid here;
//   - eligibility / stock errors map to stable codes; a gateway session opened
//     within the window → 409 PAYMENT_IN_PROGRESS (retryAfterSeconds); the
//     checkout placeholder and delivery-fee intents do not count;
//   - the reservation and eligibility are re-checked under the order lock;
//     concurrent calls produce one session;
//   - payNowOrder only re-reserves — it creates no payment rows any more;
//   - customerOrderActions mirrors cancelOrderByUser's refusal rules;
//   - /payment/init refuses online initialisation for a non-payable order.
// DB-free; no gateway is called (the initialiser is replaced):
//   npx tsx --test tests/pay-now.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { OrderService, orderServiceDb, customerOrderActions } from "../src/services/order.service.ts";
import { startPayNow, payNowDeps, PayNowError, PAY_NOW_SESSION_WINDOW_MS, isOrderGatewaySession } from "../src/services/pay-now.service.ts";
import { OrderController } from "../src/controllers/order.controller.ts";
import { PaymentController } from "../src/controllers/payment.controller.ts";
import { paymentGatewayService } from "../src/services/payment-gateway.service.ts";
import { BOOKING_PENDING } from "../src/services/courier.service.ts";

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
function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Row };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.set = (k: string, v: string) => ((res.headers[k.toLowerCase()] = v), res);
  return res;
}

const NOW = Date.parse("2026-10-18T10:00:00Z");
const allocated = () => [{ status: "PENDING", items: [{ allocations: [{ id: "A1" }] }] }];

/** A fake DB for the lock transaction: one order, a mutex standing in for the row lock. */
function lockDb(order: Row) {
  const sql: string[] = [];
  let chain = Promise.resolve();
  const db = {
    sql,
    order,
    $transaction: (fn: any, opts: Row) => {
      const run = chain.then(() =>
        fn({
          $executeRaw: async (strings: TemplateStringsArray) => (sql.push(strings.join("?")), 1),
          order: {
            findUnique: async (a: Row) => {
              const since: Date = a.select.payments.where.createdAt.gte;
              return { ...order, payments: order.payments.filter((p: Row) => p.status === "PENDING" && p.createdAt >= since) };
            },
          },
        }),
      );
      chain = run.then(() => undefined, () => undefined);
      (db as any).lastOpts = opts;
      return run;
    },
  };
  return db;
}
const ORDER = (over: Row = {}) => ({
  userId: "U1", status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", reservationReleasedAt: null,
  vendorOrders: allocated(), payments: [{ status: "PENDING", meta: null, createdAt: new Date(NOW - 60_000) }], ...over,
});

function withDeps(order: Row, initiate?: (p: Row) => Promise<any>, reserve?: () => Promise<any>) {
  const s = stubber();
  const db = lockDb(order);
  const calls: Row[] = [];
  s.set(payNowDeps, "db", db);
  s.set(payNowDeps, "now", () => NOW);
  s.set(payNowDeps, "reserve", reserve ?? (async () => ({ reReserved: false })));
  s.set(payNowDeps, "initiate", async (p: Row) => {
    calls.push(p);
    if (initiate) return initiate(p);
    order.payments.push({ status: "PENDING", meta: { type: "order_payment" }, createdAt: new Date(NOW) });
    return { gatewayPageURL: "https://sandbox.sslcommerz.com/EasyCheckOut/abc", transactionId: "TXN_1_O1", sessionKey: "k" };
  });
  return { db, calls, restore: s.restore };
}

test("happy path: re-reserve, lock the order (FOR NO KEY UPDATE), open ONE session via the active gateway, return its URL", async () => {
  const order = ORDER();
  const { db, calls, restore } = withDeps(order);
  try {
    const r = await startPayNow("U1", "O1", "bkash");
    assert.deepEqual(r, { gatewayPageURL: "https://sandbox.sslcommerz.com/EasyCheckOut/abc", transactionId: "TXN_1_O1" });
    assert.deepEqual(calls, [{ orderId: "O1", userId: "U1", gatewayCode: "bkash" }]);
    assert.match(db.sql[0], /FOR NO KEY UPDATE/);
    assert.ok((db as any).lastOpts.timeout >= 30_000, "the lock transaction outlives a gateway call");
  } finally {
    restore();
  }
});

test("checkout placeholder and delivery-fee intents don't block; an order-payment session inside the window does (409 + retry-after)", async () => {
  assert.equal(isOrderGatewaySession({ status: "PENDING", meta: null }), false);
  assert.equal(isOrderGatewaySession({ status: "PENDING", meta: { type: "delivery_fee" } }), false);
  assert.equal(isOrderGatewaySession({ status: "FAILED", meta: { type: "order_payment" } }), false);
  assert.equal(isOrderGatewaySession({ status: "PENDING", meta: { type: "order_payment" } }), true);

  const recent = ORDER({ payments: [{ status: "PENDING", meta: { type: "order_payment" }, createdAt: new Date(NOW - 60_000) }] });
  const a = withDeps(recent);
  try {
    await assert.rejects(startPayNow("U1", "O1"), (e: any) => e instanceof PayNowError && e.statusCode === 409 && e.code === "PAYMENT_IN_PROGRESS" && e.retryAfterSeconds === 240);
    assert.equal(a.calls.length, 0, "no second session");
  } finally {
    a.restore();
  }
  const old = ORDER({ payments: [{ status: "PENDING", meta: { type: "order_payment" }, createdAt: new Date(NOW - PAY_NOW_SESSION_WINDOW_MS - 1000) }] });
  const b = withDeps(old);
  try {
    await startPayNow("U1", "O1");
    assert.equal(b.calls.length, 1, "a session older than the window no longer blocks");
  } finally {
    b.restore();
  }
});

test("concurrent Pay Now for one order: the second waits for the lock, sees the first session and gets 409 — one gateway call", async () => {
  const order = ORDER();
  const { calls, restore } = withDeps(order, async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.payments.push({ status: "PENDING", meta: { type: "order_payment" }, createdAt: new Date(NOW) });
    return { gatewayPageURL: "https://gw.example/pay", transactionId: "T1" };
  });
  try {
    const results = await Promise.allSettled([startPayNow("U1", "O1"), startPayNow("U1", "O1")]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.code, "PAYMENT_IN_PROGRESS");
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test("re-checked under the lock: released reservation, no longer payable, not the owner — no session", async () => {
  for (const [over, status, code] of [
    [{ reservationReleasedAt: new Date() }, 409, "RESERVATION_CHANGED"],
    [{ vendorOrders: [{ status: "PENDING", items: [{ allocations: [] }] }] }, 409, "RESERVATION_CHANGED"],
    [{ paymentStatus: "PAID" }, 409, "NOT_PAYABLE"],
    [{ status: "CANCELLED" }, 409, "NOT_PAYABLE"],
    [{ userId: "U2" }, 404, "NOT_FOUND"],
  ] as const) {
    const { calls, restore } = withDeps(ORDER(over as Row));
    try {
      await assert.rejects(startPayNow("U1", "O1"), (e: any) => e.statusCode === status && e.code === code, JSON.stringify(over));
      assert.equal(calls.length, 0);
    } finally {
      restore();
    }
  }
});

test("step-1 errors map to stable codes; nothing is locked or initialised", async () => {
  for (const [msg, status, code] of [
    ["Order not found", 404, "NOT_FOUND"],
    ["COD orders cannot use Pay Now — pay the courier on delivery", 400, "COD_ORDER"],
    ["Order is not PAYMENT_PENDING (status=CONFIRMED, payment=PAID)", 409, "NOT_PAYABLE"],
    ["Pay Now cannot complete: stock for this order is no longer available (Insufficient sellable stock)", 409, "STOCK_UNAVAILABLE"],
  ] as const) {
    const { db, calls, restore } = withDeps(ORDER(), undefined, async () => {
      throw new Error(msg);
    });
    try {
      await assert.rejects(startPayNow("U1", "O1"), (e: any) => e.statusCode === status && e.code === code);
      assert.deepEqual([db.sql.length, calls.length], [0, 0]);
    } finally {
      restore();
    }
  }
});

test("gateway failure or a non-https page URL → 502, never a fake success", async () => {
  for (const initiate of [
    async () => {
      throw new Error("store_passwd invalid");
    },
    async () => ({ gatewayPageURL: "", transactionId: "T" }),
    async () => ({ gatewayPageURL: "javascript:alert(1)", transactionId: "T" }),
    async () => ({ gatewayPageURL: "http://insecure.example/pay", transactionId: "T" }),
  ]) {
    const { restore } = withDeps(ORDER(), initiate);
    try {
      await assert.rejects(startPayNow("U1", "O1"), (e: any) => e.statusCode === 502 && e.code === "GATEWAY_ERROR" && !/store_passwd/.test(e.message));
    } finally {
      restore();
    }
  }
});

test("payNowOrder only re-reserves: it creates no payment or SSLCommerz rows", async () => {
  const s = stubber();
  const tx = {
    order: {
      findUnique: async () => ({ id: "O1", userId: "U1", status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", reservationReleasedAt: null, payments: [], vendorOrders: [{ vendorId: "V1", items: [{ id: "I1", allocations: [{ id: "A1" }] }] }] }),
      update: async () => assert.fail("nothing to re-reserve"),
    },
    payment: { create: async () => assert.fail("no payment row") },
    sSLCommerzTransaction: { create: async () => assert.fail("no SSLCommerz row") },
  };
  s.set(orderServiceDb.order, "findUnique", tx.order.findUnique);
  s.set(orderServiceDb, "$transaction", async (fn: any) => fn(tx));
  try {
    assert.deepEqual(await new OrderService().payNowOrder("U1", "O1"), { reReserved: false });
  } finally {
    s.restore();
  }
});

test("controller: rawId owner, gateway code validated (never COD), stable error body, no-store", async () => {
  const s = stubber();
  const seen: Row[] = [];
  s.set(payNowDeps, "reserve", async () => ({}));
  const db = lockDb(ORDER());
  s.set(payNowDeps, "db", db);
  s.set(payNowDeps, "now", () => NOW);
  s.set(payNowDeps, "initiate", async (p: Row) => {
    seen.push(p);
    db.order.payments.push({ status: "PENDING", meta: { type: "order_payment" }, createdAt: new Date(NOW) });
    return { gatewayPageURL: "https://gw.example/pay", transactionId: "T1" };
  });
  const c = new OrderController();
  try {
    const unauth = fakeRes();
    await c.payNow({ params: { orderId: "O1" }, body: {} } as any, unauth);
    assert.equal(unauth.statusCode, 401);
    for (const gatewayCode of ["COD", "cod", "bad code", 5, "x".repeat(30)]) {
      const r = fakeRes();
      await c.payNow({ user: { rawId: "U1" }, params: { orderId: "O1" }, body: { gatewayCode } } as any, r);
      assert.equal(r.statusCode, 400, String(gatewayCode));
    }
    assert.equal(seen.length, 0);
    const ok = fakeRes();
    await c.payNow({ user: { id: "C-1", rawId: "U1" }, params: { orderId: "O1" }, body: {} } as any, ok);
    assert.deepEqual(ok.body, { success: true, data: { gatewayPageURL: "https://gw.example/pay", transactionId: "T1" } });
    assert.equal(ok.headers["cache-control"], "no-store");
    assert.deepEqual(seen[0], { orderId: "O1", userId: "U1", gatewayCode: "" });
    const busy = fakeRes();
    await c.payNow({ user: { rawId: "U1" }, params: { orderId: "O1" }, body: {} } as any, busy);
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.body.code, "PAYMENT_IN_PROGRESS");
    assert.ok(busy.body.retryAfterSeconds > 0);
  } finally {
    s.restore();
  }
});

test("customerOrderActions mirrors the cancel / Pay Now rules", () => {
  const a = (over: Row = {}, vos: Row[] = [{ status: "PENDING", courierOrders: [] }]) =>
    customerOrderActions({ status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", vendorOrders: vos as any, ...over });
  assert.deepEqual(a(), { canPayNow: true, canCancel: true, cancelBlockedReason: null });
  assert.equal(a({ paymentmethod: "COD" }).canPayNow, false);
  assert.equal(a({ paymentStatus: "PAID" }).canPayNow, false);
  assert.equal(a({ status: "CONFIRMED", paymentStatus: "PAID" }).canCancel, true);
  assert.deepEqual(a({ status: "CANCELLED" }), { canPayNow: false, canCancel: false, cancelBlockedReason: "ALREADY_CANCELLED" });
  for (const st of ["SHIPPED", "DELIVERED", "RETURNED", "REFUNDED"]) assert.equal(a({ status: st }).cancelBlockedReason, "DISPATCHED", st);
  assert.equal(a({ status: "PACKAGING" }, [{ status: "SHIPPED" }]).cancelBlockedReason, "DISPATCHED", "a dispatched vendor order blocks");
  assert.equal(a({ status: "PACKAGING" }, [{ status: "PACKAGING", courierOrders: [{ status: "PENDING_PICKUP", courierStatus: "Booked", courierTrackingId: "TRK1" }] }]).cancelBlockedReason, "COURIER_BOOKING_ACTIVE");
  assert.equal(a({ status: "PACKAGING" }, [{ status: "PACKAGING", courierOrders: [{ status: "PENDING_PICKUP", courierStatus: "Booking claimed", courierTrackingId: null }] }]).cancelBlockedReason, "COURIER_BOOKING_ACTIVE", "unresolved booking");
  assert.equal(a({ status: "PACKAGING" }, [{ status: "PACKAGING", courierOrders: [{ status: "PENDING_PICKUP", courierStatus: BOOKING_PENDING, courierTrackingId: null }] }]).canCancel, true, "an unclaimed intent is cancelled with the order");
  assert.equal(a({ status: "PACKAGING" }, [{ status: "PACKAGING", courierOrders: [{ status: "CANCELLED", courierStatus: "Booked", courierTrackingId: "TRK0" }] }]).canCancel, true, "cancelled bookings are ignored");
});

test("order detail carries customerActions derived from the order's courier rows (not exposed themselves)", async () => {
  const s = stubber();
  s.set(orderServiceDb.order, "findFirst", async (a: Row) => {
    assert.deepEqual(a.where, { id: "O1", userId: "U1" });
    return { id: "O1", status: "PACKAGING", paymentStatus: "PAID", paymentmethod: "SSLCOMMERZ", vendorOrders: [{ id: "VO1", status: "PACKAGING" }, { id: "VO2", status: "PACKAGING" }] };
  });
  s.set(orderServiceDb.courierOrder, "findMany", async () => [{ vendorOrderId: "VO2", status: "PENDING_PICKUP", courierStatus: "Booked", courierTrackingId: "TRK1" }]);
  try {
    const o: any = await new OrderService().getUserOrderById("U1", "O1");
    assert.deepEqual(o.customerActions, { canPayNow: false, canCancel: false, cancelBlockedReason: "COURIER_BOOKING_ACTIVE" });
    assert.ok(!("courierStatus" in o.vendorOrders[1]));
  } finally {
    s.restore();
  }
});

test("/payment/init: online initialisation refused for a non-payable order; COD path unchanged", async () => {
  const s = stubber();
  let status = "CONFIRMED";
  let initiated = 0;
  s.set(prisma.order, "findUnique", async (a: Row) =>
    a.select.vendorOrders ? { id: "O1", userId: "U1", vendorOrders: [] } : { status, paymentStatus: status === "PENDING" ? "PENDING" : "PAID" },
  );
  s.set(paymentGatewayService, "initiatePayment", async () => (initiated++, { gatewayPageURL: "https://gw.example/pay", sessionKey: "k", transactionId: "T" }));
  // Phase 5: /payment/init opens its session through the same locked helper as Pay Now.
  const order = ORDER({ status: "CONFIRMED", paymentStatus: "PAID" });
  s.set(payNowDeps, "db", lockDb(order));
  s.set(payNowDeps, "now", () => NOW);
  const req = (gatewayCode: string) => ({ body: { orderId: "O1", gatewayCode }, user: { role: "CUSTOMER", rawId: "U1" } }) as any;
  try {
    const refused = fakeRes();
    await PaymentController.createPayment(req("bkash"), refused);
    assert.deepEqual([refused.statusCode, refused.body.code, initiated], [409, "NOT_PAYABLE", 0]);
    status = "PENDING";
    Object.assign(order, { status: "PENDING", paymentStatus: "PENDING" });
    const ok = fakeRes();
    await PaymentController.createPayment(req("bkash"), ok);
    assert.deepEqual([ok.statusCode, ok.body.data.gatewayPageURL, initiated], [200, "https://gw.example/pay", 1]);
  } finally {
    s.restore();
  }
});
