// tests/courier-webhook-test.security.test.ts
//
// PHASE 0:
//   S1 — POST /api/admin-orders/courier-webhook-test/:courierOrderId is ADMIN
//        only (admin-side and vendor employees, vendors, customers refused).
//   S2 — processCourierStatusUpdate refuses UNBOOKED courier rows
//        (courierTrackingId IS NULL — the only Phase 0 definition of booked)
//        before any state write and before delivery-voucher posting, and its
//        state claim carries a database-level `courierTrackingId: { not: null }`
//        guard. Booked rows behave as before.
//
// DB-free: Prisma delegates are replaced by plain property stubs; any call to
// a write/voucher path on a refused row fails the test. Run with:
//   npx tsx --test tests/courier-webhook-test.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import adminOrderRoutes from "../src/routes/admin.order.routes.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";
import { AdminOrderService } from "../src/services/admin.order.service.ts";
import { AdminOrderController } from "../src/controllers/admin.order.controller.ts";
import { BOOKING_PENDING, BOOKING_UNKNOWN } from "../src/services/courier.service.ts";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

const ROUTE = "/courier-webhook-test/:courierOrderId";

function webhookTestLayer() {
  const layer = (adminOrderRoutes as any).stack.find((l: any) => l.route?.path === ROUTE && l.route.methods.post);
  assert.ok(layer, "courier-webhook-test route not registered");
  return layer.route.stack.map((s: any) => s.handle);
}

const USERS = {
  ADMIN: { id: "A", role: "ADMIN", vendorId: null },
  ADMIN_SIDE_EMPLOYEE: { id: "E1", role: "EMPLOYEE", vendorId: null },
  VENDOR_EMPLOYEE: { id: "E2", role: "EMPLOYEE", vendorId: "V1" },
  VENDOR: { id: "V1", role: "VENDOR", vendorId: "V1" },
  CUSTOMER: { id: "C1", role: "CUSTOMER", vendorId: null },
} as const;

// ── S1 ──────────────────────────────────────────────────────────────────────

test("S1: the admin-orders router still authenticates first (router-level authenticateUser)", () => {
  assert.equal((adminOrderRoutes as any).stack[0].handle, authenticateUser);
});

test("S1: courier-webhook-test has a route-level ADMIN-only check before the controller", () => {
  const handles = webhookTestLayer();
  assert.equal(handles.length, 2, "expected role check + controller");
  const roleCheck = handles[0];
  for (const [name, user] of Object.entries(USERS)) {
    const res = fakeRes();
    let reached = false;
    roleCheck({ user }, res, () => (reached = true));
    if (name === "ADMIN") assert.ok(reached, "ADMIN must pass");
    else {
      assert.equal(reached, false, `${name} must not reach the controller`);
      assert.equal(res.statusCode, 403, name);
    }
  }
  const anon = fakeRes();
  let reached = false;
  roleCheck({}, anon, () => (reached = true));
  assert.equal(reached, false);
  assert.equal(anon.statusCode, 401);
});

test("S1: a vendor employee passes the router-level role check but is stopped at the route", () => {
  const routerRoleCheck = (adminOrderRoutes as any).stack[1].handle;
  const res = fakeRes();
  let passedRouter = false;
  routerRoleCheck({ user: USERS.VENDOR_EMPLOYEE }, res, () => (passedRouter = true));
  assert.ok(passedRouter, "EMPLOYEE passes the router-level ADMIN/EMPLOYEE check (unchanged)");
  const res2 = fakeRes();
  let reached = false;
  webhookTestLayer()[0]({ user: USERS.VENDOR_EMPLOYEE }, res2, () => (reached = true));
  assert.equal(reached, false);
  assert.equal(res2.statusCode, 403);
});

// ── S2 ──────────────────────────────────────────────────────────────────────

