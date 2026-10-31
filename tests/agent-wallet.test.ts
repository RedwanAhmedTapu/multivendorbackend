// tests/agent-wallet.test.ts
//
// Phase 7 wallet and withdrawals, DB-free (in-memory agentDb fake whose
// transactions emulate the wallet row lock — tests/support/agent-wallet-fake.ts):
// ledger = wallet balance, clearance credits, reversal debits and the C5
// negative balance offset, two concurrent withdrawals against one balance,
// double-submit idempotency, settings read fresh / 409 when missing, fee and
// limits, auto-approval, reject / cancel releasing the hold, mark-paid,
// suspended agents, payout methods (masked, enabled types only) and the
// admin "re-run accrual" action.
//
//   npx tsx --test tests/agent-wallet.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";

const { installAgentFakeDb, makeTable } = await import("./support/agent-fake-db.ts");
const { compositeUnique, decimalIncrements, installWalletTables } = await import("./support/agent-wallet-fake.ts");
const engine = await import("../src/modules/agent/services/agent-commission.service.ts");
const wallet = await import("../src/modules/agent/services/agent-wallet.service.ts");
const wd = await import("../src/modules/agent/services/agent-withdrawal.service.ts");
const payout = await import("../src/modules/agent/services/agent-payout.service.ts");
const { rerunAccrualForDelivery } = await import("../src/modules/agent/services/agent-commission-admin.service.ts");
const { invalidateAgentSettingsCache } = await import("../src/modules/agent/services/agent-settings.service.ts");
const { withdrawalMarkPaidSchema } = await import("../src/modules/agent/validators/agent-wallet.validators.ts");

let fake: ReturnType<typeof installAgentFakeDb>;
const DAY = 24 * 3600_000;
const T0 = new Date("2026-10-01T06:00:00Z"); // order placed
const DELIVERED = new Date("2026-10-05T06:00:00Z");
const NOW = new Date("2026-10-06T06:00:00Z"); // inside the 7-day hold
const CLEARED = new Date("2026-10-13T06:00:00Z"); // past it
const PLATFORM_10 = { resolvePlatformRate: async () => ({ rate: "0.10", source: "GLOBAL_DEFAULT" }), now: () => NOW };
const ADMIN = { userId: "U-ADMIN", name: "Admin", ip: "127.0.0.1", userAgent: "test" };

let vendorOrders: Map<string, any>;
let vendorReturns: Map<string, any>;

