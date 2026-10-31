// src/modules/agent/services/agent-commission.service.ts
//
// Phase 6 — the agent commission engine (docs/agent-system-plan.md §2A, §5, §8).
//
// Business rules (decided 2026-11-01, plan §8):
//   C1  base = FinixMart's OWN commission on the delivered line, not the
//       vendor's gross sale. A CommissionRecord for the line is used when one
//       exists; otherwise the same per-line resolver the delivery voucher uses
//       (resolveCommissionRateForLine) is applied to the charged line.
//   C3  the charged line excludes shipping and VAT (OrderItem.price is
//       VAT-exclusive; shipping lives on the VendorOrder) and is net of the
//       PLATFORM-funded share of any line discount.
//   C4  earned on DELIVERED, per consignment (deliveryId = CourierOrder.id),
//       using the consignment's line scope; withdrawable after holdDays.
//   C5  reversed when a refund completes with a confirmed return
//       (consumeVendorReturnsForRefund). The wallet (Phase 7,
//       agent-wallet.service.ts) credits a commission once it clears and
//       debits reversals of credited ones; both hooks sync it afterwards.
//   C6  the agent is the one whose link was open when the ORDER WAS PLACED,
//       within commissionDurationMonths of the link start (null = lifetime).
//   C7  single level. C12 POS sales never reach this code.
//
// Guarantees:
//   - idempotent: @@unique([deliveryId, orderItemId]); existing rows are
//     skipped, a concurrent duplicate insert (P2002) is treated as done;
//   - the snapshot columns are written once here and never updated
//     (assertNoSnapshotMutation guards every update in this file);
//   - an agent commission never exceeds FinixMart's commission on the line;
//   - the *Safe wrappers never throw: a failure is logged and audited so the
//     courier webhook / refund flow that called them is never broken.

import Decimal from "decimal.js";
import { agentDb } from "../agent-db.ts";
import { getAgentSettings } from "./agent-settings.service.ts";
import {
  assertNoSnapshotMutation,
  buildCommissionSnapshot,
  commissionAmount,
  loadRateInputs,
  resolveAgentCommissionRate,
} from "./agent-rate.service.ts";
import { syncAgentWalletSafe } from "./agent-wallet.service.ts";
import { evaluateBonusesForAgentSafe } from "./agent-bonus.service.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type LineScope = Array<{ orderItemId: string; quantity: number }>;

/** Marketplace look-ups the engine needs; injectable for tests. */
export type CommissionDeps = {
  /** FinixMart's per-line commission rate as a FRACTION (0.10 = 10%). */
  resolvePlatformRate: (vendorId: string, categoryId: string | null) => Promise<{ rate: Decimal.Value; source: string }>;
  now: () => Date;
};

const defaultDeps: CommissionDeps = {
  resolvePlatformRate: async (vendorId, categoryId) => {
    // Imported lazily: admin.order.service imports this module (accrual hook).
    const { resolveCommissionRateForLine } = await import("../../../services/admin.order.service.ts");
    const r = await resolveCommissionRateForLine(vendorId, categoryId);
    return { rate: r.rate.toString(), source: r.source };
  },
  now: () => new Date(),
};

const withDefaults = (deps?: Partial<CommissionDeps>): CommissionDeps => ({ ...defaultDeps, ...(deps ?? {}) });

/** Calendar months after `from` (same day of month, clamped by JS Date). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** PENDING (not yet withdrawable) / AVAILABLE / PARTIALLY_REVERSED / REVERSED, computed from availableAt. */
export function effectiveCommissionStatus(row: { status: string; availableAt: Date }, now: Date): "PENDING" | "AVAILABLE" | "PARTIALLY_REVERSED" | "REVERSED" {
  if (row.status === "REVERSED") return "REVERSED";
  if (row.status === "PARTIALLY_REVERSED") return "PARTIALLY_REVERSED";
  return row.availableAt.getTime() <= now.getTime() ? "AVAILABLE" : "PENDING";
}

/**
 * FinixMart's commission on `quantity` units of one line (C1/C3), as a
 * 4-decimal string, plus how it was obtained (for the snapshot).
 */
