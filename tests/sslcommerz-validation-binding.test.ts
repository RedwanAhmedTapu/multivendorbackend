// tests/sslcommerz-validation-binding.test.ts
//
// C1 — an SSLCommerz validation proves payment for ONE transaction only.
// confirmPayment refuses a validation unless (fail closed):
//   status VALID/VALIDATED · tran_id === this transaction · currency and
//   currency_type BDT · amount present and covering the payment.
// Exercised through the PRODUCTION path — PaymentController.ipn / success →
// paymentGatewayService.verifyAndConfirmByTransactionId → the real
// paymentService.validatePayment (only its HTTP call is stubbed: the stub
// answers like SSLCommerz's validation API, keyed by val_id) → the real
// confirmPayment. The database is an in-memory model; nothing is ever set to
// PAID by the fixture — every PAID below was written by the code under test.
// Network-free and DB-free:
//   npx tsx --test tests/sslcommerz-validation-binding.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";

process.env.SSLCOMMERZ_STORE_ID ??= "test-store";
process.env.SSLCOMMERZ_STORE_PASSWORD ??= "test-store-secret";
process.env.FRONTEND_URL = "https://shop.test";
const axios = (await import("axios")).default;
const { paymentServiceDb, sslcommerzValidationMismatch } = await import("../src/services/payment.service.ts");
const { paymentGatewayDb } = await import("../src/services/payment-gateway.service.ts");
const { PaymentController } = await import("../src/controllers/payment.controller.ts");
const { AccountingService } = await import("../src/services/accounting.services.ts");
const { prisma: sharedDb } = await import("../src/config/prisma.ts");

type Row = Record<string, any>;

/** What SSLCommerz's validation API returns for a successful BDT payment of `tranId`. */
const validation = (tranId: string, valId: string, over: Row = {}): Row => ({
  status: "VALID", tran_id: tranId, val_id: valId, amount: "1500.00", store_amount: "1462.50",
  currency: "BDT", currency_type: "BDT", currency_amount: "1500.00", bank_tran_id: `BANK_${valId}`, card_type: "BKASH-BKash",
  risk_level: "0", risk_title: "Safe", ...over,
});

// ── pure rule ───────────────────────────────────────────────────────────────

test("sslcommerzValidationMismatch: only a complete validation for THIS transaction, in BDT, covering the amount passes", () => {
  const ok = validation("T1", "V1");
  const exp = { tranId: "T1", amount: new Decimal("1500") };
  assert.equal(sslcommerzValidationMismatch(ok, exp), null);
  assert.equal(sslcommerzValidationMismatch({ ...ok, status: "VALIDATED" }, exp), null, "a re-validated val_id of THIS transaction (duplicate callback)");
  assert.equal(sslcommerzValidationMismatch({ ...ok, amount: "1520.00" }, exp), null, "gateway charges: over-payment allowed");
  assert.equal(sslcommerzValidationMismatch({ ...ok, amount: "1499.99" }, exp), null, "0.01 rounding tolerance");
  const refused: [string, Row | null, RegExp][] = [
    ["no response", null, /no validation response/],
    ["status FAILED", { ...ok, status: "FAILED" }, /status is FAILED/],
    ["status INVALID_TRANSACTION", { ...ok, status: "INVALID_TRANSACTION" }, /status/],
    ["status missing", { ...ok, status: undefined }, /status is missing/],
    ["tran_id of another transaction", { ...ok, tran_id: "T2" }, /does not match/],
    ["tran_id missing", { ...ok, tran_id: undefined }, /tran_id is missing/],
    ["tran_id empty", { ...ok, tran_id: "" }, /tran_id is missing/],
    ["tran_id differs only in case", { ...ok, tran_id: "t1" }, /does not match/],
    ["currency USD", { ...ok, currency: "USD" }, /currency is USD/],
    ["currency missing", { ...ok, currency: undefined }, /currency is missing/],
    ["currency_type USD", { ...ok, currency_type: "USD" }, /currency_type is USD/],
    ["currency_type missing", { ...ok, currency_type: undefined }, /currency_type is missing/],
    ["amount missing", { ...ok, amount: undefined }, /amount is missing/],
    ["amount not a number", { ...ok, amount: "abc" }, /amount is missing/],
    ["under-payment", { ...ok, amount: "1499.98" }, /less than/],
    ["under-payment (empty amount)", { ...ok, amount: "" }, /less than/],
  ];
  for (const [label, v, re] of refused) assert.match(String(sslcommerzValidationMismatch(v as any, exp)), re, label);
  assert.match(String(sslcommerzValidationMismatch(ok, { tranId: "", amount: 1500 })), /does not match/, "no expected transaction");
  assert.match(String(sslcommerzValidationMismatch(ok, { tranId: "T1", amount: undefined })), /expected amount is unknown/);
});