beforeEach(async () => {
  invalidateAgentSettingsCache();
  fake = installAgentFakeDb();
  const db = fake.db;
  db.agentCommission = makeTable("commission", { defaults: () => ({ reversedQty: 0, reversedAmount: "0.00", status: "PENDING_CLEARANCE", walletCreditedAt: null }) });
  compositeUnique(db.agentCommission, ["deliveryId", "orderItemId"]);
  decimalIncrements(db.agentCommission);
  db.agentCommissionReversal = makeTable("reversal", { defaults: () => ({ walletPostedAt: null }) });
  compositeUnique(db.agentCommissionReversal, ["commissionId", "vendorReturnId"]);
  db.commissionRecord = makeTable("crec");
  db.orderItemDiscount = makeTable("oid");
  db.auditLog = makeTable("auditlog");
  db.order = makeTable("order");
  db.courierOrder = makeTable("courier");
  db.orderItemAllocation = makeTable("alloc");
  installWalletTables(db);
  vendorOrders = new Map();
  vendorReturns = new Map();
  db.vendorOrder = { findUnique: async ({ where }: any) => vendorOrders.get(where.id) ?? null };
  db.vendorReturn = { findUnique: async ({ where }: any) => vendorReturns.get(where.id) ?? null };
  db.agentVendorLink.findFirst = async ({ where }: any) => {
    const at = where.startedAt.lte as Date;
    const l = db.agentVendorLink.rows
      .filter((x: any) => x.vendorId === where.vendorId && x.startedAt <= at && (x.endedAt == null || x.endedAt > at))
      .sort((a: any, b: any) => b.startedAt - a.startedAt)[0];
    if (!l) return null;
    return { id: l.id, agentId: l.agentId, source: l.source, startedAt: l.startedAt, agent: { status: db.agent.rows.find((a: any) => a.id === l.agentId)?.status ?? null } };
  };
  // courier order with its vendor order relation (re-run accrual)
  db.courierOrder.findUnique = async ({ where }: any) => {
    const co = db.courierOrder.rows.find((r: any) => r.id === where.id);
    if (!co) return null;
    const vo = vendorOrders.get(co.vendorOrderId);
    return { ...co, vendorOrder: vo ? { id: vo.id, status: vo.status ?? "DELIVERED", items: vo.items.map((i: any) => ({ id: i.id })) } : null };
  };

  await db.agent.create({ data: { id: "A1", agentCode: "AG-AAAAAA", referralCode: "REF-A", name: "Rahim", email: "a1@x.com", passwordHash: "x", status: "ACTIVE" } });
  await db.agent.create({ data: { id: "A2", agentCode: "AG-BBBBBB", referralCode: "REF-B", name: "Karim", email: "a2@x.com", passwordHash: "x", status: "ACTIVE" } });
  await db.vendor.create({ data: { id: "V1", storeName: "Dhaka Fashion" } });
  await db.order.create({ data: { id: "O1", orderNumber: "FM-1001" } });
  await db.agentVendorLink.create({ data: { id: "L1", agentId: "A1", vendorId: "V1", source: "ADMIN_ASSIGNED", startedAt: new Date("2026-09-01T00:00:00Z"), endedAt: null } });
  await settings({
    ratePrecedence: ["VENDOR", "AGENT", "CATEGORY", "LEVEL", "GLOBAL"],
    defaultCommissionPercent: "20",
    holdDays: 7,
    commissionDurationMonths: null,
    minWithdrawalAmount: "10.00",
    maxWithdrawalAmount: "500.00",
    withdrawalFee: { type: "NONE" },
    enabledPayoutMethods: ["BKASH", "NAGAD", "BANK"],
    autoApproveWithdrawalLimit: "0.00",
  });
  // 5 × 200 @10% = FinixMart 100 → agent 20.00 ; 1 × 1000 @10% = 100 → agent 20.00
  vendorOrders.set("VO1", {
    id: "VO1",
    orderId: "O1",
    vendorId: "V1",
    order: { createdAt: T0 },
    items: [
      { id: "IA", quantity: 5, price: "200.0000", variant: { product: { categoryId: "CAT1" } } },
      { id: "IB", quantity: 1, price: "1000.0000", variant: { product: { categoryId: "CAT2" } } },
    ],
  });
});
afterEach(() => fake.restore());

async function settings(values: Record<string, unknown>, opts: { invalidate?: boolean } = {}) {
  for (const [key, value] of Object.entries(values)) {
    const row = fake.db.agentSetting.rows.find((r: any) => r.key === key);
    if (row) row.value = { value };
    else await fake.db.agentSetting.create({ data: { key, value: { value }, updatedById: "U", updatedAt: new Date() } });
  }
  if (opts.invalidate !== false) invalidateAgentSettingsCache();
}
async function unsetSetting(key: string) {
  const i = fake.db.agentSetting.rows.findIndex((r: any) => r.key === key);
  if (i >= 0) fake.db.agentSetting.rows.splice(i, 1);
  invalidateAgentSettingsCache();
}

const accrue = (deliveryId: string, lineScope?: Array<{ orderItemId: string; quantity: number }>, deps: any = PLATFORM_10) =>
  engine.accrueAgentCommissionForDelivery({ vendorOrderId: "VO1", deliveryId, lineScope, deliveredAt: DELIVERED }, deps);

const ledger = (agentId = "A1") => (fake.db.agentWalletTransaction.rows as any[]).filter((r) => r.agentId === agentId);
const walletRow = (agentId = "A1") => (fake.db.agentWallet.rows as any[]).find((r) => r.agentId === agentId);
const withdrawals = (agentId = "A1") => (fake.db.agentWithdrawal.rows as any[]).filter((r) => r.agentId === agentId);

