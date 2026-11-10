// tests/vendor-order-status-race.test.ts
//
// PHASE 4 (M-a): guarded status transitions — a cancellation / fraud
// rejection that commits between a status read and its write is never undone.
//   vendor updateStatus  — updateMany guarded on {id, vendorId, old status};
//                          count 0 → 409 VENDOR_ORDER_STATUS_CHANGED, no
//                          recalculation, no notification.
//   vendor confirmCodOrder — guarded on PENDING; same 409 contract.
//   admin confirmOrder   — the Order claim is guarded on PENDING; an ADMIN
//                          caller gets 409, the SYSTEM caller (payment webhook /
//                          COD auto-confirm) is skipped and audited.
// PHASE 4 (M-b): vendor responses carry a server-derived bookingState; the raw
//   intent text (with its claim token) is never sent.
//
// DB-free: Prisma delegates replaced in place. Run with:
//   npx tsx --test tests/vendor-order-status-race.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import {
  VendorOrderService,
  VendorOrderStatusConflictError,
  deriveBookingState,
} from "../src/services/vendor.order.service.ts";
import { VendorOrderController } from "../src/controllers/vendor.order.controller.ts";
import { AdminOrderService, OrderStatusTransitionError } from "../src/services/admin.order.service.ts";
import { AdminOrderController } from "../src/controllers/admin.order.controller.ts";
import { BOOKING_PENDING, BOOKING_UNKNOWN, BOOKING_CONFIRM_FAILED } from "../src/services/courier.service.ts";

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
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

// H1: confirmations lock the order and read its reservation — placement left it intact.
const INTACT_RESERVATION = { reservationReleasedAt: null, vendorOrders: [{ items: [{ allocations: [{ id: "A1" }] }] }] };
const reservationTx = { $executeRaw: async () => 1 };

const CLAIMED_ROW = { id: "CO1", status: "PENDING_PICKUP", courierTrackingId: null, courierStatus: "Booking submitting [claim:secret-token]" };

function stubVendor(read: Row, opts: { raced?: boolean } = {}) {
  const s = stubber();
  const log: string[] = [];
  const claims: any[] = [];
  s.set(prisma.vendorOrder, "findUnique", async () => read);
  s.set(prisma.vendorOrder, "update", async () => assert.fail("unguarded vendorOrder.update"));
  s.set(prisma.notification, "create", async () => (log.push("notification"), {}));
  s.set(prisma, "$transaction", async (fn: any) =>
    fn({
      ...reservationTx,
      vendorOrder: {
        update: async () => assert.fail("unguarded tx.vendorOrder.update"),
        updateMany: async (args: any) => (claims.push(args), { count: opts.raced ? 0 : 1 }),
        findMany: async () => (log.push("recalc"), [{ status: claims[0]?.data.status }]),
        findUniqueOrThrow: async () => ({ id: "VO1", status: claims[0]?.data.status, courierOrders: [{ ...CLAIMED_ROW }] }),
      },
      order: { update: async () => ({}), findUnique: async () => INTACT_RESERVATION },
      auditLog: { create: async ({ data }: any) => (log.push(`audit:${data.action}`), data) },
    }),
  );
  return { log, claims, restore: s.restore };
}

// ── vendor updateStatus ─────────────────────────────────────────────────────

test("vendor updateStatus: guarded on the status it read; recalculates; strips the raw intent text", async () => {
  const env = stubVendor({ vendorId: "V1", status: "CONFIRMED", orderId: "O1" });
  try {
    const out: any = await VendorOrderService.updateStatus("VO1", "V1", "PROCESSING");
    assert.deepEqual(env.claims[0].where, { id: "VO1", vendorId: "V1", status: "CONFIRMED" });
    assert.deepEqual(env.claims[0].data, { status: "PROCESSING" });
    assert.ok(env.log.includes("recalc"));
    assert.ok(env.log.includes("notification"));
    assert.equal(out.courierOrders[0].bookingState, "IN_FLIGHT");
    assert.ok(!("courierStatus" in out.courierOrders[0]), "raw intent text (claim token) not sent");
  } finally {
    env.restore();
  }
});

test("vendor updateStatus: cancelled meanwhile (count 0) → conflict; no recalc, no notification", async () => {
  const env = stubVendor({ vendorId: "V1", status: "CONFIRMED", orderId: "O1" }, { raced: true });
  try {
    await assert.rejects(VendorOrderService.updateStatus("VO1", "V1", "PROCESSING"), VendorOrderStatusConflictError);
    assert.deepEqual(env.log, []);
  } finally {
    env.restore();
  }
});

