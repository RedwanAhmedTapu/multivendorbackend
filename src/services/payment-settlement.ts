// src/services/payment-settlement.ts
//
// Phase 6: the ONE place a gateway-verified payment for an order's total is
// settled — SSLCommerz (payment.service.confirmPayment), EPS and PayStation
// (payment-gateway.service) all come through here.
//
// Before Phase 6 each gateway posted Event 0a BEFORE taking the order lock
// (after an unlocked pre-check). Two different sessions verified at the same
// moment both passed the pre-check and both posted Event 0a; under the lock one
// was applied and the other recorded as unapplied — but its receipt voucher
// stayed. The engine key is ORDER_PLACED:SSLCommerz:<order>:<provider>, so two
// sessions through different providers (e.g. checkout via SSLCommerz, Pay Now
// via PayStation after the active gateway changed) produced TWO receipts for
// one order; a cancellation landing between the pre-check and the lock left a
// receipt behind for money that was then recorded as unapplied.
//
// Now, inside one transaction holding lockOrderForPaymentSettlement:
//   1. classify (payment-reconciliation.ts) — self already applied / recorded
//      → converge; order already paid / cancelled / moved on → record the
//      money, NO Event 0a, nothing else changes;
//   2. only for a payment that WILL be applied: post Event 0a (the engine runs
//      on its own connection; its voucher FK insert is compatible with the
//      lock). A voucher failure throws → the whole settlement rolls back and
//      nothing is confirmed (the gateway retries), as before;
//   3. the H1 reservation check, the guarded order claim, the sub-orders, the
//      payment row (gateway-specific, via applyPayment).
// Concurrent settlements of one order are therefore strictly serial: the
// second one sees the first's committed result and is recorded, never booked.
// No service imports besides the two lock/classification modules (the Event 0a
// poster is passed in, so payment services can use this without cycles).

import { lockOrderForPaymentSettlement, orderReservationIntact, STOCK_HOLD_AUDIT, STOCK_HOLD_REASON } from "./order-reservation.ts";
import { classifyVerifiedPayment, isUnappliedReason, recordUnappliedPayment, type UnappliedReason } from "./payment-reconciliation.ts";

export type SettlementOutcome = "CONFIRMED" | "HELD" | "UNAPPLIED" | "ALREADY";

export interface SettleArgs {
  orderId: string;
  paymentId: string;
  amount: unknown;
  /** Reconciliation record fields when the money can't be applied. */
  gateway: string;
  gatewayRef?: string | null;
  unappliedMeta?: Record<string, unknown>;
  /** Event 0a for this payment; null = this gateway posts none (see EPS). Called only when the payment is applied. */
  postEvent0a: (() => Promise<unknown>) | null;
  /** Marks the payment row PAID (plus gateway meta; stockHold on HELD). Runs on the settlement transaction. */
  applyPayment: (tx: any, outcome: "CONFIRMED" | "HELD", at: Date) => Promise<unknown>;
  /** Extra fields for the H1 stock-hold audit row. */
  holdAuditData?: Record<string, unknown>;
}

export const SETTLEMENT_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

export async function settleVerifiedPayment(db: any, a: SettleArgs): Promise<{ outcome: SettlementOutcome; reason?: UnappliedReason }> {
  return db.$transaction(async (tx: any) => {
    await lockOrderForPaymentSettlement(tx, a.orderId);

    const reason = await classifyVerifiedPayment(tx, a.orderId, a.paymentId);
    if (reason === "SELF_APPLIED" || reason === "SELF_RECORDED") return { outcome: "ALREADY" as const };
    if (isUnappliedReason(reason)) {
      await recordUnappliedPayment(tx, {
        paymentId: a.paymentId,
        orderId: a.orderId,
        reason,
        gateway: a.gateway,
        gatewayRef: a.gatewayRef ?? null,
        amount: a.amount,
        extraMeta: a.unappliedMeta,
      });
      return { outcome: "UNAPPLIED" as const, reason };
    }

    // Applied from here on. Event 0a first: a voucher failure rolls everything back.
    if (a.postEvent0a) await a.postEvent0a();

    const at = new Date();
    const stockHeld = await orderReservationIntact(tx, a.orderId);
    const claim = await tx.order.updateMany({
      where: { id: a.orderId, status: "PENDING", paymentStatus: "PENDING" },
      data: stockHeld ? { status: "CONFIRMED", paymentStatus: "PAID", paidAt: at } : { paymentStatus: "PAID", paidAt: at },
    });
    // Classification under this lock said PENDING/PENDING; anything else is a bug — roll back.
    if (claim.count !== 1) throw new Error("Order changed while the payment was being settled; nothing applied");

    if (stockHeld) {
      // Sub-orders are confirmed with the master (guarded on PENDING — a cancelled one is never revived).
      await tx.vendorOrder.updateMany({ where: { orderId: a.orderId, status: "PENDING" }, data: { status: "CONFIRMED" } });
    } else {
      // H1 (Option B): paid, NOT confirmed — its stock reservation is gone.
      await tx.auditLog.create({
        data: {
          action: STOCK_HOLD_AUDIT,
          entity: "Order",
          entityId: a.orderId,
          newData: { paymentId: a.paymentId, ...a.holdAuditData, reason: STOCK_HOLD_REASON, resolution: "Cancel the order to refund the customer" },
        },
      });
    }
    const outcome = stockHeld ? ("CONFIRMED" as const) : ("HELD" as const);
    await a.applyPayment(tx, outcome, at);
    return { outcome };
  }, SETTLEMENT_TX_OPTIONS);
}

/** The stockHold marker a HELD payment carries (unchanged from H1). */
export function stockHoldMeta(at: Date) {
  return { stockHold: { reason: STOCK_HOLD_REASON, at: at.toISOString() } };
}
