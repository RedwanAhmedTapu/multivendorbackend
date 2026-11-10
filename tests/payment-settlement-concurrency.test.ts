// tests/payment-settlement-concurrency.test.ts
//
// Phase 6 / Priority 1: concurrent verified payments for ONE order.
// Root cause fixed: every gateway posted Event 0a before taking the order lock
// (after an unlocked pre-check), so two sessions verified at the same moment
// both posted a receipt; with different providers (different engine keys) the
// order ended up with two receipts, one of them for money later recorded as
// unapplied. Settlement now decides AND posts Event 0a under one order lock
// (payment-settlement.ts), so:
//   - two different sessions (SSLCommerz + PayStation, or + EPS) → exactly one
//     receipt, one PAID payment, the other recorded (never discarded);
//   - duplicate callbacks for the same payment → one receipt, no marker;
//   - a cancellation or shipment that lands first → recorded, NO receipt;
//   - an accounting failure rolls the whole settlement back; a retry succeeds;
//   - the lock is FOR NO KEY UPDATE (the voucher FK insert isn't blocked).
// The fake lock is a real mutex per order; the fake accounting engine yields
// mid-post to widen any race window. DB-free; no gateway is called:
//   npx tsx --test tests/payment-settlement-concurrency.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

const { paymentService, paymentServiceDb } = await import("../src/services/payment.service.ts");
const { paymentGatewayService, paymentGatewayDb } = await import("../src/services/payment-gateway.service.ts");
const { AccountingService } = await import("../src/services/accounting.services.ts");
const { paystationService } = await import("../src/services/paystation.service.ts");
const { epsService } = await import("../src/services/eps.service.ts");
const { prisma: sharedDb } = await import("../src/config/prisma.ts");

type Row = Record<string, any>;
const VALID = (tran: string) => ({ status: "VALID", tran_id: tran, val_id: `VAL_${tran}`, amount: "1500.00", currency: "BDT", currency_type: "BDT", currency_amount: "1500.00", bank_tran_id: `BANK_${tran}` });
const tick = () => new Promise((r) => setTimeout(r, 5));
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => row[k] === v);

function world(order: Row = {}) {
  return {
    order: { id: "O1", userId: "U1", status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", reservationReleasedAt: null, ...order } as Row,
    vendorOrders: [{ id: "VO1", orderId: "O1", status: "PENDING", items: [{ id: "OI1", allocations: [{ id: "AL1" }] }] }] as Row[],
    payments: {
      PAY_SSL: { id: "PAY_SSL", orderId: "O1", status: "PENDING", amount: 1500, method: "SSLCOMMERZ", meta: { type: "order_payment" }, paymentProviderId: "PROV_SSL" },
      PAY_PS: { id: "PAY_PS", orderId: "O1", status: "PENDING", amount: 1500, method: "PAYSTATION", meta: { type: "order_payment", invoiceNumber: "INV_PS" }, paymentProviderId: "PROV_PS" },
      PAY_EPS: { id: "PAY_EPS", orderId: "O1", status: "PENDING", amount: 1500, method: "EPS", meta: { type: "order_payment", merchantTransactionId: "EPS_1" }, paymentProviderId: "PROV_EPS" },
    } as Record<string, Row>,
    txns: { T_SSL: { tranId: "T_SSL", paymentId: "PAY_SSL", status: "PENDING" } } as Record<string, Row>,
    vouchers: new Map<string, number>(), // engine idempotency key → posts that created it
    postings: [] as Row[], // every Event 0a call that created a voucher (args)
    lockSql: [] as string[],
    audits: [] as string[],
  };
}
type World = ReturnType<typeof world>;

/** Per-order mutex standing in for the row lock. */
function mutex() {
  const tails = new Map<string, Promise<void>>();
  return async (key: string) => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    tails.set(key, prev.then(() => next));
    await prev;
    return release;
  };
}