/** The invariants every test ends with. */
function assertLedgerInvariant(agentId = "A1") {
  const w = walletRow(agentId);
  if (!w) return;
  const entries = ledger(agentId);
  const sum = entries.reduce((s, e) => s.plus(e.amount), new Decimal(0));
  assert.equal(new Decimal(w.available).toFixed(2), sum.toFixed(2), "wallet.available must equal the sum of the ledger");
  if (entries.length) assert.equal(new Decimal(entries[entries.length - 1].balanceAfter).toFixed(2), sum.toFixed(2), "last balanceAfter = balance");
  const open = withdrawals(agentId).filter((x) => x.status === "REQUESTED" || x.status === "APPROVED");
  assert.equal(new Decimal(w.onHold).toFixed(2), open.reduce((s, x) => s.plus(x.amount), new Decimal(0)).toFixed(2), "onHold = open withdrawals");
  const paid = withdrawals(agentId).filter((x) => x.status === "PAID");
  assert.equal(new Decimal(w.totalWithdrawn).toFixed(2), paid.reduce((s, x) => s.plus(x.amount), new Decimal(0)).toFixed(2), "totalWithdrawn = paid withdrawals");
  for (const k of ["pendingClearance", "onHold", "totalEarned", "totalWithdrawn"]) assert.ok(new Decimal(w[k]).gte(0), `${k} must never be negative (DB CHECK)`);
  for (const e of entries) assert.ok(!new Decimal(e.amount).isZero(), "no zero ledger entries (DB CHECK)");
}

async function bkash(agentId = "A1", number = "01711000001") {
  return payout.createPayoutMethod(agentId, { type: "BKASH", accountName: "Rahim Uddin", accountNumber: number });
}

/** Accrue D1 (agent earns 40.00) and let it clear. */
async function earn40(): Promise<void> {
  await accrue("D1");
  await wallet.syncAgentWallet("A1", CLEARED);
}

let reqSeq = 0;
const request = (amount: string, payoutMethodId: string, clientRequestId = `req-${++reqSeq}-abcdef`, now = CLEARED) =>
  wd.requestWithdrawal("A1", { clientRequestId, amount, payoutMethodId }, now);

async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (err: any) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    if (status) assert.equal(err.statusCode, status);
    return true;
  });
}

// ── ledger and clearance ─────────────────────────────────────────────────

test("accrual during the hold: pending only; clearance credits the ledger once; ledger = balance", async () => {
  await accrue("D1");
  let w = walletRow();
  assert.equal(w.pendingClearance, "40.00");
  assert.equal(w.available, "0.00");
  assert.equal(w.totalEarned, "40.00");
  assert.equal(ledger().length, 0, "nothing is credited before availableAt");

  await wallet.syncAgentWallet("A1", CLEARED);
  await wallet.syncAgentWallet("A1", CLEARED); // a second sync posts nothing
  w = walletRow();
  assert.equal(w.available, "40.00");
  assert.equal(w.pendingClearance, "0.00");
  assert.deepEqual(ledger().map((e) => [e.type, e.amount]).sort(), [["COMMISSION_CREDIT", "20.00"], ["COMMISSION_CREDIT", "20.00"]]);
  assert.ok(fake.db.agentCommission.rows.every((c: any) => c.walletCreditedAt && c.status === "AVAILABLE"));
  assertLedgerInvariant();
});

test("holdDays = 0: the accrual hook credits at once", async () => {
  await settings({ holdDays: 0 });
  await engine.accrueAgentCommissionForDelivery({ vendorOrderId: "VO1", deliveryId: "D1", deliveredAt: NOW }, PLATFORM_10);
  assert.equal(walletRow().available, "40.00");
  assert.equal(ledger().length, 2);
  assertLedgerInvariant();
});

test("a reversal before clearance only lowers pending; after clearance the credit and its reversal both post", async () => {
  await accrue("D1");
  vendorReturns.set("R1", { id: "R1", items: [{ orderItemId: "IA", quantity: 2 }] });
  await engine.reverseAgentCommissionForReturn("R1", NOW); // 2 of 5 units of IA's 20.00 → 8.00
  assert.equal(walletRow().pendingClearance, "32.00");
  assert.equal(walletRow().available, "0.00");
  await wallet.syncAgentWallet("A1", CLEARED);
  assert.equal(walletRow().available, "32.00");
  assert.equal(walletRow().totalEarned, "32.00");
  const rev = ledger().filter((e) => e.type === "COMMISSION_REVERSAL");
  assert.equal(rev.length, 1);
  assert.equal(rev[0].amount, "-8.00");
  assertLedgerInvariant();
});