test("vendor updateStatus: disallowed transitions are still refused before any write", async () => {
  const env = stubVendor({ vendorId: "V1", status: "CANCELLED", orderId: "O1" });
  try {
    await assert.rejects(VendorOrderService.updateStatus("VO1", "V1", "PROCESSING"), /Cannot transition/);
    assert.deepEqual(env.claims, []);
  } finally {
    env.restore();
  }
});

// ── vendor confirmCodOrder ──────────────────────────────────────────────────

const COD_READ = { vendorId: "V1", status: "PENDING", orderId: "O1", order: { id: "O1", orderNumber: "ORD-1", paymentmethod: "COD", status: "PENDING", userId: null } };

test("vendor confirmCodOrder: guarded on PENDING", async () => {
  const env = stubVendor(COD_READ);
  try {
    await VendorOrderService.confirmCodOrder("VO1", "V1", "Staff");
    assert.deepEqual(env.claims[0].where, { id: "VO1", vendorId: "V1", status: "PENDING" });
    assert.ok(env.log.includes("audit:COD_ORDER_CONFIRMED_BY_VENDOR"));
  } finally {
    env.restore();
  }
});

test("vendor confirmCodOrder: rejected / cancelled meanwhile → conflict; no audit, no notification", async () => {
  const env = stubVendor(COD_READ, { raced: true });
  try {
    await assert.rejects(VendorOrderService.confirmCodOrder("VO1", "V1", "Staff"), VendorOrderStatusConflictError);
    assert.deepEqual(env.log, []);
  } finally {
    env.restore();
  }
});

test("vendor controllers: conflicts answer 409 VENDOR_ORDER_STATUS_CHANGED with a message", async () => {
  for (const [handler, body, read] of [
    [VendorOrderController.updateStatus, { status: "PROCESSING" }, { vendorId: "V1", status: "CONFIRMED", orderId: "O1" }],
    [VendorOrderController.confirmCodOrder, { confirmedByName: "Staff", verifiedBy: "Staff" }, COD_READ],
  ] as const) {
    const env = stubVendor(read as Row, { raced: true });
    try {
      const res = fakeRes();
      await (handler as any)({ user: { id: "V1", vendorId: "V1", role: "VENDOR" }, params: { id: "VO1", vendorOrderId: "VO1" }, body }, res);
      if (res.statusCode === 400 && /required|must be/i.test(res.body?.message ?? "")) {
        assert.fail(`request shape rejected before the service: ${res.body.message}`);
      }
      assert.equal(res.statusCode, 409, (handler as any).name);
      assert.equal(res.body.code, "VENDOR_ORDER_STATUS_CHANGED");
      assert.ok(res.body.message);
    } finally {
      env.restore();
    }
  }
});

// ── admin confirmOrder ──────────────────────────────────────────────────────

function stubAdminConfirm(opts: { raced?: boolean } = {}) {
  const s = stubber();
  const log: string[] = [];
  const claims: any[] = [];
  s.set(prisma.order, "findUnique", async () => ({ status: "PENDING", orderNumber: "ORD-1", userId: null, paymentmethod: "SSLCOMMERZ", riskScore: null }));
  s.set(prisma.order, "update", async () => assert.fail("unguarded order.update"));
  s.set(prisma.auditLog, "create", async ({ data }: any) => (log.push(`audit:${data.action}`), data));
  s.set(prisma, "$transaction", async (fn: any) =>
    fn({
      ...reservationTx,
      order: {
        update: async () => assert.fail("unguarded tx.order.update"),
        updateMany: async (args: any) => (claims.push(args), { count: opts.raced ? 0 : 1 }),
        findUnique: async () => INTACT_RESERVATION,
      },
      vendorOrder: { updateMany: async () => (log.push("vendorOrders"), { count: 1 }) },
      auditLog: { create: async ({ data }: any) => (log.push(`tx-audit:${data.action}`), data) },
      // The online order these tests confirm is paid (the payment-webhook case).
      payment: { findMany: async () => [{ meta: { type: "order_payment" } }] },
    }),
  );
  return { log, claims, restore: s.restore };
}

test("admin confirmOrder: the Order claim is guarded on PENDING", async () => {
  const env = stubAdminConfirm();
  try {
    await AdminOrderService.confirmOrder("O1", "A1");
    assert.deepEqual(env.claims[0].where, { id: "O1", status: "PENDING" });
    assert.ok(env.log.includes("vendorOrders"));
  } finally {
    env.restore();
  }
});