export async function platformCommissionForLine(
  line: { orderItemId: string; vendorId: string; categoryId: string | null; unitPrice: Decimal.Value; lineQuantity: number; quantity: number },
  deps: CommissionDeps,
  db: any = agentDb.prisma,
): Promise<{ amount: string; detail: Record<string, unknown> }> {
  const records = await db.commissionRecord.findMany({
    where: { orderItemId: line.orderItemId, status: { not: "REVERSED" } },
    select: { id: true, quantity: true, commissionAmount: true, commissionRate: true },
  });
  const record = records.find((r: any) => r.quantity > 0);
  if (record) {
    const amount = new Decimal(record.commissionAmount.toString()).times(line.quantity).dividedBy(record.quantity);
    return {
      amount: amount.toDecimalPlaces(4, Decimal.ROUND_DOWN).toFixed(4),
      detail: { source: "COMMISSION_RECORD", commissionRecordId: record.id, recordRatePercent: record.commissionRate.toString() },
    };
  }

  // Charged line: VAT-exclusive unit price × units, minus the platform-funded
  // share of line discounts (net of any reversed discount).
  const discounts = await db.orderItemDiscount.findMany({
    where: { orderItemId: line.orderItemId },
    select: { amount: true, platformFunded: true, reversedAmount: true },
  });
  let platformFunded = new Decimal(0);
  for (const d of discounts) {
    const amount = new Decimal(d.amount.toString());
    const funded = new Decimal(d.platformFunded.toString());
    const live = amount.gt(0) ? amount.minus(new Decimal(d.reversedAmount.toString())).dividedBy(amount) : new Decimal(0);
    platformFunded = platformFunded.plus(funded.times(Decimal.max(live, 0)));
  }
  const perUnitDiscount = line.lineQuantity > 0 ? platformFunded.dividedBy(line.lineQuantity) : new Decimal(0);
  const charged = Decimal.max(new Decimal(line.unitPrice.toString()).minus(perUnitDiscount).times(line.quantity), 0);
  const rate = await deps.resolvePlatformRate(line.vendorId, line.categoryId);
  const amount = charged.times(rate.rate);
  return {
    amount: amount.toDecimalPlaces(4, Decimal.ROUND_DOWN).toFixed(4),
    detail: {
      source: "LINE_RESOLVER",
      platformRateSource: rate.source,
      platformRatePercent: new Decimal(rate.rate).times(100).toFixed(4),
      chargedLine: charged.toFixed(4),
      platformFundedDiscount: perUnitDiscount.times(line.quantity).toFixed(4),
    },
  };
}

/** Agent amount: base × rate, half-up to paisa, never above the base itself. */
export function cappedAgentAmount(baseAmount: string, ratePercent: string): string {
  const raw = new Decimal(commissionAmount(baseAmount, ratePercent));
  const cap = new Decimal(baseAmount).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  return Decimal.min(raw, cap).toFixed(2);
}

export type AccrualResult =
  | { status: "SKIPPED"; reason: "NO_AGENT" | "DURATION_ENDED" | "NOTHING_DELIVERED" | "NOT_CONFIGURED"; detail?: string }
  | { status: "DONE"; created: number; existing: number };

/**
 * Accrue agent commission for one delivered consignment (§5.1). Idempotent per
 * (deliveryId, orderItemId). Throws on unexpected errors — callers in the
 * order flow use accrueAgentCommissionForDeliverySafe.
 */
