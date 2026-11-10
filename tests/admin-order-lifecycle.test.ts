// tests/admin-order-lifecycle.test.ts
//
// PHASE 3: admin order lifecycle, courier events after cancellation, payout routes.
//   H-5  — PATCH /:id/status accepts only CANCELLED (routed to cancelOrder);
//          every other target → 422, nothing written. The vendor-order
//          override accepts only CONFIRMED→PROCESSING and PROCESSING→PACKAGING
//          (422 otherwise), guarded on the status it read (409 if it changed).
//   H-4  — admin cancel of a PAID order: exactly one PENDING refund (in the
//          stock transaction) + one Event 0a reversal; retries / repeats /
//          an existing active refund never add a second one.
//   M-c  — rejectOrder releases the stock reservation, refuses PAID orders
//          and orders with a live courier row; nothing written when refused.
//   Webhook — a courier event for a CANCELLED shipment or vendor order (also
//          when cancelled while the event is processed) changes nothing, posts
//          no voucher, and is answered as skipped with an audit row.
//   Payout — every /api/payout route is ADMIN-only (401 anonymous, 403 other
//          roles); the order-cancel endpoint is retired (410) and writes nothing.
//          Phase 4 (D2): POST /payouts/process is retired (410) as well, no
//          route reaches PayoutService, and the service itself refuses to run.
//
// DB-free: Prisma delegates on the shared client are replaced in place; the
// $transaction stub snapshots the in-memory world and restores it when the
// callback throws. Proves guards and write routing, NOT PostgreSQL
// serialization (S4). Requires ACCESS_TOKEN_SECRET (payout auth tests). Run:
//   npx tsx --test tests/admin-order-lifecycle.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma.ts";
import { AdminOrderService, OrderStatusTransitionError } from "../src/services/admin.order.service.ts";
import { PayoutService, PayoutsDisabledError } from "../src/services/payout.service.ts";
import { PayoutController } from "../src/controllers/payout.controller.ts";
import { AdminOrderController } from "../src/controllers/admin.order.controller.ts";
import { BOOKING_PENDING, BOOKING_UNKNOWN } from "../src/services/courier.service.ts";
import payoutRoutes from "../src/routes/payout.routes.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";

type Row = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function matches(row: Row, where: Row = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k] ?? null;
    if (cond !== null && typeof cond === "object") {
      if ("not" in cond && (cond.not === null ? v === null : v === cond.not)) return false;
      if ("in" in cond && !cond.in.includes(v)) return false;
      if ("notIn" in cond && cond.notIn.includes(v)) return false;
      continue;
    }
    if (cond === null ? v !== null : v !== cond) return false;
  }
  return true;
}

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
  const res: any = { statusCode: 200, body: undefined, ended: false };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => {
    res.body = b;
    res.ended = true;
    res.onEnd?.();
    return res;
  };
  return res;
}

// ── in-memory order world for cancelOrder / rejectOrder ─────────────────────

interface World {
  order: Row;
  courierOrders: Row[];
  allocations: Row[];
  stock: Row[];
  refunds: Row[];
  records: Row[];
  audits: Row[];
  writes: string[];
}

function world(opts: { status?: string; paid?: boolean; courier?: Row[]; refunds?: Row[] } = {}): World {
  const status = opts.status ?? "CONFIRMED";
  return {
    order: {
      id: "O1",
      orderNumber: "ORD-1",
      userId: null,
      status,
      payments: opts.paid ? [{ id: "PAY1", status: "PAID", amount: 1500 }] : [{ id: "PAY1", status: "PENDING", amount: 1500 }],
      vendorOrders: [{ id: "VO1", status, items: [{ id: "I1", variantId: "VAR1" }] }],
    },
    courierOrders: (opts.courier ?? []).map((c, i) => ({ id: `CO${i + 1}`, vendorOrderId: "VO1", status: "PENDING_PICKUP", courierTrackingId: null, courierProviderId: "P", ...c })),
    allocations: [{ id: "AL1", orderItemId: "I1", warehouseId: "WH-A", rackId: null, rowNumber: null, shelfNumber: null, quantity: 2, shippedQty: 0 }],
    stock: [{ id: "S1", variantId: "VAR1", warehouseId: "WH-A", rackId: null, rowNumber: null, shelfNumber: null, quantity: 10, reservedQty: 2, damagedQty: 0 }],
    refunds: clone(opts.refunds ?? []),
    records: [],
    audits: [],
    writes: [],
  };
}

