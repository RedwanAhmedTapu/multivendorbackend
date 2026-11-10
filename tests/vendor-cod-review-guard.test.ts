// tests/vendor-cod-review-guard.test.ts
//
// COD fraud review: a vendor's manual COD confirmation must not bypass the
// review of HIGH-RISK orders. Policy = the platform's existing threshold:
// placeOrder auto-confirms COD only when riskScore < 60 and
// confirmOrderBySystem skips riskScore >= 60 (missing score = 0). So:
//   riskScore >= 60 → VendorOrderService.confirmCodOrder refuses
//                      (CodReviewRequiredError → HTTP 403 COD_REVIEW_REQUIRED),
//                      nothing is written;
//   riskScore < 60 or missing (legacy) → the existing confirmation runs.
// The vendor detail response carries codReviewRequired so the drawer can hide
// the button. DB-free (Prisma delegates replaced in place):
//   npx tsx --test tests/vendor-cod-review-guard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../src/config/prisma.ts";
import {
  VendorOrderService,
  CodReviewRequiredError,
  COD_REVIEW_RISK_THRESHOLD,
  codReviewRequired,
} from "../src/services/vendor.order.service.ts";
import { VendorOrderController } from "../src/controllers/vendor.order.controller.ts";

type Row = Record<string, any>;
const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

function stubber() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  return { set, restore: () => restores.reverse().forEach((r) => r()) };
}

/** A PENDING COD vendor order of vendor V1 with the given risk score. */
function stubCod(riskScore: unknown, over: Row = {}) {
  const s = stubber();
  const writes: string[] = [];
  s.set(prisma.vendorOrder, "findUnique", async () => ({
    id: "VO1", vendorId: "V1", status: "PENDING", orderId: "O1",
    order: { id: "O1", orderNumber: "ORD-1", paymentmethod: "COD", status: "PENDING", userId: "U1", riskScore },
    ...over,
  }));
  s.set(prisma.notification, "create", async () => (writes.push("notification"), {}));
  s.set(prisma, "$transaction", async (fn: any) =>
    fn({
      $executeRaw: async () => 1, // H1 order lock
      order: {
        findUnique: async () => ({ reservationReleasedAt: null, vendorOrders: [{ items: [{ allocations: [{ id: "A1" }] }] }] }),
        update: async () => (writes.push("order.update"), {}),
      },
      vendorOrder: {
        updateMany: async (a: Row) => (writes.push(`vendorOrder:${a.data.status}`), { count: 1 }),
        findMany: async () => [{ status: "CONFIRMED" }],
      },
      auditLog: { create: async ({ data }: Row) => (writes.push(`audit:${data.action}`), data) },
    }),
  );
  return { writes, restore: s.restore };
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

test("the threshold is the platform's existing one (placement auto-confirm < 60, system auto-confirm skips >= 60)", () => {
  assert.equal(COD_REVIEW_RISK_THRESHOLD, 60);
  assert.match(read("services/order.service.ts"), /const autoConfirmCod = paymentMethod === PaymentMethod\.COD && riskScore < 60;/);
  assert.match(read("services/admin.order.service.ts"), /const riskScore = order\.riskScore\?\.toNumber\(\) \?\? 0;\s+if \(riskScore >= 60\)/);
});

test("high-risk COD (riskScore >= 60, as number, Decimal or string) → refused before any write", async () => {
  for (const score of [60, new Decimal("60"), "60.00", new Decimal("85.5"), 115]) {
    const env = stubCod(score);
    try {
      await assert.rejects(VendorOrderService.confirmCodOrder("VO1", "V1", "Staff"), (e: any) => e instanceof CodReviewRequiredError && e.code === "COD_REVIEW_REQUIRED", String(score));
      assert.deepEqual(env.writes, [], `nothing written for ${String(score)}`);
    } finally {
      env.restore();
    }
  }
});

test("below the threshold or unscored (legacy) → the existing vendor confirmation still works", async () => {
  for (const score of [59.99, new Decimal("0"), null, undefined]) {
    const env = stubCod(score);
    try {
      await VendorOrderService.confirmCodOrder("VO1", "V1", "Staff");
      assert.ok(env.writes.includes("vendorOrder:CONFIRMED"), String(score));
      assert.ok(env.writes.includes("audit:COD_ORDER_CONFIRMED_BY_VENDOR"), String(score));
    } finally {
      env.restore();
    }
  }
});

test("existing refusals are unchanged and come first: another vendor, non-COD, not PENDING", async () => {
  for (const [over, re] of [
    [{ vendorId: "V2" }, /Unauthorized/],
    [{ order: { id: "O1", paymentmethod: "SSLCOMMERZ", status: "PENDING", riskScore: 90 } }, /not a COD order/],
    [{ status: "CONFIRMED" }, /not in PENDING status/],
  ] as [Row, RegExp][]) {
    const env = stubCod(90, over);
    try {
      await assert.rejects(VendorOrderService.confirmCodOrder("VO1", "V1", "Staff"), re);
      assert.deepEqual(env.writes, []);
    } finally {
      env.restore();
    }
  }
});

test("controller: a high-risk COD confirmation answers 403 COD_REVIEW_REQUIRED with the review message", async () => {
  const env = stubCod(75);
  try {
    const res = fakeRes();
    await VendorOrderController.confirmCodOrder({ user: { vendorId: "V1" }, params: { vendorOrderId: "VO1" }, body: { confirmedByName: "Staff" } } as any, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "COD_REVIEW_REQUIRED");
    assert.match(res.body.message, /FinixMart's fraud review/);
    assert.deepEqual(env.writes, []);
  } finally {
    env.restore();
  }
});

test("codReviewRequired flag: only PENDING COD orders at or above the threshold; exposed on the vendor detail response", async () => {
  const vo = (status: string, paymentmethod: string, riskScore: unknown) => ({ status, order: { paymentmethod, riskScore } });
  assert.equal(codReviewRequired(vo("PENDING", "COD", 60)), true);
  assert.equal(codReviewRequired(vo("PENDING", "COD", new Decimal("59.99"))), false);
  assert.equal(codReviewRequired(vo("PENDING", "COD", null)), false, "unscored legacy order");
  assert.equal(codReviewRequired(vo("CONFIRMED", "COD", 90)), false, "already confirmed");
  assert.equal(codReviewRequired(vo("PENDING", "SSLCOMMERZ", 90)), false, "prepaid");

  const s = stubber();
  s.set(prisma.vendorOrder, "findUnique", async () => ({ id: "VO1", vendorId: "V1", status: "PENDING", order: { paymentmethod: "COD", riskScore: new Decimal("72") }, courierOrders: [] }));
  // getById also reads the reservation and payment facts behind vendorActions.
  s.set(prisma.order, "findUnique", async () => ({ reservationReleasedAt: null, vendorOrders: [] }));
  s.set(prisma.payment, "count", async () => 0);
  try {
    const detail: any = await VendorOrderService.getById("VO1", "V1");
    assert.equal(detail.codReviewRequired, true);
  } finally {
    s.restore();
  }
});