test("C5: a reversal after the money was withdrawn makes the balance negative; it is offset by later earnings", async () => {
  await earn40();
  const m = await bkash();
  const out = await request("40.00", m.id);
  await wd.approveWithdrawal(out.withdrawal.id, ADMIN, CLEARED);
  await wd.markWithdrawalPaid(out.withdrawal.id, { transactionRef: "BK-TRX-1" }, ADMIN, CLEARED);
  assert.equal(walletRow().available, "0.00");
  assert.equal(walletRow().totalWithdrawn, "40.00");

  vendorReturns.set("R1", { id: "R1", items: [{ orderItemId: "IB", quantity: 1 }] });
  await engine.reverseAgentCommissionForReturn("R1", CLEARED); // the hook syncs: −20.00 on a credited commission
  assert.equal(walletRow().available, "-20.00", "negative balance, not hidden");
  const view = await wd.getAgentWallet("A1", CLEARED);
  assert.equal(view.negative, true);
  assert.equal(view.withdrawable, "0.00");
  assert.equal(view.canWithdraw, false);
  await rejects(request("10.00", m.id), "INSUFFICIENT_BALANCE", 409);

  // A new delivery's commission offsets the debt.
  vendorOrders.set("VO2", { id: "VO2", orderId: "O1", vendorId: "V1", order: { createdAt: T0 }, items: [{ id: "IC", quantity: 1, price: "1500.0000", variant: { product: { categoryId: "CAT1" } } }] });
  await engine.accrueAgentCommissionForDelivery({ vendorOrderId: "VO2", deliveryId: "D2", deliveredAt: DELIVERED }, PLATFORM_10); // 1500 × 10% × 20% = 30.00
  await wallet.syncAgentWallet("A1", CLEARED);
  assert.equal(walletRow().available, "10.00", "30.00 earned − 20.00 owed");
  assertLedgerInvariant();
});

// ── withdrawals: concurrency and idempotency ──────────────────────────────

test("two concurrent withdrawals against one balance: exactly one is held", async () => {
  await earn40();
  const m = await bkash();
  const results = await Promise.allSettled([request("30.00", m.id), request("30.00", m.id)]);
  const okCount = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(okCount, 1, "only one request fits in 40.00");
  assert.equal(failed[0].reason.code, "INSUFFICIENT_BALANCE");
  assert.equal(walletRow().available, "10.00");
  assert.equal(walletRow().onHold, "30.00");
  assertLedgerInvariant();
});

test("many concurrent withdrawals never overdraw", async () => {
  await earn40();
  const m = await bkash();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => request("15.00", m.id)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "2 × 15 fits in 40, a third does not");
  assert.ok(new Decimal(walletRow().available).gte(0));
  assertLedgerInvariant();
});

test("double-submit with the same clientRequestId creates one withdrawal (sequential and concurrent)", async () => {
  await earn40();
  const m = await bkash();
  const [a, b] = await Promise.all([request("12.00", m.id, "same-key-0001"), request("12.00", m.id, "same-key-0001")]);
  const c = await request("12.00", m.id, "same-key-0001");
  assert.equal(withdrawals().length, 1);
  assert.equal(a.withdrawal.id, b.withdrawal.id);
  assert.equal(c.withdrawal.id, a.withdrawal.id);
  assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
  assert.equal(c.replayed, true);
  assert.equal(ledger().filter((e) => e.type === "WITHDRAWAL_HOLD").length, 1, "one hold");
  await rejects(request("13.00", m.id, "same-key-0001"), "IDEMPOTENCY_KEY_REUSED", 409);
  assertLedgerInvariant();
});

// ── withdrawals: settings ────────────────────────────────────────────────

test("409 SETTINGS_NOT_CONFIGURED when a withdrawal setting is missing", async () => {
  await earn40();
  const m = await bkash();
  await unsetSetting("autoApproveWithdrawalLimit");
  await unsetSetting("maxWithdrawalAmount");
  await assert.rejects(request("20.00", m.id), (err: any) => {
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, "SETTINGS_NOT_CONFIGURED");
    assert.deepEqual([...err.details.missing].sort(), ["autoApproveWithdrawalLimit", "maxWithdrawalAmount"]);
    return true;
  });
  assert.equal(withdrawals().length, 0);
  const view = await wd.getAgentWallet("A1", CLEARED);
  assert.equal(view.rules.configured, false);
  assert.equal(view.canWithdraw, false);
});