test("admin confirmOrder: cancelled meanwhile → ADMIN gets 409; vendor orders untouched", async () => {
  const env = stubAdminConfirm({ raced: true });
  try {
    await assert.rejects(AdminOrderService.confirmOrder("O1", "A1"), (e: any) => e instanceof OrderStatusTransitionError && e.statusCode === 409);
    assert.deepEqual(env.log, []);
  } finally {
    env.restore();
  }
});

test("admin confirmOrderBySystem (payment webhook): cancelled meanwhile → skipped + audited, nothing confirmed", async () => {
  const env = stubAdminConfirm({ raced: true });
  try {
    const out: any = await AdminOrderService.confirmOrderBySystem("O1", "PAYMENT_WEBHOOK");
    assert.deepEqual(out, { success: true, skipped: true, reason: "STATE_CHANGED" });
    assert.deepEqual(env.log, ["audit:ORDER_AUTO_CONFIRM_SKIPPED_STATE_CHANGED"]);
  } finally {
    env.restore();
  }
});

test("admin controllers: confirm / approve conflicts answer 409", async () => {
  for (const handler of [AdminOrderController.confirmOrder, AdminOrderController.approveOrder]) {
    const env = stubAdminConfirm({ raced: true });
    try {
      const res = fakeRes();
      await (handler as any)({ user: { id: "A1" }, params: { id: "O1" }, body: {} }, res);
      assert.equal(res.statusCode, 409, (handler as any).name);
      assert.equal(res.body.code, "STATUS_TRANSITION_NOT_ALLOWED");
    } finally {
      env.restore();
    }
  }
});

// ── M-b: bookingState ───────────────────────────────────────────────────────

test("deriveBookingState covers every intent state", () => {
  const cases: [Row, string][] = [
    [{ status: "CANCELLED", courierStatus: BOOKING_UNKNOWN }, "CANCELLED"],
    [{ status: "PENDING_PICKUP", courierTrackingId: "TRK", courierStatus: "Order Created" }, "BOOKED"],
    [{ status: "PENDING_PICKUP", courierStatus: BOOKING_PENDING }, "PENDING"],
    [{ status: "PENDING_PICKUP", courierStatus: "Booking submitting [claim:x]" }, "IN_FLIGHT"],
    [{ status: "PENDING_PICKUP", courierStatus: BOOKING_UNKNOWN }, "NEEDS_RECONCILIATION"],
    [{ status: "PENDING_PICKUP", courierStatus: BOOKING_CONFIRM_FAILED }, "NEEDS_RECONCILIATION"],
    [{ status: "PENDING_PICKUP", courierStatus: "Booking in progress" }, "NEEDS_RECONCILIATION"],
    [{ status: "PENDING_PICKUP", courierStatus: null }, "NEEDS_RECONCILIATION"],
  ];
  for (const [row, want] of cases) assert.equal(deriveBookingState(row as any), want, JSON.stringify(row));
});

test("vendor getById / getAll: bookingState added, raw courierStatus never sent", async () => {
  const s = stubber();
  try {
    const vo = { id: "VO1", vendorId: "V1", courierOrders: [{ ...CLAIMED_ROW }, { id: "CO2", status: "PENDING_PICKUP", courierTrackingId: null, courierStatus: BOOKING_UNKNOWN }] };
    s.set(prisma.vendorOrder, "findUnique", async () => structuredClone(vo));
    s.set(prisma.vendorOrder, "findMany", async () => [structuredClone(vo)]);
    s.set(prisma.vendorOrder, "count", async () => 1);
    // getById also reads the reservation and payment facts behind vendorActions.
    s.set(prisma.order, "findUnique", async () => ({ reservationReleasedAt: null, vendorOrders: [] }));
    s.set(prisma.payment, "count", async () => 0);
    const one: any = await VendorOrderService.getById("VO1", "V1");
    const list: any = await VendorOrderService.getAll("V1", { page: 1, limit: 10 });
    for (const v of [one, list.vendorOrders[0]]) {
      assert.deepEqual(v.courierOrders.map((c: Row) => c.bookingState), ["IN_FLIGHT", "NEEDS_RECONCILIATION"]);
      assert.ok(v.courierOrders.every((c: Row) => !("courierStatus" in c)));
      assert.ok(!JSON.stringify(v).includes("secret-token"));
    }
  } finally {
    s.restore();
  }
});
