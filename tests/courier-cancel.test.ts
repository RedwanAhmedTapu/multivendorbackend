// tests/courier-cancel.test.ts
//
// PHASE 0 (S3): admin order cancellation and courier rows.
//   • An order whose booking outcome is unresolved (claimed / UNKNOWN /
//     CONFIRM_FAILED / legacy "Booking in progress") cannot be cancelled —
//     nothing is written.
//   • Courier cancellations go through the order-cancellation transaction
//     client (`tx`) — never the global Prisma clients — so they roll back and
//     retry with it.
//   • cancelCourierOrder refuses by RETURNING { cancelled: false } (a thrown SQL
//     error would abort the caller's transaction).
//
// DB-free: Prisma delegates are replaced by an in-memory model whose
// $transaction snapshots state and restores it when the callback throws.
// NOTE: this proves call routing and guard predicates, NOT PostgreSQL
// rollback/serialization behaviour (S4, separately approved, is required for
// that). Run with:
//   npx tsx --test tests/courier-cancel.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma.ts";
import courierService, {
  courierServiceDb,
  BOOKING_PENDING,
  BOOKING_UNKNOWN,
  BOOKING_CONFIRM_FAILED,
} from "../src/services/courier.service.ts";
import { AdminOrderService } from "../src/services/admin.order.service.ts";

type Row = Record<string, any>;

function matches(row: Row, where: Record<string, any> = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as any[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const value = row[key] ?? null;
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("not" in cond && (cond.not === null ? value === null : value === cond.not)) return false;
      if ("in" in cond && !cond.in.includes(value)) return false;
      continue;
    }
    if (cond === null ? value !== null : value !== cond) return false;
  }
  return true;
}

const courierRow = (over: Row = {}): Row => ({
  id: "CO1",
  status: "PENDING_PICKUP",
  courierStatus: BOOKING_PENDING,
  courierTrackingId: null,
  courierProviderId: "P_SF",
  ...over,
});

interface Opts {
  /** Throw a P2034 (write conflict) once, AFTER the courier cancel ran. */
  p2034Once?: boolean;
  /** Make the courier updateMany fail with a non-retryable database error. */
  courierUpdateFails?: boolean;
}

function setup(rows: Row[], opts: Opts = {}) {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const state = { orderStatus: "CONFIRMED", voStatus: "CONFIRMED" };
  const history: Row[] = [];
  const audits: Row[] = [];
  let attempts = 0;
  let conflictThrown = false;

  const snapshotRows = () => ({
    rows: rows.map((r) => ({ ...r })),
    history: history.length,
    audits: audits.length,
    state: { ...state },
  });

  // Outside-the-transaction read (the stale snapshot cancelOrder starts from).
  set(prisma.order, "findUnique", async () => ({
    id: "O1",
    status: state.orderStatus,
    paymentStatus: "PENDING",
    payments: [], // Phase 3: cancelOrder's read includes payments (unpaid here → no refund)
    userId: null,
    vendorOrders: [{ id: "VO1", items: [{ id: "I1" }], courierOrders: rows.map((r) => ({ ...r })) }],
  }));

  const tx = {
    order: {
      findUnique: async () => ({
        status: state.orderStatus,
        vendorOrders: [
          {
            id: "VO1",
            status: state.voStatus,
            courierOrders: rows.map((r) => ({ id: r.id, status: r.status, courierStatus: r.courierStatus, courierTrackingId: r.courierTrackingId })),
          },
        ],
      }),
      update: async ({ data }: any) => {
        state.orderStatus = data.status;
        return data;
      },
    },
    vendorOrder: {
      updateMany: async ({ data }: any) => {
        state.voStatus = data.status;
        return { count: 1 };
      },
    },
    courierOrder: {
      updateMany: async ({ where, data }: any) => {
        if (opts.courierUpdateFails) throw new Error("simulated database failure");
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
    courierTrackingHistory: {
      create: async ({ data }: any) => {
        history.push(data);
        if (opts.p2034Once && !conflictThrown) {
          conflictThrown = true;
          throw new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: "test" });
        }
        return data;
      },
    },
    orderItem: { findUnique: async () => null }, // releaseAllocationsForOrderItem: nothing reserved
    auditLog: {
      create: async ({ data }: any) => {
        audits.push(data);
        return data;
      },
    },
  };

  set(prisma, "$transaction", async (fn: any) => {
    attempts++;
    const snap = snapshotRows();
    try {
      return await fn(tx);
    } catch (e) {
      rows.splice(0, rows.length, ...snap.rows);
      history.splice(snap.history);
      audits.splice(snap.audits);
      Object.assign(state, snap.state);
      throw e;
    }
  });

  // Courier rows must NEVER be written through a global client.
  const forbid = (label: string) => async () => assert.fail(`courier write through the global client (${label})`);
  set(courierServiceDb.courierOrder as any, "update", forbid("courierServiceDb.courierOrder.update"));
  set(courierServiceDb.courierOrder as any, "updateMany", forbid("courierServiceDb.courierOrder.updateMany"));
  set(courierServiceDb.courierTrackingHistory as any, "create", forbid("courierServiceDb.courierTrackingHistory.create"));
  set(prisma.courierOrder as any, "update", forbid("prisma.courierOrder.update"));
  set(prisma.courierOrder as any, "updateMany", forbid("prisma.courierOrder.updateMany"));

  return {
    state,
    history,
    audits,
    attempts: () => attempts,
    restore: () => restores.reverse().forEach((r) => r()),
  };
}

