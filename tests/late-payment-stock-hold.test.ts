// tests/late-payment-stock-hold.test.ts
//
// H1 (Option B) — a verified payment that arrives after the order's stock
// reservation was released (reservation TTL / failed payment) is RECORDED
// (payment PAID, order paymentStatus PAID, Event 0a posted once) but the order
// is NOT confirmed for fulfilment: it stays PENDING ("paid, awaiting review"),
// its vendor orders stay PENDING, so nothing can be processed or booked with a
// courier. An audit row + Payment.meta.stockHold say why. No confirm path —
// SSLCommerz, EPS, PayStation, admin confirm/approve, system auto-confirm,
// vendor COD confirm — confirms an order without its stock.
// Production paths: PaymentController.ipn (with the C1 verification), the
// gateway service, AdminOrderService, VendorOrderService, OrderService.
// The in-memory database models the order row lock (a per-order mutex), so
// concurrent callbacks really interleave. Network-free and DB-free:
//   npx tsx --test tests/late-payment-stock-hold.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";

process.env.SSLCOMMERZ_STORE_ID ??= "test-store";
process.env.SSLCOMMERZ_STORE_PASSWORD ??= "test-store-secret";
const axios = (await import("axios")).default;
const { paymentServiceDb } = await import("../src/services/payment.service.ts");
const { paymentGatewayService, paymentGatewayDb } = await import("../src/services/payment-gateway.service.ts");
const { PaymentController } = await import("../src/controllers/payment.controller.ts");
const { AdminOrderService, OrderStatusTransitionError } = await import("../src/services/admin.order.service.ts");
const { VendorOrderService } = await import("../src/services/vendor.order.service.ts");
const { OrderService, orderServiceDb } = await import("../src/services/order.service.ts");
const { AccountingService } = await import("../src/services/accounting.services.ts");
const courierService = (await import("../src/services/courier.service.ts")).default;
const { epsService } = await import("../src/services/eps.service.ts");
const { paystationService } = await import("../src/services/paystation.service.ts");
const { prisma: sharedDb } = await import("../src/config/prisma.ts");
const { STOCK_HOLD_AUDIT, STOCK_HOLD_REASON } = await import("../src/services/order-reservation.ts");

type Row = Record<string, any>;
const validation = (over: Row = {}): Row => ({
  status: "VALID", tran_id: "T1", val_id: "V1", amount: "1500.00", currency: "BDT", currency_type: "BDT", currency_amount: "1500.00", bank_tran_id: "B1", ...over,
});

/** One prepaid two-vendor order whose stock was reserved at placement. */
function world(over: { order?: Row; payment?: Row } = {}) {
  return {
    order: { id: "O1", userId: "U1", orderNumber: "ORD-1", status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", reservationReleasedAt: null, riskScore: null, ...over.order } as Row,
    vendorOrders: [
      { id: "VO1", orderId: "O1", vendorId: "V1", status: "PENDING", items: [{ id: "OI1", variantId: "VAR1", quantity: 1, allocations: [{ id: "AL1", warehouseId: "WH1", quantity: 1, shippedQty: 0 }] }] },
      { id: "VO2", orderId: "O1", vendorId: "V2", status: "PENDING", items: [{ id: "OI2", variantId: "VAR2", quantity: 2, allocations: [{ id: "AL2", warehouseId: "WH2", quantity: 2, shippedQty: 0 }] }] },
    ] as Row[],
    payment: { id: "PAY1", orderId: "O1", status: "PENDING", amount: new Decimal("1500"), method: "SSLCOMMERZ", meta: { type: "order_payment" }, paymentProviderId: null, ...over.payment } as Row,
    txn: { tranId: "T1", paymentId: "PAY1", status: "PENDING" } as Row,
    gateway: { V1: validation() } as Record<string, Row>,
    validated: new Set<string>(),
    vouchers: new Set<string>(), // Event 0a ledger (engine idempotency key)
    voucherCalls: 0,
    audits: [] as Row[],
    locks: [] as string[],
    failAccounting: false,
  };
}
type World = ReturnType<typeof world>;

/** What OrderService.releaseStockForOrder + the TTL / failed-payment hook leave behind. */
function releaseReservation(w: World, opts: { marker?: boolean } = {}) {
  for (const vo of w.vendorOrders) for (const it of vo.items) it.allocations = [];
  if (opts.marker !== false) w.order.reservationReleasedAt = new Date("2026-10-18T09:00:00Z");
}

const liveFilter = (a: Row = {}) => (v: Row) => { const not = a.select?.vendorOrders?.where?.status?.not; return not === undefined || v.status !== not; };
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => row[k] === v);