test("limits are read fresh: a just-saved minimum applies even while the settings cache is warm", async () => {
  await earn40();
  const m = await bkash();
  await wd.getAgentWallet("A1", CLEARED); // warms the 30 s cache
  await settings({ minWithdrawalAmount: "25.00" }, { invalidate: false });
  await rejects(request("20.00", m.id), "AMOUNT_BELOW_MINIMUM", 400);
  await settings({ maxWithdrawalAmount: "30.00" }, { invalidate: false });
  await rejects(request("35.00", m.id), "AMOUNT_ABOVE_MAXIMUM", 400);
  const ok = await request("30.00", m.id);
  assert.equal(ok.withdrawal.amount, "30.00");
});

test("fee comes out of the amount and is snapshotted; a disabled method type is refused", async () => {
  await earn40();
  const m = await bkash();
  await settings({ withdrawalFee: { type: "PERCENT", percent: "1.5000" } });
  const out = await request("20.00", m.id);
  assert.equal(out.withdrawal.fee, "0.30");
  assert.equal(out.withdrawal.netAmount, "19.70");
  assert.equal(walletRow().onHold, "20.00", "the full amount is held");
  const row = withdrawals()[0];
  assert.deepEqual(row.settingsSnapshot.withdrawalFee, { type: "PERCENT", percent: "1.5000" });
  assert.equal(row.methodSnapshot.accountNumber, "01711000001", "full details stay in the snapshot for the admin");
  assert.equal(out.withdrawal.method.accountNumberMasked, "•••• 0001");
  assert.ok(!JSON.stringify(out.withdrawal).includes("01711000001"), "the agent response is masked");

  await settings({ enabledPayoutMethods: ["NAGAD"] });
  await rejects(request("10.00", m.id), "PAYOUT_METHOD_DISABLED", 409);
  assertLedgerInvariant();
});

test("auto-approve at or under autoApproveWithdrawalLimit (audited as the system), manual above, never when 0", async () => {
  await earn40();
  const m = await bkash();
  const zero = await request("10.00", m.id);
  assert.equal(zero.withdrawal.status, "REQUESTED", "limit 0 = never");
  await settings({ autoApproveWithdrawalLimit: "15.00" });
  const auto = await request("12.00", m.id);
  assert.equal(auto.withdrawal.status, "APPROVED");
  assert.equal(auto.withdrawal.autoApproved, true);
  const manual = await request("15.01", m.id);
  assert.equal(manual.withdrawal.status, "REQUESTED");
  const audit = fake.db.agentConfigAudit.rows.filter((r: any) => r.entity === "WITHDRAWAL");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entityId, auto.withdrawal.id);
  assert.equal(audit[0].actorUserId, "system:auto-approve");
  assertLedgerInvariant();
});

// ── admin actions ─────────────────────────────────────────────────────────

test("reject releases the hold (ledger entry + audit); a second reject is refused", async () => {
  await earn40();
  const m = await bkash();
  const out = await request("25.00", m.id);
  assert.equal(walletRow().available, "15.00");
  await wd.approveWithdrawal(out.withdrawal.id, ADMIN, CLEARED);
  const r = await wd.rejectWithdrawal(out.withdrawal.id, "Account name mismatch", ADMIN, CLEARED);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.rejectReason, "Account name mismatch");
  assert.equal(walletRow().available, "40.00");
  assert.equal(walletRow().onHold, "0.00");
  assert.deepEqual(ledger().filter((e) => e.refType === "AgentWithdrawal").map((e) => [e.type, e.amount]), [["WITHDRAWAL_HOLD", "-25.00"], ["WITHDRAWAL_RELEASE", "25.00"]]);
  const audit = fake.db.agentConfigAudit.rows.filter((a: any) => a.entityId === out.withdrawal.id).map((a: any) => a.newValue.status);
  assert.deepEqual(audit, ["APPROVED", "REJECTED"]);
  await rejects(wd.rejectWithdrawal(out.withdrawal.id, "again", ADMIN), "INVALID_WITHDRAWAL_STATE", 409);
  assertLedgerInvariant();
});

test("agent cancel releases the hold only while REQUESTED; another agent can't cancel it", async () => {
  await earn40();
  const m = await bkash();
  const out = await request("25.00", m.id);
  await rejects(wd.cancelWithdrawal("A2", out.withdrawal.id), "NOT_FOUND", 404);
  const c = await wd.cancelWithdrawal("A1", out.withdrawal.id);
  assert.equal(c.status, "CANCELLED");
  assert.equal(walletRow().available, "40.00");
  const again = await request("25.00", m.id);
  await wd.approveWithdrawal(again.withdrawal.id, ADMIN);
  await rejects(wd.cancelWithdrawal("A1", again.withdrawal.id), "INVALID_WITHDRAWAL_STATE", 409);
  assertLedgerInvariant();
});