function installWorld(w: World, opts: { p2034Once?: boolean } = {}) {
  const s = stubber();
  const reversals: string[] = [];
  const view = () => ({
    ...clone(w.order),
    vendorOrders: w.order.vendorOrders.map((vo: Row) => ({ ...clone(vo), courierOrders: clone(w.courierOrders.filter((c) => c.vendorOrderId === vo.id)) })),
  });
  s.set(prisma.order, "findUnique", async () => view());
  s.set(prisma.voucher, "findFirst", async ({ where }: any) => (reversals.push(where.orderId), null));
  s.set(prisma.notification, "create", async () => assert.fail("no notification for a guest order"));
  for (const d of ["courierOrder", "refund", "order", "vendorOrder"] as const) {
    s.set((prisma as any)[d], "updateMany", async () => assert.fail(`${d}.updateMany through the global client`));
  }
  s.set(prisma.refund, "create", async () => assert.fail("refund.create through the global client"));

  let conflictThrown = false;
  let attempts = 0;
  s.set(prisma, "$transaction", async (fn: any) => {
    attempts++;
    const snap = clone(w);
    const tx = {
      // Phase 4: the cancellation refund locks the payment row, reads the consumed sum, writes its record.
      $executeRaw: async () => 1,
      payment: {
        findFirst: async ({ where }: any) => clone(w.order.payments.find((p: Row) => where.status.in.includes(p.status)) ?? null),
      },
      refundRecord: { create: async ({ data }: any) => (w.writes.push("refundRecord.create"), w.records.push(clone(data)), data) },
      order: {
        findUnique: async () => view(),
        update: async ({ data }: any) => (w.writes.push("order.update"), (w.order.status = data.status), {}),
      },
      vendorOrder: {
        updateMany: async ({ data }: any) => {
          w.writes.push("vendorOrder.updateMany");
          w.order.vendorOrders.forEach((vo: Row) => (vo.status = data.status));
          return { count: w.order.vendorOrders.length };
        },
      },
      courierOrder: {
        updateMany: async ({ where, data }: any) => {
          w.writes.push("courierOrder.updateMany");
          const hit = w.courierOrders.filter((c) => matches(c, where));
          hit.forEach((c) => Object.assign(c, data));
          return { count: hit.length };
        },
      },
      courierTrackingHistory: { create: async () => (w.writes.push("history.create"), {}) },
      orderItem: { findUnique: async ({ where }: any) => ({ variantId: where.id === "I1" ? "VAR1" : null }) },
      orderItemAllocation: {
        findMany: async ({ where }: any) => clone(w.allocations.filter((a) => a.orderItemId === where.orderItemId)),
        delete: async ({ where }: any) => (w.writes.push("allocation.delete"), (w.allocations = w.allocations.filter((a) => a.id !== where.id)), {}),
        update: async () => assert.fail("no shipped allocations here"),
      },
      warehouseStock: {
        findFirst: async ({ where }: any) => clone(w.stock.find((x) => matches(x, where)) ?? null),
        update: async ({ where, data }: any) => {
          w.writes.push("warehouseStock.update");
          const st = w.stock.find((x) => x.id === where.id)!;
          for (const k of ["quantity", "reservedQty", "damagedQty"]) st[k] += data[k]?.increment ?? 0;
          return st;
        },
      },
      productVariant: { update: async () => ({}) },
      refund: {
        aggregate: async ({ where }: any) => ({
          _sum: {
            amount:
              w.refunds
                .filter((r) => r.orderId === where.orderId && where.status.in.includes(r.status))
                .reduce((a, r) => a + Number(r.amount), 0) || null,
          },
        }),
        create: async ({ data }: any) => {
          w.writes.push("refund.create");
          const row = { id: `RF${w.refunds.length + 1}`, ...clone(data) };
          w.refunds.push(row);
          if (opts.p2034Once && !conflictThrown) {
            conflictThrown = true;
            throw new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: "test" });
          }
          return row;
        },
      },
      auditLog: { create: async ({ data }: any) => (w.writes.push(`audit:${data.action}`), w.audits.push(data), data) },
    };
    try {
      return await fn(tx);
    } catch (e) {
      Object.assign(w, clone(snap));
      throw e;
    }
  });
  return { reversals, attempts: () => attempts, restore: s.restore };
}

// ── H-5: order-level status override ────────────────────────────────────────

