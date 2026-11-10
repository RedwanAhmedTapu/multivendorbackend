// tests/customer-cancel.test.ts
//
// PHASE 3 (H-1, H-2): customer cancellation (OrderService.cancelOrderByUser).
//   H-1 — a booked shipment, or a booking whose outcome is unresolved
//         (claimed / UNKNOWN / CONFIRM_FAILED / legacy "Booking in progress"),
//         blocks the cancellation: 409 COURIER_BOOKING_ACTIVE, nothing written
//         (no status change, no stock release, no refund, no courier write).
//         An UNCLAIMED intent ("Booking pending") is cancelled through the
//         guarded cancelCourierOrder on the SAME transaction client.
//   H-2 — cancelling twice (sequentially, concurrently via a P2034 retry, or
//         with a refund already present) creates exactly one refund and one
//         Event 0a reversal; an already-cancelled order is a no-op.
//   Phase 4 (H-2) — the cancellation refund takes the shared payment-row lock
//         before reading the consumed sum, refunds only the remaining
//         balance, and is created together with its RefundRecord (one
//         transaction: a record failure rolls the whole cancellation back).
//
// DB-free: an in-memory order / courier / allocation / stock / refund world
// behind the service's Prisma delegates and a $transaction stub that snapshots
// and restores it on failure. Proves the guards and write routing, NOT
// PostgreSQL serialization (S4). Run with:
//   npx tsx --test tests/customer-cancel.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma.ts";
import { OrderService, orderServiceDb, CourierBookingActiveError } from "../src/services/order.service.ts";
import { OrderController } from "../src/controllers/order.controller.ts";
import { courierServiceDb, BOOKING_PENDING, BOOKING_UNKNOWN, BOOKING_CONFIRM_FAILED } from "../src/services/courier.service.ts";

type Row = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function matches(row: Row, where: Row = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k] ?? null;
    if (cond !== null && typeof cond === "object") {
      if ("not" in cond && (cond.not === null ? v === null : v === cond.not)) return false;
      if ("in" in cond && !cond.in.includes(v)) return false;
      continue;
    }
    if (cond === null ? v !== null : v !== cond) return false;
  }
  return true;
}

interface World {
  order: Row;
  courierOrders: Row[];
  allocations: Row[];
  stock: Row[];
  refunds: Row[];
  records: Row[];
  history: Row[];
  writes: string[];
  /** non-write calls, in order (payment lock, consumed-sum read) */
  ledger: string[];
}

function world(opts: { paid?: boolean; courier?: Row[]; refunds?: Row[]; status?: string } = {}): World {
  return {
    order: {
      id: "O1",
      userId: "U1",
      status: opts.status ?? "CONFIRMED",
      payments: opts.paid ? [{ id: "PAY1", status: "PAID", amount: 1500 }] : [],
      vendorOrders: [{ id: "VO1", status: opts.status ?? "PACKAGING", items: [{ id: "I1", variantId: "VAR1" }] }],
    },
    courierOrders: (opts.courier ?? []).map((c, i) => ({ id: `CO${i + 1}`, vendorOrderId: "VO1", status: "PENDING_PICKUP", courierTrackingId: null, ...c })),
    allocations: [{ id: "AL1", orderItemId: "I1", warehouseId: "WH-A", rackId: null, rowNumber: null, shelfNumber: null, quantity: 2, shippedQty: 0 }],
    stock: [{ id: "S1", variantId: "VAR1", warehouseId: "WH-A", rackId: null, rowNumber: null, shelfNumber: null, quantity: 10, reservedQty: 2, damagedQty: 0 }],
    refunds: clone(opts.refunds ?? []),
    records: [],
    history: [],
    writes: [],
    ledger: [],
  };
}

