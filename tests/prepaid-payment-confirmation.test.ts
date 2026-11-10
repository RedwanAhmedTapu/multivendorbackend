// tests/prepaid-payment-confirmation.test.ts
//
// Prepaid orders: a VERIFIED online payment confirms the master order AND its
// vendor sub-orders (previously the sub-orders stayed PENDING, and the vendor
// could not start fulfilment — CONFIRMED → PROCESSING is the vendor's first
// step). Covered:
//   - SSLCommerz success: master CONFIRMED/PAID, every PENDING sub-order of a
//     multi-vendor order CONFIRMED in the same transaction, a CANCELLED
//     sub-order left alone; Event 0a posted once; no stock writes;
//   - the vendor can then move its sub-order CONFIRMED → PROCESSING;
//   - duplicate callbacks (already PAID / racing winner) write nothing more;
//   - failed payment: nothing confirmed, stock released, no Event 0a;
//   - not verified / under-paid / cancelled order / accounting failure:
//     nothing confirmed;
//   - EPS and PayStation success paths confirm the sub-orders too.
// DB-free and network-free: the Prisma clients, the gateway status checks and
// the accounting engine are stubbed; any unexpected stock write fails the test.
//   npx tsx --test tests/prepaid-payment-confirmation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

const { paymentService, paymentServiceDb } = await import("../src/services/payment.service.ts");
const { paymentGatewayService, paymentGatewayDb } = await import("../src/services/payment-gateway.service.ts");
const { VendorOrderService } = await import("../src/services/vendor.order.service.ts");
const { OrderService } = await import("../src/services/order.service.ts");
const { AccountingService } = await import("../src/services/accounting.services.ts");
const { epsService } = await import("../src/services/eps.service.ts");
const { paystationService } = await import("../src/services/paystation.service.ts");
const { prisma: sharedDb } = await import("../src/config/prisma.ts");

type Row = Record<string, any>;
// A complete SSLCommerz validation response for transaction T1 (C1: tran_id, amount and currency are verified).
const VALID = { status: "VALID", tran_id: "T1", val_id: "VAL1", amount: "1500.00", currency: "BDT", currency_type: "BDT", currency_amount: "1500.00", bank_tran_id: "BANK1", card_type: "VISA" };

/** One prepaid multi-vendor order: two PENDING sub-orders (V1, V2) and one already CANCELLED (V3). */
function world(over: { order?: Row; payment?: Row } = {}) {
  return {
    order: { id: "O1", userId: "U1", status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", totalAmount: 1500, ...over.order } as Row,
    vendorOrders: [
      // Placement reserved stock: every live item has its allocation rows (the cancelled one released them).
      { id: "VO1", orderId: "O1", vendorId: "V1", status: "PENDING", items: [{ id: "OI1", allocations: [{ id: "AL1" }] }] },
      { id: "VO2", orderId: "O1", vendorId: "V2", status: "PENDING", items: [{ id: "OI2", allocations: [{ id: "AL2" }] }] },
      { id: "VO3", orderId: "O1", vendorId: "V3", status: "CANCELLED", items: [{ id: "OI3", allocations: [] }] },
    ] as Row[],
    payment: { id: "PAY1", orderId: "O1", status: "PENDING", amount: 1500, method: "SSLCOMMERZ", meta: { type: "order_payment" }, paymentProviderId: null, ...over.payment } as Row,
    txn: { tranId: "T1", paymentId: "PAY1", status: "PENDING" } as Row,
    events: [] as string[], // Event 0a postings
    released: [] as string[], // stock releases
    notifications: [] as Row[],
  };
}
type World = ReturnType<typeof world>;

const liveFilter = (a: Row = {}) => (v: Row) => { const not = a.select?.vendorOrders?.where?.status?.not; return not === undefined || v.status !== not; };
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => row[k] === v);

function stubber() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  return { set, restore: () => restores.reverse().forEach((r) => r()) };
}

