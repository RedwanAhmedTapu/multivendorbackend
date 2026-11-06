// tests/payout-platform.test.ts
//
// Vendor payout scheduling on the ledger (DB-free):
//   pure rules — next payout date for every cycle (no fixed dates, Dhaka days),
//   eligibility (hold window, open items, threshold, holds, never negative),
//   policy validation and vendor overrides;
//   service — batch drafting (due vendors only, one open item per vendor),
//   approval re-check (balance drop → held), mark paid (approved only,
//   reference required, voucher once, counters once, ledger balance check,
//   pending-approval voucher not paid), cancel rules, vendor summary
//   isolation, auto-propose never approves; routes are admin / owner only.
//   npx tsx --test tests/payout-platform.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_PAYOUT_POLICY,
  batchNumberFor,
  computeEligibility,
  effectiveRule,
  isPayoutDay,
  nextPayoutDate,
  validatePayoutPolicy,
  type PayoutPolicy,
} from "../src/modules/payouts/payout.rules.ts";
import { createPayoutService, PayoutError } from "../src/modules/payouts/payout.service.ts";
import { createFakeBillingDb } from "./support/fake-billing-db.ts";

const NOW = new Date("2026-11-06T06:00:00Z"); // Friday, 12:00 in Dhaka
const day = (s: string) => new Date(`${s}T00:00:00+06:00`);
const iso = (d: Date) => d.toISOString();
const ADMIN = { userId: "U_ADMIN", name: "Admin" };
const P = (o: Partial<PayoutPolicy> = {}): PayoutPolicy => ({ ...DEFAULT_PAYOUT_POLICY, ...o });

// ─── pure rules ─────────────────────────────────────────────────────────────

test("next payout date: weekly, bi-weekly, monthly (31 → month end), quarterly, custom — all computed in Dhaka calendar days", () => {
  assert.equal(iso(nextPayoutDate(P({ cycle: "WEEKLY", weekday: 5 }), NOW)), iso(day("2026-11-06")), "today is Friday");
  assert.equal(iso(nextPayoutDate(P({ cycle: "WEEKLY", weekday: 0 }), NOW)), iso(day("2026-11-08")));
  assert.equal(iso(nextPayoutDate(P({ cycle: "WEEKLY", weekday: 4 }), NOW)), iso(day("2026-11-12")));
  // 23:30 UTC Thursday is already Friday in Dhaka.
  assert.equal(iso(nextPayoutDate(P({ cycle: "WEEKLY", weekday: 5 }), new Date("2026-11-05T19:30:00Z"))), iso(day("2026-11-06")));
  const bi = P({ cycle: "BIWEEKLY", anchorDate: "2026-10-30" });
  assert.equal(iso(nextPayoutDate(bi, NOW)), iso(day("2026-11-13")));
  assert.equal(iso(nextPayoutDate(bi, day("2026-11-13"))), iso(day("2026-11-13")));
  assert.equal(iso(nextPayoutDate(P({ cycle: "MONTHLY", monthDays: [1, 15] }), NOW)), iso(day("2026-11-15")));
  assert.equal(iso(nextPayoutDate(P({ cycle: "MONTHLY", monthDays: [31] }), day("2027-02-02"))), iso(day("2027-02-28")));
  assert.equal(iso(nextPayoutDate(P({ cycle: "QUARTERLY", monthDays: [5] }), NOW)), iso(day("2027-01-05")));
  assert.equal(iso(nextPayoutDate(P({ cycle: "CUSTOM", customIntervalDays: 10, anchorDate: "2026-11-01" }), NOW)), iso(day("2026-11-11")));
  assert.equal(isPayoutDay(P({ cycle: "WEEKLY", weekday: 5 }), NOW), true);
  assert.equal(isPayoutDay(P({ cycle: "WEEKLY", weekday: 6 }), NOW), false);
  assert.equal(batchNumberFor(NOW, 7), "PO-20261106-007");
});