function stubPrisma(row: Record<string, any> | null) {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const calls: string[] = [];
  const trap = (label: string, impl: any = async () => assert.fail(`${label} must not run for an unbooked row`)) =>
    async (...args: any[]) => {
      calls.push(label);
      return impl(...args);
    };
  set(prisma.courierOrder, "findUnique", async () => row);
  set(prisma, "$transaction", trap("$transaction"));
  set(prisma.orderItemAllocation, "findMany", trap("orderItemAllocation.findMany"));
  set(prisma.orderItemAllocation, "count", trap("orderItemAllocation.count"));
  set(prisma.productVariant, "findUnique", trap("productVariant.findUnique (voucher)"));
  set(prisma.voucher, "findUnique", trap("voucher.findUnique (voucher)"));
  set(prisma.voucher, "create", trap("voucher.create (voucher)"));
  return { calls, set, restore: () => restores.reverse().forEach((r) => r()) };
}

const courierOrder = (over: Record<string, any> = {}) => ({
  id: "CO1",
  status: "PENDING_PICKUP",
  courierStatus: BOOKING_PENDING,
  courierTrackingId: null,
  consignmentId: null,
  returnConsignmentId: null,
  warehouseId: "WH1",
  codAmount: { greaterThan: () => false },
  deliveryCharge: 0,
  vendorOrder: { id: "VO1", orderId: "O1", vendorId: "V1", shippingCost: 0, vendor: {}, items: [] },
  ...over,
});

const UNBOOKED: [string, Record<string, any>][] = [
  ["unclaimed intent", {}],
  ["claimed intent", { courierStatus: "Booking submitting [claim:x]" }],
  ["UNKNOWN intent", { courierStatus: BOOKING_UNKNOWN }],
  ["L1: consignmentId only", { consignmentId: "CN-1" }],
  ["L2: returnConsignmentId only", { returnConsignmentId: "RCN-1" }],
  ["L4: moved off pending without a tracking id", { status: "DELIVERED" }],
];

for (const [label, over] of UNBOOKED) {
  for (const newStatus of ["CANCELLED", "DELIVERED", "PICKED_UP"] as const) {
    test(`S2: ${label} + ${newStatus} → refused before any write or voucher`, async () => {
      const env = stubPrisma(courierOrder(over));
      try {
        await assert.rejects(
          AdminOrderService.processCourierStatusUpdate({
            courierOrderId: "CO1",
            newStatus,
            courierStatus: "simulated",
            timestamp: new Date(),
          }),
          (e: any) => e.code === "COURIER_ORDER_NOT_BOOKED",
        );
        assert.deepEqual(env.calls, [], "no state transaction, allocation read or voucher call");
      } finally {
        env.restore();
      }
    });
  }
}

test("S2: the simulate endpoint answers 400 for an unbooked intent and writes nothing", async () => {
  const env = stubPrisma(courierOrder({ courierStatus: BOOKING_UNKNOWN }));
  try {
    const res = fakeRes();
    await AdminOrderController.simulateCourierWebhook(
      { params: { courierOrderId: "CO1" }, body: { newStatus: "CANCELLED", courierStatus: "manual" } } as any,
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /not a booked shipment/);
    assert.deepEqual(env.calls, []);
  } finally {
    env.restore();
  }
});

test("S2: a BOOKED row still transitions, and the claim carries courierTrackingId: { not: null }", async () => {
  const env = stubPrisma(courierOrder({ courierTrackingId: "TRK1", courierStatus: "Order Created" }));
  const claims: any[] = [];
  const history: any[] = [];
  try {
    env.set(prisma.orderItemAllocation, "findMany", async () => []);
    env.set(prisma.orderItemAllocation, "count", async () => 0);
    env.set(prisma, "$transaction", async (fn: any) =>
      fn({
        courierOrder: {
          updateMany: async (args: any) => {
            claims.push(args);
            return { count: 1 };
          },
        },
        courierTrackingHistory: { create: async ({ data }: any) => history.push(data) },
        // Phase 3: the transaction re-reads the vendor order's status first.
        vendorOrder: { findUnique: async () => ({ status: "PACKAGING" }), update: async () => ({}), findMany: async () => [] },
      }),
    );
    const out = await AdminOrderService.processCourierStatusUpdate({
      courierOrderId: "CO1",
      newStatus: "PICKED_UP",
      courierStatus: "picked",
      timestamp: new Date(),
    });
    assert.equal(out.processed, true);
    assert.equal(claims.length, 1);
    assert.deepEqual(claims[0].where.courierTrackingId, { not: null });
    assert.equal(history.length, 1);
  } finally {
    env.restore();
  }
});