export async function accrueAgentCommissionForDelivery(
  params: { vendorOrderId: string; deliveryId: string; lineScope?: LineScope; deliveredAt?: Date },
  depsIn?: Partial<CommissionDeps>,
): Promise<AccrualResult> {
  const deps = withDefaults(depsIn);
  const db = agentDb.prisma as any;
  const vo = await db.vendorOrder.findUnique({
    where: { id: params.vendorOrderId },
    select: {
      id: true,
      orderId: true,
      vendorId: true,
      order: { select: { createdAt: true } },
      items: { select: { id: true, quantity: true, price: true, variant: { select: { product: { select: { categoryId: true } } } } } },
    },
  });
  if (!vo) throw new Error(`Vendor order ${params.vendorOrderId} not found`);
  const orderAt: Date = vo.order.createdAt;

  // C6: the link open when the order was placed.
  const link = await db.agentVendorLink.findFirst({
    where: { vendorId: vo.vendorId, startedAt: { lte: orderAt }, OR: [{ endedAt: null }, { endedAt: { gt: orderAt } }] },
    orderBy: { startedAt: "desc" },
    select: { id: true, agentId: true, source: true, startedAt: true, agent: { select: { status: true } } },
  });
  if (!link) return { status: "SKIPPED", reason: "NO_AGENT" };

  const settings = await getAgentSettings({ fresh: true });
  if (settings.values.holdDays == null) {
    return { status: "SKIPPED", reason: "NOT_CONFIGURED", detail: "holdDays is not configured" };
  }
  const durationMonths = settings.values.commissionDurationMonths;
  if (durationMonths != null && orderAt.getTime() >= addMonths(link.startedAt, durationMonths).getTime()) {
    return { status: "SKIPPED", reason: "DURATION_ENDED", detail: `Order placed after the ${durationMonths}-month commission period of link ${link.id}` };
  }

  // C4: the consignment's quantities (legacy: the full line).
  const scope = params.lineScope ? new Map(params.lineScope.map((s) => [s.orderItemId, s.quantity])) : null;
  const lines = (vo.items as any[])
    .map((item) => ({ item, quantity: scope ? Math.min(scope.get(item.id) ?? 0, item.quantity) : item.quantity }))
    .filter((l) => l.quantity > 0);
  if (!lines.length) return { status: "SKIPPED", reason: "NOTHING_DELIVERED" };

  const existing = await db.agentCommission.findMany({
    where: { deliveryId: params.deliveryId, orderItemId: { in: lines.map((l) => l.item.id) } },
    select: { orderItemId: true },
  });
  const done = new Set(existing.map((e: any) => e.orderItemId));
  const todo = lines.filter((l) => !done.has(l.item.id));
  if (!todo.length) return { status: "DONE", created: 0, existing: done.size };

  const deliveredAt = params.deliveredAt ?? deps.now();
  const availableAt = new Date(deliveredAt.getTime() + settings.values.holdDays * DAY_MS);
  const now = deps.now();
  let created = 0;
  const rateCache = new Map<string, Awaited<ReturnType<typeof loadRateInputs>>>();

  for (const { item, quantity } of todo) {
    const categoryId: string | null = item.variant?.product?.categoryId ?? null;
    const key = categoryId ?? "";
    let inputs = rateCache.get(key);
    if (!inputs) {
      inputs = await loadRateInputs({ agentId: link.agentId, vendorId: vo.vendorId, categoryId, at: orderAt }, settings, db);
      rateCache.set(key, inputs);
    }
    const resolution = resolveAgentCommissionRate(inputs);
    if (resolution.status !== "RESOLVED") {
      return { status: "SKIPPED", reason: "NOT_CONFIGURED", detail: resolution.reason };
    }

    const platform = await platformCommissionForLine(
      { orderItemId: item.id, vendorId: vo.vendorId, categoryId, unitPrice: item.price.toString(), lineQuantity: item.quantity, quantity },
      deps,
      db,
    );
    const snapshot = buildCommissionSnapshot(resolution, inputs, settings, now);
    const amount = cappedAgentAmount(platform.amount, snapshot.ratePercent);

    try {
      await db.agentCommission.create({
        data: {
          agentId: link.agentId,
          vendorId: vo.vendorId,
          orderId: vo.orderId,
          vendorOrderId: vo.id,
          orderItemId: item.id,
          deliveryId: params.deliveryId,
          quantity,
          baseAmount: platform.amount,
          amount,
          rateSource: snapshot.rateSource,
          rateRefId: snapshot.rateRefId,
          ratePercent: snapshot.ratePercent,
          levelId: snapshot.levelId,
          levelName: snapshot.levelName,
          holdDays: snapshot.holdDays,
          durationMonths: snapshot.durationMonths,
          ruleSnapshot: {
            ...snapshot.ruleSnapshot,
            base: { kind: "FINIXMART_COMMISSION", ...platform.detail, units: quantity, lineQuantity: item.quantity },
            attribution: {
              linkId: link.id,
              linkSource: link.source,
              linkStartedAt: link.startedAt.toISOString(),
              orderPlacedAt: orderAt.toISOString(),
              agentStatusAtAccrual: link.agent?.status ?? null,
            },
            delivery: { deliveryId: params.deliveryId, deliveredAt: deliveredAt.toISOString() },
          },
          status: availableAt.getTime() <= now.getTime() ? "AVAILABLE" : "PENDING_CLEARANCE",
          earnedAt: deliveredAt,
          availableAt,
        },
        select: { id: true },
      });
      created += 1;
    } catch (err: any) {
      if (err?.code === "P2002") continue; // a concurrent duplicate webhook won — already accrued
      throw err;
    }
  }
  // Phase 7: credit at once what is already past its hold (holdDays = 0); never throws.
  if (created) {
    await syncAgentWalletSafe(link.agentId, now);
    // Phase 9: milestone bonuses that this delivery may have unlocked; never throws.
    await evaluateBonusesForAgentSafe(link.agentId, now);
  }
  return { status: "DONE", created, existing: done.size };
}

