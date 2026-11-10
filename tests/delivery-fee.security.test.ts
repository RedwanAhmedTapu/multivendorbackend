// tests/delivery-fee.security.test.ts
//
// PHASE 4 (D4): COD delivery-fee payment — ownership and trust boundaries.
//   processDeliveryFeePayment — the payer is the authenticated owner and the
//     amount is the order's own shipping cost (a body `userId` / `amount` is
//     ignored); non-owners get 404, ineligible orders 409 (not COD, shipped /
//     closed, no fee, fee already paid); the gateway is asked for the FEE, not
//     the order total, and no extra payment row is created.
//   confirmDeliveryFeePayment — owner only; only delivery-fee transactions;
//     the gateway validation must be for THIS transaction and cover the fee;
//     the payment is recorded once and the ORDER IS NEVER CHANGED (the old
//     version set CONFIRMED, bypassing fraud review / reviving cancellations).
//   confirmPayment (IPN / success callback) — a delivery-fee payment never
//     confirms the order, marks it PAID or posts Event 0a.
//   initiatePayment never logs the gateway payload (it carries store_passwd).
//
// DB-free and network-free: the payment service's Prisma client and axios are
// stubbed; any unexpected call fails the test.
//   npx tsx --test tests/delivery-fee.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SSLCOMMERZ_STORE_ID ??= "test-store";
process.env.SSLCOMMERZ_STORE_PASSWORD = "test-store-secret-DO-NOT-LOG";
const axios = (await import("axios")).default;
const { paymentService, paymentServiceDb, DeliveryFeeError } = await import("../src/services/payment.service.ts");
const { PaymentController } = await import("../src/controllers/payment.controller.ts");

type Row = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

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
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

const ORDER = (over: Row = {}) => ({
  id: "O1",
  userId: "U1",
  paymentmethod: "COD",
  status: "CONFIRMED",
  shippingCost: 60,
  totalAmount: 1560,
  ...over,
});

/** Traps every order write on the payment service's client. */
function trapOrderWrites(s: ReturnType<typeof stubber>, db: any = paymentServiceDb) {
  for (const m of ["update", "updateMany"]) s.set(db.order, m, async () => assert.fail(`order.${m} must not run`));
}

// ── processDeliveryFeePayment ───────────────────────────────────────────────

function stubInitiate(order: Row | null, opts: { paidFee?: boolean } = {}) {
  const s = stubber();
  const initiated: any[] = [];
  s.set(paymentServiceDb.order, "findUnique", async () => clone(order));
  s.set(paymentServiceDb.payment, "findFirst", async ({ where }: any) => {
    assert.deepEqual(where.meta, { path: ["type"], equals: "delivery_fee" });
    return opts.paidFee ? { id: "PAYFEE" } : null;
  });
  s.set(paymentServiceDb.payment, "create", async () => assert.fail("no payment row outside initiatePayment"));
  s.set(paymentService, "initiatePayment", async (p: any) => (initiated.push(p), { payment: { id: "PAYNEW" }, gatewayPageURL: "x" }));
  trapOrderWrites(s);
  return { initiated, restore: s.restore };
}

for (const [label, order, requester, status, re] of [
  ["another customer's order", ORDER(), "ATTACKER", 404, /Order not found/],
  ["a guest order (no owner)", ORDER({ userId: null }), "U1", 404, /Order not found/],
  ["a missing order", null, "U1", 404, /Order not found/],
  ["an online-paid order", ORDER({ paymentmethod: "SSLCOMMERZ" }), "U1", 409, /only available for cash-on-delivery/],
  ["a shipped order", ORDER({ status: "SHIPPED" }), "U1", 409, /can no longer take/],
  ["a cancelled order", ORDER({ status: "CANCELLED" }), "U1", 409, /can no longer take/],
  ["an order with no delivery fee", ORDER({ shippingCost: 0 }), "U1", 409, /no delivery fee/],
] as const) {
  test(`processDeliveryFeePayment refuses ${label} (${status}) — no gateway call`, async () => {
    const env = stubInitiate(order as Row | null);
    try {
      await assert.rejects(
        paymentService.processDeliveryFeePayment("O1", requester, "BKASH"),
        (e: any) => e instanceof DeliveryFeeError && e.statusCode === status && re.test(e.message),
      );
      assert.deepEqual(env.initiated, []);
    } finally {
      env.restore();
    }
  });
}

test("processDeliveryFeePayment refuses a second payment once the fee is paid (409)", async () => {
  const env = stubInitiate(ORDER(), { paidFee: true });
  try {
    await assert.rejects(paymentService.processDeliveryFeePayment("O1", "U1"), (e: any) => e.statusCode === 409 && /already paid/.test(e.message));
    assert.deepEqual(env.initiated, []);
  } finally {
    env.restore();
  }
});