// ── production path harness ─────────────────────────────────────────────────

/** Two PENDING prepaid orders, each with one SSLCommerz transaction (T1 → O1, T2 → O2). */
function world() {
  const order = (id: string) => ({ id, userId: `U_${id}`, status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", totalAmount: 1500 }) as Row;
  return {
    orders: { O1: order("O1"), O2: order("O2") } as Record<string, Row>,
    vendorOrders: [
      { id: "VO1", orderId: "O1", vendorId: "V1", status: "PENDING", items: [{ id: "OI1", allocations: [{ id: "AL1" }] }] },
      { id: "VO2", orderId: "O2", vendorId: "V2", status: "PENDING", items: [{ id: "OI2", allocations: [{ id: "AL2" }] }] },
    ] as Row[],
    payments: {
      PAY1: { id: "PAY1", orderId: "O1", status: "PENDING", amount: new Decimal("1500"), method: "SSLCOMMERZ", meta: { type: "order_payment" }, paymentProviderId: null },
      PAY2: { id: "PAY2", orderId: "O2", status: "PENDING", amount: new Decimal("1500"), method: "SSLCOMMERZ", meta: { type: "order_payment" }, paymentProviderId: null },
    } as Record<string, Row>,
    txns: { T1: { tranId: "T1", paymentId: "PAY1", status: "PENDING" }, T2: { tranId: "T2", paymentId: "PAY2", status: "PENDING" } } as Record<string, Row>,
    /** SSLCommerz's side: val_id → validation response. */
    gateway: { V1: validation("T1", "V1"), V2: validation("T2", "V2") } as Record<string, Row>,
    validatedOnce: new Set<string>(),
    gatewayCalls: [] as string[],
    events: [] as string[],
  };
}
type World = ReturnType<typeof world>;
const liveFilter = (a: Row = {}) => (v: Row) => { const not = a.select?.vendorOrders?.where?.status?.not; return not === undefined || v.status !== not; };
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => row[k] === v);

function install(w: World) {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const state = () => JSON.stringify({ orders: w.orders, vendorOrders: w.vendorOrders, payments: w.payments, txns: w.txns });

  // SSLCommerz validation API (the only network call validatePayment makes). Like the real API,
  // a val_id answers VALID the first time and VALIDATED afterwards.
  set(axios, "get", async (url: string, cfg: Row) => {
    assert.match(url, /\/validator\/api\/validationserverAPI\.php$/, "only the validation API may be called");
    const valId = String(cfg?.params?.val_id);
    w.gatewayCalls.push(valId);
    const v = w.gateway[valId];
    if (!v) return { data: { status: "INVALID_TRANSACTION" } };
    const status = w.validatedOnce.has(valId) && v.status === "VALID" ? "VALIDATED" : v.status;
    w.validatedOnce.add(valId);
    return { data: { ...v, status } };
  });
  set(axios, "post", async () => assert.fail("no POST to any gateway"));

  set(paymentGatewayDb.sSLCommerzTransaction, "findUnique", async ({ where }: Row) => (w.txns[where.tranId] ? { tranId: where.tranId } : null));
  const db = paymentServiceDb as any;
  set(db.sSLCommerzTransaction, "findUnique", async ({ where }: Row) => {
    const t = w.txns[where.tranId];
    if (!t) return null;
    const p = w.payments[t.paymentId];
    const o = w.orders[p.orderId];
    return { ...t, payment: { ...p, order: { ...o, vendorOrders: w.vendorOrders.filter((v) => v.orderId === o.id).map((v) => ({ ...v, items: [] })) } } };
  });
  set(db.sSLCommerzTransaction, "update", async ({ where, data }: Row) => (Object.assign(w.txns[where.tranId], data), { ...w.txns[where.tranId] }));
  set(db.payment, "findUnique", async ({ where }: Row) => (w.payments[where.id] ? { ...w.payments[where.id] } : null));
  set(db.payment, "findUniqueOrThrow", async ({ where }: Row) => ({ ...w.payments[where.id] }));
  set(db.payment, "update", async ({ where, data }: Row) => (Object.assign(w.payments[where.id], data), { ...w.payments[where.id] }));
  // The order's payment rows (Phase 5 reconciliation reads them).
  set(db.payment, "findMany", async ({ where }: Row) => Object.values(w.payments).filter((p: Row) => p.orderId === where?.orderId).map((p: Row) => ({ ...p })));
  set(db.order, "updateMany", async ({ where, data }: Row) => {
    const o = w.orders[where.id];
    if (!o || !matches(o, where)) return { count: 0 };
    Object.assign(o, data);
    return { count: 1 };
  });
  // Also answers the H1 reservation read (placement left the stock reserved).
  set(db.order, "findUnique", async (args: Row) => ({
    reservationReleasedAt: null,
    ...w.orders[args.where.id],
    vendorOrders: w.vendorOrders.filter((v) => v.orderId === args.where.id && liveFilter(args)(v)).map((v) => ({ items: v.items })),
  }));
  set(db, "$executeRaw", async () => 1); // H1 row lock
  set(db.auditLog, "create", async ({ data }: Row) => data);
  set(db.vendorOrder, "updateMany", async ({ where, data }: Row) => {
    const rows = w.vendorOrders.filter((v) => matches(v, where));
    rows.forEach((v) => Object.assign(v, data));
    return { count: rows.length };
  });
  set(db, "$transaction", async (fn: any) => {
    const before = state();
    try {
      return await fn(db);
    } catch (e) {
      const s = JSON.parse(before);
      w.orders = s.orders;
      w.vendorOrders = s.vendorOrders;
      w.txns = s.txns;
      w.payments = Object.fromEntries(Object.entries(s.payments as Record<string, Row>).map(([k, p]) => [k, { ...p, amount: new Decimal(p.amount) }]));
      throw e;
    }
  });
  for (const model of ["warehouseStock", "productVariant", "stockMovement", "orderItemAllocation"]) {
    for (const m of ["update", "updateMany", "create", "delete", "deleteMany"]) set(db[model], m, async () => assert.fail(`unexpected ${model}.${m}`));
  }
  set(AccountingService.prototype, "createEvent0aOnlinePayment", async (d: Row) => (w.events.push(`0a:${d.orderId}`), { id: "V0A" }));
  set(sharedDb.user, "findFirst", async () => ({ id: "U_SYSTEM" }));
  return { state, restore: () => restores.reverse().forEach((r) => r()) };
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, redirectedTo: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.send = (b: unknown) => ((res.body = b), res);
  res.redirect = (url: string) => ((res.redirectedTo = url), res);
  return res;
}
const ipn = async (body: Row) => {
  const res = fakeRes();
  await PaymentController.ipn({ body } as any, res);
  return res;
};
const successPost = async (body: Row) => {
  const res = fakeRes();
  await PaymentController.success({ body, query: {} } as any, res);
  return res;
};
const summary = (w: World, orderId: string, payId: string, tranId: string) =>
  [w.orders[orderId].status, w.orders[orderId].paymentStatus, w.payments[payId].status, w.txns[tranId].status, w.vendorOrders.find((v) => v.orderId === orderId)!.status].join(" ");

/** Runs `fn` and asserts it changed nothing at all (order, sub-orders, payments, transactions, ledger). */
async function unchanged(w: World, h: { state: () => string }, fn: () => Promise<any>) {
  const before = h.state();
  const events = w.events.length;
  const out = await fn();
  assert.equal(h.state(), before, "nothing written");
  assert.equal(w.events.length, events, "no Event 0a");
  return out;
}

// ── IPN ─────────────────────────────────────────────────────────────────────

test("IPN, matching validation: the order, its sub-order and the payment are confirmed once (Event 0a once)", async () => {
  const w = world();
  const h = install(w);
  try {
    const res = await ipn({ tran_id: "T1", val_id: "V1", status: "VALID" });
    assert.equal(res.statusCode, 200, String(res.body));
    assert.equal(summary(w, "O1", "PAY1", "T1"), "CONFIRMED PAID PAID SUCCESS CONFIRMED");
    assert.equal(summary(w, "O2", "PAY2", "T2"), "PENDING PENDING PENDING PENDING PENDING", "the other order is untouched");
    assert.deepEqual(w.events, ["0a:O1"]);
    assert.deepEqual(w.gatewayCalls, ["V1"], "verified with the gateway, by val_id");
  } finally {
    h.restore();
  }
});

test("IPN with a valid val_id of ANOTHER transaction: refused, nothing written", async () => {
  const w = world();
  const h = install(w);
  try {
    // O1 was really paid (V1 belongs to T1). The attacker posts T2 with V1.
    const res = await unchanged(w, h, () => ipn({ tran_id: "T2", val_id: "V1", status: "VALID" }));
    assert.equal(res.statusCode, 400);
    assert.match(String(res.body), /tran_id T1 does not match this transaction \(T2\)/);
  } finally {
    h.restore();
  }
});

test("replay: the same val_id (now VALIDATED) confirms nothing new for its own transaction and nothing at all for another", async () => {
  const w = world();
  const h = install(w);
  try {
    assert.equal((await ipn({ tran_id: "T1", val_id: "V1" })).statusCode, 200);
    // Browser return + IPN duplicate: same transaction, re-validated → idempotent, no new writes.
    const dup = await unchanged(w, h, () => ipn({ tran_id: "T1", val_id: "V1" }));
    assert.equal(dup.statusCode, 200);
    assert.deepEqual(w.gatewayCalls, ["V1", "V1"]);
    // Replay against another order.
    const replay = await unchanged(w, h, () => ipn({ tran_id: "T2", val_id: "V1" }));
    assert.equal(replay.statusCode, 400);
    assert.equal(summary(w, "O2", "PAY2", "T2"), "PENDING PENDING PENDING PENDING PENDING");
    assert.deepEqual(w.events, ["0a:O1"], "exactly one Event 0a overall");
  } finally {
    h.restore();
  }
});

test("IPN: amount, currency, status and missing-field mismatches are all refused with nothing written", async () => {
  const cases: [string, Row, RegExp][] = [
    ["under-payment", { amount: "1000.00", currency_amount: "1000.00" }, /less than/],
    ["currency USD", { currency: "USD" }, /currency is USD/],
    ["currency_type USD", { currency_type: "USD" }, /currency_type is USD/],
    ["tran_id missing", { tran_id: undefined }, /tran_id is missing/],
    ["amount missing", { amount: undefined }, /amount is missing/],
    ["currency missing", { currency: undefined }, /currency is missing/],
    ["currency_type missing", { currency_type: undefined }, /currency_type is missing/],
  ];
  for (const [label, over, re] of cases) {
    const w = world();
    w.gateway.V1 = validation("T1", "V1", over);
    const h = install(w);
    try {
      const res = await unchanged(w, h, () => ipn({ tran_id: "T1", val_id: "V1" }));
      assert.equal(res.statusCode, 400, label);
      assert.match(String(res.body), re, label);
    } finally {
      h.restore();
    }
  }
});

test("IPN: an unknown val_id (gateway INVALID_TRANSACTION) or no val_id at all confirms nothing", async () => {
  const w = world();
  const h = install(w);
  try {
    assert.equal((await unchanged(w, h, () => ipn({ tran_id: "T1", val_id: "FORGED" }))).statusCode, 400);
    assert.equal((await unchanged(w, h, () => ipn({ tran_id: "T1" }))).statusCode, 400, "val_id is required");
    assert.deepEqual(w.gatewayCalls, ["FORGED"], "no gateway call without a val_id");
  } finally {
    h.restore();
  }
});

// ── success callback (browser return) ───────────────────────────────────────

test("success callback enforces the same rule: foreign val_id → /payment/failed and nothing written; matching → /payment/success", async () => {
  const w = world();
  const h = install(w);
  try {
    const foreign = await unchanged(w, h, () => successPost({ tran_id: "T2", val_id: "V1" }));
    assert.equal(foreign.redirectedTo, "https://shop.test/payment/failed");
    const ok = await successPost({ tran_id: "T1", val_id: "V1" });
    assert.equal(ok.redirectedTo, "https://shop.test/payment/success?tran_id=T1");
    assert.equal(summary(w, "O1", "PAY1", "T1"), "CONFIRMED PAID PAID SUCCESS CONFIRMED");
    // GET return without a val_id (query only) can never confirm.
    const res = fakeRes();
    await unchanged(w, h, () => PaymentController.success({ body: {}, query: { tran_id: "T2" } } as any, res));
    assert.equal(res.redirectedTo, "https://shop.test/payment/failed");
  } finally {
    h.restore();
  }
});