async function auditEngineEvent(action: string, entityId: string, data: Record<string, unknown>): Promise<void> {
  try {
    await (agentDb.prisma as any).auditLog.create({
      data: { userId: null, action, entity: "AgentCommission", entityId, newData: data },
    });
  } catch (err: any) {
    console.error(`[agent-commission] audit write failed (${action} ${entityId}): ${err?.message ?? err}`);
  }
}

/** The accrual hook: never throws, so a failure can't break the courier webhook. */
export async function accrueAgentCommissionForDeliverySafe(
  params: { vendorOrderId: string; deliveryId: string; lineScope?: LineScope; deliveredAt?: Date },
  deps?: Partial<CommissionDeps>,
): Promise<AccrualResult | { status: "FAILED"; error: string }> {
  try {
    const result = await accrueAgentCommissionForDelivery(params, deps);
    if (result.status === "SKIPPED" && result.reason === "NOT_CONFIGURED") {
      await auditEngineEvent("AGENT_COMMISSION_ACCRUAL_SKIPPED", params.deliveryId, { ...params, reason: result.reason, detail: result.detail ?? null });
    }
    return result;
  } catch (err: any) {
    const error = String(err?.message ?? err).slice(0, 500);
    console.error(`[agent-commission] accrual failed for delivery ${params.deliveryId}: ${error}`);
    await auditEngineEvent("AGENT_COMMISSION_ACCRUAL_FAILED", params.deliveryId, { ...params, error });
    return { status: "FAILED", error };
  }
}

// ── Reversal (C5) ───────────────────────────────────────────────────────────