function install(w: World, opts: { p2034Once?: boolean; courierClaimedAtWrite?: boolean; recordFails?: boolean } = {}) {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const reversals: string[] = [];
  const orderView = () => ({
    ...clone(w.order),
    vendorOrders: w.order.vendorOrders.map((vo: Row) => ({ ...clone(vo), courierOrders: clone(w.courierOrders.filter((c) => c.vendorOrderId === vo.id)) })),
  });
  set(orderServiceDb.order as any, "findFirst", async () => orderView());
  set(prisma.voucher as any, "findFirst", async ({ where }: any) => (reversals.push(where.orderId), null));
  // Courier rows must never be written through a global client.
  set(courierServiceDb.courierOrder as any, "updateMany", async () => assert.fail("courier write through the global client"));
  set(courierServiceDb.courierTrackingHistory as any, "create", async () => assert.fail("history write through the global client"));

  let conflictThrown = false;
  let attempts = 0;
  set(orderServiceDb as any, "$transaction", async (fn: any) => {
    attempts++;
    const snap = clone({ order: w.order, courierOrders: w.courierOrders, allocations: w.allocations, stock: w.stock, refunds: w.refunds, records: w.records, history: w.history, writes: w.writes });
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => (w.ledger.push(`lock:${strings.join("?")}:${values.join(",")}`), 1),
      payment: {
        findFirst: async ({ where }: any) =>
          clone(w.order.payments.find((p: Row) => where.orderId === w.order.id && where.status.in.includes(p.status)) ?? null),
      },
      refundRecord: {
        create: async ({ data }: any) => {
          if (opts.recordFails) throw new Error("record insert failed");
          w.writes.push("refundRecord.create");
          w.records.push(clone(data));
          return data;
        },
      },
      order: {
        findUnique: async () => ({ userId: w.order.userId, vendorOrders: [{ vendorId: "V1" }] }),
        findFirst: async () => orderView(),
        update: async ({ data }: any) => (w.writes.push("order.update"), Object.assign(w.order, { status: data.status }), orderView()),
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
          if (opts.courierClaimedAtWrite) return { count: 0 };
          const hit = w.courierOrders.filter((c) => matches(c, where));
          hit.forEach((c) => Object.assign(c, data));
          return { count: hit.length };
        },
      },
      courierTrackingHistory: { create: async ({ data }: any) => (w.writes.push("history.create"), w.history.push(data), data) },
      orderItem: { findUnique: async ({ where }: any) => ({ variantId: w.order.vendorOrders[0].items.find((i: Row) => i.id === where.id)?.variantId }) },
      orderItemAllocation: {
        findMany: async ({ where }: any) => clone(w.allocations.filter((a) => a.orderItemId === where.orderItemId)),
        delete: async ({ where }: any) => (w.writes.push("allocation.delete"), (w.allocations = w.allocations.filter((a) => a.id !== where.id)), {}),
        update: async () => assert.fail("no shipped allocations here"),
      },
      warehouseStock: {
        findFirst: async ({ where }: any) => clone(w.stock.find((s) => matches(s, where)) ?? null),
        update: async ({ where, data }: any) => {
          w.writes.push("warehouseStock.update");
          const s = w.stock.find((x) => x.id === where.id)!;
          for (const k of ["quantity", "reservedQty", "damagedQty"]) s[k] += data[k]?.increment ?? 0;
          return s;
        },
      },
      productVariant: { update: async () => ({}) },
      refund: {
        aggregate: async ({ where }: any) => {
          w.ledger.push("consumed-sum");
          const sum = w.refunds
            .filter((r) => r.orderId === where.orderId && where.status.in.includes(r.status))
            .reduce((a, r) => a + Number(r.amount), 0);
          return { _sum: { amount: sum || null } };
        },
        create: async ({ data }: any) => {
          w.writes.push("refund.create");
          const r = { id: `RF${w.refunds.length + 1}`, ...clone(data) };
          w.refunds.push(r);
          if (opts.p2034Once && !conflictThrown) {
            conflictThrown = true;
            throw new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: "test" });
          }
          return r;
        },
      },
    };
    try {
      return await fn(tx);
    } catch (e) {
      Object.assign(w, clone(snap));
      throw e;
    }
  });
  return { reversals, attempts: () => attempts, restore: () => restores.reverse().forEach((r) => r()) };
}

const cancel = () => new OrderService().cancelOrderByUser("U1", "O1", "changed my mind");

// ── H-1: active / unresolved bookings block the cancellation ────────────────

for (const [label, row] of [
  ["booked shipment (tracking id)", { courierTrackingId: "TRK1", courierStatus: "Order Created" }],
  ["claimed intent (provider call in flight)", { courierStatus: "Booking submitting [claim:x]" }],
  ["UNKNOWN intent", { courierStatus: BOOKING_UNKNOWN }],
  ["CONFIRM_FAILED intent", { courierStatus: BOOKING_CONFIRM_FAILED }],
  ["legacy 'Booking in progress' intent", { courierStatus: "Booking in progress" }],
] as const) {
  test(`H-1: ${label} → 409 COURIER_BOOKING_ACTIVE, nothing written`, async () => {
    const w = world({ paid: true, courier: [row as Row] });
    const before = clone(w);
    const env = install(w);
    try {
      await assert.rejects(cancel(), (e: any) => e instanceof CourierBookingActiveError);
      assert.deepEqual(w.order, before.order, "order + vendor orders unchanged");
      assert.deepEqual(w.courierOrders, before.courierOrders, "courier row unchanged");
      assert.deepEqual(w.allocations, before.allocations, "no stock release");
      assert.deepEqual(w.stock, before.stock);
      assert.deepEqual(w.refunds, [], "no refund");
      assert.deepEqual(w.writes, []);
      assert.deepEqual(env.reversals, [], "no 0a reversal");
    } finally {
      env.restore();
    }
  });
}