test("H-5: updateStatus refuses every target except CANCELLED with 422 — nothing written", async () => {
  const s = stubber();
  const writes: string[] = [];
  try {
    s.set(prisma.order, "findUnique", async () => ({ status: "CONFIRMED", userId: "U1", orderNumber: "ORD-1" }));
    s.set(prisma, "$transaction", async () => (writes.push("$transaction"), assert.fail("no transaction")));
    s.set(prisma.order, "update", async () => (writes.push("order.update"), assert.fail("no raw write")));
    s.set(AdminOrderService, "cancelOrder", async () => (writes.push("cancelOrder"), assert.fail("not a cancel")));
    for (const target of ["PENDING", "CONFIRMED", "PROCESSING", "PACKAGING", "SHIPPED", "DELIVERED", "REFUNDED", "FAILED_TO_DELIVER", "RETURNED"]) {
      await assert.rejects(
        AdminOrderService.updateStatus("O1", "A1", target as any),
        (e: any) => e instanceof OrderStatusTransitionError && e.statusCode === 422 && e.code === "STATUS_TRANSITION_NOT_ALLOWED",
        target,
      );
    }
    assert.deepEqual(writes, []);
  } finally {
    s.restore();
  }
});

test("H-5: updateStatus CANCELLED is routed to the guarded cancelOrder; terminal orders still refused", async () => {
  const s = stubber();
  const calls: any[] = [];
  try {
    let status = "CONFIRMED";
    s.set(prisma.order, "findUnique", async () => ({ status, userId: null, orderNumber: "ORD-1" }));
    s.set(AdminOrderService, "cancelOrder", async (...args: any[]) => (calls.push(args), { success: true }));
    const out = await AdminOrderService.updateStatus("O1", "A1", "CANCELLED", "dup");
    assert.deepEqual(out, { success: true, oldStatus: "CONFIRMED", newStatus: "CANCELLED" });
    assert.deepEqual(calls, [["O1", "A1", "dup"]]);
    for (status of ["DELIVERED", "CANCELLED", "REFUNDED"]) {
      await assert.rejects(AdminOrderService.updateStatus("O1", "A1", "CANCELLED"), /Cannot update status/);
    }
    assert.equal(calls.length, 1);
  } finally {
    s.restore();
  }
});

test("H-5: controller answers 422 with the code for a refused order transition", async () => {
  const s = stubber();
  try {
    s.set(prisma.order, "findUnique", async () => ({ status: "CONFIRMED", userId: null, orderNumber: "ORD-1" }));
    const res = fakeRes();
    await AdminOrderController.updateStatus({ user: { id: "A1" }, params: { id: "O1" }, body: { status: "DELIVERED" } } as any, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, "STATUS_TRANSITION_NOT_ALLOWED");
  } finally {
    s.restore();
  }
});

// ── H-5: vendor-order override ──────────────────────────────────────────────

function stubVendorOrder(status: string, opts: { raced?: boolean } = {}) {
  const s = stubber();
  const log: string[] = [];
  const claims: any[] = [];
  s.set(prisma.vendorOrder, "findUnique", async () => ({ id: "VO1", status, vendorId: "V1", courierOrderId: null }));
  s.set(prisma.notification, "create", async () => (log.push("notification"), {}));
  for (const [d, m] of [["voucher", "create"], ["voucher", "findUnique"], ["voucher", "findFirst"], ["vendorOrder", "update"], ["order", "update"]] as const) {
    s.set((prisma as any)[d], m, async () => assert.fail(`${d}.${m} must not run`));
  }
  s.set(prisma, "$transaction", async (fn: any) => {
    log.push("$transaction");
    return fn({
      vendorOrder: {
        updateMany: async (args: any) => (claims.push(args), { count: opts.raced ? 0 : 1 }),
        findMany: async () => [{ status: claims[0]?.data.status ?? status }],
      },
      order: { update: async () => (log.push("order.recalc"), {}) },
      auditLog: { create: async ({ data }: any) => (log.push(`audit:${data.action}`), data) },
    });
  });
  return { log, claims, restore: s.restore };
}

for (const [from, to] of [["CONFIRMED", "PROCESSING"], ["PROCESSING", "PACKAGING"]]) {
  test(`H-5: vendor order ${from} → ${to} is allowed, guarded on ${from}`, async () => {
    const env = stubVendorOrder(from);
    try {
      const out = await AdminOrderService.updateVendorOrderStatus("O1", "VO1", "A1", to as any);
      assert.deepEqual(out, { success: true, oldStatus: from, newStatus: to });
      assert.deepEqual(env.claims[0].where, { id: "VO1", orderId: "O1", status: from });
      assert.deepEqual(env.claims[0].data, { status: to });
      assert.ok(env.log.includes("audit:VENDOR_ORDER_STATUS_UPDATE_ADMIN_OVERRIDE"));
      assert.ok(env.log.includes("notification"));
    } finally {
      env.restore();
    }
  });
}