test("eligibility: hold-window credits and open items are not payable; threshold, pause, hold and platform hold block; never negative", () => {
  const rule = effectiveRule(P({ minThreshold: "500" }), null);
  const e = computeEligibility({ balance: "5000", recentNet: "1200", openItems: "800", rule, now: NOW });
  assert.deepEqual([e.available, e.payable, e.amount, e.reasons], ["3000.00", true, "3000.00", []]);
  assert.deepEqual(computeEligibility({ balance: "5000", recentNet: "-900", openItems: "0", rule, now: NOW }).available, "5000.00", "net debits (refunds) in the window don't add money");
  assert.deepEqual(computeEligibility({ balance: "100", recentNet: "500", openItems: "0", rule, now: NOW }).reasons, ["NOTHING_DUE"]);
  assert.deepEqual(computeEligibility({ balance: "-300", recentNet: "0", openItems: "0", rule, now: NOW }).available, "0.00");
  assert.deepEqual(computeEligibility({ balance: "499.99", recentNet: "0", openItems: "0", rule, now: NOW }).reasons, ["BELOW_THRESHOLD"]);
  assert.equal(computeEligibility({ balance: "500", recentNet: "0", openItems: "0", rule, now: NOW }).payable, true, "exactly the threshold is payable");
  const held = effectiveRule(P(), { cycle: null, weekday: null, monthDays: [], customIntervalDays: null, anchorDate: null, minThreshold: null, settlementDelayDays: null, requireApproval: null, paused: true, holdUntil: new Date("2026-12-01"), holdReason: "KYC" });
  assert.deepEqual(computeEligibility({ balance: "5000", recentNet: "0", openItems: "0", rule: held, now: NOW }).reasons, ["PAUSED", "ON_HOLD"]);
  assert.deepEqual(computeEligibility({ balance: "5000", recentNet: "0", openItems: "0", rule: effectiveRule(P({ holdAll: true }), null), now: NOW }).reasons, ["PLATFORM_HOLD"]);
});

test("policy validation and vendor overrides", () => {
  assert.equal(validatePayoutPolicy(DEFAULT_PAYOUT_POLICY).ok, true);
  for (const bad of [{ cycle: "DAILY" }, { weekday: 7 }, { monthDays: [] }, { monthDays: [0] }, { cycle: "CUSTOM", customIntervalDays: null }, { cycle: "CUSTOM", customIntervalDays: 7, anchorDate: null }, { minThreshold: "-1" }, { settlementDelayDays: 400 }, { autoPropose: "yes" }])
    assert.equal(validatePayoutPolicy({ ...DEFAULT_PAYOUT_POLICY, ...bad }).ok, false, JSON.stringify(bad));
  const r = effectiveRule(P({ cycle: "WEEKLY", minThreshold: "500" }), { cycle: "MONTHLY", weekday: null, monthDays: [10], customIntervalDays: null, anchorDate: null, minThreshold: "2000", settlementDelayDays: 14, requireApproval: null, paused: false, holdUntil: null, holdReason: null });
  assert.deepEqual([r.cycle, r.monthDays, r.minThreshold, r.settlementDelayDays, r.overridden.sort()], ["MONTHLY", [10], "2000.00", 14, ["cycle", "minThreshold", "monthDays", "settlementDelayDays"]]);
});

// ─── service ────────────────────────────────────────────────────────────────