function install(w: World) {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const state = () => JSON.stringify({ order: w.order, vendorOrders: w.vendorOrders, payment: w.payment, audits: w.audits });
  const mutex = new Map<string, Promise<void>>();
  const acquire = async (id: string) => {
    const prev = mutex.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    mutex.set(id, prev.then(() => mine));
    await prev;
    return release;
  };

  set(axios, "get", async (url: string, cfg: Row) => {
    assert.match(url, /validationserverAPI\.php$/);
    const id = String(cfg?.params?.val_id);
    const v = w.gateway[id];
    if (!v) return { data: { status: "INVALID_TRANSACTION" } };
    const status = w.validated.has(id) ? "VALIDATED" : v.status;
    w.validated.add(id);
    return { data: { ...v, status } };
  });
  set(axios, "post", async () => assert.fail("no gateway POST"));
  set(courierService, "selectBestCourier", async () => assert.fail("courier booking must not run"));

  for (const db of [paymentServiceDb, paymentGatewayDb, sharedDb, orderServiceDb] as any[]) {
    for (const model of ["warehouseStock", "productVariant", "stockMovement", "orderItemAllocation"]) {
      for (const m of ["update", "updateMany", "create", "upsert", "delete", "deleteMany"]) set(db[model], m, async () => assert.fail(`unexpected stock write ${model}.${m}`));
    }
    set(db.order, "findUnique", async (a: Row) => {
      if (a.where.id !== w.order.id) return null;
      return { ...w.order, vendorOrders: w.vendorOrders.filter(liveFilter(a)).map((v) => ({ ...v, items: v.items })) };
    });
    set(db.order, "updateMany", async ({ where, data }: Row) => (matches(w.order, where) ? (Object.assign(w.order, data), { count: 1 }) : { count: 0 }));
    set(db.order, "update", async ({ where, data }: Row) => (assert.equal(where.id, w.order.id), Object.assign(w.order, data), { ...w.order }));
    set(db.vendorOrder, "updateMany", async ({ where, data }: Row) => {
      const rows = w.vendorOrders.filter((v) => matches(v, where));
      rows.forEach((v) => Object.assign(v, data));
      return { count: rows.length };
    });
    set(db.vendorOrder, "findUnique", async ({ where }: Row) => {
      const v = w.vendorOrders.find((x) => x.id === where.id);
      return v ? { ...v, order: { ...w.order, address: { location: {} }, user: {} }, courierOrders: [] } : null;
    });
    set(db.payment, "findUnique", async ({ where }: Row) => (where.id === w.payment.id ? { ...w.payment } : null));
    set(db.payment, "findUniqueOrThrow", async () => ({ ...w.payment }));
    set(db.payment, "findFirst", async ({ where }: Row) =>
      where?.meta && w.payment.meta?.[where.meta.path[0]] === where.meta.equals
        ? { ...w.payment, paymentProvider: { id: "GW", payment_credentials: [{ environment: "SANDBOX" }, { environment: "PRODUCTION" }] } }
        : null,
    );
    set(db.payment, "update", async ({ where, data }: Row) => (assert.equal(where.id, w.payment.id), Object.assign(w.payment, data), { ...w.payment }));
    // The world's one payment row (the admin confirm guard reads the order's PAID payments).
    set(db.payment, "findMany", async ({ where }: Row) => (where.orderId === w.payment.orderId && (!where.status || where.status === w.payment.status) ? [{ ...w.payment }] : []));
    set(db.auditLog, "create", async ({ data }: Row) => (w.audits.push(data), data));
    set(db.notification, "create", async ({ data }: Row) => data);
    set(db, "$transaction", async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      const releases: (() => void)[] = [];
      const tx = Object.create(db);
      // The order row lock: a second transaction on the same order waits here.
      tx.$executeRaw = async (_s: TemplateStringsArray, ...vals: any[]) => {
        w.locks.push(String(vals[0]));
        releases.push(await acquire(String(vals[0])));
        return 1;
      };
      const before = state();
      try {
        return await arg(tx);
      } catch (e) {
        const s = JSON.parse(before);
        Object.assign(w.order, s.order);
        w.vendorOrders = s.vendorOrders;
        Object.assign(w.payment, { ...s.payment, amount: new Decimal(s.payment.amount) });
        w.audits = s.audits;
        throw e;
      } finally {
        releases.forEach((r) => r());
      }
    });
  }
  set(paymentServiceDb.sSLCommerzTransaction, "findUnique", async ({ where }: Row) =>
    where.tranId === w.txn.tranId
      ? { ...w.txn, payment: { ...w.payment, order: { ...w.order, vendorOrders: w.vendorOrders.map((v) => ({ ...v, items: [] })) } } }
      : null,
  );
  set(paymentServiceDb.sSLCommerzTransaction, "update", async ({ data }: Row) => (Object.assign(w.txn, data), { ...w.txn }));
  set(paymentGatewayDb.sSLCommerzTransaction, "findUnique", async ({ where }: Row) => (where.tranId === w.txn.tranId && w.payment.method === "SSLCOMMERZ" ? { tranId: w.txn.tranId } : null));
  // Accounting engine: idempotent per key (ORDER_PLACED:<order>:<gateway>), like the real engine.
  set(AccountingService.prototype, "createEvent0aOnlinePayment", async (d: Row) => {
    w.voucherCalls++;
    if (w.failAccounting) throw new Error("ledger unavailable");
    w.vouchers.add(`${d.orderId}:${d.paymentGatewayId}`);
    return { id: "V0A" };
  });
  set(sharedDb.user, "findFirst", async () => ({ id: "U_SYSTEM" }));
  return { state, restore: () => restores.reverse().forEach((r) => r()) };
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.send = (b: unknown) => ((res.body = b), res);
  return res;
}
const ipn = async () => {
  const res = fakeRes();
  await PaymentController.ipn({ body: { tran_id: "T1", val_id: "V1" } } as any, res);
  return res;
};
const summary = (w: World) => `${w.order.status}/${w.order.paymentStatus} payment:${w.payment.status} subs:${w.vendorOrders.map((v) => v.status).join(",")}`;
const holds = (w: World) => w.audits.filter((a) => a.action === STOCK_HOLD_AUDIT);