test("H-5: vendor order changed concurrently → 409, no audit, no notification", async () => {
  const env = stubVendorOrder("CONFIRMED", { raced: true });
  try {
    await assert.rejects(
      AdminOrderService.updateVendorOrderStatus("O1", "VO1", "A1", "PROCESSING"),
      (e: any) => e instanceof OrderStatusTransitionError && e.statusCode === 409,
    );
    assert.deepEqual(env.log, ["$transaction"]);
  } finally {
    env.restore();
  }
});

const REFUSED_VENDOR: [string, string][] = [
  ["PENDING", "PROCESSING"],
  ["CONFIRMED", "PACKAGING"],
  ["CONFIRMED", "SHIPPED"],
  ["PACKAGING", "SHIPPED"],
  ["SHIPPED", "DELIVERED"],
  ["PACKAGING", "DELIVERED"],
  ["PROCESSING", "CONFIRMED"],
  ["PACKAGING", "PROCESSING"],
  ["CONFIRMED", "CANCELLED"],
  ["SHIPPED", "FAILED_TO_DELIVER"],
  ["DELIVERED", "RETURNED"],
  ["CANCELLED", "PROCESSING"],
  ["PROCESSING", "PROCESSING"],
];

test("H-5: every other vendor-order transition → 422, no transaction, no voucher, no notification", async () => {
  for (const [from, to] of REFUSED_VENDOR) {
    const env = stubVendorOrder(from);
    try {
      await assert.rejects(
        AdminOrderService.updateVendorOrderStatus("O1", "VO1", "A1", to as any),
        (e: any) => e instanceof OrderStatusTransitionError && e.statusCode === 422,
        `${from} → ${to}`,
      );
      assert.deepEqual(env.log, [], `${from} → ${to}`);
    } finally {
      env.restore();
    }
  }
});

test("H-5: vendor-order controller answers 422 / 409 with the code", async () => {
  for (const [make, body, want] of [
    [() => stubVendorOrder("PACKAGING"), { status: "DELIVERED" }, 422],
    [() => stubVendorOrder("CONFIRMED", { raced: true }), { status: "PROCESSING" }, 409],
  ] as const) {
    const env = make();
    try {
      const res = fakeRes();
      await AdminOrderController.updateVendorOrderStatus(
        { user: { id: "A1" }, params: { id: "O1", vendorOrderId: "VO1" }, body } as any,
        res,
      );
      assert.equal(res.statusCode, want);
      assert.equal(res.body.code, "STATUS_TRANSITION_NOT_ALLOWED");
    } finally {
      env.restore();
    }
  }
});

// ── H-4: admin cancel of a paid order ───────────────────────────────────────

const adminCancel = () => AdminOrderService.cancelOrder("O1", "A1", "out of stock");

test("H-4: admin cancel of a PAID order → one PENDING refund in the transaction + one 0a reversal", async () => {
  const w = world({ paid: true, courier: [{ courierStatus: BOOKING_PENDING }] });
  const env = installWorld(w);
  try {
    await adminCancel();
    assert.equal(w.order.status, "CANCELLED");
    assert.equal(w.refunds.length, 1);
    assert.deepEqual(
      { orderId: w.refunds[0].orderId, amount: Number(w.refunds[0].amount), status: w.refunds[0].status },
      { orderId: "O1", amount: 1500, status: "PENDING" },
    );
    assert.equal(w.courierOrders[0].status, "CANCELLED");
    assert.equal(w.stock[0].reservedQty, 0, "reservation released");
    assert.deepEqual(env.reversals, ["O1"]);
    // Phase 4: the refund carries its RefundRecord, so it can be approved / rejected.
    assert.equal(w.records.length, 1);
    assert.equal(w.records[0].refundId, w.refunds[0].id);
    assert.equal(w.records[0].refundType, "ADMIN_INITIATED");
    assert.equal(w.records[0].initiatedBy, "A1");
  } finally {
    env.restore();
  }
});