/** Stubs every client the payment / vendor paths touch with an in-memory model of `w`. */
function install(w: World, opts: { failAccounting?: boolean } = {}) {
  const s = stubber();
  const snapshot = () => JSON.stringify({ order: w.order, vendorOrders: w.vendorOrders, payment: w.payment, txn: w.txn });
  const restoreFrom = (json: string) => Object.assign(w, JSON.parse(json));
  const orderWithVendors = () => ({ ...w.order, vendorOrders: w.vendorOrders.map((v) => ({ ...v, items: [] })) });

  for (const db of [paymentServiceDb, paymentGatewayDb, sharedDb] as any[]) {
    // Any stock movement from a payment confirmation is a bug.
    for (const model of ["warehouseStock", "productVariant", "stockMovement", "orderItemAllocation"]) {
      for (const m of ["update", "updateMany", "create", "upsert", "delete", "deleteMany"]) s.set(db[model], m, async () => assert.fail(`unexpected ${model}.${m}`));
    }
    s.set(db.order, "updateMany", async ({ where, data }: Row) => {
      if (!matches(w.order, where)) return { count: 0 };
      Object.assign(w.order, data);
      return { count: 1 };
    });
    s.set(db.order, "update", async ({ where, data }: Row) => {
      assert.equal(where.id, w.order.id);
      Object.assign(w.order, data);
      return { ...w.order };
    });
    // Also answers the H1 reservation read (live vendor orders with their allocation rows).
    // Honours the query's own vendorOrders filter (the real code excludes CANCELLED ones).
    s.set(db.order, "findUnique", async (a: Row = {}) => ({
      reservationReleasedAt: null,
      ...w.order,
      vendorOrders: w.vendorOrders.filter(liveFilter(a)).map((v) => ({ items: v.items ?? [] })),
    }));
    s.set(db, "$executeRaw", async () => 1); // H1 row lock
    s.set(db.auditLog, "create", async ({ data }: Row) => data);
    s.set(db.vendorOrder, "updateMany", async ({ where, data }: Row) => {
      const rows = w.vendorOrders.filter((v) => matches(v, where));
      rows.forEach((v) => Object.assign(v, data));
      return { count: rows.length };
    });
    s.set(db.payment, "findUnique", async ({ where }: Row) => (where.id === w.payment.id ? { ...w.payment } : null));
    s.set(db.payment, "findUniqueOrThrow", async () => ({ ...w.payment }));
    s.set(db.payment, "update", async ({ data }: Row) => (Object.assign(w.payment, data), { ...w.payment }));
    // The order's payment rows (Phase 5 reconciliation reads them) — this world has one.
    s.set(db.payment, "findMany", async ({ where }: Row) => (where?.orderId === w.payment.orderId ? [{ ...w.payment }] : []));
    s.set(db.notification, "create", async ({ data }: Row) => (w.notifications.push(data), data));
    s.set(db, "$transaction", async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg); // array form: the stubbed writes already ran
      const before = snapshot();
      try {
        return await arg(db);
      } catch (e) {
        restoreFrom(before); // interactive form rolls back like Postgres
        throw e;
      }
    });
  }

  // SSLCommerz tables (payment.service client).
  s.set(paymentServiceDb.sSLCommerzTransaction, "findUnique", async ({ where }: Row) =>
    where.tranId === w.txn.tranId ? { ...w.txn, payment: { ...w.payment, order: orderWithVendors() } } : null,
  );
  s.set(paymentServiceDb.sSLCommerzTransaction, "update", async ({ data }: Row) => (Object.assign(w.txn, data), { ...w.txn }));
  s.set(paymentServiceDb.payment, "findFirst", async () => ({ id: w.payment.id, status: w.payment.status, orderId: w.payment.orderId }));
  s.set(paymentGatewayDb.sSLCommerzTransaction, "findUnique", async () => null);
  // EPS / PayStation lookups by Payment.meta (payment-gateway client).
  s.set(paymentGatewayDb.payment, "findFirst", async ({ where }: Row) =>
    w.payment.meta?.[where.meta.path[0]] === where.meta.equals
      ? { ...w.payment, paymentProvider: { id: "GW1", payment_credentials: [{ environment: "SANDBOX" }, { environment: "PRODUCTION" }] } }
      : null,
  );

  // Accounting engine (Event 0a) and the system actor lookup.
  s.set(AccountingService.prototype, "createEvent0aOnlinePayment", async (d: Row) => {
    if (opts.failAccounting) throw new Error("ledger unavailable");
    w.events.push(`0a:${d.orderId}:${Number(d.amount)}`);
    return { id: "V0A" };
  });
  s.set(sharedDb.user, "findFirst", async () => ({ id: "U_SYSTEM" }));
  s.set(OrderService.prototype, "releaseStockForOrder", async (orderId: string) => (w.released.push(orderId), { released: 2 }));
  return s;
}

