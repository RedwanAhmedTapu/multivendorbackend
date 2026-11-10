// tests/admin-fraud-review.test.ts
//
// GET /api/admin-orders/fraud-review — the admin review queue.
//   - server-derived facts per order: reviewReason, highRisk (existing COD
//     threshold), stockReserved (the same rule as the confirm guard), payment
//     summary without raw meta, customer history count;
//   - actions the backend will accept: canApprove only while the stock is
//     reserved (confirmOrder refuses otherwise — checked against the real
//     service), canReject only when nothing was paid, canCancel always;
//   - queue filter (cod | paid), order-number search, paging bounds, real
//     per-queue counts; invalid queue → 400.
// DB-free (Prisma delegates replaced in place):
//   npx tsx --test tests/admin-fraud-review.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../src/config/prisma.ts";
import { AdminOrderService, OrderStatusTransitionError, toReviewItem } from "../src/services/admin.order.service.ts";
import { AdminOrderController } from "../src/controllers/admin.order.controller.ts";
import { isReservationIntact } from "../src/services/order-reservation.ts";

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

const vo = (allocated: boolean[], over: Row = {}) => ({
  status: "PENDING", subtotal: new Decimal("1000"), vendor: { id: "V1", storeName: "Store One" },
  items: allocated.map((a) => ({ quantity: 2, _count: { allocations: a ? 1 : 0 } })), ...over,
});
const ORDER = (over: Row = {}) => ({
  id: "O1", orderNumber: "ORD-1", createdAt: new Date("2026-10-18T08:00:00Z"), totalAmount: new Decimal("1060"),
  paymentmethod: "COD", status: "PENDING", paymentStatus: "PENDING", riskScore: new Decimal("72"), reservationReleasedAt: null,
  user: { id: "U1", name: "Customer", email: "c@example.com", phone: "01700000000", isVerified: false, createdAt: new Date("2026-10-15T00:00:00Z"), orders: [{ id: "X1" }, { id: "X2" }] },
  address: { receiverFullName: "Customer", city: "Dhaka", address: "House 1" },
  payments: [],
  vendorOrders: [vo([true, true])],
  ...over,
});

test("isReservationIntact: the confirm guard's rule on loaded rows (array or _count shapes)", () => {
  assert.equal(isReservationIntact({ reservationReleasedAt: null, vendorOrders: [vo([true])] }), true);
  assert.equal(isReservationIntact({ reservationReleasedAt: new Date(), vendorOrders: [vo([true])] }), false);
  assert.equal(isReservationIntact({ reservationReleasedAt: null, vendorOrders: [vo([true, false])] }), false);
  assert.equal(isReservationIntact({ reservationReleasedAt: null, vendorOrders: [vo([true]), vo([false], { status: "CANCELLED" })] }), true);
  assert.equal(isReservationIntact({ reservationReleasedAt: null, vendorOrders: [{ status: "PENDING", items: [{ allocations: [] }] }] }), false);
  assert.equal(isReservationIntact({ reservationReleasedAt: null, vendorOrders: [] }), false);
});

test("review item: high-risk COD with stock → approve / reject / cancel; facts and customer history", () => {
  const r = toReviewItem(ORDER());
  assert.deepEqual([r.reviewReason, r.highRisk, r.riskScore, r.stockReserved], ["HIGH_RISK_COD", true, 72, true]);
  assert.deepEqual(r.actions, { canApprove: true, canReject: true, canCancel: true });
  assert.deepEqual(r.customer, { id: "U1", name: "Customer", email: "c@example.com", phone: "01700000000", verified: false, memberSince: new Date("2026-10-15T00:00:00Z"), problemOrders: 2 });
  assert.deepEqual(r.vendors, [{ id: "V1", storeName: "Store One", subtotal: "1000", items: 4 }]);
  assert.equal(r.totalAmount, "1060");
  assert.equal(r.payment, null);
});

test("review item: paid order whose stock was released → cannot be approved or rejected, only cancelled (refund); no raw meta", () => {
  const r = toReviewItem(
    ORDER({
      paymentmethod: "SSLCOMMERZ", paymentStatus: "PAID", riskScore: new Decimal("10"), reservationReleasedAt: new Date("2026-10-18T09:00:00Z"),
      payments: [{ method: "SSLCOMMERZ", status: "PAID", amount: new Decimal("1060"), paidAt: new Date("2026-10-18T09:30:00Z"), meta: { stockHold: { reason: "STOCK_RESERVATION_RELEASED" }, bankTranId: "secret" } }],
      vendorOrders: [vo([false])],
    }),
  );
  assert.deepEqual([r.reviewReason, r.stockReserved, r.highRisk], ["PAID_STOCK_RELEASED", false, false]);
  assert.deepEqual(r.actions, { canApprove: false, canReject: false, canCancel: true });
  assert.deepEqual(r.payment, { method: "SSLCOMMERZ", status: "PAID", amount: "1060", paidAt: new Date("2026-10-18T09:30:00Z"), stockHold: true });
  assert.ok(!JSON.stringify(r).includes("secret") && !JSON.stringify(r).includes("bankTranId"), "no raw payment meta");
});