test("H-4: a repeated admin cancel is refused and adds no refund / reversal", async () => {
  const w = world({ paid: true });
  const env = installWorld(w);
  try {
    await adminCancel();
    await assert.rejects(adminCancel(), /Cannot cancel order in status: CANCELLED/);
    assert.equal(w.refunds.length, 1);
    assert.deepEqual(env.reversals, ["O1"]);
  } finally {
    env.restore();
  }
});

test("H-4: P2034 on the first attempt → the retry still creates exactly one refund", async () => {
  const w = world({ paid: true });
  const env = installWorld(w, { p2034Once: true });
  try {
    await adminCancel();
    assert.equal(env.attempts(), 2);
    assert.equal(w.refunds.length, 1);
    assert.equal(w.records.length, 1, "one RefundRecord after the retry");
    assert.deepEqual(env.reversals, ["O1"]);
  } finally {
    env.restore();
  }
});

test("H-4: an existing active refund (e.g. the customer's) → no second refund", async () => {
  for (const status of ["PENDING", "APPROVED", "PROCESSING", "REFUNDED"]) {
    const w = world({ paid: true, refunds: [{ id: "RF0", orderId: "O1", amount: 1500, status }] });
    const env = installWorld(w);
    try {
      await adminCancel();
      assert.equal(w.refunds.length, 1, status);
    } finally {
      env.restore();
    }
  }
});

test("H-4: an unpaid order → no refund, no reversal (unchanged)", async () => {
  const w = world();
  const env = installWorld(w);
  try {
    await adminCancel();
    assert.equal(w.order.status, "CANCELLED");
    assert.equal(w.refunds.length, 0);
    assert.deepEqual(env.reversals, []);
  } finally {
    env.restore();
  }
});

test("H-4: an unresolved booking still blocks admin cancel — no refund, no reversal", async () => {
  const w = world({ paid: true, courier: [{ courierStatus: BOOKING_UNKNOWN }] });
  const before = clone(w);
  const env = installWorld(w);
  try {
    await assert.rejects(adminCancel(), (e: any) => e.code === "COURIER_BOOKING_UNRESOLVED");
    assert.deepEqual(w, before);
    assert.deepEqual(env.reversals, []);
  } finally {
    env.restore();
  }
});

// ── M-c: fraud rejection ────────────────────────────────────────────────────

const reject = () => AdminOrderService.rejectOrder("O1", "A1", "fraud");

test("M-c: rejectOrder releases the reservation and cancels order + vendor orders", async () => {
  const w = world({ status: "PENDING" });
  const env = installWorld(w);
  try {
    await reject();
    assert.equal(w.order.status, "CANCELLED");
    assert.equal(w.order.vendorOrders[0].status, "CANCELLED");
    assert.deepEqual(w.allocations, []);
    assert.equal(w.stock[0].reservedQty, 0);
    assert.equal(w.stock[0].quantity, 10, "on-hand unchanged — only the reservation is released");
    assert.ok(w.audits.some((a) => a.action === "ORDER_REJECTED_FRAUD"));
  } finally {
    env.restore();
  }
});

test("M-c: rejectOrder ignores already-cancelled courier rows", async () => {
  const w = world({ status: "PENDING", courier: [{ status: "CANCELLED" }] });
  const env = installWorld(w);
  try {
    await reject();
    assert.equal(w.order.status, "CANCELLED");
  } finally {
    env.restore();
  }
});

for (const [label, opts, pattern] of [
  ["a PAID order", { status: "PENDING", paid: true }, /cancel it instead/],
  ["an order with a live courier row", { status: "PENDING", courier: [{ courierStatus: BOOKING_PENDING }] }, /courier booking/],
  ["a non-PENDING order", { status: "CONFIRMED" }, /Only PENDING orders/],
] as const) {
  test(`M-c: rejectOrder refuses ${label} — nothing written`, async () => {
    const w = world(opts as any);
    const before = clone(w);
    const env = installWorld(w);
    try {
      await assert.rejects(reject(), pattern);
      assert.deepEqual(w, before);
      assert.deepEqual(env.reversals, []);
    } finally {
      env.restore();
    }
  });
}

test("M-c: an order paid / confirmed after the outer read is re-checked inside the transaction", async () => {
  const w = world({ status: "PENDING" });
  const env = installWorld(w);
  const s = stubber();
  try {
    // The outer read sees PENDING; the in-transaction read sees the payment.
    const outer = { ...clone(w.order) };
    s.set(prisma.order, "findUnique", async () => outer);
    w.order.payments = [{ id: "PAY1", status: "PAID", amount: 1500 }];
    const before = clone(w);
    await assert.rejects(reject(), /cancel it instead/);
    assert.deepEqual(w, before);
  } finally {
    s.restore();
    env.restore();
  }
});