const statuses = (w: World) => w.vendorOrders.map((v) => `${v.id}:${v.status}`);

// ── SSLCommerz ──────────────────────────────────────────────────────────────

test("verified SSLCommerz payment: master CONFIRMED/PAID and every PENDING sub-order CONFIRMED; a cancelled one stays cancelled", async () => {
  const w = world();
  const s = install(w);
  try {
    await paymentService.confirmPayment("T1", VALID as any);
    assert.deepEqual([w.order.status, w.order.paymentStatus], ["CONFIRMED", "PAID"]);
    assert.deepEqual(statuses(w), ["VO1:CONFIRMED", "VO2:CONFIRMED", "VO3:CANCELLED"], "multi-vendor: both live sub-orders confirmed, the cancelled one untouched");
    assert.equal(w.payment.status, "PAID");
    assert.equal(w.txn.status, "SUCCESS");
    assert.deepEqual(w.events, ["0a:O1:1500"], "Event 0a posted exactly once");
    assert.deepEqual(w.released, [], "stock is neither released nor deducted at payment time");
  } finally {
    s.restore();
  }
});

test("after a verified payment the vendor can start fulfilment (CONFIRMED → PROCESSING)", async () => {
  const w = world();
  const s = install(w);
  s.set(sharedDb.vendorOrder, "findUnique", async ({ where }: Row) => ({ ...w.vendorOrders.find((v) => v.id === where.id) }));
  s.set(sharedDb.vendorOrder, "findMany", async ({ where }: Row) => w.vendorOrders.filter((v) => matches(v, where)).map((v) => ({ status: v.status })));
  s.set(sharedDb.vendorOrder, "findUniqueOrThrow", async ({ where }: Row) => ({ ...w.vendorOrders.find((v) => v.id === where.id) }));
  try {
    await paymentService.confirmPayment("T1", VALID as any);
    const updated = await VendorOrderService.updateStatus("VO1", "V1", "PROCESSING");
    assert.equal(updated.status, "PROCESSING");
    assert.deepEqual(statuses(w), ["VO1:PROCESSING", "VO2:CONFIRMED", "VO3:CANCELLED"]);
    assert.equal(w.order.status, "CONFIRMED", "master reflects the least-advanced live sub-order");
  } finally {
    s.restore();
  }
});

test("duplicate success callback (payment already PAID): nothing is written again", async () => {
  const w = world();
  const s = install(w);
  try {
    await paymentService.confirmPayment("T1", VALID as any);
    const after = JSON.stringify([w.order, w.vendorOrders, w.payment]);
    await paymentService.confirmPayment("T1", VALID as any); // IPN + browser return
    assert.equal(JSON.stringify([w.order, w.vendorOrders, w.payment]), after);
    assert.deepEqual(w.events, ["0a:O1:1500"], "no second Event 0a");
  } finally {
    s.restore();
  }
});

test("racing duplicate (the winner already confirmed the order while this payment row read PENDING): converges without writing", async () => {
  const w = world({ order: { status: "CONFIRMED", paymentStatus: "PAID" } });
  w.vendorOrders[0].status = "PROCESSING"; // the vendor already moved on
  w.vendorOrders[1].status = "CONFIRMED";
  const s = install(w);
  try {
    await paymentService.confirmPayment("T1", VALID as any);
    assert.deepEqual(statuses(w), ["VO1:PROCESSING", "VO2:CONFIRMED", "VO3:CANCELLED"], "never moved backwards");
    assert.equal(w.payment.status, "PENDING", "the winning callback owns the payment row");
  } finally {
    s.restore();
  }
});

test("failed payment: nothing confirmed, the reservation is released, no Event 0a", async () => {
  const w = world();
  const s = install(w);
  try {
    await paymentService.handleFailedPayment("T1", "declined");
    assert.deepEqual([w.order.status, w.order.paymentStatus], ["PENDING", "PENDING"]);
    assert.deepEqual(statuses(w), ["VO1:PENDING", "VO2:PENDING", "VO3:CANCELLED"]);
    assert.equal(w.payment.status, "FAILED");
    assert.deepEqual(w.released, ["O1"]);
    assert.ok(w.order.reservationReleasedAt instanceof Date, "Pay Now can re-reserve later");
    assert.deepEqual(w.events, []);
  } finally {
    s.restore();
  }
});

