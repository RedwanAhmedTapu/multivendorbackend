// tests/delivery-voucher-idempotency.test.ts
//
// #K6 REGRESSION (2026-11-08): duplicate accounting through multiple
// DELIVERED paths.
//
// Trace conclusion (verified against source, 2026-11-08):
//   * Exactly ONE accounting-producing DELIVERED path exists: every courier
//     DELIVERED event (provider webhook or the ADMIN-only simulate endpoint)
//     funnels through AdminOrderService.processCourierStatusUpdate →
//     postDeliveryVoucherForVendorOrder → createDeliveryVoucher, keyed
//     `DELIVERED:<courierOrderId>:<method>:<variant>:<orderId>` per side.
//   * Admin manual updateVendorOrderStatus and vendor updateStatus CANNOT set
//     DELIVERED (transition tables exclude it); no other writer sets a
//     VendorOrder to DELIVERED.
//   * Multi-consignment scopes are disjoint by construction (lineScope sums
//     shippedQty of the consignment's OWN warehouse allocations; total
//     shippedQty per item ≤ item.quantity). A cancelled consignment can never
//     deliver (cancelCourierOrder only acts pre-pickup; the state claim
//     refuses transitions off CANCELLED), so a rebook posts the first and
//     only voucher for its warehouse scope.
//   * Provider retries (sameState) re-attempt posting intentionally; the
//     idempotency key makes them converge.
//
// The residual gap this file pins: two duplicate triggers could both observe
// the idempotent-hit voucher as DRAFT and both call postVoucher. #K5's
// guarded claim prevents the double POST; this fix (postVoucherIdempotent in
// postPairedVoucher) makes the loser CONVERGE on the posted voucher instead
// of throwing into the webhook (500 → provider retry storm).
//
// DB-free: the engine's idempotency/race behavior is simulated with stubbed
// instance methods (createVoucher / postVoucher / getVoucherById /
// resolveEntries). Run with:
//   npx tsx --test tests/delivery-voucher-idempotency.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountingService } from "../src/services/accounting.services.ts";

// Minimal paired-voucher input shaped like createDeliveryVoucher's call:
// platform side + vendor side, one balanced entry pair each.
function deliveryInput(key = "DELIVERED:CO1:COD:std:O1") {
  return {
    idempotencyKey: key,
    eventTrigger: "DELIVERED",
    referenceType: "delivery",
    referenceId: "CO1",
    orderId: "O1",
    platform: {
      voucherType: "SALES",
      voucherDate: new Date("2026-01-02"),
      narration: "platform side",
      vendorId: "V1",
      entries: [{ accountClass: "ASSET", accountName: "COD Receivable", debit: 100, credit: 0 }],
    },
    vendor: {
      voucherType: "SALES",
      voucherDate: new Date("2026-01-02"),
      narration: "vendor side",
      vendorId: "V1",
      entries: [{ accountClass: "ASSET", accountName: "Receivable from Platform", debit: 90, credit: 0 }],
    },
  };
}

interface Sim {
  // The shared voucher ROWS both duplicate triggers observe (per side).
  rows: { PLATFORM: any; VENDOR: any };
  postCalls: number;
  rereadCalls: number;
  // Behavior switches for the simulated race.
  postImpl?: (row: any) => Promise<any>;
  rereadImpl?: (row: any) => any;
}

function makeService(sim: Sim) {
  const svc = new AccountingService() as any;
  svc.resolveEntries = async (_et: any, _ei: any, entries: any[]) =>
    entries.map((e, i) => ({ accountId: `ACC${i}`, debitAmount: e.debit, creditAmount: e.credit }));
  svc.createVoucher = async (input: any) =>
    input.idempotencyKey.endsWith(":PLATFORM") ? sim.rows.PLATFORM : sim.rows.VENDOR;
  svc.postVoucher = async (id: string) => {
    sim.postCalls += 1;
    const row = id === sim.rows.PLATFORM.id ? sim.rows.PLATFORM : sim.rows.VENDOR;
    if (sim.postImpl) return sim.postImpl(row);
    // Default: #K5 guarded-claim semantics — only a DRAFT row posts.
    if (row.status !== "DRAFT") throw new Error("Only DRAFT vouchers can be posted");
    row.status = "POSTED";
    return { ...row, status: "POSTED" };
  };
  svc.getVoucherById = async (id: string) => {
    sim.rereadCalls += 1;
    const row = id === sim.rows.PLATFORM.id ? sim.rows.PLATFORM : sim.rows.VENDOR;
    return sim.rereadImpl ? sim.rereadImpl(row) : { ...row };
  };
  return svc;
}

const draftRow = (id: string) => ({ id, status: "DRAFT", approvalStatus: "APPROVED" });