// ── the rule (same as Pay Now's re-reservation check) ──────────────────────

test("orderReservationIntact: marker cleared AND every item of every live vendor order still allocated", async () => {
  const { orderReservationIntact } = await import("../src/services/order-reservation.ts");
  const tx = (order: Row | null) => ({ order: { findUnique: async (a: Row) => (order ? { ...order, vendorOrders: order.vendorOrders.filter(liveFilter(a)) } : null) } });
  const vo = (status: string, allocated: boolean[]) => ({ status, items: allocated.map((x) => ({ allocations: x ? [{ id: "A" }] : [] })) });
  assert.equal(await orderReservationIntact(tx({ reservationReleasedAt: null, vendorOrders: [vo("PENDING", [true, true])] }), "O1"), true);
  assert.equal(await orderReservationIntact(tx({ reservationReleasedAt: new Date(), vendorOrders: [vo("PENDING", [true])] }), "O1"), false, "the release marker alone is enough");
  assert.equal(await orderReservationIntact(tx({ reservationReleasedAt: null, vendorOrders: [vo("PENDING", [true, false])] }), "O1"), false, "one unallocated item");
  assert.equal(await orderReservationIntact(tx({ reservationReleasedAt: null, vendorOrders: [vo("PENDING", [true]), vo("CANCELLED", [false])] }), "O1"), true, "a cancelled sub-order (allocations released) does not count");
  assert.equal(await orderReservationIntact(tx({ reservationReleasedAt: null, vendorOrders: [vo("CANCELLED", [false])] }), "O1"), false, "nothing live to fulfil");
  assert.equal(await orderReservationIntact(tx(null), "O1"), false, "unknown order");
});

// ── normal vs late ──────────────────────────────────────────────────────────

test("reservation intact: the verified payment confirms the order and its sub-orders as before", async () => {
  const w = world();
  const h = install(w);
  try {
    assert.equal((await ipn()).statusCode, 200);
    assert.equal(summary(w), "CONFIRMED/PAID payment:PAID subs:CONFIRMED,CONFIRMED");
    assert.deepEqual(holds(w), []);
    assert.equal(w.vouchers.size, 1);
    assert.deepEqual(w.locks, ["O1"], "the order row was locked for the decision");
  } finally {
    h.restore();
  }
});