const cancel = () => AdminOrderService.cancelOrder("O1", "ADMIN_1", "test");

// ── unresolved bookings block the whole cancellation ────────────────────────

for (const [label, over] of [
  ["claimed (provider call in flight)", { courierStatus: "Booking submitting [claim:abc]" }],
  ["UNKNOWN", { courierStatus: BOOKING_UNKNOWN }],
  ["CONFIRM_FAILED", { courierStatus: BOOKING_CONFIRM_FAILED }],
  ["legacy 'Booking in progress'", { courierStatus: "Booking in progress" }],
] as const) {
  test(`cancelOrder with a ${label} intent → COURIER_BOOKING_UNRESOLVED, nothing written`, async () => {
    const rows = [courierRow(over as Row)];
    const before = { ...rows[0] };
    const env = setup(rows);
    try {
      await assert.rejects(cancel(), (e: any) => e.code === "COURIER_BOOKING_UNRESOLVED");
      assert.deepEqual(rows[0], before, "courier row unchanged (booking slot still occupied)");
      assert.equal(env.state.orderStatus, "CONFIRMED");
      assert.equal(env.state.voStatus, "CONFIRMED");
      assert.equal(env.history.length, 0);
      assert.equal(env.audits.length, 0);
    } finally {
      env.restore();
    }
  });
}

// ── cancellable rows go through tx ──────────────────────────────────────────

test("an unclaimed 'Booking pending' intent is cancelled through tx together with the order", async () => {
  const rows = [courierRow()];
  const env = setup(rows);
  try {
    await cancel();
    assert.equal(rows[0].status, "CANCELLED");
    assert.equal(env.state.orderStatus, "CANCELLED");
    assert.equal(env.history.length, 1);
    assert.ok(env.audits.some((a) => a.action === "ORDER_CANCELLED"));
  } finally {
    env.restore();
  }
});

test("a booked pre-pickup shipment is cancelled through tx", async () => {
  const rows = [courierRow({ courierTrackingId: "TRK1", courierStatus: "Order Created", status: "READY_FOR_PICKUP" })];
  const env = setup(rows);
  try {
    await cancel();
    assert.equal(rows[0].status, "CANCELLED");
    assert.equal(env.history.length, 1);
  } finally {
    env.restore();
  }
});

// ── retry / rollback atomicity (fake transaction semantics) ─────────────────

test("P2034 after the courier cancel: attempt 1 leaves nothing behind; the retry cancels exactly once", async () => {
  const rows = [courierRow({ courierTrackingId: "TRK1", courierStatus: "Order Created" })];
  const env = setup(rows, { p2034Once: true });
  try {
    await cancel();
    assert.equal(env.attempts(), 2, "runStockMutation retried once");
    assert.equal(rows[0].status, "CANCELLED");
    assert.equal(env.history.length, 1, "no duplicate history row from the rolled-back attempt");
    assert.equal(env.state.orderStatus, "CANCELLED");
  } finally {
    env.restore();
  }
});

test("a non-retryable database error rolls back the WHOLE cancellation (no partial courier cancel)", async () => {
  const rows = [courierRow({ courierTrackingId: "TRK1", courierStatus: "Order Created" })];
  const env = setup(rows, { courierUpdateFails: true });
  try {
    await assert.rejects(cancel(), /simulated database failure/);
    assert.equal(rows[0].status, "PENDING_PICKUP");
    assert.equal(env.state.orderStatus, "CONFIRMED");
    assert.equal(env.audits.length, 0);
    assert.equal(env.attempts(), 1, "not a P2034 → not retried");
  } finally {
    env.restore();
  }
});

// ── cancelCourierOrder refuses by value ─────────────────────────────────────

for (const [label, over] of [
  ["claimed", { courierStatus: "Booking submitting [claim:abc]" }],
  ["UNKNOWN", { courierStatus: BOOKING_UNKNOWN }],
  ["CONFIRM_FAILED", { courierStatus: BOOKING_CONFIRM_FAILED }],
  ["legacy 'Booking in progress'", { courierStatus: "Booking in progress" }],
  ["already cancelled", { status: "CANCELLED", courierTrackingId: "TRK1" }],
  ["picked up", { status: "PICKED_UP", courierTrackingId: "TRK1" }],
] as const) {
  test(`cancelCourierOrder(${label}) → { cancelled: false }, no throw, no history`, async () => {
    const rows = [courierRow(over as Row)];
    const before = { ...rows[0] };
    const history: Row[] = [];
    const db = {
      courierOrder: {
        updateMany: async ({ where, data }: any) => {
          const hit = rows.filter((r) => matches(r, where));
          hit.forEach((r) => Object.assign(r, data));
          return { count: hit.length };
        },
      },
      courierTrackingHistory: { create: async ({ data }: any) => history.push(data) },
    };
    const out = await courierService.cancelCourierOrder("CO1", db as any);
    assert.deepEqual(out, { cancelled: false });
    assert.deepEqual(rows[0], before);
    assert.equal(history.length, 0);
  });
}