test("processDeliveryFeePayment: the owner pays the order's own fee — purpose delivery_fee, payer from the order", async () => {
  const env = stubInitiate(ORDER());
  try {
    await paymentService.processDeliveryFeePayment("O1", "U1", "NAGAD");
    assert.deepEqual(env.initiated, [{ orderId: "O1", userId: "U1", gatewayCode: "NAGAD", purpose: "delivery_fee" }]);
  } finally {
    env.restore();
  }
});

// ── initiatePayment: amount + logging ───────────────────────────────────────

test("initiatePayment(delivery_fee) charges the shipping cost, not the order total — and never logs the password", async () => {
  const s = stubber();
  const created: Row[] = [];
  let posted = "";
  const logs: string[] = [];
  try {
    s.set(paymentServiceDb.order, "findUnique", async () => ({
      ...ORDER(),
      user: { id: "U1", name: "n", email: null, phone: null },
      address: null,
      vendorOrders: [{ items: [{ variant: { product: { name: "P", vendorId: "V1" } } }] }],
    }));
    s.set(paymentServiceDb.paymentProvider, "findUnique", async () => ({ id: "PROV" }));
    s.set(paymentServiceDb.payment, "create", async ({ data }: any) => (created.push(clone(data)), { id: "PAYNEW", ...data }));
    s.set(paymentServiceDb.sSLCommerzTransaction, "create", async () => ({}));
    s.set(paymentServiceDb.sSLCommerzTransaction, "update", async () => ({}));
    s.set(axios, "post", async (_url: string, body: string) => {
      posted = body;
      return { data: { status: "SUCCESS", sessionkey: "SK", GatewayPageURL: "https://gw", redirectGatewayURL: "" } };
    });
    s.set(console, "log", (...a: any[]) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
    await paymentService.initiatePayment({ orderId: "O1", userId: "U1", gatewayCode: "BKASH", purpose: "delivery_fee" });
    assert.equal(Number(created[0].amount), 60);
    assert.equal(created[0].meta.type, "delivery_fee");
    const form = new URLSearchParams(posted);
    assert.equal(form.get("total_amount"), "60.00");
    assert.equal(form.get("value_d"), "delivery_fee");
    assert.ok(!logs.some((l) => l.includes("test-store-secret-DO-NOT-LOG") || l.includes("store_passwd")), "password never logged");
  } finally {
    s.restore();
  }
});

// ── confirmDeliveryFeePayment ───────────────────────────────────────────────

function stubConfirm(txn: Row | null, validation: Row, opts: { claimCount?: number } = {}) {
  const s = stubber();
  const calls: string[] = [];
  s.set(paymentServiceDb.sSLCommerzTransaction, "findUnique", async () => clone(txn));
  s.set(axios, "get", async () => ({ data: validation }));
  s.set(paymentServiceDb.payment, "findUniqueOrThrow", async () => ({ id: "PAYFEE", status: "PAID" }));
  trapOrderWrites(s);
  s.set(paymentServiceDb, "$transaction", async (fn: any) =>
    fn({
      payment: {
        updateMany: async ({ where }: any) => {
          calls.push(`claim:${where.id}:${where.status}`);
          return { count: opts.claimCount ?? 1 };
        },
      },
      sSLCommerzTransaction: { update: async ({ where }: any) => (calls.push(`txn:${where.tranId}`), {}) },
      order: { update: async () => assert.fail("order write"), updateMany: async () => assert.fail("order write") },
    }),
  );
  return { calls, restore: s.restore };
}

const FEE_TXN = (over: Row = {}) => ({
  tranId: "T1",
  payment: { id: "PAYFEE", amount: 60, status: "PENDING", meta: { type: "delivery_fee" }, order: { userId: "U1" }, ...over },
});
const VALID = { status: "VALID", tran_id: "T1", amount: "60.00", val_id: "VAL1" };

for (const [label, txn, validation, requester, status, re] of [
  ["another customer's transaction", FEE_TXN(), VALID, "ATTACKER", 404, /Transaction not found/],
  ["an unknown transaction", null, VALID, "U1", 404, /Transaction not found/],
  ["an ORDER payment (not a delivery fee)", FEE_TXN({ meta: { type: "order_payment" } }), VALID, "U1", 409, /not a delivery-fee payment/],
  ["a failed payment", FEE_TXN({ status: "FAILED" }), VALID, "U1", 409, /cannot confirm/],
  ["an invalid gateway validation", FEE_TXN(), { ...VALID, status: "INVALID_TRANSACTION" }, "U1", 400, /validation failed/],
  ["a validation for a different transaction (replayed val_id)", FEE_TXN(), { ...VALID, tran_id: "OTHER" }, "U1", 400, /does not match/],
  ["an under-payment", FEE_TXN(), { ...VALID, amount: "10.00" }, "U1", 400, /does not cover/],
] as const) {
  test(`confirmDeliveryFeePayment refuses ${label} (${status}) — nothing recorded`, async () => {
    const env = stubConfirm(txn as Row | null, validation);
    try {
      await assert.rejects(
        paymentService.confirmDeliveryFeePayment("T1", "VAL1", requester),
        (e: any) => e instanceof DeliveryFeeError && e.statusCode === status && re.test(e.message),
      );
      assert.deepEqual(env.calls, []);
    } finally {
      env.restore();
    }
  });
}

test("confirmDeliveryFeePayment: records the payment once (guarded on PENDING) and never touches the order", async () => {
  const env = stubConfirm(FEE_TXN(), VALID);
  try {
    await paymentService.confirmDeliveryFeePayment("T1", "VAL1", "U1");
    assert.deepEqual(env.calls, ["claim:PAYFEE:PENDING", "txn:T1"]);
  } finally {
    env.restore();
  }
});

test("confirmDeliveryFeePayment: a duplicate callback (claim count 0) writes nothing more", async () => {
  const env = stubConfirm(FEE_TXN(), VALID, { claimCount: 0 });
  try {
    await paymentService.confirmDeliveryFeePayment("T1", "VAL1", "U1");
    assert.deepEqual(env.calls, ["claim:PAYFEE:PENDING"]);
  } finally {
    env.restore();
  }
});

test("confirmDeliveryFeePayment: an already-PAID fee is idempotent — no gateway call, no write", async () => {
  const env = stubConfirm(FEE_TXN({ status: "PAID" }), VALID);
  const s = stubber();
  s.set(axios, "get", async () => assert.fail("no validation call"));
  try {
    await paymentService.confirmDeliveryFeePayment("T1", "VAL1", "U1");
    assert.deepEqual(env.calls, []);
  } finally {
    s.restore();
    env.restore();
  }
});

// ── confirmPayment (IPN / success callback) ─────────────────────────────────

test("confirmPayment: a delivery-fee payment never confirms the order, marks it PAID or posts Event 0a", async () => {
  const env = stubConfirm(null, VALID);
  const s = stubber();
  try {
    s.set(paymentServiceDb.sSLCommerzTransaction, "findUnique", async () => ({
      tranId: "T1",
      paymentId: "PAYFEE",
      payment: { orderId: "O1", amount: 60, order: { status: "CONFIRMED", userId: "U1", vendorOrders: [] } },
    }));
    s.set(paymentServiceDb.payment, "findUnique", async () => ({ id: "PAYFEE", status: "PENDING", amount: 60, meta: { type: "delivery_fee" } }));
    s.set(paymentServiceDb.sSLCommerzTransaction, "update", async () => assert.fail("only the guarded fee path may update the txn"));
    // C1: the IPN path verifies currency too — a complete SSLCommerz response.
    await paymentService.confirmPayment("T1", { ...VALID, currency: "BDT", currency_type: "BDT" } as any);
    assert.deepEqual(env.calls, ["claim:PAYFEE:PENDING", "txn:T1"], "fee recorded; no order claim (trapped), no Event 0a");
  } finally {
    s.restore();
    env.restore();
  }
});

// ── controllers ─────────────────────────────────────────────────────────────

test("controller: body userId / amount are ignored — the service gets the token's identity", async () => {
  const s = stubber();
  const calls: any[] = [];
  try {
    s.set(paymentService, "processDeliveryFeePayment", async (...a: any[]) => (calls.push(a), { ok: true }));
    const res = fakeRes();
    await PaymentController.processDeliveryFee(
      { user: { id: "U1", rawId: "U1", role: "CUSTOMER" }, body: { orderId: "O1", userId: "VICTIM", amount: 1, gatewayCode: "BKASH" } } as any,
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [["O1", "U1", "BKASH"]]);
  } finally {
    s.restore();
  }
});

test("controller: refusals map to their status; missing ids → 400", async () => {
  const s = stubber();
  try {
    s.set(paymentService, "processDeliveryFeePayment", async () => {
      throw new DeliveryFeeError(404, "Order not found");
    });
    s.set(paymentService, "confirmDeliveryFeePayment", async () => {
      throw new DeliveryFeeError(400, "Payment validation does not match this transaction");
    });
    const user = { id: "U1", rawId: "U1", role: "CUSTOMER" };
    let res = fakeRes();
    await PaymentController.processDeliveryFee({ user, body: { orderId: "O1" } } as any, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, "DELIVERY_FEE_REFUSED");
    res = fakeRes();
    await PaymentController.confirmDeliveryFee({ user, body: { tranId: "T1", valId: "V" } } as any, res);
    assert.equal(res.statusCode, 400);
    res = fakeRes();
    await PaymentController.processDeliveryFee({ user, body: {} } as any, res);
    assert.equal(res.statusCode, 400);
    res = fakeRes();
    await PaymentController.confirmDeliveryFee({ user, body: { tranId: "T1" } } as any, res);
    assert.equal(res.statusCode, 400);
  } finally {
    s.restore();
  }
});