test("review item: unscored legacy COD → awaiting confirmation; COD whose stock was released → no approve", () => {
  assert.equal(toReviewItem(ORDER({ riskScore: null })).reviewReason, "COD_AWAITING_CONFIRMATION");
  assert.equal(toReviewItem(ORDER({ riskScore: null })).riskScore, null);
  const released = toReviewItem(ORDER({ reservationReleasedAt: new Date() }));
  assert.deepEqual([released.stockReserved, released.actions.canApprove, released.actions.canReject], [false, false, true]);
});

test("canApprove=false matches the backend: confirmOrder refuses the same order with 409 (stock released)", async () => {
  const s = stubber();
  const row = ORDER({ reservationReleasedAt: new Date() });
  assert.equal(toReviewItem(row).actions.canApprove, false);
  s.set(prisma.order, "findUnique", async () => ({ status: "PENDING", orderNumber: "ORD-1", userId: "U1", paymentmethod: "COD" }));
  s.set(prisma.auditLog, "create", async (a: Row) => a.data);
  s.set(prisma, "$transaction", async (fn: any) =>
    fn({
      $executeRaw: async () => 1,
      order: { findUnique: async () => ({ reservationReleasedAt: row.reservationReleasedAt, vendorOrders: [{ items: [{ allocations: [] }] }] }), updateMany: async () => assert.fail("must not confirm") },
    }),
  );
  try {
    await assert.rejects(AdminOrderService.approveOrder("O1", "A1"), (e: any) => e instanceof OrderStatusTransitionError && e.statusCode === 409);
  } finally {
    s.restore();
  }
});

test("queue filter, search, paging bounds and real per-queue counts", async () => {
  const s = stubber();
  const finds: Row[] = [];
  const counts: Row[] = [];
  s.set(prisma.order, "findMany", async (a: Row) => (finds.push(a), [ORDER()]));
  s.set(prisma.order, "count", async (a: Row) => (counts.push(a.where), a.where.paymentmethod === "COD" ? 3 : JSON.stringify(a.where).includes('"not":"COD"') && !a.where.OR ? 5 : 8));
  try {
    const all = await AdminOrderService.getFraudReview({ page: 1, limit: 20 });
    assert.ok(finds[0].where.OR, "both queues");
    assert.deepEqual(all.counts, { cod: 3, paid: 5 });
    assert.equal(all.pagination.total, 8);
    await AdminOrderService.getFraudReview({ queue: "cod", search: " ORD-17 ", limit: 500, page: 0 });
    assert.deepEqual(finds[1].where, { status: "PENDING", paymentmethod: "COD", orderNumber: { contains: "ORD-17", mode: "insensitive" } });
    assert.deepEqual([finds[1].take, finds[1].skip], [50, 0], "limit capped at 50, page at least 1");
    await AdminOrderService.getFraudReview({ queue: "paid" });
    assert.deepEqual(finds[2].where, { status: "PENDING", paymentmethod: { not: "COD" }, payments: { some: { status: "PAID" } } });
    assert.ok(!("include" in finds[0]), "explicit select only");
  } finally {
    s.restore();
  }
});

test("controller: invalid queue → 400 before any query; counts returned; search trimmed and capped", async () => {
  const s = stubber();
  const seen: Row[] = [];
  s.set(AdminOrderService, "getFraudReview", async (p: Row) => (seen.push(p), { orders: [], counts: { cod: 1, paid: 2 }, pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } }));
  try {
    const bad = fakeRes();
    await AdminOrderController.getFraudReview({ query: { queue: "everything" } } as any, bad);
    assert.equal(bad.statusCode, 400);
    assert.equal(seen.length, 0);
    const ok = fakeRes();
    await AdminOrderController.getFraudReview({ query: { queue: "paid", search: "  " + "x".repeat(100) } } as any, ok);
    assert.deepEqual(ok.body.counts, { cod: 1, paid: 2 });
    assert.equal(seen[0].queue, "paid");
    assert.equal(seen[0].search.length, 64);
  } finally {
    s.restore();
  }
});