test("mark-paid needs APPROVED and a transaction reference; moves onHold to totalWithdrawn without a second debit", async () => {
  await earn40();
  const m = await bkash();
  const out = await request("25.00", m.id);
  await rejects(wd.markWithdrawalPaid(out.withdrawal.id, { transactionRef: "BK-1" }, ADMIN), "INVALID_WITHDRAWAL_STATE", 409);
  assert.equal(withdrawalMarkPaidSchema.safeParse({}).success, false, "transactionRef is required");
  assert.equal(withdrawalMarkPaidSchema.safeParse({ transactionRef: "  " }).success, false);
  await wd.approveWithdrawal(out.withdrawal.id, ADMIN);
  const paid = await wd.markWithdrawalPaid(out.withdrawal.id, { transactionRef: "BK-8X2K91" }, ADMIN);
  assert.equal(paid.status, "PAID");
  assert.equal(paid.transactionRef, "BK-8X2K91");
  const w = walletRow();
  assert.equal(w.available, "15.00");
  assert.equal(w.onHold, "0.00");
  assert.equal(w.totalWithdrawn, "25.00");
  assert.equal(ledger().filter((e) => e.refType === "AgentWithdrawal").length, 1, "only the hold");
  await rejects(wd.rejectWithdrawal(out.withdrawal.id, "too late", ADMIN), "INVALID_WITHDRAWAL_STATE", 409);
  const detail = await wd.adminGetWithdrawal(out.withdrawal.id);
  assert.equal(detail.method.accountNumber, "01711000001", "the admin sees the full number to pay");
  assertLedgerInvariant();
});

test("suspended agent: commission still accrues and clears, but withdrawals are blocked (request, approve, pay); reject allowed", async () => {
  await earn40();
  const m = await bkash();
  const out = await request("20.00", m.id);
  fake.db.agent.rows.find((a: any) => a.id === "A1").status = "SUSPENDED";

  vendorOrders.set("VO2", { id: "VO2", orderId: "O1", vendorId: "V1", order: { createdAt: T0 }, items: [{ id: "IC", quantity: 1, price: "500.0000", variant: { product: { categoryId: "CAT1" } } }] });
  const acc = await engine.accrueAgentCommissionForDelivery({ vendorOrderId: "VO2", deliveryId: "D2", deliveredAt: DELIVERED }, PLATFORM_10);
  assert.equal(acc.status, "DONE");
  await wallet.syncAgentWallet("A1", CLEARED);
  assert.equal(walletRow().available, "30.00", "40 − 20 held + 10 new");

  await rejects(request("10.00", m.id), "AGENT_NOT_ACTIVE", 403);
  await rejects(wd.approveWithdrawal(out.withdrawal.id, ADMIN), "AGENT_NOT_ACTIVE", 409);
  const view = await wd.getAgentWallet("A1", CLEARED);
  assert.equal(view.canWithdraw, false);
  await wd.rejectWithdrawal(out.withdrawal.id, "Agent suspended", ADMIN);
  assert.equal(walletRow().available, "50.00");
  assertLedgerInvariant();
});