/** Share of a commission's amount for `take` units; the last units get the exact remainder. */
export function reversalAmount(row: { quantity: number; amount: Decimal.Value; reversedQty: number; reversedAmount: Decimal.Value }, take: number): string {
  const amount = new Decimal(row.amount.toString());
  const left = amount.minus(new Decimal(row.reversedAmount.toString()));
  if (row.reversedQty + take >= row.quantity) return Decimal.max(left, 0).toFixed(2);
  const share = amount.times(take).dividedBy(row.quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return Decimal.min(share, Decimal.max(left, 0)).toFixed(2);
}

class ReversalConflict extends Error {}

export type ReversalResult = { reversedRows: number; reversedQuantity: number; reversedAmount: string };

/**
 * Reverse agent commission for one confirmed return whose refund completed
 * (§5.2). Per returned line, units are taken from that line's commission rows
 * oldest first, never more than was earned. Idempotent per (commission, return).
 */
export async function reverseAgentCommissionForReturn(vendorReturnId: string, now: Date = new Date()): Promise<ReversalResult> {
  const db = agentDb.prisma as any;
  const vr = await db.vendorReturn.findUnique({
    where: { id: vendorReturnId },
    select: { id: true, items: { select: { orderItemId: true, quantity: true } } },
  });
  if (!vr) throw new Error(`Vendor return ${vendorReturnId} not found`);

  let reversedRows = 0;
  let reversedQuantity = 0;
  let total = new Decimal(0);
  const agentIds = new Set<string>();
  for (const ri of vr.items as Array<{ orderItemId: string; quantity: number }>) {
    let remaining = ri.quantity;
    const rows = await db.agentCommission.findMany({
      where: { orderItemId: ri.orderItemId },
      orderBy: { earnedAt: "asc" },
      select: { id: true, earnedAt: true, agentId: true },
    });
    rows.sort((a: any, b: any) => a.earnedAt.getTime() - b.earnedAt.getTime());
    const already = await db.agentCommissionReversal.findMany({
      where: { vendorReturnId, commissionId: { in: rows.map((r: any) => r.id) } },
      select: { commissionId: true, quantity: true },
    });
    const alreadyBy = new Map(already.map((a: any) => [a.commissionId, a.quantity as number]));
    for (const a of already) remaining -= a.quantity; // re-run: those units are done

    for (const { id, agentId } of rows) {
      if (remaining <= 0) break;
      if (alreadyBy.has(id)) continue;
      for (let attempt = 1; ; attempt++) {
        try {
          const out = await db.$transaction(async (tx: any) => {
            const c = await tx.agentCommission.findUnique({
              where: { id },
              select: { id: true, quantity: true, amount: true, reversedQty: true, reversedAmount: true },
            });
            const open = c.quantity - c.reversedQty;
            if (open <= 0) return null;
            const take = Math.min(open, remaining);
            const amount = reversalAmount(c, take);
            await tx.agentCommissionReversal.create({ data: { commissionId: id, vendorReturnId, quantity: take, amount } });
            const data = {
              reversedQty: { increment: take },
              reversedAmount: { increment: amount },
              status: c.reversedQty + take >= c.quantity ? "REVERSED" : "PARTIALLY_REVERSED",
            };
            assertNoSnapshotMutation(data);
            const upd = await tx.agentCommission.updateMany({ where: { id, reversedQty: c.reversedQty }, data });
            if (upd.count !== 1) throw new ReversalConflict("commission changed meanwhile");
            return { take, amount };
          });
          if (out) {
            agentIds.add(agentId);
            remaining -= out.take;
            reversedRows += 1;
            reversedQuantity += out.take;
            total = total.plus(out.amount);
          }
          break;
        } catch (err: any) {
          if (err?.code === "P2002") break; // this return was already applied to this row (concurrent run)
          if ((err instanceof ReversalConflict || err?.code === "P2034") && attempt < 3) continue;
          throw err;
        }
      }
    }
  }
  // Phase 7: debit reversals of already-credited commissions now; never throws.
  for (const agentId of agentIds) await syncAgentWalletSafe(agentId, now);
  return { reversedRows, reversedQuantity, reversedAmount: total.toFixed(2) };
}

/** The reversal hook: never throws, so a failure can't break the refund flow. */
export async function reverseAgentCommissionForReturnSafe(vendorReturnId: string): Promise<ReversalResult | { status: "FAILED"; error: string }> {
  try {
    return await reverseAgentCommissionForReturn(vendorReturnId);
  } catch (err: any) {
    const error = String(err?.message ?? err).slice(0, 500);
    console.error(`[agent-commission] reversal failed for return ${vendorReturnId}: ${error}`);
    await auditEngineEvent("AGENT_COMMISSION_REVERSAL_FAILED", vendorReturnId, { vendorReturnId, error });
    return { status: "FAILED", error };
  }
}

// ── Clearance ──────────────────────────────────────────────────────────────

/**
 * PENDING_CLEARANCE → AVAILABLE once availableAt has passed. Reads never depend
 * on it (effectiveCommissionStatus derives the state from availableAt), so a
 * late or skipped run is harmless; the job only keeps the stored status tidy.
 */
export async function clearMaturedAgentCommissions(now: Date = new Date()): Promise<number> {
  const data = { status: "AVAILABLE" };
  assertNoSnapshotMutation(data);
  const res = await (agentDb.prisma as any).agentCommission.updateMany({
    where: { status: "PENDING_CLEARANCE", availableAt: { lte: now } },
    data,
  });
  return res.count;
}