test("not verified, under-paid, cancelled order or ledger failure: no order or sub-order is confirmed", async () => {
  const cases: [string, () => World, Row, Row?][] = [
    ["gateway says FAILED", () => world(), { ...VALID, status: "FAILED" }],
    ["under-payment", () => world(), { ...VALID, amount: "1400.00" }],
    ["Event 0a fails", () => world(), VALID, { failAccounting: true }],
  ];
  for (const [label, make, validation, opts] of cases) {
    const w = make();
    const s = install(w, opts);
    try {
      await assert.rejects(paymentService.confirmPayment("T1", validation as any), label);
      assert.notEqual(w.order.paymentStatus, "PAID", label);
      assert.deepEqual(statuses(w), ["VO1:PENDING", "VO2:PENDING", "VO3:CANCELLED"], label);
      assert.equal(w.payment.status, "PENDING", label);
    } finally {
      s.restore();
    }
  }
});

// ── EPS / PayStation ────────────────────────────────────────────────────────

test("order cancelled meanwhile (Phase 5): the verified money is RECORDED for reconciliation, never applied — no order, sub-order or payment status changes, no Event 0a", async () => {
  // Before Phase 5 this threw (the gateway kept retrying) and the received money was never recorded.
  const w = world({ order: { status: "CANCELLED" } });
  const s = install(w);
  try {
    await paymentService.confirmPayment("T1", VALID as any);
    assert.equal(w.order.status, "CANCELLED");
    assert.notEqual(w.order.paymentStatus, "PAID");
    assert.deepEqual(statuses(w), ["VO1:PENDING", "VO2:PENDING", "VO3:CANCELLED"]);
    assert.equal(w.payment.status, "PENDING", "not marked PAID — refund flows read PAID rows as the order's payment");
    assert.equal(w.payment.meta.reconciliation?.reason, "ORDER_CANCELLED");
    assert.deepEqual(w.events, [], "no Event 0a for unapplied money");
  } finally {
    s.restore();
  }
});

test("verified EPS payment confirms the sub-orders with the master; an unsuccessful one confirms nothing", async () => {
  for (const [gateway, expectConfirmed] of [["Success", true], ["Failed", false]] as const) {
    const w = world({ payment: { method: "EPS", meta: { merchantTransactionId: "EPS1" } } });
    const s = install(w);
    s.set(epsService, "checkTransactionStatus", async () => ({ status: gateway, raw: {} }));
    try {
      const run = paymentGatewayService.verifyAndConfirmByTransactionId("EPS1");
      if (expectConfirmed) {
        await run;
        assert.deepEqual([w.order.status, w.payment.status], ["CONFIRMED", "PAID"]);
        assert.deepEqual(statuses(w), ["VO1:CONFIRMED", "VO2:CONFIRMED", "VO3:CANCELLED"]);
      } else {
        await assert.rejects(run);
        assert.equal(w.order.status, "PENDING");
        assert.deepEqual(statuses(w), ["VO1:PENDING", "VO2:PENDING", "VO3:CANCELLED"]);
      }
    } finally {
      s.restore();
    }
  }
});

test("verified PayStation payment confirms the sub-orders with the master; a duplicate is idempotent", async () => {
  const w = world({ payment: { method: "PAYSTATION", meta: { invoiceNumber: "INV1" } } });
  const s = install(w);
  let checks = 0;
  s.set(paystationService, "checkTransactionStatus", async () => (checks++, { status: "success", paymentAmount: 1500, trxId: "TRX1", paymentMethod: "bkash", raw: {} }));
  try {
    await paymentGatewayService.verifyAndConfirmByTransactionId("INV1");
    assert.deepEqual([w.order.status, w.payment.status], ["CONFIRMED", "PAID"]);
    assert.deepEqual(statuses(w), ["VO1:CONFIRMED", "VO2:CONFIRMED", "VO3:CANCELLED"]);
    assert.deepEqual(w.events, ["0a:O1:1500"]);
    await paymentGatewayService.verifyAndConfirmByTransactionId("INV1");
    assert.equal(checks, 1, "already PAID → no second gateway check");
    assert.deepEqual(w.events, ["0a:O1:1500"], "no second Event 0a");
  } finally {
    s.restore();
  }
});
