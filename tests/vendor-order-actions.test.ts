// tests/vendor-order-actions.test.ts
//
// GET /api/vendor-orders/:id now carries `vendorActions` — what the store may
// do right now, derived from the rules the action endpoints enforce:
//   - next status only CONFIRMED → PROCESSING → PACKAGING;
//   - manual COD confirmation never for high-risk COD (FinixMart review) or a
//     released reservation, never for prepaid orders;
//   - courier booking only from PACKAGING, never while a booking is in flight
//     or needs reconciliation, never for an unpaid prepaid order;
//   - return receipt only after the courier reported the return;
//   - ownership: another vendor's order is refused before anything is derived.
// DB-free: npx tsx --test tests/vendor-order-actions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { VendorOrderService, vendorOrderActions } from "../src/services/vendor.order.service.ts";
import { BOOKING_PENDING } from "../src/services/courier.service.ts";

type Row = Record<string, any>;
const OK = { reservationIntact: true, paid: false };
const VO = (over: Row = {}) => ({ status: "PENDING", order: { paymentmethod: "COD", riskScore: 10 }, courierOrders: [], courierOrderId: null, ...over });

test("COD pending: confirm only when not under review and the stock is still reserved", () => {
  assert.deepEqual(vendorOrderActions(VO(), OK), { nextStatus: null, canConfirmCod: true, canMarkForDelivery: false, canConfirmReturn: false, notes: [] });
  const review = vendorOrderActions(VO({ order: { paymentmethod: "COD", riskScore: 60 } }), OK);
  assert.deepEqual([review.canConfirmCod, review.notes], [false, ["COD_REVIEW_REQUIRED"]]);
  const released = vendorOrderActions(VO(), { reservationIntact: false, paid: false });
  assert.deepEqual([released.canConfirmCod, released.notes], [false, ["STOCK_RELEASED"]]);
});

test("prepaid pending: never a COD confirmation; awaiting payment vs paid-awaiting-confirmation", () => {
  const unpaid = vendorOrderActions(VO({ order: { paymentmethod: "SSLCOMMERZ", riskScore: 0 } }), OK);
  assert.deepEqual([unpaid.canConfirmCod, unpaid.notes], [false, ["AWAITING_PAYMENT"]]);
  const paid = vendorOrderActions(VO({ order: { paymentmethod: "SSLCOMMERZ", riskScore: 0 } }), { reservationIntact: false, paid: true });
  assert.deepEqual(paid.notes, ["PAID_AWAITING_CONFIRMATION"]);
});

test("status steps and courier booking follow the endpoint rules", () => {
  assert.equal(vendorOrderActions(VO({ status: "CONFIRMED" }), OK).nextStatus, "PROCESSING");
  assert.equal(vendorOrderActions(VO({ status: "PROCESSING" }), OK).nextStatus, "PACKAGING");
  for (const st of ["PACKAGING", "SHIPPED", "DELIVERED", "CANCELLED", "PENDING"]) assert.equal(vendorOrderActions(VO({ status: st }), OK).nextStatus, null, st);

  assert.equal(vendorOrderActions(VO({ status: "PACKAGING" }), OK).canMarkForDelivery, true, "COD from packaging");
  const unpaidPrepaid = vendorOrderActions(VO({ status: "PACKAGING", order: { paymentmethod: "EPS" } }), OK);
  assert.deepEqual([unpaidPrepaid.canMarkForDelivery, unpaidPrepaid.notes], [false, ["AWAITING_PAYMENT"]]);
  assert.equal(vendorOrderActions(VO({ status: "PACKAGING", order: { paymentmethod: "EPS" } }), { reservationIntact: true, paid: true }).canMarkForDelivery, true);
  for (const courierStatus of ["Booking submitting [claim:abc]", "Booking outcome unknown"]) {
    const a = vendorOrderActions(VO({ status: "PACKAGING", courierOrders: [{ id: "C1", status: "PENDING_PICKUP", courierTrackingId: null, courierStatus }] }), OK);
    assert.deepEqual([a.canMarkForDelivery, a.notes], [false, ["BOOKING_NEEDS_ATTENTION"]], courierStatus);
  }
  assert.equal(
    vendorOrderActions(VO({ status: "PACKAGING", courierOrders: [{ id: "C1", status: "PENDING_PICKUP", courierTrackingId: null, courierStatus: BOOKING_PENDING }] }), OK).canMarkForDelivery,
    true,
    "an unclaimed intent may be retried",
  );
  assert.equal(vendorOrderActions(VO({ status: "CONFIRMED" }), OK).canMarkForDelivery, false);
});

test("return receipt only after the courier reported the return, and only once", () => {
  const co = (o: Row) => ({ id: "C1", status: "RETURNED", courierTrackingId: "T", courierStatus: "Returned", ...o });
  assert.equal(vendorOrderActions(VO({ status: "SHIPPED", courierOrders: [co({ returnedAt: new Date() })] }), OK).canConfirmReturn, true);
  assert.equal(vendorOrderActions(VO({ status: "SHIPPED", courierOrders: [co({ returnedAt: new Date(), vendorConfirmedReturnAt: new Date() })] }), OK).canConfirmReturn, false);
  assert.equal(vendorOrderActions(VO({ status: "SHIPPED", courierOrders: [co({ returnedAt: null })] }), OK).canConfirmReturn, false);
});

test("getById: refuses another vendor's order before deriving; attaches vendorActions from real facts", async () => {
  const restores: (() => void)[] = [];
  const set = (o: any, k: string, v: any) => {
    const orig = o[k];
    o[k] = v;
    restores.push(() => (o[k] = orig));
  };
  const counted: Row[] = [];
  set(prisma.vendorOrder, "findUnique", async () => ({ id: "VO1", vendorId: "V1", orderId: "O1", status: "PENDING", order: { paymentmethod: "COD", riskScore: 20 }, courierOrders: [], courierOrderId: null }));
  set(prisma.order, "findUnique", async () => ({ reservationReleasedAt: new Date(), vendorOrders: [] }));
  set(prisma.payment, "count", async (a: Row) => (counted.push(a.where), 0));
  try {
    await assert.rejects(VendorOrderService.getById("VO1", "V2"), /Unauthorized/);
    assert.equal(counted.length, 0, "nothing derived for a foreign order");
    const r: any = await VendorOrderService.getById("VO1", "V1");
    assert.deepEqual(r.vendorActions, { nextStatus: null, canConfirmCod: false, canMarkForDelivery: false, canConfirmReturn: false, notes: ["STOCK_RELEASED"] });
    assert.equal(r.codReviewRequired, false);
    assert.deepEqual(counted[0], { orderId: "O1", status: "PAID" });
  } finally {
    restores.reverse().forEach((r) => r());
  }
});