test("reservation released: the late payment is recorded (PAID, Event 0a) but the order is NOT confirmed — held for review / refund", async () => {
  const w = world();
  releaseReservation(w);
  const h = install(w);
  try {
    const res = await ipn();
    assert.equal(res.statusCode, 200, "the gateway is acknowledged — the money is recorded");
    assert.equal(summary(w), "PENDING/PAID payment:PAID subs:PENDING,PENDING");
    assert.equal(w.vouchers.size, 1, "Event 0a posted — the money is in the books");
    assert.equal(holds(w).length, 1);
    assert.equal(holds(w)[0].newData.reason, STOCK_HOLD_REASON);
    assert.equal(w.payment.meta.stockHold.reason, STOCK_HOLD_REASON, "the payment row says why");
    assert.equal(w.payment.meta.type, "order_payment", "existing payment meta kept");
  } finally {
    h.restore();
  }
});

test("allocations gone but the release marker not yet written (release/marker window): still held, never confirmed", async () => {
  const w = world();
  releaseReservation(w, { marker: false });
  const h = install(w);
  try {
    await ipn();
    assert.equal(summary(w), "PENDING/PAID payment:PAID subs:PENDING,PENDING");
  } finally {
    h.restore();
  }
});

test("insufficient / available stock alike: a late payment never re-reserves (no stock write) and the admin cannot confirm it afterwards", async () => {
  const w = world();
  releaseReservation(w);
  const h = install(w); // every stock write is a test failure
  try {
    await ipn();
    await assert.rejects(AdminOrderService.confirmOrder("O1", "A1"), (e: any) => e instanceof OrderStatusTransitionError && e.statusCode === 409 && /stock reservation was released/.test(e.message));
    await assert.rejects(AdminOrderService.approveOrder("O1", "A1"), (e: any) => e instanceof OrderStatusTransitionError && e.statusCode === 409);
    const sys = await AdminOrderService.confirmOrderBySystem("O1", "PAYMENT_WEBHOOK");
    assert.deepEqual([sys.skipped, (sys as any).reason], [true, STOCK_HOLD_REASON]);
    assert.equal(summary(w), "PENDING/PAID payment:PAID subs:PENDING,PENDING", "still held");
  } finally {
    h.restore();
  }
});

// ── duplicates / concurrency / accounting failure ───────────────────────────

test("duplicate late callback (browser return + IPN): recorded once — one hold, one voucher, no further writes", async () => {
  const w = world();
  releaseReservation(w);
  const h = install(w);
  try {
    await ipn();
    const after = h.state();
    assert.equal((await ipn()).statusCode, 200);
    assert.equal(h.state(), after);
    assert.equal(holds(w).length, 1);
    assert.equal(w.vouchers.size, 1);
  } finally {
    h.restore();
  }
});

test("concurrent late callbacks: serialised on the order lock — the payment is recorded once, one hold, one voucher", async () => {
  const w = world();
  releaseReservation(w);
  const h = install(w);
  try {
    const [a, b] = await Promise.all([ipn(), ipn()]);
    assert.deepEqual([a.statusCode, b.statusCode], [200, 200]);
    assert.equal(summary(w), "PENDING/PAID payment:PAID subs:PENDING,PENDING");
    assert.equal(holds(w).length, 1, "exactly one hold");
    assert.equal(w.vouchers.size, 1, "one Event 0a voucher (the engine dedupes the second post)");
    assert.deepEqual(w.locks, ["O1", "O1"], "both callbacks went through the lock");
  } finally {
    h.restore();
  }
});

test("concurrent callbacks on an intact order: confirmed exactly once", async () => {
  const w = world();
  const h = install(w);
  try {
    await Promise.all([ipn(), ipn()]);
    assert.equal(summary(w), "CONFIRMED/PAID payment:PAID subs:CONFIRMED,CONFIRMED");
    assert.equal(w.vouchers.size, 1);
    assert.deepEqual(holds(w), []);
  } finally {
    h.restore();
  }
});

