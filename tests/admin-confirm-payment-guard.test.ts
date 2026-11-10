// tests/admin-confirm-payment-guard.test.ts
//
// Phase 5 / Step 1: AdminOrderService.confirmOrder — the shared enforcement
// point behind PATCH /admin-orders/:id/confirm, /approve and the system
// auto-confirm — confirms an ONLINE-payment order only when a PAID payment row
// exists for it (a COD delivery-fee payment doesn't count). The check runs
// inside the transaction, after the order row lock. COD and the H1
// stock-reservation guard are unchanged.
// DB-free: npx tsx --test tests/admin-confirm-payment-guard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { AdminOrderService, OrderStatusTransitionError } from "../src/services/admin.order.service.ts";
import { AdminOrderController } from "../src/controllers/admin.order.controller.ts";

type Row = Record<string, any>;
const INTACT = { reservationReleasedAt: null, vendorOrders: [{ items: [{ allocations: [{ id: "A1" }] }] }] };
const RELEASED = { reservationReleasedAt: new Date(), vendorOrders: [{ items: [{ allocations: [] }] }] };

function world(opts: { paymentmethod?: string; payments?: Row[]; reservation?: Row }) {
  const restores: (() => void)[] = [];
  const set = (o: any, k: string, v: any) => {
    const orig = o[k];
    o[k] = v;
    restores.push(() => (o[k] = orig));
  };
  const steps: string[] = [];
  const audits: string[] = [];
  set(prisma.order, "findUnique", async () => ({ status: "PENDING", orderNumber: "ORD-1", userId: null, paymentmethod: opts.paymentmethod ?? "SSLCOMMERZ", riskScore: null }));
  set(prisma.auditLog, "create", async ({ data }: Row) => (audits.push(data.action), data));
  set(prisma.notification, "create", async ({ data }: Row) => data);
  set(prisma, "$transaction", async (fn: any) =>
    fn({
      $executeRaw: async () => (steps.push("lock"), 1),
      payment: {
        findMany: async ({ where }: Row) => {
          if (opts.payments === undefined) assert.fail("COD: the payment guard must not run");
          steps.push("payments");
          assert.deepEqual(where, { orderId: "O1", status: "PAID" });
          return opts.payments.filter((p) => p.status === "PAID");
        },
      },
      order: {
        findUnique: async () => (steps.push("reservation"), opts.reservation ?? INTACT),
        updateMany: async () => (steps.push("claim"), { count: 1 }),
      },
      vendorOrder: { updateMany: async () => (steps.push("vendorOrders"), { count: 1 }) },
      auditLog: { create: async ({ data }: Row) => (audits.push(data.action), data) },
    }),
  );
  return { steps, audits, restore: () => restores.reverse().forEach((r) => r()) };
}
const PAID = { status: "PAID", meta: { type: "order_payment" } };

test("unpaid online order: confirm and approve are refused (409) before anything is claimed", async () => {
  for (const payments of [[], [{ status: "PENDING", meta: { type: "order_payment" } }], [{ status: "FAILED", meta: null }]]) {
    for (const call of [() => AdminOrderService.confirmOrder("O1", "A1"), () => AdminOrderService.approveOrder("O1", "A1")]) {
      const w = world({ payments });
      try {
        await assert.rejects(call(), (e: any) => e instanceof OrderStatusTransitionError && e.statusCode === 409 && /no verified payment/.test(e.message));
        assert.deepEqual(w.steps, ["lock", "payments"], "checked under the lock; no claim, no vendor-order write");
      } finally {
        w.restore();
      }
    }
  }
});

test("a PAID delivery-fee payment does not count as payment for an online order", async () => {
  const w = world({ payments: [{ status: "PAID", meta: { type: "delivery_fee" } }] });
  try {
    await assert.rejects(AdminOrderService.confirmOrder("O1", "A1"), (e: any) => e.statusCode === 409);
    assert.ok(!w.steps.includes("claim"));
  } finally {
    w.restore();
  }
});

test("system auto-confirm of an unpaid online order is skipped and audited, never confirmed", async () => {
  const w = world({ payments: [] });
  try {
    assert.deepEqual(await AdminOrderService.confirmOrderBySystem("O1", "PAYMENT_WEBHOOK"), { success: true, skipped: true, reason: "PAYMENT_NOT_VERIFIED" });
    assert.ok(w.audits.includes("ORDER_AUTO_CONFIRM_SKIPPED_UNPAID"));
    assert.ok(!w.steps.includes("claim"));
  } finally {
    w.restore();
  }
});

test("paid online order (incl. a legacy row without meta): confirmed as before", async () => {
  for (const payments of [[PAID], [{ status: "PAID", meta: null }], [{ status: "PAID", meta: { type: "delivery_fee" } }, PAID]]) {
    const w = world({ payments });
    try {
      assert.deepEqual(await AdminOrderService.confirmOrder("O1", "A1"), { success: true });
      assert.deepEqual(w.steps, ["lock", "payments", "reservation", "claim", "vendorOrders"]);
    } finally {
      w.restore();
    }
  }
});

test("COD order: no payment is required (the guard doesn't run); still recorded as an admin override", async () => {
  const w = world({ paymentmethod: "COD" });
  try {
    assert.deepEqual(await AdminOrderService.confirmOrder("O1", "A1"), { success: true });
    assert.deepEqual(w.steps, ["lock", "reservation", "claim", "vendorOrders"]);
    assert.ok(w.audits.includes("COD_ORDER_MANUAL_OVERRIDE_BY_ADMIN"));
  } finally {
    w.restore();
  }
});

test("released reservation still refuses confirmation — paid online and COD alike", async () => {
  for (const opts of [{ payments: [PAID] }, { paymentmethod: "COD" }]) {
    const w = world({ ...opts, reservation: RELEASED });
    try {
      await assert.rejects(AdminOrderService.confirmOrder("O1", "A1"), (e: any) => e.statusCode === 409 && /stock reservation was released/.test(e.message));
      assert.ok(!w.steps.includes("claim"));
    } finally {
      w.restore();
    }
  }
});

test("controllers: direct PATCH …/confirm and …/approve on an unpaid online order answer 409", async () => {
  for (const handler of [AdminOrderController.confirmOrder, AdminOrderController.approveOrder]) {
    const w = world({ payments: [] });
    try {
      const res: any = { statusCode: 200 };
      res.status = (c: number) => ((res.statusCode = c), res);
      res.json = (b: unknown) => ((res.body = b), res);
      await (handler as any)({ user: { id: "A1", rawId: "A1" }, params: { id: "O1" }, body: {} }, res);
      assert.equal(res.statusCode, 409);
      assert.match(res.body.message, /no verified payment/);
    } finally {
      w.restore();
    }
  }
});
