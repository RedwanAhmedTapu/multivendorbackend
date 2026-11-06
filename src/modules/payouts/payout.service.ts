// src/modules/payouts/payout.service.ts
//
// Vendor payout scheduling and approval on top of the existing ledger.
//
// Invariants
//   - What FinixMart owes a vendor is VendorPayable.balance (ledger-derived,
//     already net of commission, refunds, returns, chargebacks and earlier
//     payouts). Nothing here recomputes sales or commission.
//   - Ledger credits inside the hold window (max(settlement delay, refund
//     window)) and amounts already in open batch items are not payable.
//   - A vendor appears at most once per batch (@@unique) and is never in two
//     open batches at once (open items are subtracted from what's available).
//   - No money moves automatically: auto mode only drafts batches. An admin
//     approves, pays outside the system (no payout provider is integrated),
//     then marks each item paid with a transfer reference. Marking paid posts
//     the paired payout voucher (idempotency VENDOR_PAYOUT:<itemId>), which is
//     the only thing that reduces VendorPayable.balance; the item's
//     APPROVED → PAID claim is conditional, so a double click pays once.
//   - Every change writes an immutable PayoutAuditLog row.
//   - Subscription billing is a separate flow: nothing here reads or writes
//     subscription payments.

import { Decimal } from "@prisma/client/runtime/library";
import { prisma, prismaDirect } from "../../config/prisma.ts";
import {
  PAYOUT_SETTING_KEY,
  batchNumberFor,
  computeEligibility,
  effectiveRule,
  holdWindowStart,
  isPayoutDay,
  nextPayoutDate,
  parsePayoutPolicy,
  validatePayoutPolicy,
  type EffectiveRule,
  type PayoutPolicy,
} from "./payout.rules.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PayoutDb = any;

export class PayoutError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, statusCode = 400, code = "PAYOUT_ERROR") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface Actor {
  userId: string;
  name?: string | null;
}

/** Posts the ledger payout voucher; must be idempotent per item id. */
export type PostPayoutVoucher = (input: { payoutItemId: string; vendorId: string; amount: Decimal; payoutDate: Date; createdBy: string }) => Promise<{ voucherId: string | null; pendingApproval?: boolean }>;

const OPEN_ITEM = ["PENDING", "APPROVED"];
const DAY = 86_400_000;
const dec = (v: unknown) => new Decimal(v === null || v === undefined ? 0 : String(v));
const reasonOf = (v: unknown) => {
  if (typeof v !== "string" || v.trim().length < 3) throw new PayoutError("A reason (at least 3 characters) is required", 400, "VALIDATION");
  return v.trim().slice(0, 500);
};
const dateOf = (v: unknown, field: string) => {
  const d = typeof v === "string" || v instanceof Date ? new Date(v as string) : null;
  if (!d || Number.isNaN(d.getTime())) throw new PayoutError(`${field} must be a date`, 400, "VALIDATION");
  return d;
};

