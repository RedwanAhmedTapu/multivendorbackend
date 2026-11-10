// tests/refund-concurrency.test.ts
//
// PHASE 4 (H-2): refund record atomicity and concurrency safeguards.
//   requestRefund — the Refund and its RefundRecord are created in ONE
//     transaction under the shared payment-row lock (taken before the consumed
//     sum is read); a record failure leaves no orphan Refund; the balance can
//     never be over-committed; refund numbers do not collide.
//   approveRefund / rejectRefund — the refund is CLAIMED on PENDING inside the
//     transaction: a double approval or an approve/reject race (both admins
//     read PENDING) moves it exactly once and calls the gateway at most once;
//     the loser gets 409 REFUND_STATE_CHANGED.
//   D6 — approval may only reduce the requested amount, and never exceed the
//     remaining refundable balance.
//
// DB-free: Prisma delegates replaced in place; $transaction snapshots and
// restores the in-memory ledger. "Concurrent" here means both callers acted on
// the same stale read — it proves the guards, NOT PostgreSQL locking (S4).
//   npx tsx --test tests/refund-concurrency.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { paymentService, paymentServiceDb } from "../src/services/payment.service.ts";
import { AdminOrderService, RefundStateConflictError } from "../src/services/admin.order.service.ts";
import { AdminOrderController } from "../src/controllers/admin.order.controller.ts";
import { newRefundNumber, lockRefundableBalance } from "../src/services/refund-balance.ts";

type Row = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const CONSUMING = ["PENDING", "APPROVED", "PROCESSING", "REFUNDED"];

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

interface Ledger {
  refunds: Row[];
  records: Row[];
  order: Row;
  log: string[];
  gateway: string[];
}

function install(
  init: { refunds?: Row[]; paid?: number },
  opts: { staleReads?: boolean; recordFails?: boolean } = {},
) {
  const L: Ledger = {
    refunds: clone(init.refunds ?? []),
    records: clone((init.refunds ?? []).map((r) => ({ refundId: r.id, status: r.status, refundAmount: r.amount, originalAmount: init.paid ?? 1000 }))),
    order: { id: "O1", status: "DELIVERED", paymentStatus: "PAID" },
    log: [],
    gateway: [],
  };
  const firstReads = new Map(L.refunds.map((r) => [r.id, clone(r)]));
  const s = stubber();
  const payment = { id: "PAY1", amount: init.paid ?? 1000, status: "PAID", sslCommerzDetail: { tranId: "T1", vendorId: "V1", customerId: "C1" } };

  const view = (r: Row) => ({
    ...clone(r),
    detail: { ...clone(L.records.find((x) => x.refundId === r.id) ?? {}), originalAmount: init.paid ?? 1000 },
    order: { id: "O1", orderNumber: "ORD-1", totalAmount: 1000, paymentStatus: "PAID", status: "DELIVERED", userId: null, vendorOrders: [] },
  });
  s.set(prisma.refund, "findUnique", async ({ where }: any) => {
    const cur = L.refunds.find((r) => r.id === where.id);
    if (!cur) return null;
    return view(opts.staleReads ? firstReads.get(where.id) ?? cur : cur);
  });
  // admin.order.service uses the shared client; payment.service has its own.
  for (const db of [prisma, paymentServiceDb] as any[]) {
    s.set(db.payment, "findFirst", async () => clone(payment));
    for (const [d, m] of [["refund", "update"], ["refund", "create"], ["refundRecord", "update"], ["refundRecord", "create"]] as const) {
      s.set(db[d], m, async () => assert.fail(`${d}.${m} through a global client`));
    }
  }
  s.set(prisma.notification, "create", async () => assert.fail("no notification for a guest order"));
  s.set(paymentService, "processApprovedRefund", async (id: string) => (L.gateway.push(`gateway:${id}`), {}));
  s.set(paymentService, "completeGoodwillRefund", async (id: string) => (L.gateway.push(`goodwill:${id}`), {}));

  const transaction = async (fn: any) => {
    if (typeof fn !== "function") assert.fail("array transactions are no longer used for refunds");
    const snap = clone({ refunds: L.refunds, records: L.records, order: L.order });
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) =>
        (L.log.push(`lock:${/FOR UPDATE/.test(strings.join("?")) ? "FOR UPDATE" : "?"}:${values.join(",")}`), 1),
      payment: { findFirst: async () => clone(payment) },
      refund: {
        aggregate: async ({ where }: any) => {
          L.log.push("consumed-sum");
          const sum = L.refunds.filter((r) => r.orderId === where.orderId && where.status.in.includes(r.status)).reduce((a, r) => a + Number(r.amount), 0);
          return { _sum: { amount: sum || null } };
        },
        create: async ({ data }: any) => {
          const row = { id: `RF${L.refunds.length + 1}`, ...clone(data) };
          L.refunds.push(row);
          L.log.push("refund.create");
          return row;
        },
        updateMany: async ({ where, data }: any) => {
          const row = L.refunds.find((r) => r.id === where.id && r.status === where.status);
          if (!row) return { count: 0 };
          Object.assign(row, clone(data));
          L.log.push(`claim:${data.status}`);
          return { count: 1 };
        },
      },
      refundRecord: {
        create: async ({ data }: any) => {
          if (opts.recordFails) throw new Error("record insert failed");
          L.records.push(clone(data));
          L.log.push("record.create");
          return data;
        },
        update: async ({ where, data }: any) => {
          const rec = L.records.find((r) => r.refundId === where.refundId);
          Object.assign(rec!, clone(data));
          return rec;
        },
      },
      auditLog: { create: async ({ data }: any) => (L.log.push(`audit:${data.action}`), data) },
      order: { update: async ({ data }: any) => (Object.assign(L.order, data), L.order) },
    };
    try {
      return await fn(tx);
    } catch (e) {
      Object.assign(L, clone(snap));
      throw e;
    }
  };
  s.set(prisma, "$transaction", transaction);
  s.set(paymentServiceDb, "$transaction", transaction);
  return { L, restore: s.restore };
}