// ── courier events after cancellation ───────────────────────────────────────

const bookedRow = (over: Row = {}): Row => ({
  id: "CO1",
  status: "PENDING_PICKUP",
  courierStatus: "Order Created",
  courierTrackingId: "TRK1",
  consignmentId: "CN1",
  returnConsignmentId: null,
  warehouseId: "WH1",
  codAmount: { greaterThan: () => false },
  deliveryCharge: 0,
  vendorOrder: { id: "VO1", orderId: "O1", vendorId: "V1", status: "PACKAGING", shippingCost: 0, vendor: {}, items: [{ id: "I1", quantity: 1, deliveredQuantity: 0 }] },
  ...over,
});

function stubWebhook(row: Row, tx: { voStatusNow?: string; rowStatusAtClaim?: string } = {}) {
  const s = stubber();
  const calls: string[] = [];
  const audits: Row[] = [];
  const claims: any[] = [];
  const trap = (label: string) => async () => (calls.push(label), assert.fail(`${label} must not run`));
  s.set(prisma.courierOrder, "findUnique", async () => row);
  s.set(prisma.auditLog, "create", async ({ data }: any) => (audits.push(data), data));
  s.set(prisma.orderItemAllocation, "findMany", async () => (calls.push("allocation.findMany"), []));
  s.set(prisma.orderItemAllocation, "count", async () => (calls.push("allocation.count"), 0));
  s.set(prisma.productVariant, "findUnique", trap("productVariant.findUnique (voucher)"));
  s.set(prisma.voucher, "findUnique", trap("voucher.findUnique (voucher)"));
  s.set(prisma.voucher, "findFirst", trap("voucher.findFirst (voucher)"));
  s.set(prisma.voucher, "create", trap("voucher.create (voucher)"));
  s.set(prisma, "$transaction", async (fn: any) => {
    calls.push("$transaction");
    const current = { ...row, status: tx.rowStatusAtClaim ?? row.status };
    return fn({
      vendorOrder: {
        findUnique: async () => ({ status: tx.voStatusNow ?? row.vendorOrder.status }),
        update: trap("tx.vendorOrder.update"),
        findMany: async () => [{ status: "PACKAGING" }],
      },
      courierOrder: {
        updateMany: async (args: any) => (claims.push(args), { count: matches(current, args.where) ? 1 : 0 }),
        findUnique: async () => ({ status: current.status }),
      },
      courierTrackingHistory: { create: async () => (calls.push("history.create"), {}) },
      orderItem: { update: trap("tx.orderItem.update"), findMany: trap("tx.orderItem.findMany") },
      order: { update: async () => (calls.push("order.recalc"), {}) },
    });
  });
  return { calls, audits, claims, restore: s.restore };
}

const event = (newStatus: string) =>
  AdminOrderService.processCourierStatusUpdate({ courierOrderId: "CO1", newStatus: newStatus as any, courierStatus: "provider says", timestamp: new Date() });

const silenceErrors = () => {
  const orig = console.error;
  console.error = () => {};
  return () => (console.error = orig);
};

for (const [label, over] of [
  ["a CANCELLED shipment", { status: "CANCELLED" }],
  ["a shipment of a CANCELLED vendor order", { vendorOrder: { ...bookedRow().vendorOrder, status: "CANCELLED" } }],
] as const) {
  for (const newStatus of ["DELIVERED", "PICKED_UP", "RETURNED", "CANCELLED"]) {
    test(`webhook: ${newStatus} for ${label} → skipped, nothing written, no voucher, audited`, async () => {
      const env = stubWebhook(bookedRow(over as Row));
      const quiet = silenceErrors();
      try {
        const out: any = await event(newStatus);
        assert.equal(out.processed, false);
        assert.equal(out.skipped, "ORDER_CANCELLED");
        assert.deepEqual(env.calls, [], "no transaction, allocation read or voucher");
        assert.equal(env.audits.length, 1);
        assert.equal(env.audits[0].action, "COURIER_EVENT_AFTER_CANCEL");
        assert.equal(env.audits[0].newData.eventStatus, newStatus);
      } finally {
        quiet();
        env.restore();
      }
    });
  }
}