test("accounting failure on a late payment: nothing is recorded or held (the gateway retries)", async () => {
  const w = world();
  releaseReservation(w);
  w.failAccounting = true;
  const h = install(w);
  try {
    const before = h.state();
    assert.equal((await ipn()).statusCode, 400);
    assert.equal(h.state(), before, "order, sub-orders, payment and audit unchanged");
    assert.equal(w.vouchers.size, 0);
  } finally {
    h.restore();
  }
});

// ── no fulfilment without allocation ───────────────────────────────────────

test("a held order can't reach fulfilment: vendor can't process, can't book a courier, can't COD-confirm; admin override has nothing to move", async () => {
  const w = world();
  releaseReservation(w);
  const h = install(w);
  try {
    await ipn();
    await assert.rejects(VendorOrderService.updateStatus("VO1", "V1", "PROCESSING"), /Cannot transition from PENDING/);
    await assert.rejects(VendorOrderService.markForDelivery("VO1", "V1"), /must be in PACKAGING/);
    await assert.rejects(
      AdminOrderService.updateVendorOrderStatus("O1", "VO1", "A1", "PROCESSING" as any),
      (e: any) => e instanceof OrderStatusTransitionError && e.statusCode === 422,
      "the admin override only moves CONFIRMED → PROCESSING",
    );
    assert.equal(summary(w), "PENDING/PAID payment:PAID subs:PENDING,PENDING");
  } finally {
    h.restore();
  }
});

test("COD order whose reservation was released: the vendor's manual COD confirm is refused; nothing changes", async () => {
  const w = world({ order: { paymentmethod: "COD" } });
  releaseReservation(w);
  const h = install(w);
  try {
    await assert.rejects(VendorOrderService.confirmCodOrder("VO1", "V1", "Staff"), /stock reservation was released/);
    assert.equal(summary(w), "PENDING/PENDING payment:PENDING subs:PENDING,PENDING");
  } finally {
    h.restore();
  }
});

test("stock release takes the same order lock before re-checking the order (release and confirmation never interleave)", async () => {
  const w = world({ order: { status: "CONFIRMED", paymentStatus: "PAID" } });
  const h = install(w);
  const seen: string[] = [];
  const realFind = (orderServiceDb as any).order.findUnique;
  (orderServiceDb as any).order.findUnique = async (a: Row) => (seen.push("read"), realFind(a));
  const realExec = (orderServiceDb as any).$transaction;
  (orderServiceDb as any).$transaction = async (fn: any) =>
    realExec(async (tx: any) => {
      const exec = tx.$executeRaw;
      tx.$executeRaw = async (...a: any[]) => (seen.push("lock"), exec(...a));
      return fn(tx);
    });
  try {
    const out = await new OrderService().releaseStockForOrder("O1");
    assert.deepEqual(out, { released: 0, skipped: true }, "a confirmed order is never released");
    assert.deepEqual(seen, ["read", "lock", "read"], "outer read, then the lock, then the in-transaction re-check");
  } finally {
    (orderServiceDb as any).$transaction = realExec;
    (orderServiceDb as any).order.findUnique = realFind;
    h.restore();
  }
});

// ── EPS / PayStation ────────────────────────────────────────────────────────

test("EPS and PayStation late payments are held the same way (never confirmed without stock)", async () => {
  for (const gw of ["EPS", "PAYSTATION"] as const) {
    const w = world({ payment: gw === "EPS" ? { method: "EPS", meta: { merchantTransactionId: "X1" } } : { method: "PAYSTATION", meta: { invoiceNumber: "X1" } } });
    releaseReservation(w);
    const h = install(w);
    const restoreEps = epsService.checkTransactionStatus;
    const restorePs = paystationService.checkTransactionStatus;
    (epsService as any).checkTransactionStatus = async () => ({ status: "Success", raw: {} });
    (paystationService as any).checkTransactionStatus = async () => ({ status: "success", paymentAmount: 1500, trxId: "TRX", paymentMethod: "bkash", raw: {} });
    try {
      await paymentGatewayService.verifyAndConfirmByTransactionId("X1");
      assert.equal(summary(w), "PENDING/PAID payment:PAID subs:PENDING,PENDING", gw);
      assert.equal(holds(w).length, 1, gw);
      assert.equal(w.payment.meta.stockHold?.reason, STOCK_HOLD_REASON, gw);
    } finally {
      (epsService as any).checkTransactionStatus = restoreEps;
      (paystationService as any).checkTransactionStatus = restorePs;
      h.restore();
    }
  }
});
