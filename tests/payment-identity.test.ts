// tests/payment-identity.test.ts
//
// Phase 5 / Step 4: the customer identity a payment carries comes from the
// ORDER (its owner), never from a request-body `userId`.
//   - POST /payment/init with a mismatched body userId: the real SSLCommerz
//     initialiser records customerId = the order's customer and posts
//     value_b = the order's customer (the gateway echoes it; refunds copy
//     SSLCommerzTransaction.customerId into RefundRecord.customerId);
//   - PayStation receives optB = the order's customer;
//   - staff-initiated payments carry the order's customer too;
//   - authorisation is unchanged: another customer is still refused (403).
// DB-free; the gateway HTTP calls are stubbed (axios / paystationService):
//   npx tsx --test tests/payment-identity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

const { paymentServiceDb } = await import("../src/services/payment.service.ts");
const { paymentGatewayService, paymentGatewayDb } = await import("../src/services/payment-gateway.service.ts");
const { paystationService } = await import("../src/services/paystation.service.ts");
const { prisma: sharedDb } = await import("../src/config/prisma.ts");
const { PaymentController } = await import("../src/controllers/payment.controller.ts");
const { payNowDeps } = await import("../src/services/pay-now.service.ts");

type Row = Record<string, any>;
const OWNER = "U_OWNER";

function install(opts: { gateway?: "SSLCOMMERZ" | "PAYSTATION"; orderUserId?: string | null } = {}) {
  const restores: (() => void)[] = [];
  const set = (o: any, k: string, v: any) => {
    const orig = o[k];
    o[k] = v;
    restores.push(() => (o[k] = orig));
  };
  const seen = { sslTxn: [] as Row[], posted: [] as URLSearchParams[], paystation: [] as Row[], initiated: [] as Row[] };
  const userId = opts.orderUserId === undefined ? OWNER : opts.orderUserId;
  // authorisation (resolveOrderAccess) and the lock transaction read the order
  set(sharedDb.order, "findUnique", async () => ({ id: "O1", userId, vendorOrders: [{ vendorId: "V1" }] }));
  set(payNowDeps, "db", {
    $transaction: async (fn: any) =>
      fn({
        $executeRaw: async () => 1,
        order: { findUnique: async () => ({ userId, status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", reservationReleasedAt: null, vendorOrders: [], payments: [] }) },
      }),
  });
  const realInitiate = payNowDeps.initiate;
  set(payNowDeps, "initiate", async (p: Row) => (seen.initiated.push(p), realInitiate(p as any)));
  // the active gateway
  set(paymentGatewayService, "getActiveProvider", async () => ({
    provider: { id: "GW1", name: opts.gateway ?? "SSLCOMMERZ" },
    credential: { environment: "SANDBOX", merchantId: "M", password: "P" },
  }));
  // what the real initialisers read / write
  const order = {
    id: "O1", userId, totalAmount: 1500, shippingCost: 60, user: { id: OWNER, name: "Owner", email: "o@example.com", phone: "017" },
    address: { address: "House 1", city: "Dhaka", zone: "Z", country: "Bangladesh", phone: "017", receiverFullName: "Owner" },
    vendorOrders: [{ items: [{ variant: { product: { name: "Phone", vendorId: "V1" } } }] }],
  };
  for (const db of [paymentServiceDb, paymentGatewayDb] as any[]) {
    set(db.order, "findUnique", async () => order);
    set(db.paymentProvider, "findUnique", async () => ({ id: "GW1" }));
    set(db.payment, "create", async ({ data }: Row) => ({ id: "PAY1", ...data }));
    set(db.payment, "update", async ({ data }: Row) => ({ id: "PAY1", ...data }));
    set(db.sSLCommerzTransaction, "create", async ({ data }: Row) => (seen.sslTxn.push(data), data));
    set(db.sSLCommerzTransaction, "update", async ({ data }: Row) => data);
  }
  set(axios, "post", async (_url: string, body: string) => {
    seen.posted.push(new URLSearchParams(body));
    return { data: { status: "SUCCESS", GatewayPageURL: "https://sandbox.sslcommerz.com/pay", sessionkey: "S", redirectGatewayURL: "" } };
  });
  set(axios, "get", async () => assert.fail("no GET to a gateway"));
  set(paystationService, "initializePayment", async (_p: unknown, _c: unknown, input: Row) => (seen.paystation.push(input), { paymentUrl: "https://paystation.example/pay" }));
  return { seen, restore: () => restores.reverse().forEach((r) => r()) };
}
function fakeRes() {
  const res: any = { statusCode: 200 };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}
const req = (user: Row, body: Row) => ({ user, body }) as any;

test("SSLCommerz: a mismatched body userId never reaches the gateway — customerId and value_b are the order's customer", async () => {
  const env = install();
  try {
    const res = fakeRes();
    await PaymentController.createPayment(req({ role: "CUSTOMER", rawId: OWNER }, { orderId: "O1", gatewayCode: "bkash", userId: "U_ATTACKER" }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.gatewayPageURL, "https://sandbox.sslcommerz.com/pay");
    assert.equal(env.seen.initiated[0].userId, OWNER);
    assert.equal(env.seen.sslTxn[0].customerId, OWNER, "SSLCommerzTransaction.customerId → later RefundRecord.customerId");
    assert.equal(env.seen.posted[0].get("value_b"), OWNER, "the id the gateway echoes back");
    assert.ok(!JSON.stringify(env.seen).includes("U_ATTACKER"));
  } finally {
    env.restore();
  }
});

test("missing body userId (the old 'undefined' case) and staff-initiated payments carry the order's customer too", async () => {
  for (const [user, body] of [
    [{ role: "CUSTOMER", rawId: OWNER }, { orderId: "O1", gatewayCode: "nagad" }],
    [{ role: "ADMIN", rawId: "A1" }, { orderId: "O1", gatewayCode: "", userId: "A1" }],
  ] as const) {
    const env = install();
    try {
      const res = fakeRes();
      await PaymentController.createPayment(req(user, body), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(env.seen.sslTxn[0].customerId, OWNER, user.role);
      assert.equal(env.seen.posted[0].get("value_b"), OWNER, user.role);
    } finally {
      env.restore();
    }
  }
});

test("PayStation: optB is the order's customer, not the body userId", async () => {
  const env = install({ gateway: "PAYSTATION" });
  try {
    const res = fakeRes();
    await PaymentController.createPayment(req({ role: "CUSTOMER", rawId: OWNER }, { orderId: "O1", gatewayCode: "", userId: "U_ATTACKER" }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(env.seen.paystation[0].optB, OWNER);
    assert.equal(env.seen.paystation[0].optA, "O1");
  } finally {
    env.restore();
  }
});

test("authorisation is unchanged: another customer (whatever userId they send) is refused before any gateway work", async () => {
  const env = install();
  try {
    const res = fakeRes();
    await PaymentController.createPayment(req({ role: "CUSTOMER", rawId: "U_ATTACKER" }, { orderId: "O1", gatewayCode: "bkash", userId: OWNER }), res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual([env.seen.initiated.length, env.seen.sslTxn.length, env.seen.posted.length], [0, 0, 0]);
  } finally {
    env.restore();
  }
});

test("an order without a customer account cannot open a gateway session", async () => {
  const env = install({ orderUserId: null });
  try {
    const res = fakeRes();
    await PaymentController.createPayment(req({ role: "ADMIN", rawId: "A1" }, { orderId: "O1", gatewayCode: "" }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "NOT_PAYABLE");
    assert.equal(env.seen.initiated.length, 0);
  } finally {
    env.restore();
  }
});