test("property: a random sequence of accruals, reversals, requests, rejects and payouts keeps ledger = balance", async () => {
  await settings({ holdDays: 0, autoApproveWithdrawalLimit: "50.00" });
  const m = await bkash();
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 60; i++) {
    const op = rnd();
    if (op < 0.35) {
      const id = `VOX${i}`;
      vendorOrders.set(id, { id, orderId: "O1", vendorId: "V1", order: { createdAt: T0 }, items: [{ id: `IX${i}`, quantity: 3, price: (100 + Math.floor(rnd() * 900)).toFixed(4), variant: { product: { categoryId: "CAT1" } } }] });
      await engine.accrueAgentCommissionForDelivery({ vendorOrderId: id, deliveryId: `DX${i}`, deliveredAt: NOW }, PLATFORM_10);
    } else if (op < 0.5) {
      const c = (fake.db.agentCommission.rows as any[]).find((x) => x.reversedQty < x.quantity);
      if (c) {
        vendorReturns.set(`RX${i}`, { id: `RX${i}`, items: [{ orderItemId: c.orderItemId, quantity: 1 }] });
        await engine.reverseAgentCommissionForReturn(`RX${i}`, NOW);
      }
    } else if (op < 0.8) {
      await request((10 + Math.floor(rnd() * 60)).toFixed(2), m.id, `prop-${i}-xxxxxx`, NOW).catch((e: any) => {
        if (!["INSUFFICIENT_BALANCE", "AMOUNT_BELOW_MINIMUM"].includes(e.code)) throw e;
      });
    } else {
      const open = withdrawals().find((x) => x.status === "REQUESTED" || x.status === "APPROVED");
      if (open && rnd() < 0.5) await wd.rejectWithdrawal(open.id, "random", ADMIN, NOW);
      else if (open) {
        if (open.status === "REQUESTED") await wd.approveWithdrawal(open.id, ADMIN, NOW);
        await wd.markWithdrawalPaid(open.id, { transactionRef: `T${i}` }, ADMIN, NOW);
      }
    }
    assertLedgerInvariant();
  }
  assert.ok(ledger().length > 10, "the sequence exercised the ledger");
});

// ── payout methods ────────────────────────────────────────────────────────

test("payout methods: masked lists, first is default, enabled types only, duplicates refused, per-agent scope", async () => {
  const a = await bkash();
  assert.equal(a.isDefault, true);
  const b = await payout.createPayoutMethod("A1", { type: "BANK", accountName: "Rahim Uddin", accountNumber: "1234-5678-9012", bankName: "Dutch-Bangla Bank", routingNumber: "090261234" });
  assert.equal(b.isDefault, false);
  const list = await payout.listPayoutMethods("A1");
  const json = JSON.stringify(list);
  assert.ok(!json.includes("01711000001") && !json.includes("123456789012"), "full numbers never listed");
  assert.equal(list.items.find((x) => x.id === b.id)!.accountNumberMasked, "•••• 9012");

  await assert.rejects(payout.createPayoutMethod("A1", { type: "BKASH", accountName: "Rahim", accountNumber: "12345" }), (e: any) => e.name === "ZodError");
  await rejects(bkash(), "DUPLICATE_PAYOUT_METHOD", 409);
  await settings({ enabledPayoutMethods: ["BKASH"] });
  await rejects(payout.createPayoutMethod("A1", { type: "NAGAD", accountName: "Rahim", accountNumber: "01811000002" }), "PAYOUT_METHOD_DISABLED", 409);
  const after = await payout.listPayoutMethods("A1");
  assert.equal(after.items.find((x) => x.id === b.id)!.enabled, false, "a disabled type stays listed but flagged");

  await rejects(payout.setDefaultPayoutMethod("A2", a.id), "NOT_FOUND", 404);
  await rejects(payout.deletePayoutMethod("A2", a.id), "NOT_FOUND", 404);
  await settings({ enabledPayoutMethods: ["BKASH", "BANK"] });
  await payout.setDefaultPayoutMethod("A1", b.id);
  assert.deepEqual(fake.db.agentPayoutMethod.rows.map((r: any) => [r.id, r.isDefault]), [[a.id, false], [b.id, true]]);
  await payout.deletePayoutMethod("A1", b.id);
  assert.equal(fake.db.agentPayoutMethod.rows[0].isDefault, true, "deleting the default promotes the next one");
});

test("payout methods: 409 while settings are missing; can't delete a method with a withdrawal in progress", async () => {
  await unsetSetting("enabledPayoutMethods");
  await rejects(bkash(), "SETTINGS_NOT_CONFIGURED", 409);
  await settings({ enabledPayoutMethods: ["BKASH"] });
  await earn40();
  const m = await bkash();
  await request("20.00", m.id);
  await rejects(payout.deletePayoutMethod("A1", m.id), "PAYOUT_METHOD_IN_USE", 409);
  const upd = await payout.updatePayoutMethod("A1", m.id, { accountName: "Rahim U." });
  assert.equal(upd.accountName, "Rahim U.");
  await assert.rejects(payout.updatePayoutMethod("A1", m.id, { bankName: "X Bank" }), (e: any) => e.code === "VALIDATION_ERROR");
});

// ── re-run accrual ────────────────────────────────────────────────────────