test("H-1: an unclaimed 'Booking pending' intent is cancelled through the transaction, with the order", async () => {
  const w = world({ courier: [{ courierStatus: BOOKING_PENDING }] });
  const env = install(w);
  try {
    await cancel();
    assert.equal(w.order.status, "CANCELLED");
    assert.equal(w.courierOrders[0].status, "CANCELLED");
    assert.equal(w.history.length, 1);
    assert.deepEqual(w.allocations, [], "reservation released");
    assert.equal(w.stock[0].reservedQty, 0);
  } finally {
    env.restore();
  }
});

test("H-1: an intent claimed between the read and the guarded cancel → 409, everything rolled back", async () => {
  const w = world({ paid: true, courier: [{ courierStatus: BOOKING_PENDING }] });
  const before = clone(w);
  const env = install(w, { courierClaimedAtWrite: true });
  try {
    await assert.rejects(cancel(), (e: any) => e instanceof CourierBookingActiveError);
    assert.deepEqual(w.order, before.order);
    assert.deepEqual(w.allocations, before.allocations);
    assert.deepEqual(w.stock, before.stock);
    assert.deepEqual(w.refunds, []);
    assert.deepEqual(env.reversals, []);
  } finally {
    env.restore();
  }
});

test("H-1: already-cancelled courier rows are ignored; no courier rows → unchanged behavior", async () => {
  for (const courier of [[{ status: "CANCELLED", courierStatus: "Booking rejected: x" }], []]) {
    const w = world({ courier });
    const env = install(w);
    try {
      await cancel();
      assert.equal(w.order.status, "CANCELLED");
      assert.equal(w.history.length, 0);
    } finally {
      env.restore();
    }
  }
});

// ── H-2: one refund, one reversal ───────────────────────────────────────────

test("H-2: a paid order cancelled twice → exactly one refund and one 0a reversal; the second call is a no-op", async () => {
  const w = world({ paid: true });
  const env = install(w);
  try {
    await cancel();
    assert.equal(w.refunds.length, 1);
    assert.equal(Number(w.refunds[0].amount), 1500);
    const writesAfterFirst = w.writes.length;
    const again: any = await cancel();
    assert.equal(again.status, "CANCELLED", "returns the cancelled order");
    assert.equal(w.refunds.length, 1, "no second refund");
    assert.equal(w.writes.length, writesAfterFirst, "the second call wrote nothing");
    assert.deepEqual(env.reversals, ["O1"], "0a reversed once");
  } finally {
    env.restore();
  }
});

test("H-2: concurrent cancel (P2034 on the first attempt) → the retry creates exactly one refund", async () => {
  const w = world({ paid: true });
  const env = install(w, { p2034Once: true });
  try {
    await cancel();
    assert.equal(env.attempts(), 2, "retried once");
    assert.equal(w.refunds.length, 1);
    assert.equal(w.records.length, 1, "exactly one RefundRecord after the retry");
    assert.equal(w.order.status, "CANCELLED");
  } finally {
    env.restore();
  }
});

test("H-2: a cancel committed between the outer read and the transaction → in-transaction no-op", async () => {
  const w = world({ paid: true, status: "CANCELLED", refunds: [{ id: "RF0", orderId: "O1", amount: 1500, status: "PENDING" }] });
  const env = install(w);
  const outer = { ...clone(w.order), status: "CONFIRMED", vendorOrders: [{ ...clone(w.order.vendorOrders[0]), status: "PACKAGING", courierOrders: [] }] };
  const orig = orderServiceDb.order.findFirst;
  let outerRead = true;
  (orderServiceDb.order as any).findFirst = async (...a: any[]) => (outerRead ? ((outerRead = false), clone(outer)) : (orig as any)(...a));
  try {
    const out: any = await cancel();
    assert.equal(out.status, "CANCELLED");
    assert.deepEqual(w.writes, [], "nothing written");
    assert.equal(w.refunds.length, 1, "no second refund");
    assert.deepEqual(env.reversals, [], "no second 0a reversal");
  } finally {
    (orderServiceDb.order as any).findFirst = orig;
    env.restore();
  }
});