function install(w: World, opts: { failAccountingOnce?: boolean } = {}) {
  const restores: (() => void)[] = [];
  const set = (o: any, k: string, v: any) => {
    const orig = o[k];
    o[k] = v;
    restores.push(() => (o[k] = orig));
  };
  const acquire = mutex();
  const snapshot = () => JSON.stringify({ order: w.order, vendorOrders: w.vendorOrders, payments: w.payments, txns: w.txns, audits: w.audits });
  let failAccounting = !!opts.failAccountingOnce;
  for (const db of [paymentServiceDb, paymentGatewayDb, sharedDb] as any[]) {
    for (const model of ["warehouseStock", "productVariant", "stockMovement", "orderItemAllocation"]) {
      for (const m of ["update", "updateMany", "create", "upsert", "delete", "deleteMany"]) set(db[model], m, async () => assert.fail(`unexpected ${model}.${m}`));
    }
    set(db.order, "update", async () => assert.fail("unguarded order.update"));
    set(db.order, "updateMany", async ({ where, data }: Row) => (matches(w.order, where) ? (Object.assign(w.order, data), { count: 1 }) : { count: 0 }));
    set(db.order, "findUnique", async () => ({ ...w.order, vendorOrders: w.vendorOrders.map((v) => ({ items: v.items })) }));
    set(db.vendorOrder, "updateMany", async ({ where, data }: Row) => {
      const rows = w.vendorOrders.filter((v) => matches(v, where));
      rows.forEach((v) => Object.assign(v, data));
      return { count: rows.length };
    });
    set(db.payment, "findUnique", async ({ where }: Row) => (w.payments[where.id] ? { ...w.payments[where.id] } : null));
    set(db.payment, "findUniqueOrThrow", async ({ where }: Row) => ({ ...w.payments[where.id] }));
    set(db.payment, "findMany", async ({ where }: Row) => Object.values(w.payments).filter((p) => p.orderId === where?.orderId).map((p) => ({ ...p })));
    set(db.payment, "update", async ({ where, data }: Row) => (Object.assign(w.payments[where.id], data), { ...w.payments[where.id] }));
    set(db.payment, "findFirst", async ({ where }: Row) => {
      const p = Object.values(w.payments).find((x) => where?.meta && x.meta?.[where.meta.path[0]] === where.meta.equals);
      return p ? { ...p, paymentProvider: { id: p.paymentProviderId, payment_credentials: [{ environment: "SANDBOX" }, { environment: "PRODUCTION" }] } } : null;
    });
    set(db.auditLog, "create", async ({ data }: Row) => (w.audits.push(data.action), data));
    set(db, "$transaction", async (fn: any) => {
      const releases: (() => void)[] = [];
      const tx = Object.create(db);
      tx.$executeRaw = async (strings: TemplateStringsArray, ...vals: any[]) => {
        w.lockSql.push(strings.join("?"));
        releases.push(await acquire(String(vals[0])));
        return 1;
      };
      const before = snapshot();
      try {
        return await fn(tx);
      } catch (e) {
        Object.assign(w, JSON.parse(before));
        throw e;
      } finally {
        releases.forEach((r) => r());
      }
    });
  }
  set(paymentServiceDb.sSLCommerzTransaction, "findUnique", async ({ where }: Row) => {
    const t = w.txns[where.tranId];
    return t ? { ...t, payment: { ...w.payments[t.paymentId], order: { ...w.order, vendorOrders: [] } } } : null;
  });
  set(paymentServiceDb.sSLCommerzTransaction, "update", async ({ where, data }: Row) => (Object.assign(w.txns[where.tranId], data), { ...w.txns[where.tranId] }));
  set(paymentGatewayDb.sSLCommerzTransaction, "findUnique", async ({ where }: Row) => (w.txns[where.tranId] ? { ...w.txns[where.tranId] } : null));
  // The engine: idempotent per ORDER_PLACED:SSLCommerz:<order>:<provider> — yields mid-post.
  set(AccountingService.prototype, "createEvent0aOnlinePayment", async (d: Row) => {
    await tick();
    if (failAccounting) {
      failAccounting = false;
      throw new Error("ledger unavailable");
    }
    const key = `ORDER_PLACED:SSLCommerz:${d.orderId}:${d.paymentGatewayId}`;
    if (!w.vouchers.has(key)) (w.vouchers.set(key, 1), w.postings.push({ ...d, amount: Number(d.amount) }));
    return { id: key };
  });
  set(sharedDb.user, "findFirst", async () => ({ id: "U_SYSTEM" }));
  set(paystationService, "checkTransactionStatus", async () => (await tick(), { status: "success", paymentAmount: 1500, trxId: "TRX_PS", paymentMethod: "bkash", raw: {} }));
  set(epsService, "checkTransactionStatus", async () => (await tick(), { status: "Success", raw: {} }));
  return { restore: () => restores.reverse().forEach((r) => r()) };
}
const ssl = () => paymentService.confirmPayment("T_SSL", VALID("T_SSL") as any);
const ps = () => paymentGatewayService.handlePaystationCallback("INV_PS", "");
const eps = () => paymentGatewayService.verifyAndConfirmByTransactionId("EPS_1");
const paidCount = (w: World) => Object.values(w.payments).filter((p) => p.status === "PAID").length;
const recorded = (w: World) => Object.values(w.payments).filter((p) => p.meta?.reconciliation).map((p) => `${p.id}:${p.meta.reconciliation.reason}`);