export function createPayoutService(deps: { db?: PayoutDb; txDb?: PayoutDb; postVoucher?: PostPayoutVoucher; now?: () => Date } = {}) {
  const db: PayoutDb = deps.db ?? prisma;
  const txDb: PayoutDb = deps.txDb ?? deps.db ?? prismaDirect;
  const clock = deps.now ?? (() => new Date());
  const postVoucher: PostPayoutVoucher =
    deps.postVoucher ??
    (async (input) => {
      const { AccountingService } = await import("../../services/accounting.services.ts");
      const out: any = await new AccountingService().createVendorPayoutVoucher(input);
      return { voucherId: out?.vendor?.id ?? out?.platform?.id ?? null, pendingApproval: Boolean(out?.pendingApproval) };
    });

  async function audit(tx: PayoutDb, entity: string, entityId: string, action: string, before: unknown, after: unknown, actor: Actor | null) {
    await tx.payoutAuditLog.create({ data: { entity, entityId, action, before: before ?? undefined, after: after ?? undefined, actorUserId: actor?.userId ?? null, actorName: actor?.name ?? null } });
  }

  // ─── policy and vendor rules ─────────────────────────────────────────────

  async function getPolicy(): Promise<PayoutPolicy> {
    const row = await db.platformSettings.findUnique({ where: { key: PAYOUT_SETTING_KEY } });
    return parsePayoutPolicy(row?.value);
  }

  async function setPolicy(input: unknown, actor: Actor) {
    const v = validatePayoutPolicy(input);
    if (!v.ok) throw new PayoutError(v.message, 400, "VALIDATION");
    const before = await getPolicy();
    await txDb.$transaction(async (tx: PayoutDb) => {
      const value = JSON.stringify(v.value);
      await tx.platformSettings.upsert({ where: { key: PAYOUT_SETTING_KEY }, update: { value }, create: { key: PAYOUT_SETTING_KEY, value, note: "Vendor payout policy" } });
      await audit(tx, "PayoutPolicy", PAYOUT_SETTING_KEY, "POLICY_UPDATED", before, v.value, actor);
    });
    return v.value;
  }

  const listRules = () => db.vendorPayoutRule.findMany({ orderBy: { updatedAt: "desc" }, include: { vendor: { select: { id: true, storeName: true } } } });

  async function setRule(vendorId: string, input: any, actor: Actor) {
    const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
    if (!vendor) throw new PayoutError("Vendor not found", 404, "NOT_FOUND");
    const policy = await getPolicy();
    const i = input ?? {};
    // Validate the override by validating the policy it would produce.
    const merged = {
      ...policy,
      ...(i.cycle ? { cycle: i.cycle } : {}),
      ...(i.weekday !== undefined && i.weekday !== null ? { weekday: i.weekday } : {}),
      ...(Array.isArray(i.monthDays) && i.monthDays.length ? { monthDays: i.monthDays } : {}),
      ...(i.customIntervalDays ? { customIntervalDays: i.customIntervalDays } : {}),
      ...(i.anchorDate ? { anchorDate: i.anchorDate } : {}),
      ...(i.minThreshold !== undefined && i.minThreshold !== null && i.minThreshold !== "" ? { minThreshold: i.minThreshold } : {}),
      ...(i.settlementDelayDays !== undefined && i.settlementDelayDays !== null ? { settlementDelayDays: i.settlementDelayDays } : {}),
    };
    const v = validatePayoutPolicy(merged);
    if (!v.ok) throw new PayoutError(v.message, 400, "VALIDATION");
    const data = {
      cycle: i.cycle || null,
      weekday: i.weekday ?? null,
      monthDays: Array.isArray(i.monthDays) && i.monthDays.length ? v.value.monthDays : [],
      customIntervalDays: i.customIntervalDays || null,
      anchorDate: i.anchorDate ? new Date(`${i.anchorDate}T00:00:00Z`) : null,
      minThreshold: i.minThreshold === undefined || i.minThreshold === null || i.minThreshold === "" ? null : v.value.minThreshold,
      settlementDelayDays: i.settlementDelayDays ?? null,
      requireApproval: typeof i.requireApproval === "boolean" ? i.requireApproval : null,
      note: typeof i.note === "string" ? i.note.trim().slice(0, 500) || null : null,
      updatedById: actor.userId,
    };
    return txDb.$transaction(async (tx: PayoutDb) => {
      const before = await tx.vendorPayoutRule.findUnique({ where: { vendorId } });
      const row = await tx.vendorPayoutRule.upsert({ where: { vendorId }, update: data, create: { vendorId, ...data } });
      await audit(tx, "VendorPayoutRule", vendorId, "RULE_SET", before, data, actor);
      return row;
    });
  }

  /** Hold (optionally until a date), release, pause, resume. Holds never touch balances. */
  async function setVendorState(vendorId: string, action: "hold" | "release" | "pause" | "resume", input: any, actor: Actor) {
    const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
    if (!vendor) throw new PayoutError("Vendor not found", 404, "NOT_FOUND");
    let data: Record<string, unknown>;
    if (action === "hold") {
      const reason = reasonOf(input?.reason);
      const until = input?.until ? dateOf(input.until, "Hold until") : new Date("9999-12-31T00:00:00Z");
      if (until <= clock()) throw new PayoutError("The hold must end in the future", 400, "VALIDATION");
      data = { holdUntil: until, holdReason: reason };
    } else if (action === "release") data = { holdUntil: null, holdReason: null };
    else if (action === "pause") data = { paused: true, holdReason: reasonOf(input?.reason) };
    else if (action === "resume") data = { paused: false };
    else throw new PayoutError("Unknown action", 400, "VALIDATION");
    return txDb.$transaction(async (tx: PayoutDb) => {
      const before = await tx.vendorPayoutRule.findUnique({ where: { vendorId } });
      const row = await tx.vendorPayoutRule.upsert({ where: { vendorId }, update: { ...data, updatedById: actor.userId }, create: { vendorId, ...data, updatedById: actor.userId } });
      await audit(tx, "VendorPayoutRule", vendorId, `VENDOR_${action.toUpperCase()}`, before ? { paused: before.paused, holdUntil: before.holdUntil, holdReason: before.holdReason } : null, data, actor);
      return row;
    });
  }

  // ─── eligibility ─────────────────────────────────────────────────────────

  async function ruleFor(vendorId: string, policy?: PayoutPolicy): Promise<EffectiveRule> {
    const [p, rule] = await Promise.all([policy ?? getPolicy(), db.vendorPayoutRule.findUnique({ where: { vendorId } })]);
    return effectiveRule(p, rule);
  }

  async function recentNet(vendorId: string, since: Date) {
    const account = await db.chartOfAccount.findFirst({ where: { entityType: "VENDOR", entityId: vendorId, name: "Receivable from Platform" }, select: { id: true } });
    if (!account) return dec(0);
    const agg = await db.ledgerEntry.aggregate({ where: { accountId: account.id, entryDate: { gte: since } }, _sum: { debitAmount: true, creditAmount: true } });
    return dec(agg._sum?.debitAmount).minus(dec(agg._sum?.creditAmount));
  }

  async function openItemsTotal(vendorId: string, excludeItemId?: string) {
    const agg = await db.payoutBatchItem.aggregate({ where: { vendorId, status: { in: OPEN_ITEM }, ...(excludeItemId ? { id: { not: excludeItemId } } : {}) }, _sum: { amount: true } });
    return dec(agg._sum?.amount);
  }

  async function eligibilityFor(vendorId: string, opts: { policy?: PayoutPolicy; excludeItemId?: string; now?: Date } = {}) {
    const now = opts.now ?? clock();
    const rule = await ruleFor(vendorId, opts.policy);
    const [payable, pending, open] = await Promise.all([
      db.vendorPayable.findUnique({ where: { vendorId } }),
      recentNet(vendorId, holdWindowStart(rule, now)),
      openItemsTotal(vendorId, opts.excludeItemId),
    ]);
    const e = computeEligibility({ balance: dec(payable?.balance), recentNet: pending, openItems: open, rule, now });
    return { vendorId, rule, eligibility: e, nextPayoutDate: nextPayoutDate(rule, now).toISOString(), totalPaid: dec(payable?.totalPaid).toFixed(2), lastPayoutAt: payable?.lastPayoutAt ?? null };
  }

  /** Every vendor with a positive ledger balance, with what is payable now. */
  async function preview(q: { onlyDue?: boolean; date?: string } = {}) {
    const now = clock();
    const day = q.date ? dateOf(q.date, "Date") : now;
    const policy = await getPolicy();
    const payables = await db.vendorPayable.findMany({ where: { balance: { gt: 0 } }, select: { vendorId: true }, take: 5000 });
    const vendors = await db.vendor.findMany({ where: { id: { in: payables.map((p: any) => p.vendorId) } }, select: { id: true, storeName: true } });
    const names = new Map(vendors.map((v: any) => [v.id, v.storeName]));
    const rows: (Awaited<ReturnType<typeof eligibilityFor>> & { storeName: string; dueOnDate: boolean })[] = [];
    for (const p of payables) {
      const r = await eligibilityFor(p.vendorId, { policy, now });
      const due = isPayoutDay(r.rule, day);
      if (q.onlyDue && !due) continue;
      rows.push({ ...r, storeName: String(names.get(p.vendorId) ?? "—"), dueOnDate: due });
    }
    const sum = (k: "available" | "pendingInWindow" | "balance" | "inOpenBatches") => rows.reduce((s, r) => s.plus(r.eligibility[k]), dec(0)).toFixed(2);
    return {
      date: day.toISOString(),
      policy,
      totals: { vendors: rows.length, payableVendors: rows.filter((r) => r.eligibility.payable).length, balance: sum("balance"), available: sum("available"), pendingInWindow: sum("pendingInWindow"), inOpenBatches: sum("inOpenBatches"), payableNow: rows.reduce((s, r) => s.plus(r.eligibility.amount), dec(0)).toFixed(2) },
      rows,
    };
  }

  // ─── batches ─────────────────────────────────────────────────────────────

  async function nextBatchNumber(day: Date) {
    const prefix = batchNumberFor(day, 0).slice(0, -3);
    const count = await db.payoutBatch.count({ where: { batchNumber: { startsWith: prefix } } });
    return batchNumberFor(day, count + 1);
  }

  /**
   * Draft a batch for vendors that are payable now. By default only vendors
   * whose schedule falls on `scheduledFor`; an admin can pick vendors or
   * include those not due. Nothing is paid here.
   */
  async function createBatch(input: any, actor: Actor | null) {
    const scheduledFor = input?.scheduledFor ? dateOf(input.scheduledFor, "Payout date") : clock();
    const policy = await getPolicy();
    if (policy.holdAll) throw new PayoutError("Payouts are on a platform-wide hold (Payout settings)", 409, "PLATFORM_HOLD");
    const pick: string[] | null = Array.isArray(input?.vendorIds) && input.vendorIds.length ? input.vendorIds.map(String) : null;
    const pv = await preview({ onlyDue: !pick && !input?.includeNotDue, date: scheduledFor.toISOString() });
    const chosen = pv.rows.filter((r) => r.eligibility.payable && (!pick || pick.includes(r.vendorId)));
    if (!chosen.length) throw new PayoutError("No vendor has a payable balance for this batch", 422, "NOTHING_TO_PAY");
    const total = chosen.reduce((s, r) => s.plus(r.eligibility.amount), dec(0));
    for (let attempt = 0; attempt < 3; attempt++) {
      const batchNumber = await nextBatchNumber(scheduledFor);
      try {
        return await txDb.$transaction(async (tx: PayoutDb) => {
          const batch = await tx.payoutBatch.create({ data: { batchNumber, scheduledFor, status: "DRAFT", totalAmount: total.toFixed(2), vendorCount: chosen.length, createdById: actor?.userId ?? null, note: typeof input?.note === "string" ? input.note.slice(0, 500) : null } });
          for (const r of chosen) {
            // Re-check inside the transaction: the vendor must not already be in an open item.
            const open = await tx.payoutBatchItem.count({ where: { vendorId: r.vendorId, status: { in: OPEN_ITEM } } });
            if (open) throw new PayoutError(`${r.storeName} is already in an open payout batch`, 409, "ALREADY_IN_BATCH");
            await tx.payoutBatchItem.create({ data: { batchId: batch.id, vendorId: r.vendorId, amount: r.eligibility.amount, status: "PENDING", calculation: { ...r.eligibility, rule: { cycle: r.rule.cycle, minThreshold: r.rule.minThreshold, settlementDelayDays: r.rule.settlementDelayDays, refundWindowDays: r.rule.refundWindowDays }, computedAt: clock().toISOString() } } });
          }
          await audit(tx, "PayoutBatch", batch.id, "BATCH_CREATED", null, { batchNumber, scheduledFor: scheduledFor.toISOString(), total: total.toFixed(2), vendors: chosen.length, auto: !actor }, actor);
          return batch;
        });
      } catch (e) {
        if ((e as { code?: string })?.code === "P2002" && attempt < 2) continue; // batch number race
        throw e;
      }
    }
    throw new PayoutError("Could not allocate a batch number", 409, "CONFLICT");
  }

  async function getBatch(id: string) {
    const b = await db.payoutBatch.findUnique({ where: { id }, include: { items: { include: { vendor: { select: { id: true, storeName: true } } }, orderBy: { amount: "desc" } } } });
    if (!b) throw new PayoutError("Payout batch not found", 404, "NOT_FOUND");
    return b;
  }

  async function refreshBatch(tx: PayoutDb, batchId: string) {
    const items = await tx.payoutBatchItem.findMany({ where: { batchId } });
    const active = items.filter((i: any) => i.status !== "CANCELLED" && i.status !== "HELD");
    const paid = active.filter((i: any) => i.status === "PAID").length;
    const b = await tx.payoutBatch.findUnique({ where: { id: batchId } });
    let status = b.status;
    if (b.status !== "DRAFT" && b.status !== "CANCELLED") status = active.length && paid === active.length ? "PAID" : paid ? "PARTIALLY_PAID" : "APPROVED";
    if (b.status !== "CANCELLED" && active.length === 0 && items.every((i: any) => i.status === "CANCELLED")) status = "CANCELLED";
    await tx.payoutBatch.update({ where: { id: batchId }, data: { status, vendorCount: active.length, totalAmount: active.reduce((s: Decimal, i: any) => s.plus(dec(i.amount)), dec(0)).toFixed(2) } });
  }

  /** DRAFT → APPROVED. Items whose vendor balance no longer covers them are put on hold (reported). */
  async function approveBatch(id: string, actor: Actor) {
    const b = await getBatch(id);
    if (b.status !== "DRAFT") throw new PayoutError(`Only a draft batch can be approved (this one is ${b.status.toLowerCase()})`, 409, "INVALID_STATE");
    const policy = await getPolicy();
    if (policy.holdAll) throw new PayoutError("Payouts are on a platform-wide hold", 409, "PLATFORM_HOLD");
    const held: { vendorId: string; reason: string }[] = [];
    const checks = new Map<string, string | null>();
    for (const item of b.items.filter((i: any) => i.status === "PENDING")) {
      const r = await eligibilityFor(item.vendorId, { policy, excludeItemId: item.id });
      const blocking = r.eligibility.reasons.filter((x) => x === "PAUSED" || x === "ON_HOLD");
      checks.set(item.id, blocking.length ? `Vendor ${blocking.join(", ").toLowerCase().replace("_", " ")}` : dec(r.eligibility.available).lessThan(dec(item.amount)) ? `Balance now ৳${r.eligibility.available}, below ৳${dec(item.amount).toFixed(2)}` : null);
    }
    return txDb.$transaction(async (tx: PayoutDb) => {
      const claimed = await tx.payoutBatch.updateMany({ where: { id, status: "DRAFT" }, data: { status: "APPROVED", approvedById: actor.userId, approvedAt: clock() } });
      if (claimed.count !== 1) throw new PayoutError("The batch changed at the same time. Reload and try again.", 409, "CONFLICT");
      for (const [itemId, reason] of checks) {
        if (reason) {
          await tx.payoutBatchItem.updateMany({ where: { id: itemId, status: "PENDING" }, data: { status: "HELD", heldReason: reason } });
          held.push({ vendorId: b.items.find((i: any) => i.id === itemId).vendorId, reason });
        } else await tx.payoutBatchItem.updateMany({ where: { id: itemId, status: "PENDING" }, data: { status: "APPROVED" } });
      }
      await refreshBatch(tx, id);
      await audit(tx, "PayoutBatch", id, "BATCH_APPROVED", { status: "DRAFT" }, { status: "APPROVED", held }, actor);
      return { batch: await tx.payoutBatch.findUnique({ where: { id } }), held };
    });
  }

  async function cancelBatch(id: string, reasonRaw: unknown, actor: Actor) {
    const reason = reasonOf(reasonRaw);
    const b = await getBatch(id);
    if (b.items.some((i: any) => i.status === "PAID")) throw new PayoutError("A batch with paid items can't be cancelled; cancel the unpaid items instead", 409, "INVALID_STATE");
    if (b.status === "CANCELLED") throw new PayoutError("Already cancelled", 409, "INVALID_STATE");
    return txDb.$transaction(async (tx: PayoutDb) => {
      await tx.payoutBatchItem.updateMany({ where: { batchId: id, status: { in: ["PENDING", "APPROVED", "HELD"] } }, data: { status: "CANCELLED", heldReason: reason } });
      const res = await tx.payoutBatch.updateMany({ where: { id, status: { in: ["DRAFT", "APPROVED"] } }, data: { status: "CANCELLED" } });
      if (res.count !== 1) throw new PayoutError("The batch changed at the same time. Reload and try again.", 409, "CONFLICT");
      await audit(tx, "PayoutBatch", id, "BATCH_CANCELLED", { status: b.status }, { status: "CANCELLED", reason }, actor);
      return tx.payoutBatch.findUnique({ where: { id } });
    });
  }

  async function itemWithBatch(itemId: string) {
    const item = await db.payoutBatchItem.findUnique({ where: { id: itemId }, include: { batch: true } });
    if (!item) throw new PayoutError("Payout item not found", 404, "NOT_FOUND");
    return item;
  }

  async function holdItem(itemId: string, reasonRaw: unknown, actor: Actor) {
    const reason = reasonOf(reasonRaw);
    const item = await itemWithBatch(itemId);
    return txDb.$transaction(async (tx: PayoutDb) => {
      const res = await tx.payoutBatchItem.updateMany({ where: { id: itemId, status: { in: ["PENDING", "APPROVED"] } }, data: { status: "HELD", heldReason: reason } });
      if (res.count !== 1) throw new PayoutError(`A ${item.status.toLowerCase()} item can't be held`, 409, "INVALID_STATE");
      await refreshBatch(tx, item.batchId);
      await audit(tx, "PayoutBatchItem", itemId, "ITEM_HELD", { status: item.status }, { status: "HELD", reason }, actor);
      return tx.payoutBatchItem.findUnique({ where: { id: itemId } });
    });
  }

  async function releaseItem(itemId: string, actor: Actor) {
    const item = await itemWithBatch(itemId);
    if (item.status !== "HELD") throw new PayoutError("Only a held item can be released", 409, "INVALID_STATE");
    if (!["DRAFT", "APPROVED", "PARTIALLY_PAID"].includes(item.batch.status)) throw new PayoutError("This batch is closed", 409, "INVALID_STATE");
    const r = await eligibilityFor(item.vendorId, { excludeItemId: itemId });
    if (dec(r.eligibility.available).lessThan(dec(item.amount))) throw new PayoutError(`The vendor's payable balance is now ৳${r.eligibility.available}; cancel this item and draft a new batch`, 409, "BALANCE_CHANGED");
    if (r.eligibility.reasons.includes("PAUSED") || r.eligibility.reasons.includes("ON_HOLD")) throw new PayoutError("The vendor's payouts are paused or on hold; release the vendor first", 409, "VENDOR_ON_HOLD");
    const to = item.batch.status === "DRAFT" ? "PENDING" : "APPROVED";
    return txDb.$transaction(async (tx: PayoutDb) => {
      const open = await tx.payoutBatchItem.count({ where: { vendorId: item.vendorId, status: { in: OPEN_ITEM }, id: { not: itemId } } });
      if (open) throw new PayoutError("The vendor is already in another open batch", 409, "ALREADY_IN_BATCH");
      const res = await tx.payoutBatchItem.updateMany({ where: { id: itemId, status: "HELD" }, data: { status: to, heldReason: null } });
      if (res.count !== 1) throw new PayoutError("The item changed at the same time. Reload and try again.", 409, "CONFLICT");
      await refreshBatch(tx, item.batchId);
      await audit(tx, "PayoutBatchItem", itemId, "ITEM_RELEASED", { status: "HELD" }, { status: to }, actor);
      return tx.payoutBatchItem.findUnique({ where: { id: itemId } });
    });
  }

  async function cancelItem(itemId: string, reasonRaw: unknown, actor: Actor) {
    const reason = reasonOf(reasonRaw);
    const item = await itemWithBatch(itemId);
    return txDb.$transaction(async (tx: PayoutDb) => {
      const res = await tx.payoutBatchItem.updateMany({ where: { id: itemId, status: { in: ["PENDING", "APPROVED", "HELD"] } }, data: { status: "CANCELLED", heldReason: reason } });
      if (res.count !== 1) throw new PayoutError(`A ${item.status.toLowerCase()} item can't be cancelled`, 409, "INVALID_STATE");
      await refreshBatch(tx, item.batchId);
      await audit(tx, "PayoutBatchItem", itemId, "ITEM_CANCELLED", { status: item.status }, { status: "CANCELLED", reason }, actor);
      return tx.payoutBatchItem.findUnique({ where: { id: itemId } });
    });
  }

  /**
   * Record that an APPROVED item was transferred (outside the system) and post
   * the ledger payout voucher. Safe to retry: the voucher is idempotent per item
   * and the APPROVED → PAID claim succeeds once.
   */
  async function markItemPaid(itemId: string, input: any, actor: Actor) {
    const reference = typeof input?.reference === "string" ? input.reference.trim() : "";
    if (reference.length < 3 || reference.length > 120) throw new PayoutError("Enter the transfer reference (3-120 characters)", 400, "VALIDATION");
    const method = typeof input?.method === "string" && input.method.trim() ? input.method.trim().slice(0, 40) : "BANK_TRANSFER";
    const paidAt = input?.paidAt ? dateOf(input.paidAt, "Paid on") : clock();
    if (paidAt.getTime() > clock().getTime() + 60_000) throw new PayoutError("The payment date can't be in the future", 400, "VALIDATION");
    const item = await itemWithBatch(itemId);
    if (item.status === "PAID") return { item, duplicate: true };
    if (item.status !== "APPROVED") throw new PayoutError(`Only an approved item can be marked paid (this one is ${item.status.toLowerCase()})`, 409, "INVALID_STATE");
    if (!["APPROVED", "PARTIALLY_PAID"].includes(item.batch.status)) throw new PayoutError("The batch must be approved first", 409, "INVALID_STATE");
    const payable = await db.vendorPayable.findUnique({ where: { vendorId: item.vendorId } });
    if (dec(payable?.balance).lessThan(dec(item.amount))) throw new PayoutError(`The vendor's ledger balance (৳${dec(payable?.balance).toFixed(2)}) no longer covers this payout; hold or cancel it`, 409, "BALANCE_CHANGED");

    const { voucherId, pendingApproval } = await postVoucher({ payoutItemId: item.id, vendorId: item.vendorId, amount: dec(item.amount), payoutDate: paidAt, createdBy: actor.userId });
    // A voucher held for accounting approval hasn't moved the ledger yet: don't call the item paid.
    if (pendingApproval) throw new PayoutError("The payout voucher is waiting for accounting approval. Approve it in Accounting, then mark the item paid again.", 409, "VOUCHER_PENDING_APPROVAL");

    return txDb.$transaction(async (tx: PayoutDb) => {
      const claimed = await tx.payoutBatchItem.updateMany({ where: { id: itemId, status: "APPROVED" }, data: { status: "PAID", reference, method, paidAt, paidById: actor.userId, voucherId } });
      if (claimed.count !== 1) {
        const now = await tx.payoutBatchItem.findUnique({ where: { id: itemId } });
        if (now?.status === "PAID") return { item: now, duplicate: true };
        throw new PayoutError("The item changed at the same time. Reload and try again.", 409, "CONFLICT");
      }
      // Payout counters only (balance itself moved with the voucher's ledger posting).
      const rule = await ruleFor(item.vendorId);
      await tx.vendorPayable.update({ where: { vendorId: item.vendorId }, data: { totalPaid: { increment: dec(item.amount) }, totalPayouts: { increment: 1 }, lastPayoutAt: paidAt, nextPayoutDate: nextPayoutDate(rule, new Date(paidAt.getTime() + DAY)) } });
      await refreshBatch(tx, item.batchId);
      await audit(tx, "PayoutBatchItem", itemId, "ITEM_PAID", { status: "APPROVED" }, { status: "PAID", amount: dec(item.amount).toFixed(2), reference, method, paidAt: paidAt.toISOString(), voucherId }, actor);
      await tx.notification.create({ data: { type: "SYSTEM", title: "Payout sent", message: `FinixMart sent your payout of ৳${dec(item.amount).toFixed(2)} (ref ${reference}).`, targetType: "VENDOR", targetId: item.vendorId, actionUrl: "/vendor-dashboard/payouts" } });
      return { item: await tx.payoutBatchItem.findUnique({ where: { id: itemId } }), duplicate: false };
    });
  }

  // ─── lists and reports ───────────────────────────────────────────────────

  const listBatches = (q: { status?: string } = {}) =>
    db.payoutBatch.findMany({ where: q.status ? { status: q.status } : {}, orderBy: { createdAt: "desc" }, take: 200 });

  async function listItems(q: { status?: string; vendorId?: string; page?: number; pageSize?: number } = {}) {
    const where = { ...(q.status ? { status: q.status } : {}), ...(q.vendorId ? { vendorId: q.vendorId } : {}) };
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));
    const page = Math.max(1, q.page ?? 1);
    const [items, total] = await Promise.all([
      db.payoutBatchItem.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { vendor: { select: { id: true, storeName: true } }, batch: { select: { id: true, batchNumber: true, status: true, scheduledFor: true } } } }),
      db.payoutBatchItem.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  const listAudit = (q: { entity?: string; entityId?: string } = {}) =>
    db.payoutAuditLog.findMany({ where: { ...(q.entity ? { entity: q.entity } : {}), ...(q.entityId ? { entityId: q.entityId } : {}) }, orderBy: { createdAt: "desc" }, take: 300 });

  async function overview() {
    const now = clock();
    const [pv, paidItems, openBatches, held] = await Promise.all([
      preview({}),
      db.payoutBatchItem.findMany({ where: { status: "PAID", paidAt: { gte: new Date(now.getTime() - 366 * DAY) } }, select: { amount: true, paidAt: true } }),
      db.payoutBatch.count({ where: { status: { in: ["DRAFT", "APPROVED", "PARTIALLY_PAID"] } } }),
      db.payoutBatchItem.count({ where: { status: "HELD" } }),
    ]);
    const byMonth = new Map<string, Decimal>();
    for (const i of paidItems) {
      const d = new Date(new Date(i.paidAt).getTime() + 6 * 3_600_000);
      const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      byMonth.set(k, (byMonth.get(k) ?? dec(0)).plus(dec(i.amount)));
    }
    const months: { month: string; paid: string }[] = [];
    const dn = new Date(now.getTime() + 6 * 3_600_000);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(dn.getUTCFullYear(), dn.getUTCMonth() - i, 1));
      const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      months.push({ month: k, paid: (byMonth.get(k) ?? dec(0)).toFixed(2) });
    }
    return {
      policy: pv.policy,
      nextPayoutDate: nextPayoutDate(pv.policy, now).toISOString(),
      totals: { ...pv.totals, openBatches, heldItems: held, paid12m: months.reduce((s, m) => s.plus(m.paid), dec(0)).toFixed(2) },
      paidByMonth: months,
    };
  }

  // ─── vendor side ─────────────────────────────────────────────────────────

  async function vendorSummary(vendorId: string) {
    const r = await eligibilityFor(vendorId);
    const onHold = r.eligibility.reasons.some((x) => x === "PAUSED" || x === "ON_HOLD" || x === "PLATFORM_HOLD");
    const items = await db.payoutBatchItem.findMany({
      where: { vendorId, status: { in: ["PENDING", "APPROVED", "PAID", "HELD"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, amount: true, status: true, method: true, reference: true, paidAt: true, createdAt: true, batch: { select: { batchNumber: true, scheduledFor: true } } },
    });
    return {
      totalBalance: r.eligibility.balance,
      available: onHold ? "0.00" : r.eligibility.available,
      pending: r.eligibility.pendingInWindow,
      onHold: onHold ? r.eligibility.available : "0.00",
      inProcess: r.eligibility.inOpenBatches,
      totalPaid: r.totalPaid,
      lastPayoutAt: r.lastPayoutAt,
      nextPayoutDate: r.nextPayoutDate,
      schedule: { cycle: r.rule.cycle, minThreshold: r.rule.minThreshold, holdWindowDays: Math.max(r.rule.settlementDelayDays, r.rule.refundWindowDays) },
      status: onHold ? "ON_HOLD" : r.eligibility.payable ? "ELIGIBLE" : r.eligibility.reasons.includes("BELOW_THRESHOLD") ? "BELOW_THRESHOLD" : "NOTHING_DUE",
      // Never expose admin-only notes (hold reason text) beyond a generic flag.
      history: items.map((i: any) => ({ ...i, amount: dec(i.amount).toFixed(2), status: i.status === "HELD" ? "ON_HOLD" : i.status })),
    };
  }

  // ─── job ─────────────────────────────────────────────────────────────────

  /** On a payout day with auto-propose on: draft one batch (never approves or pays). */
  async function runAutoPropose(now = clock()) {
    const policy = await getPolicy();
    if (!policy.autoPropose || policy.holdAll) return 0;
    const dayStart = new Date(Math.floor((now.getTime() + 6 * 3_600_000) / DAY) * DAY - 6 * 3_600_000);
    const exists = await db.payoutBatch.count({ where: { createdById: null, scheduledFor: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY) } } });
    if (exists) return 0;
    try {
      await createBatch({ scheduledFor: dayStart.toISOString() }, null);
      return 1;
    } catch (e) {
      if (e instanceof PayoutError && (e.code === "NOTHING_TO_PAY" || e.code === "ALREADY_IN_BATCH")) return 0;
      throw e;
    }
  }

  return {
    getPolicy, setPolicy, listRules, setRule, setVendorState,
    eligibilityFor, preview,
    createBatch, getBatch, approveBatch, cancelBatch, holdItem, releaseItem, cancelItem, markItemPaid,
    listBatches, listItems, listAudit, overview,
    vendorSummary, runAutoPropose,
  };
}

export type PayoutService = ReturnType<typeof createPayoutService>;
let singleton: PayoutService | null = null;
export const payoutService = (): PayoutService => (singleton ??= createPayoutService());