function world(opts: { policy?: Partial<PayoutPolicy> } = {}) {
  const policy = { ...DEFAULT_PAYOUT_POLICY, cycle: "WEEKLY", weekday: 5, minThreshold: "500", settlementDelayDays: 7, refundWindowDays: 7, ...opts.policy };
  const db = createFakeBillingDb({
    vendor: [{ id: "V1", storeName: "Alpha" }, { id: "V2", storeName: "Beta" }, { id: "V3", storeName: "Gamma" }],
    platformSettings: [{ key: "payout.policy", value: JSON.stringify(policy) }],
    vendorPayable: [
      { id: "VP1", vendorId: "V1", balance: "6000", totalPaid: "0", totalPayouts: 0 },
      { id: "VP2", vendorId: "V2", balance: "300", totalPaid: "0", totalPayouts: 0 },
      { id: "VP3", vendorId: "V3", balance: "2500", totalPaid: "0", totalPayouts: 0 },
    ],
    chartOfAccount: [{ id: "A1", entityType: "VENDOR", entityId: "V1", name: "Receivable from Platform" }, { id: "A3", entityType: "VENDOR", entityId: "V3", name: "Receivable from Platform" }],
    ledgerEntry: [
      { id: "L1", accountId: "A1", debitAmount: "1000", creditAmount: "0", entryDate: new Date("2026-11-04T00:00:00Z") }, // inside the 7-day window
      { id: "L2", accountId: "A1", debitAmount: "5000", creditAmount: "0", entryDate: new Date("2026-10-01T00:00:00Z") }, // settled
    ],
  });
  const posted: string[] = [];
  let pendingApproval = false;
  const postVoucher = async (i: { payoutItemId: string; vendorId: string; amount: any }) => {
    posted.push(i.payoutItemId);
    if (!pendingApproval) {
      // The voucher engine reduces the ledger-derived balance (postVoucher sync); idempotent per item.
      if (posted.filter((x) => x === i.payoutItemId).length === 1) {
        const vp = db.tables.vendorPayable.find((v: any) => v.vendorId === i.vendorId);
        vp.balance = String(Number(vp.balance) - Number(i.amount));
      }
    }
    return { voucherId: `VCH-${i.payoutItemId}`, pendingApproval };
  };
  const svc = createPayoutService({ db, postVoucher, now: () => NOW });
  return { db, svc, posted, setPendingApproval: (v: boolean) => (pendingApproval = v) };
}

const rejects = (p: Promise<unknown>, status: number, code?: string) =>
  assert.rejects(p, (e: unknown) => e instanceof PayoutError && e.statusCode === status && (!code || e.code === code));

test("preview and draft batch: only payable vendors due today; amounts exclude the hold window; a vendor is never in two open batches", async () => {
  const { db, svc } = world();
  const pv = await svc.preview({ onlyDue: true });
  const v1 = pv.rows.find((r) => r.vendorId === "V1")!;
  assert.deepEqual([v1.eligibility.available, v1.eligibility.pendingInWindow, v1.dueOnDate], ["5000.00", "1000.00", true]);
  assert.deepEqual(pv.rows.find((r) => r.vendorId === "V2")!.eligibility.reasons, ["BELOW_THRESHOLD"]);
  const batch = await svc.createBatch({}, ADMIN);
  const items = db.tables.payoutBatchItem;
  assert.deepEqual(items.map((i: any) => [i.vendorId, i.amount, i.status]), [["V1", "5000.00", "PENDING"], ["V3", "2500.00", "PENDING"]]);
  assert.equal(batch.totalAmount, "7500.00");
  assert.equal(batch.batchNumber, "PO-20261106-001");
  assert.ok(items[0].calculation.balance === "6000.00" && items[0].calculation.pendingInWindow === "1000.00", "calculation snapshot kept");
  await rejects(svc.createBatch({}, ADMIN), 422, "NOTHING_TO_PAY");
  assert.ok(db.tables.payoutAuditLog.some((a: any) => a.action === "BATCH_CREATED"));
});

test("not due today → nothing drafted unless the admin includes them; a platform hold blocks drafting", async () => {
  const { svc } = world({ policy: { weekday: 1 } });
  await rejects(svc.createBatch({}, ADMIN), 422, "NOTHING_TO_PAY");
  const b = await svc.createBatch({ includeNotDue: true, vendorIds: ["V3"] }, ADMIN);
  assert.equal(b.vendorCount, 1);
  const held = world({ policy: { holdAll: true } });
  await rejects(held.svc.createBatch({}, ADMIN), 409, "PLATFORM_HOLD");
});