test("two DIFFERENT sessions (SSLCommerz + PayStation, different providers) verified at once: ONE receipt, one PAID, the other recorded", async () => {
  for (const order of [[ssl, ps], [ps, ssl]] as const) {
    const w = world();
    const s = install(w);
    try {
      await Promise.all(order.map((f) => f()));
      assert.equal(w.vouchers.size, 1, `one Event 0a receipt, got ${[...w.vouchers.keys()].join(", ")}`);
      assert.equal(paidCount(w), 1);
      assert.equal(recorded(w).length, 1);
      assert.match(recorded(w)[0], /ORDER_ALREADY_PAID$/);
      assert.deepEqual([w.order.status, w.order.paymentStatus, w.vendorOrders[0].status], ["CONFIRMED", "PAID", "CONFIRMED"]);
      const winner = Object.values(w.payments).find((p) => p.status === "PAID")!;
      assert.ok([...w.vouchers.keys()][0].endsWith(winner.paymentProviderId), "the receipt belongs to the applied payment");
    } finally {
      s.restore();
    }
  }
});

test("three sessions incl. EPS at once: one applied, two recorded, at most one receipt", async () => {
  const w = world();
  const s = install(w);
  try {
    await Promise.all([eps(), ssl(), ps()]);
    assert.equal(paidCount(w), 1);
    assert.equal(recorded(w).length, 2);
    assert.ok(w.vouchers.size <= 1, "never two receipts");
    assert.equal(w.order.status, "CONFIRMED");
  } finally {
    s.restore();
  }
});

test("duplicate callbacks for the SAME payment (return URL + IPN + retry) at once: one receipt, applied once, never recorded as unapplied", async () => {
  const w = world();
  const s = install(w);
  try {
    await Promise.all([ssl(), ssl(), ssl()]);
    assert.equal(w.vouchers.size, 1);
    assert.equal(w.payments.PAY_SSL.status, "PAID");
    assert.deepEqual(recorded(w), []);
    assert.equal(w.audits.filter((a) => a === "PAYMENT_RECEIVED_NOT_APPLIED").length, 0);
  } finally {
    s.restore();
  }
});

