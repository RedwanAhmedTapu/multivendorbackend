// tests/accounting-postvoucher-concurrency.test.ts
//
// #K5 REGRESSION (2026-11-08): postVoucher double-post race.
//
// Before the fix, postVoucher() checked `status === "DRAFT"` and `isLocked`
// OUTSIDE the posting transaction and then inserted LedgerEntry rows +
// updated the voucher + synced VendorPayable inside it. Two concurrent posts
// of the same DRAFT voucher (duplicate webhooks, retries, racing event
// handlers — createVoucher is idempotent and returns the SAME voucher to
// both callers) both passed the check and both posted: duplicate ledger
// entries and double-incremented VendorPayable.
//
// The fix claims the voucher INSIDE the transaction with a guarded
// updateMany (WHERE id, status='DRAFT', isLocked=false). The row lock makes
// concurrent posters serialize; the loser's WHERE re-evaluates to 0 rows,
// it throws the same "Only DRAFT vouchers can be posted" error callers
// already see for an already-posted voucher, and its transaction rolls back
// without inserting anything.
//
// DB-free: postVoucher accepts an injectable db client (same pattern as the
// engine's getVoucherById). NOTE: this service constructs its OWN module-
// level PrismaClient (accounting.services.ts:19) — stubbing the shared
// config client has no effect on it, which is why the fake is injected
// instead. The fake transaction simulates Postgres row-lock semantics on
// the guarded claim: the first claim wins, later claims see count 0.
// Run with:
//   npx tsx --test tests/accounting-postvoucher-concurrency.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountingService } from "../src/services/accounting.services.ts";

const DRAFT_VOUCHER = {
  id: "VCH1",
  status: "DRAFT",
  isLocked: false,
  entityType: "VENDOR",
  entityId: "V1",
  voucherType: "SALES",
  voucherDate: new Date("2026-01-01"),
};

const DRAFT_ENTRIES = [
  { accountId: "ACC_RECV", debitAmount: "100", creditAmount: "0", description: "receivable", referenceType: null, referenceId: null, costCenter: null, department: null },
  { accountId: "ACC_SALES", debitAmount: "0", creditAmount: "100", description: "sales", referenceType: null, referenceId: null, costCenter: null, department: null },
];

interface FakeState { claimed: boolean }
interface CallLog { ledgerCreates: number; upserts: number; deletes: number }

/** Fake db client; its $transaction simulates the row lock on the guarded claim. */
function makeFakeDb(state: FakeState, calls: CallLog, voucher: any = DRAFT_VOUCHER) {
  const tx = {
    voucher: {
      updateMany: async ({ where }: any) => {
        // UPDATE ... WHERE status='DRAFT' AND isLocked=false — re-evaluated
        // against the committed row after the winner's lock releases.
        if (state.claimed || where.status !== "DRAFT" || where.isLocked !== false) return { count: 0 };
        state.claimed = true;
        return { count: 1 };
      },
    },
    ledgerEntry: {
      create: async () => {
        calls.ledgerCreates += 1;
        return {};
      },
    },
    voucherDraftEntry: {
      deleteMany: async () => {
        calls.deletes += 1;
        return { count: DRAFT_ENTRIES.length };
      },
    },
    vendorPayable: {
      upsert: async () => {
        calls.upserts += 1;
        return {};
      },
    },
  };
  return {
    voucher: { findUnique: async () => voucher },
    voucherDraftEntry: { findMany: async () => DRAFT_ENTRIES },
    chartOfAccount: { findFirst: async () => ({ id: "ACC_RECV" }) },
    $transaction: async (fn: any) => fn(tx),
  };
}

function makeService() {
  const svc = new AccountingService() as any;
  svc.validateEntityAccess = async () => {};
  svc.createAuditLog = async () => {};
  svc.getVoucherById = async (id: string) => ({ ...DRAFT_VOUCHER, id, status: "POSTED" });
  return svc;
}

// ── tests ───────────────────────────────────────────────────────────────────

test("two concurrent posts of the same voucher: exactly one posts; the loser gets the standard DRAFT error", async () => {
  const state: FakeState = { claimed: false };
  const calls: CallLog = { ledgerCreates: 0, upserts: 0, deletes: 0 };
  const db = makeFakeDb(state, calls);
  const svc = makeService();

  const [a, b] = await Promise.allSettled([svc.postVoucher("VCH1", "U1", db), svc.postVoucher("VCH1", "U2", db)]);

  const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
  const rejected = [a, b].filter((r) => r.status === "rejected") as PromiseRejectedResult[];

  assert.equal(fulfilled.length, 1, "exactly one poster wins");
  assert.equal(rejected.length, 1, "exactly one poster loses");
  assert.match(String(rejected[0].reason?.message), /Only DRAFT vouchers can be posted/);

  // The winner posted each draft line exactly once — never duplicated.
  assert.equal(calls.ledgerCreates, DRAFT_ENTRIES.length, "ledger entries created exactly once");
  // VendorPayable synced exactly once (no double increment).
  assert.equal(calls.upserts, 1, "VendorPayable upserted exactly once");
  assert.equal(calls.deletes, 1, "draft entries deleted exactly once");
});

test("burst of 8 concurrent posts: still exactly one posting", async () => {
  const state: FakeState = { claimed: false };
  const calls: CallLog = { ledgerCreates: 0, upserts: 0, deletes: 0 };
  const db = makeFakeDb(state, calls);
  const svc = makeService();

  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => svc.postVoucher("VCH1", `U${i}`, db)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 7);
  assert.equal(calls.ledgerCreates, DRAFT_ENTRIES.length);
  assert.equal(calls.upserts, 1);
});

test("already-POSTED voucher: rejected by the fast-path check, no transaction opened", async () => {
  const state: FakeState = { claimed: false };
  const calls: CallLog = { ledgerCreates: 0, upserts: 0, deletes: 0 };
  const db = makeFakeDb(state, calls, { ...DRAFT_VOUCHER, status: "POSTED" });
  const svc = makeService();

  await assert.rejects(() => svc.postVoucher("VCH1", "U1", db), /Only DRAFT vouchers can be posted/);
  assert.equal(calls.ledgerCreates, 0);
  assert.equal(calls.upserts, 0);
  assert.equal(calls.deletes, 0);
});

test("locked voucher: rejected with the locked message, no transaction opened", async () => {
  const state: FakeState = { claimed: false };
  const calls: CallLog = { ledgerCreates: 0, upserts: 0, deletes: 0 };
  const db = makeFakeDb(state, calls, { ...DRAFT_VOUCHER, isLocked: true });
  const svc = makeService();

  await assert.rejects(() => svc.postVoucher("VCH1", "U1", db), /Voucher is locked/);
  assert.equal(calls.ledgerCreates, 0);
});

test("voucher locked or posted between the pre-check and the claim: guarded claim catches it (rollback, no inserts)", async () => {
  // Pre-check sees DRAFT+unlocked, but the simulated DB state is already
  // claimed (someone else won in between) — the in-transaction guard is the
  // only correct line of defense.
  const state: FakeState = { claimed: true };
  const calls: CallLog = { ledgerCreates: 0, upserts: 0, deletes: 0 };
  const db = makeFakeDb(state, calls);
  const svc = makeService();

  await assert.rejects(() => svc.postVoucher("VCH1", "U1", db), /Only DRAFT vouchers can be posted/);
  assert.equal(calls.ledgerCreates, 0, "loser inserts nothing");
  assert.equal(calls.upserts, 0, "loser touches no balances");
});