test("approval re-checks balances and vendor holds; mark paid needs approval, a reference and a covering ledger balance; voucher and counters happen once", async () => {
  const { db, svc, posted } = world();
  const batch = await svc.createBatch({}, ADMIN);
  const [i1, i3] = db.tables.payoutBatchItem;
  await rejects(svc.markItemPaid(i1.id, { reference: "BANK-1" }, ADMIN), 409, "INVALID_STATE");
  // V3's balance drops (a refund) before approval → its item is held, not paid.
  db.tables.vendorPayable.find((v: any) => v.vendorId === "V3").balance = "1000";
  const approved = await svc.approveBatch(batch.id, ADMIN);
  assert.deepEqual(approved.held.map((h) => h.vendorId), ["V3"]);
  assert.equal(db.tables.payoutBatchItem.find((i: any) => i.id === i3.id).status, "HELD");
  await rejects(svc.approveBatch(batch.id, ADMIN), 409, "INVALID_STATE");
  await rejects(svc.markItemPaid(i1.id, { reference: "x" }, ADMIN), 400, "VALIDATION");
  await rejects(svc.markItemPaid(i1.id, { reference: "BANK-1", paidAt: "2030-01-01" }, ADMIN), 400, "VALIDATION");
  const paid = await svc.markItemPaid(i1.id, { reference: "BANK-1", method: "BANK_TRANSFER" }, ADMIN);
  assert.deepEqual([paid.duplicate, paid.item.status, paid.item.voucherId], [false, "PAID", `VCH-${i1.id}`]);
  const again = await svc.markItemPaid(i1.id, { reference: "BANK-1" }, ADMIN);
  assert.equal(again.duplicate, true);
  assert.deepEqual(posted, [i1.id], "the voucher is posted once");
  const vp = db.tables.vendorPayable.find((v: any) => v.vendorId === "V1");
  assert.deepEqual([vp.balance, vp.totalPaid, vp.totalPayouts], ["1000", "5000", 1]);
  assert.equal(iso(vp.nextPayoutDate), iso(day("2026-11-13")));
  assert.equal(db.tables.payoutBatch[0].status, "PAID", "held items don't keep the batch open");
  assert.ok(db.tables.notification.some((n: any) => n.targetId === "V1" && /৳5000\.00/.test(n.message)));
  await rejects(svc.cancelBatch(batch.id, "Mistake", ADMIN), 409, "INVALID_STATE");
});

test("a voucher held for accounting approval does not mark the item paid; a ledger balance that no longer covers the item blocks payment", async () => {
  const w = world();
  const b = await w.svc.createBatch({}, ADMIN);
  await w.svc.approveBatch(b.id, ADMIN);
  const [i1, i3] = w.db.tables.payoutBatchItem;
  w.setPendingApproval(true);
  await rejects(w.svc.markItemPaid(i1.id, { reference: "BANK-9" }, ADMIN), 409, "VOUCHER_PENDING_APPROVAL");
  assert.equal(w.db.tables.payoutBatchItem.find((i: any) => i.id === i1.id).status, "APPROVED");
  w.setPendingApproval(false);
  w.db.tables.vendorPayable.find((v: any) => v.vendorId === "V3").balance = "100";
  await rejects(w.svc.markItemPaid(i3.id, { reference: "BANK-10" }, ADMIN), 409, "BALANCE_CHANGED");
  assert.equal(w.posted.filter((x) => x === i3.id).length, 0, "no voucher when the balance doesn't cover it");
});