test("a cancellation that takes the order lock first: the late payment is recorded with NO receipt", async () => {
  const w = world();
  const s = install(w);
  try {
    // the cancellation holds the order lock while the payment callback arrives
    let cancelled!: () => void;
    const cancel = (paymentServiceDb as any).$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT "id" FROM "orders" WHERE "id" = ${"O1"} FOR UPDATE`;
      await new Promise<void>((r) => (cancelled = r));
      w.order.status = "CANCELLED";
      w.vendorOrders[0].status = "CANCELLED";
    });
    await tick();
    const pay = ssl();
    await tick();
    cancelled();
    await Promise.all([cancel, pay]);
    assert.equal(w.vouchers.size, 0, "no receipt for money the order can no longer take");
    assert.deepEqual(recorded(w), ["PAY_SSL:ORDER_CANCELLED"]);
    assert.deepEqual([w.order.status, w.payments.PAY_SSL.status], ["CANCELLED", "PENDING"]);
  } finally {
    s.restore();
  }
});

test("callbacks after shipment / after cancellation (no race): recorded, no receipt, status never moved", async () => {
  for (const [order, f] of [[{ status: "SHIPPED", paymentStatus: "PAID" }, ps], [{ status: "CANCELLED" }, ssl], [{ status: "SHIPPED", paymentStatus: "PAID" }, eps]] as const) {
    const w = world(order);
    if (order.paymentStatus === "PAID") Object.assign(w.payments.PAY_SSL, f === ssl ? {} : { status: "PAID" });
    const s = install(w);
    try {
      await f();
      assert.equal(w.order.status, order.status);
      assert.equal(w.vouchers.size, 0);
      assert.equal(recorded(w).length, 1, JSON.stringify(order));
    } finally {
      s.restore();
    }
  }
});

test("an accounting failure rolls the whole settlement back (nothing applied or recorded); the retry applies it once", async () => {
  const w = world();
  const s = install(w, { failAccountingOnce: true });
  try {
    await assert.rejects(ps());
    assert.deepEqual([w.order.status, w.payments.PAY_PS.status, w.vouchers.size, recorded(w).length], ["PENDING", "PENDING", 0, 0]);
    await ps();
    assert.deepEqual([w.order.status, w.payments.PAY_PS.status, w.vouchers.size], ["CONFIRMED", "PAID", 1]);
  } finally {
    s.restore();
  }
});

test("the settlement lock is FOR NO KEY UPDATE on the order (a voucher's FK insert is not blocked by it)", async () => {
  const w = world();
  const s = install(w);
  try {
    await ssl();
    assert.ok(w.lockSql.some((q) => /FROM "orders" WHERE "id" = \? FOR NO KEY UPDATE/.test(q)), w.lockSql.join(" | "));
    assert.ok(!w.lockSql.some((q) => /FOR UPDATE$/.test(q.trim()) && !/NO KEY/.test(q)), "no FOR UPDATE held while Event 0a is posted");
  } finally {
    s.restore();
  }
});

// ── Priority 4: EPS posts Event 0a like the other gateways ─────────────────

test("EPS: a verified, applied payment posts exactly one Event 0a — same function and accounts as PayStation, keyed by the EPS provider", async () => {
  const w = world();
  const s = install(w);
  try {
    await eps();
    assert.deepEqual([w.order.status, w.payments.PAY_EPS.status], ["CONFIRMED", "PAID"]);
    assert.deepEqual([...w.vouchers.keys()], ["ORDER_PLACED:SSLCommerz:O1:PROV_EPS"]);
    assert.deepEqual({ orderId: w.postings[0].orderId, amount: w.postings[0].amount, paymentGatewayId: w.postings[0].paymentGatewayId }, { orderId: "O1", amount: 1500, paymentGatewayId: "PROV_EPS" });
    await Promise.all([eps(), eps()]); // duplicate callbacks
    assert.equal(w.postings.length, 1, "one receipt for one payment");
  } finally {
    s.restore();
  }
});

test("EPS: a HELD payment (stock released) is booked like the other gateways; unapplied money is not booked", async () => {
  const held = world({ reservationReleasedAt: new Date().toISOString() });
  held.vendorOrders[0].items[0].allocations = [];
  const s1 = install(held);
  try {
    await eps();
    assert.deepEqual([held.order.status, held.order.paymentStatus, held.payments.PAY_EPS.status], ["PENDING", "PAID", "PAID"]);
    assert.equal(held.postings.length, 1);
  } finally {
    s1.restore();
  }
  const cancelled = world({ status: "CANCELLED" });
  const s2 = install(cancelled);
  try {
    await eps();
    assert.equal(cancelled.postings.length, 0);
    assert.equal(cancelled.payments.PAY_EPS.meta.reconciliation.reason, "ORDER_CANCELLED");
  } finally {
    s2.restore();
  }
});

test("EPS: an Event 0a failure rolls the settlement back (not PAID, order PENDING); the retry books it once", async () => {
  const w = world();
  const s = install(w, { failAccountingOnce: true });
  try {
    await assert.rejects(eps());
    assert.deepEqual([w.order.status, w.payments.PAY_EPS.status, w.postings.length], ["PENDING", "PENDING", 0]);
    await eps();
    assert.deepEqual([w.order.status, w.payments.PAY_EPS.status, w.postings.length], ["CONFIRMED", "PAID", 1]);
  } finally {
    s.restore();
  }
});