test("H-2: an existing active refund for the order → no second refund", async () => {
  for (const status of ["PENDING", "APPROVED", "PROCESSING", "REFUNDED"]) {
    const w = world({ paid: true, refunds: [{ id: "RF0", orderId: "O1", amount: 1500, status }] });
    const env = install(w);
    try {
      await cancel();
      assert.equal(w.refunds.length, 1, status);
    } finally {
      env.restore();
    }
  }
});

test("H-2: a rejected/failed earlier refund does not block the cancellation refund", async () => {
  const w = world({ paid: true, refunds: [{ id: "RF0", orderId: "O1", amount: 1500, status: "REJECTED" }] });
  const env = install(w);
  try {
    await cancel();
    assert.equal(w.refunds.length, 2);
  } finally {
    env.restore();
  }
});

test("unpaid (COD) cancel → no refund, no reversal", async () => {
  const w = world();
  const env = install(w);
  try {
    await cancel();
    assert.equal(w.refunds.length, 0);
    assert.deepEqual(env.reversals, []);
  } finally {
    env.restore();
  }
});

// ── controller ──────────────────────────────────────────────────────────────

test("controller: COURIER_BOOKING_ACTIVE → 409 with a message the customer UI shows", async () => {
  const proto = OrderService.prototype as any;
  const orig = proto.cancelOrderByUser;
  proto.cancelOrderByUser = async () => {
    throw new CourierBookingActiveError();
  };
  try {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (c: number) => ((res.statusCode = c), res);
    res.json = (b: unknown) => ((res.body = b), res);
    await new OrderController().cancelOrder({ user: { id: "U1" }, params: { orderId: "O1" }, body: {} } as any, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "COURIER_BOOKING_ACTIVE");
    assert.match(res.body.message, /contact support/);
  } finally {
    proto.cancelOrderByUser = orig;
  }
});

// ── Phase 4 (H-2): refund record atomicity and the shared balance lock ──────

test("Phase 4: the cancellation refund is created with its RefundRecord, under the payment-row lock", async () => {
  const w = world({ paid: true });
  const env = install(w);
  try {
    await cancel();
    assert.equal(w.refunds.length, 1);
    assert.equal(w.records.length, 1, "RefundRecord created");
    const [rf, rec] = [w.refunds[0], w.records[0]];
    assert.equal(rec.refundId, rf.id);
    assert.equal(rec.refundType, "CUSTOMER_INITIATED");
    assert.equal(rec.initiatedBy, "U1");
    assert.equal(rec.status, "PENDING");
    assert.equal(Number(rec.refundAmount), 1500);
    assert.equal(rec.customerId, "U1");
    assert.match(rec.refundNumber, /^RF-\d+-[0-9A-F]{8}$/, "collision-safe refund number");
    const lock = w.ledger.findIndex((l) => l.startsWith("lock:") && /FOR UPDATE/.test(l) && l.endsWith(":PAY1"));
    assert.ok(lock >= 0, "payment row PAY1 locked FOR UPDATE");
    assert.ok(lock < w.ledger.indexOf("consumed-sum"), "lock taken before the consumed sum is read");
  } finally {
    env.restore();
  }
});

test("Phase 4: an earlier partial refund → the cancellation refunds only the remaining balance", async () => {
  const w = world({ paid: true, refunds: [{ id: "RF0", orderId: "O1", amount: 500, status: "PENDING" }] });
  const env = install(w);
  try {
    await cancel();
    assert.equal(w.refunds.length, 2);
    assert.equal(Number(w.refunds[1].amount), 1000);
    const total = w.refunds.reduce((a, r) => a + Number(r.amount), 0);
    assert.ok(total <= 1500, "never more than was paid");
  } finally {
    env.restore();
  }
});

test("Phase 4: a RefundRecord failure rolls back the refund AND the cancellation (no orphan refund)", async () => {
  const w = world({ paid: true });
  const before = clone(w);
  const env = install(w, { recordFails: true });
  try {
    await assert.rejects(cancel(), /record insert failed/);
    assert.deepEqual(w.refunds, [], "no refund without a record");
    assert.deepEqual(w.records, []);
    assert.equal(w.order.status, before.order.status, "order not cancelled");
    assert.deepEqual(w.stock, before.stock, "stock not released");
    assert.deepEqual(env.reversals, []);
  } finally {
    env.restore();
  }
});