// ── tests ───────────────────────────────────────────────────────────────────

test("sequential duplicate triggers (provider retry after success): voucher posted exactly once", async () => {
  const sim: Sim = { rows: { PLATFORM: draftRow("VCH-P"), VENDOR: draftRow("VCH-V") }, postCalls: 0, rereadCalls: 0 };
  const svc = makeService(sim);

  const first = await svc.postPairedVoucher(deliveryInput());
  assert.equal(first.platform.status, "POSTED");
  assert.equal(first.vendor.status, "POSTED");
  assert.equal(sim.postCalls, 2, "one post per side");

  // Retry: createVoucher idempotent-hit now returns the POSTED rows — the
  // status !== "DRAFT" check skips posting entirely.
  const retry = await svc.postPairedVoucher(deliveryInput());
  assert.equal(retry.platform.status, "POSTED");
  assert.equal(retry.vendor.status, "POSTED");
  assert.equal(sim.postCalls, 2, "retry posts nothing");
  assert.equal(sim.rereadCalls, 0, "no lost-race re-read needed");
});

test("concurrent duplicate triggers (both observe DRAFT): one posts, the loser converges on the POSTED voucher", async () => {
  // Both triggers enter postVoucher while the row is still DRAFT; the #K5
  // claim lets the first win and the second throws the standard DRAFT error.
  const sim: Sim = {
    rows: { PLATFORM: draftRow("VCH-P"), VENDOR: draftRow("VCH-V") },
    postCalls: 0,
    rereadCalls: 0,
    postImpl: async (row: any) => {
      if (row.status !== "DRAFT") throw new Error("Only DRAFT vouchers can be posted");
      row.status = "POSTED";
      return { ...row, status: "POSTED" };
    },
  };
  const svc = makeService(sim);

  const loser = await (async () => {
    // Winner runs first and flips the row to POSTED…
    const winner = await svc.postPairedVoucher(deliveryInput());
    assert.equal(winner.platform.status, "POSTED");
    // …but the loser had ALREADY read the row as DRAFT (stale copy) and
    // enters postVoucher — the claim rejects it, the re-read converges it.
    sim.rows.PLATFORM = { ...sim.rows.PLATFORM, status: "POSTED" };
    sim.rows.VENDOR = { ...sim.rows.VENDOR, status: "POSTED" };
    const staleRead = { PLATFORM: draftRow("VCH-P"), VENDOR: draftRow("VCH-V") };
    svc.createVoucher = async (input: any) =>
      input.idempotencyKey.endsWith(":PLATFORM") ? staleRead.PLATFORM : staleRead.VENDOR;
    return svc.postPairedVoucher(deliveryInput());
  })();

  assert.equal(loser.platform.status, "POSTED", "loser converges instead of throwing");
  assert.equal(loser.vendor.status, "POSTED");
  assert.equal(sim.rereadCalls, 2, "one converging re-read per side");
});

test("lost race where the re-read finds CANCELLED: the error is NOT swallowed", async () => {
  const sim: Sim = {
    rows: { PLATFORM: draftRow("VCH-P"), VENDOR: draftRow("VCH-V") },
    postCalls: 0,
    rereadCalls: 0,
    postImpl: async () => {
      throw new Error("Only DRAFT vouchers can be posted");
    },
    rereadImpl: (row: any) => ({ ...row, status: "CANCELLED" }),
  };
  const svc = makeService(sim);

  await assert.rejects(
    svc.postPairedVoucher(deliveryInput()),
    /Only DRAFT vouchers can be posted/,
    "a non-POSTED re-read must rethrow the original error",
  );
});

test("unrelated postVoucher failures propagate unchanged (no silent convergence)", async () => {
  const sim: Sim = {
    rows: { PLATFORM: draftRow("VCH-P"), VENDOR: draftRow("VCH-V") },
    postCalls: 0,
    rereadCalls: 0,
    postImpl: async () => {
      throw new Error("connection terminated");
    },
  };
  const svc = makeService(sim);

  await assert.rejects(svc.postPairedVoucher(deliveryInput()), /connection terminated/);
  assert.equal(sim.rereadCalls, 0, "only the DRAFT-claim error triggers a re-read");
});

test("vouchers held for approval are never posted (existing behavior preserved)", async () => {
  const pending = (id: string) => ({ id, status: "DRAFT", approvalStatus: "PENDING" });
  const sim: Sim = { rows: { PLATFORM: pending("VCH-P"), VENDOR: pending("VCH-V") }, postCalls: 0, rereadCalls: 0 };
  const svc = makeService(sim);

  const out = await svc.postPairedVoucher(deliveryInput());
  assert.equal(sim.postCalls, 0, "PENDING approval vouchers are not posted");
  assert.equal(out.pendingApproval, true);
});