test("admin re-run accrual: idempotent per delivery, refuses undelivered ones, audited every time", async () => {
  await fake.db.courierOrder.create({ data: { id: "CO1", status: "DELIVERED", shipmentKind: "REGULAR", vendorOrderId: "VO1", warehouseId: null, deliveredAt: DELIVERED, lastStatusUpdate: DELIVERED } });
  await fake.db.courierOrder.create({ data: { id: "CO2", status: "IN_TRANSIT", shipmentKind: "REGULAR", vendorOrderId: "VO1", warehouseId: null, deliveredAt: null, lastStatusUpdate: NOW } });
  const first = await rerunAccrualForDelivery("CO1", ADMIN, PLATFORM_10);
  assert.equal(first.status, "DONE");
  assert.equal((first as any).created, 2);
  const second = await rerunAccrualForDelivery("CO1", ADMIN, PLATFORM_10);
  assert.equal((second as any).created, 0);
  assert.equal(fake.db.agentCommission.rows.length, 2);
  await rejects(rerunAccrualForDelivery("CO2", ADMIN, PLATFORM_10), "NOT_DELIVERED", 409);
  await rejects(rerunAccrualForDelivery("NOPE", ADMIN, PLATFORM_10), "NOT_FOUND", 404);
  const audit = fake.db.agentConfigAudit.rows.filter((r: any) => r.entity === "COMMISSION" && r.action === "RERUN");
  assert.equal(audit.length, 2);
  assert.equal(audit[0].actorUserId, "U-ADMIN");
});

test("admin re-run accrual uses the consignment's shipped allocations (multi-warehouse)", async () => {
  await fake.db.courierOrder.create({ data: { id: "CO1", status: "DELIVERED", shipmentKind: "REGULAR", vendorOrderId: "VO1", warehouseId: "W1", deliveredAt: DELIVERED, lastStatusUpdate: DELIVERED } });
  await fake.db.orderItemAllocation.create({ data: { orderItemId: "IA", warehouseId: "W1", quantity: 3, shippedQty: 3 } });
  await fake.db.orderItemAllocation.create({ data: { orderItemId: "IA", warehouseId: "W2", quantity: 2, shippedQty: 2 } });
  await fake.db.orderItemAllocation.create({ data: { orderItemId: "IB", warehouseId: "W2", quantity: 1, shippedQty: 1 } });
  await rerunAccrualForDelivery("CO1", ADMIN, PLATFORM_10);
  const rows = fake.db.agentCommission.rows as any[];
  assert.deepEqual(rows.map((r) => [r.orderItemId, r.quantity]), [["IA", 3]], "only W1's 3 units of IA");
});

// ── job and wiring ────────────────────────────────────────────────────────

test("the clearance job syncs every wallet with matured commissions", async () => {
  await accrue("D1");
  const { agentCommissionJobs } = await import("../src/modules/agent/agent.jobs.ts");
  const job = agentCommissionJobs()[0];
  await job.run({ now: CLEARED } as any);
  assert.equal(walletRow().available, "40.00");
  const again = await wallet.syncDueAgentWallets(CLEARED);
  assert.equal(again.agents, 0, "nothing left to post");
  assertLedgerInvariant();
});

test("routes: portal wallet routes are agent-scoped, admin actions sit before /:id", () => {
  const routes = readFileSync(new URL("../src/modules/agent/agent.routes.ts", import.meta.url), "utf8");
  for (const r of ['"/wallet"', '"/wallet/transactions"', '"/payout-methods"', '"/withdrawals"', '"/withdrawals/:id/cancel"']) assert.ok(routes.includes(`agentPortalRouter.`) && routes.includes(r), r);
  for (const r of ['"/withdrawals/:id/approve"', '"/withdrawals/:id/reject"', '"/withdrawals/:id/mark-paid"', '"/deliveries/:deliveryId/accrue"']) {
    const at = routes.indexOf(`adminAgentRouter.post(${r}`);
    assert.ok(at > 0, r);
    assert.ok(at < routes.indexOf('adminAgentRouter.get("/:id"'), `${r} before /:id`);
  }
  const controller = readFileSync(new URL("../src/modules/agent/controllers/agent-wallet.controller.ts", import.meta.url), "utf8");
  const portal = controller.slice(0, controller.indexOf("// ── admin"));
  assert.ok(!/req\.(body|query)\.agentId/.test(portal), "portal handlers never take an agent id from the client");
});