test("webhook race: vendor order cancelled after the outer read → no claim, no history, no voucher", async () => {
  const env = stubWebhook(bookedRow(), { voStatusNow: "CANCELLED" });
  const quiet = silenceErrors();
  try {
    const out: any = await event("DELIVERED");
    assert.equal(out.skipped, "ORDER_CANCELLED");
    assert.deepEqual(env.claims, []);
    assert.ok(!env.calls.includes("history.create"));
    assert.ok(!env.calls.some((c) => c.includes("voucher")));
    assert.equal(env.audits.length, 1);
  } finally {
    quiet();
    env.restore();
  }
});

test("webhook race: shipment cancelled before the claim → the claim refuses CANCELLED, nothing else runs", async () => {
  const env = stubWebhook(bookedRow(), { rowStatusAtClaim: "CANCELLED" });
  const quiet = silenceErrors();
  try {
    const out: any = await event("DELIVERED");
    assert.equal(out.skipped, "ORDER_CANCELLED");
    assert.equal(env.claims.length, 1);
    assert.deepEqual(env.claims[0].where.status, { notIn: ["DELIVERED", "CANCELLED"] });
    assert.deepEqual(env.claims[0].where.courierTrackingId, { not: null }, "S2 guard kept");
    assert.ok(!env.calls.includes("history.create"));
    assert.ok(!env.calls.some((c) => c.includes("voucher")));
  } finally {
    quiet();
    env.restore();
  }
});

test("webhook: an active booked shipment still transitions normally (PICKED_UP)", async () => {
  const env = stubWebhook(bookedRow());
  try {
    const out: any = await event("PICKED_UP");
    assert.equal(out.processed, true);
    assert.equal(env.claims.length, 1);
    assert.ok(env.calls.includes("history.create"));
    assert.equal(env.audits.length, 0);
  } finally {
    env.restore();
  }
});

test("webhook: an unbooked row is still refused first (S2 unchanged)", async () => {
  const env = stubWebhook(bookedRow({ courierTrackingId: null, status: "CANCELLED" }));
  try {
    await assert.rejects(event("DELIVERED"), (e: any) => e.code === "COURIER_ORDER_NOT_BOOKED");
    assert.deepEqual(env.calls, []);
    assert.equal(env.audits.length, 0);
  } finally {
    env.restore();
  }
});

// ── payout routes ───────────────────────────────────────────────────────────

const PAYOUT_ROUTES: [string, string][] = [
  ["post", "/payouts/process"],
  ["post", "/orders/:orderId/cancel"],
  ["get", "/payouts/vendor/:vendorId"],
];
const pStack = () => (payoutRoutes as any).stack as any[];
const pRouterLayers = () => pStack().filter((l) => !l.route);
const pRouteHandles = (method: string, path: string) => {
  const layer = pStack().find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method} ${path} not registered`);
  return layer.route.stack.map((x: any) => x.handle);
};

function run(fn: any, req: any, res: any): Promise<"next" | "ended"> {
  return new Promise((resolve, reject) => {
    res.onEnd = () => resolve("ended");
    try {
      const out = fn(req, res, (err?: unknown) => (err ? reject(err) : resolve("next")));
      if (out && typeof out.then === "function") out.catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

const PEOPLE = {
  ADMIN: { user: { id: "U_ADMIN", role: "ADMIN", vendorId: null }, employee: { id: "EMP_ADMIN", vendorId: null } },
  ADMIN_SIDE_EMPLOYEE: { user: { id: "U_AEMP", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_A", vendorId: null } },
  VENDOR_EMPLOYEE: { user: { id: "U_VEMP", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_V", vendorId: "V1" } },
  VENDOR: { user: { id: "U_VENDOR", role: "VENDOR", vendorId: "V1" }, employee: null },
  CUSTOMER: { user: { id: "U_CUST", role: "CUSTOMER", vendorId: null }, employee: null },
} as const;
type Who = keyof typeof PEOPLE | "ANONYMOUS";

function stubAuth() {
  const s = stubber();
  const byId = new Map(Object.values(PEOPLE).map((p) => [p.user.id, p]));
  s.set(prisma.user, "findUnique", async ({ where }: any) => {
    const p = byId.get(where.id);
    return p ? { id: p.user.id, name: "n", email: null, role: p.user.role, isActive: true, vendorId: p.user.vendorId } : null;
  });
  s.set(prisma.vendor, "findUnique", async ({ where }: any) => (where.id === "V1" ? { id: "V1", storeName: "Store", email: null } : null));
  s.set(prisma.employee, "findFirst", async ({ where }: any) => byId.get(where.userId)?.employee ?? null);
  // The retired endpoint and the guards must never write order / refund data.
  for (const [d, m] of [["order", "update"], ["order", "findUnique"], ["refund", "create"], ["payment", "findFirst"]] as const) {
    s.set((prisma as any)[d], m, async () => assert.fail(`${d}.${m} must not run`));
  }
  return s.restore;
}

function requestFor(who: Who) {
  const headers: Record<string, string> = {};
  if (who !== "ANONYMOUS") {
    const p = PEOPLE[who];
    headers.authorization = `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
  }
  return { headers, body: {}, query: {}, params: { orderId: "O1", vendorId: "V1" } };
}