// ── requestRefund ───────────────────────────────────────────────────────────

const request = (amount: number) =>
  paymentService.requestRefund({ orderId: "O1", refundAmount: amount, refundReason: "r", initiatedBy: "C1", refundType: "PARTIAL_REFUND" as any });

test("requestRefund: Refund + RefundRecord in one transaction, lock taken before the consumed sum", async () => {
  const env = install({});
  try {
    const { refund, detail } = await request(400);
    assert.equal(env.L.refunds.length, 1);
    assert.equal(env.L.records.length, 1);
    assert.equal(detail.refundId, refund.id);
    assert.match(detail.refundNumber, /^RF-\d+-[0-9A-F]{8}$/);
    assert.deepEqual(env.L.log.slice(0, 2), ["lock:FOR UPDATE:PAY1", "consumed-sum"]);
  } finally {
    env.restore();
  }
});

test("requestRefund: a RefundRecord failure leaves no orphan Refund", async () => {
  const env = install({}, { recordFails: true });
  try {
    await assert.rejects(request(400), /record insert failed/);
    assert.deepEqual(env.L.refunds, [], "refund rolled back with the record");
    assert.deepEqual(env.L.records, []);
  } finally {
    env.restore();
  }
});

test("requestRefund: the balance is never over-committed (600 + 600 on 1000 → second refused)", async () => {
  const env = install({});
  try {
    await request(600);
    await assert.rejects(request(600), /exceeds remaining refundable balance/);
    assert.equal(env.L.refunds.length, 1);
    assert.equal(env.L.records.length, 1);
  } finally {
    env.restore();
  }
});

test("refund numbers do not collide within one millisecond", () => {
  const now = Date.now();
  const n = new Set(Array.from({ length: 2000 }, () => newRefundNumber(now)));
  assert.equal(n.size, 2000);
});

test("lockRefundableBalance: locks the payment row first, then reads the sum of consuming refunds only", async () => {
  const calls: string[] = [];
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...v: any[]) => (calls.push(`${strings.join("?")}|${v.join(",")}`), 1),
    refund: {
      aggregate: async ({ where }: any) => {
        calls.push(`sum:${where.status.in.join(",")}`);
        return { _sum: { amount: 250 } };
      },
    },
  };
  const out = await lockRefundableBalance(tx, { id: "PAY9", amount: 1000 }, "O9");
  assert.deepEqual(out, { paid: 1000, consumed: 250, remaining: 750 });
  assert.match(calls[0], /FROM "payments" WHERE "id" = \?.*FOR UPDATE\|PAY9/s);
  assert.equal(calls[1], `sum:${CONSUMING.join(",")}`);
});

// ── approve / reject claims ─────────────────────────────────────────────────

const PENDING_600 = [{ id: "RF1", orderId: "O1", amount: 600, status: "PENDING" }];
const approve = (amount = 600) => AdminOrderService.approveRefund("RF1", "A1", amount, "ok", true);
const reject = () => AdminOrderService.rejectRefund("RF1", "A1", "no");