test("hold / release / cancel items and batches; vendor holds and pauses exclude vendors; every action is audited", async () => {
  const { db, svc } = world();
  const b = await svc.createBatch({}, ADMIN);
  const [i1] = db.tables.payoutBatchItem;
  await rejects(svc.holdItem(i1.id, "", ADMIN), 400);
  await svc.holdItem(i1.id, "Bank details check", ADMIN);
  await svc.releaseItem(i1.id, ADMIN);
  assert.equal(db.tables.payoutBatchItem[0].status, "PENDING");
  await svc.cancelItem(i1.id, "Vendor asked to wait", ADMIN);
  await rejects(svc.releaseItem(i1.id, ADMIN), 409);
  await svc.cancelBatch(b.id, "Redo with new rules", ADMIN);
  assert.ok(db.tables.payoutBatchItem.every((i: any) => i.status === "CANCELLED"));
  await svc.setVendorState("V1", "hold", { reason: "KYC review", until: "2026-12-01" }, ADMIN);
  await svc.setVendorState("V3", "pause", { reason: "Dispute" }, ADMIN);
  await rejects(svc.createBatch({}, ADMIN), 422, "NOTHING_TO_PAY");
  await svc.setVendorState("V1", "release", {}, ADMIN);
  const b2 = await svc.createBatch({}, ADMIN);
  assert.equal(b2.vendorCount, 1);
  const actions = db.tables.payoutAuditLog.map((a: any) => a.action);
  for (const a of ["ITEM_HELD", "ITEM_RELEASED", "ITEM_CANCELLED", "BATCH_CANCELLED", "VENDOR_HOLD", "VENDOR_PAUSE", "VENDOR_RELEASE"]) assert.ok(actions.includes(a), a);
  await rejects(svc.setRule("V1", { cycle: "CUSTOM", customIntervalDays: 5 }, ADMIN), 400);
  await svc.setRule("V1", { cycle: "MONTHLY", monthDays: [10], minThreshold: "2000" }, ADMIN);
  assert.equal((await svc.eligibilityFor("V1")).rule.cycle, "MONTHLY");
});

test("vendor summary shows only the vendor's own figures and never the admin's hold reason", async () => {
  const { svc } = world();
  await svc.setVendorState("V3", "hold", { reason: "Internal fraud flag" }, ADMIN);
  const s1 = await svc.vendorSummary("V1");
  assert.deepEqual([s1.totalBalance, s1.available, s1.pending, s1.onHold, s1.status], ["6000.00", "5000.00", "1000.00", "0.00", "ELIGIBLE"]);
  assert.equal(s1.nextPayoutDate, iso(day("2026-11-06")));
  const s3 = await svc.vendorSummary("V3");
  assert.deepEqual([s3.available, s3.onHold, s3.status], ["0.00", "2500.00", "ON_HOLD"]);
  assert.ok(!JSON.stringify(s3).includes("fraud"), "hold reason stays internal");
  assert.ok(!JSON.stringify(s1).includes("V3"));
});

test("auto-propose drafts at most one batch per payout day, only when switched on, and never approves or pays", async () => {
  const off = world();
  assert.equal(await off.svc.runAutoPropose(NOW), 0);
  const on = world({ policy: { autoPropose: true } });
  assert.equal(await on.svc.runAutoPropose(NOW), 1);
  assert.equal(await on.svc.runAutoPropose(NOW), 0);
  assert.deepEqual(on.db.tables.payoutBatch.map((b: any) => [b.status, b.createdById]), [["DRAFT", null]]);
  assert.equal(on.posted.length, 0);
});

test("routes: admin-only management, owner-only vendor summary; the legacy payout processor stays disabled", () => {
  const routes = readFileSync(new URL("../src/modules/payouts/payout.routes.ts", import.meta.url), "utf8");
  assert.match(routes, /r\.use\(authenticateUser, authorizeRoles\("ADMIN"\)\)/);
  assert.match(routes, /r\.use\(authenticateUser, requireVendorOwner\)/);
  assert.ok(!/vendorId/.test(routes.slice(routes.indexOf("createVendorPayoutRouter"))), "the vendor router never reads a vendor id from the request");
  const legacy = readFileSync(new URL("../src/routes/payout.routes.ts", import.meta.url), "utf8");
  assert.match(legacy, /410/);
  const svc = readFileSync(new URL("../src/modules/payouts/payout.service.ts", import.meta.url), "utf8");
  assert.ok(!/subscriptionPayment/.test(svc), "payouts never read subscription billing");
});