test("payout: exactly three routes; authenticateUser + role check are router-level and run first", () => {
  const mounted = pStack()
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`))
    .sort();
  assert.deepEqual(mounted, PAYOUT_ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  assert.equal(pStack()[0].handle, authenticateUser);
  assert.equal(pStack()[0].route, undefined);
  assert.equal(pStack()[1].route, undefined, "role check is router-level");
  assert.ok(pStack().findIndex((l) => l.route) > 1, "no route before the guards");
});

test("payout: access matrix — anonymous 401, every non-ADMIN role 403, ADMIN passes; no handler runs", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const [method, path] of PAYOUT_ROUTES) {
      for (const who of [...Object.keys(PEOPLE), "ANONYMOUS"] as Who[]) {
        const req = requestFor(who);
        const res = fakeRes();
        let got = "guards passed";
        for (const layer of pRouterLayers()) {
          if ((await run(layer.handle, req, res)) === "ended") {
            got = String(res.statusCode);
            break;
          }
        }
        const want = who === "ADMIN" ? "guards passed" : who === "ANONYMOUS" ? "401" : "403";
        if (got !== want) mismatches.push(`${method} ${path} as ${who}: expected ${want}, got ${got}`);
      }
    }
    assert.deepEqual(mismatches, []);
  } finally {
    restore();
  }
});

test("payout: the order-cancel endpoint is retired — 410 for an ADMIN, nothing written", async () => {
  const restore = stubAuth();
  try {
    const handles = pRouteHandles("post", "/orders/:orderId/cancel");
    assert.equal(handles.length, 1, "no other middleware / controller on the retired route");
    const req = requestFor("ADMIN");
    const res = fakeRes();
    for (const layer of pRouterLayers()) assert.equal(await run(layer.handle, req, res), "next");
    assert.equal(await run(handles[0], req, res), "ended");
    assert.equal(res.statusCode, 410);
    assert.equal(res.body.code, "ENDPOINT_RETIRED");
    assert.equal(res.body.success, false);
  } finally {
    restore();
  }
});

// ── Phase 4 (D2): payout processing cannot be triggered ─────────────────────

test("D2: POST /payouts/process is retired — 410 for an ADMIN; its only handler is the retired stub", async () => {
  const restore = stubAuth();
  try {
    const handles = pRouteHandles("post", "/payouts/process");
    assert.equal(handles.length, 1);
    assert.notEqual(handles[0], PayoutController.prototype.processVendorPayouts);
    const req = requestFor("ADMIN");
    const res = fakeRes();
    for (const layer of pRouterLayers()) assert.equal(await run(layer.handle, req, res), "next");
    assert.equal(await run(handles[0], req, res), "ended");
    assert.equal(res.statusCode, 410);
    assert.equal(res.body.code, "ENDPOINT_RETIRED");
  } finally {
    restore();
  }
});

test("D2: no payout route reaches a PayoutController method that calls the payout service", () => {
  const callsService = [PayoutController.prototype.processVendorPayouts, PayoutController.prototype.handleOrderCancellation];
  for (const layer of pStack().filter((l) => l.route)) {
    for (const h of layer.route.stack.map((x: any) => x.handle)) {
      assert.ok(!callsService.includes(h), `${layer.route.path} must not reach the payout service`);
    }
  }
});

test("D2: PayoutService refuses to run from any entry point (cron included)", async () => {
  const svc = new PayoutService() as any;
  await assert.rejects(svc.processVendorPayouts("V1", "weekly"), PayoutsDisabledError);
  await assert.rejects(svc.processPayoutThroughSSLCommerz("V1", 100, "P1"), PayoutsDisabledError);
  await assert.rejects(svc.handleOrderCancellation(1, "x"), PayoutsDisabledError);
});