test("approve: claims PENDING → APPROVED once and calls the gateway once", async () => {
  const env = install({ refunds: PENDING_600 });
  try {
    await approve();
    assert.equal(env.L.refunds[0].status, "APPROVED");
    assert.equal(env.L.records[0].status, "APPROVED");
    assert.deepEqual(env.L.gateway, ["goodwill:RF1"]);
    const lock = env.L.log.indexOf("lock:FOR UPDATE:PAY1");
    assert.ok(lock >= 0 && lock < env.L.log.indexOf("claim:APPROVED"), "lock before the claim");
  } finally {
    env.restore();
  }
});

test("double approval (both read PENDING) → the second gets 409 and the gateway runs once", async () => {
  const env = install({ refunds: PENDING_600 }, { staleReads: true });
  try {
    await approve();
    await assert.rejects(approve(), (e: any) => e instanceof RefundStateConflictError && e.code === "REFUND_STATE_CHANGED");
    assert.equal(env.L.gateway.length, 1, "gateway called exactly once");
    assert.equal(env.L.log.filter((l) => l === "audit:APPROVE").length, 1);
  } finally {
    env.restore();
  }
});

test("approve vs reject race: reject wins → approve gets 409, no gateway call", async () => {
  const env = install({ refunds: PENDING_600 }, { staleReads: true });
  try {
    await reject();
    await assert.rejects(approve(), RefundStateConflictError);
    assert.equal(env.L.refunds[0].status, "REJECTED");
    assert.deepEqual(env.L.gateway, []);
  } finally {
    env.restore();
  }
});

test("approve vs reject race: approve wins → reject gets 409, the approval stands", async () => {
  const env = install({ refunds: PENDING_600 }, { staleReads: true });
  try {
    await approve();
    await assert.rejects(reject(), RefundStateConflictError);
    assert.equal(env.L.refunds[0].status, "APPROVED");
    assert.equal(env.L.records[0].status, "APPROVED");
  } finally {
    env.restore();
  }
});

// ── D6 ──────────────────────────────────────────────────────────────────────

test("D6: approval above the requested amount is refused — nothing claimed, no gateway call", async () => {
  const env = install({ refunds: PENDING_600 });
  try {
    await assert.rejects(approve(700), /can't exceed the requested refund/);
    assert.equal(env.L.refunds[0].status, "PENDING");
    assert.deepEqual(env.L.gateway, []);
  } finally {
    env.restore();
  }
});

test("D6: approval may reduce the requested amount (record follows)", async () => {
  const env = install({ refunds: PENDING_600 });
  try {
    await approve(450);
    assert.equal(Number(env.L.refunds[0].amount), 450);
    assert.equal(Number(env.L.records[0].refundAmount), 450);
  } finally {
    env.restore();
  }
});

test("D6: approval is refused when other refunds leave less than the amount (legacy over-commit)", async () => {
  // 600 requested, but another APPROVED 700 already consumes the balance → only 300 left for RF1.
  const env = install({ refunds: [...PENDING_600, { id: "RF0", orderId: "O1", amount: 700, status: "APPROVED" }] });
  try {
    await assert.rejects(approve(600), /remaining refundable balance \(300\.00\)/);
    assert.equal(env.L.refunds[0].status, "PENDING", "nothing claimed");
    assert.deepEqual(env.L.gateway, []);
    await approve(300);
    assert.equal(env.L.refunds[0].status, "APPROVED");
  } finally {
    env.restore();
  }
});

// ── controllers ─────────────────────────────────────────────────────────────

test("controllers: approve / reject conflicts answer 409 with REFUND_STATE_CHANGED", async () => {
  for (const [handler, req] of [
    [AdminOrderController.approveRefund, { user: { id: "A1" }, params: { refundId: "RF1" }, body: { amount: 600, isGoodwill: true } }],
    [AdminOrderController.rejectRefund, { user: { id: "A1" }, params: { refundId: "RF1" }, body: { reason: "no" } }],
  ] as const) {
    const env = install({ refunds: [{ id: "RF1", orderId: "O1", amount: 600, status: "APPROVED" }] }, { staleReads: false });
    const s = stubber();
    // The outside read says PENDING (stale); the claim finds APPROVED.
    s.set(prisma.refund, "findUnique", async () => ({
      id: "RF1", orderId: "O1", amount: 600, status: "PENDING",
      detail: { refundId: "RF1", originalAmount: 1000 },
      order: { id: "O1", orderNumber: "ORD-1", totalAmount: 1000, paymentStatus: "PAID", status: "DELIVERED", userId: null, vendorOrders: [] },
    }));
    try {
      const res = fakeRes();
      await (handler as any)(req, res);
      assert.equal(res.statusCode, 409, (handler as any).name);
      assert.equal(res.body.code, "REFUND_STATE_CHANGED");
    } finally {
      s.restore();
      env.restore();
    }
  }
});
