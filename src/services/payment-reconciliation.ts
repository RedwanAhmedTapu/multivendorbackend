// src/services/payment-reconciliation.ts
//
// Phase 5 / Step 2: verified money that can't be applied to its order.
//
// A gateway can verify a payment for an order that no longer needs it:
//   - ORDER_ALREADY_PAID — another payment for the order was already verified
//     (two sessions both paid: Pay Now + checkout, a session older than the
//     Pay Now window, a delayed callback);
//   - ORDER_CANCELLED    — the order was cancelled / refunded before the money
//     arrived;
//   - ORDER_NOT_PAYABLE  — the order moved past PENDING without this payment.
// Before Phase 5 such a payment was silently dropped (SSLCommerz returned
// early, EPS/PayStation overwrote the order's status). Now it is RECORDED on
// the payment row — meta.reconciliation — together with an audit row, under
// the order lock, exactly once. The payment's status and the order are left
// as they were, and no Event 0a is posted: existing refund and confirmation
// flows read "the latest PAID payment", so the unapplied money must not look
// like the order's payment. Resolving it (refunding the customer) is a
// separate, manual decision — no gateway refund is triggered here.
//
// No service imports (payment.service and payment-gateway.service use it).

export const PAYMENT_UNAPPLIED_AUDIT = "PAYMENT_RECEIVED_NOT_APPLIED";

export type UnappliedReason = "ORDER_ALREADY_PAID" | "ORDER_CANCELLED" | "ORDER_NOT_PAYABLE";

/** Payment states that mean "this money is the order's" (refunds keep the original row). */
const PAID_LIKE = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];

export interface Reconciliation {
  state: "NEEDS_REVIEW";
  reason: UnappliedReason;
  receivedAt: string;
  gateway: string;
  gatewayRef: string | null;
  amount: string;
}

/** The reconciliation marker on a payment row, if any. */
export function reconciliationOf(meta: unknown): Reconciliation | null {
  const r = (meta as Record<string, any> | null | undefined)?.reconciliation;
  return r && typeof r === "object" && typeof r.reason === "string" ? (r as Reconciliation) : null;
}

/**
 * What to do with a VERIFIED payment for its order:
 *   "SELF_APPLIED"  — this payment was already applied (duplicate callback) → converge;
 *   "SELF_RECORDED" — already recorded as unapplied → converge;
 *   an UnappliedReason → record it, don't touch the order;
 *   null → apply it normally (confirm, or the H1 stock hold).
 * Call under the order lock for the decision that writes (a pre-check without
 * the lock is fine for skipping side effects such as Event 0a).
 */
export async function classifyVerifiedPayment(
  db: any,
  orderId: string,
  paymentId: string,
): Promise<UnappliedReason | "SELF_APPLIED" | "SELF_RECORDED" | null> {
  const self = await db.payment.findUnique({ where: { id: paymentId }, select: { status: true, meta: true } });
  if (!self) throw new Error("Payment not found");
  if (PAID_LIKE.includes(self.status)) return "SELF_APPLIED";
  if (reconciliationOf(self.meta)) return "SELF_RECORDED";

  const order = await db.order.findUnique({ where: { id: orderId }, select: { status: true, paymentStatus: true } });
  if (!order) throw new Error("Order not found");
  if (order.status === "CANCELLED" || order.status === "REFUNDED") return "ORDER_CANCELLED";

  const payments: { id: string; status: string; meta?: unknown }[] =
    (await db.payment.findMany({ where: { orderId }, select: { id: true, status: true, meta: true } })) ?? [];
  const otherPaid = payments.some(
    (p) => p.id !== paymentId && PAID_LIKE.includes(p.status) && (p.meta as any)?.type !== "delivery_fee",
  );
  if (otherPaid || order.paymentStatus !== "PENDING") return "ORDER_ALREADY_PAID";
  if (order.status !== "PENDING") return "ORDER_NOT_PAYABLE";
  return null;
}

export const isUnappliedReason = (r: unknown): r is UnappliedReason =>
  r === "ORDER_ALREADY_PAID" || r === "ORDER_CANCELLED" || r === "ORDER_NOT_PAYABLE";

// ── Phase 5 / Step 3: unverified failure reports ────────────────────────────
// A fail / cancel callback the gateway's own API could not confirm changes no
// state (no FAILED, no stock release — the reservation TTL job still releases
// abandoned orders). It is noted on the payment as `meta.gatewayReport` so the
// customer can retry (the Pay Now window ignores such a session) and the
// result page can say what was reported. The first report is kept.

export interface GatewayReport {
  outcome: "FAILED" | "CANCELLED";
  at: string;
  verified: false;
}

export function gatewayReportOf(meta: unknown): GatewayReport | null {
  const r = (meta as Record<string, any> | null | undefined)?.gatewayReport;
  return r && typeof r === "object" && (r.outcome === "FAILED" || r.outcome === "CANCELLED") ? (r as GatewayReport) : null;
}

export async function recordGatewayReport(db: any, paymentId: string, outcome: "FAILED" | "CANCELLED") {
  const p = await db.payment.findUnique({ where: { id: paymentId }, select: { id: true, status: true, meta: true } });
  if (!p) throw new Error("Payment not found");
  if (p.status !== "PENDING" || gatewayReportOf(p.meta) || reconciliationOf(p.meta)) return p;
  const gatewayReport: GatewayReport = { outcome, at: new Date().toISOString(), verified: false };
  return db.payment.update({
    where: { id: paymentId },
    data: { meta: { ...((p.meta as Record<string, unknown> | null) ?? {}), gatewayReport } },
  });
}

/**
 * Record verified-but-unapplied money on the payment row (idempotent: a row
 * that already carries a marker is left alone). Run on the transaction that
 * holds the order lock. Status, order and vendor orders are not changed.
 */
export async function recordUnappliedPayment(
  tx: any,
  args: { paymentId: string; orderId: string; reason: UnappliedReason; gateway: string; gatewayRef?: string | null; amount: unknown; extraMeta?: Record<string, unknown> },
): Promise<{ recorded: boolean }> {
  const current = await tx.payment.findUnique({ where: { id: args.paymentId }, select: { meta: true } });
  if (!current) throw new Error("Payment not found");
  if (reconciliationOf(current.meta)) return { recorded: false };
  const reconciliation: Reconciliation = {
    state: "NEEDS_REVIEW",
    reason: args.reason,
    receivedAt: new Date().toISOString(),
    gateway: args.gateway,
    gatewayRef: args.gatewayRef ?? null,
    amount: String(args.amount),
  };
  await tx.payment.update({
    where: { id: args.paymentId },
    data: { meta: { ...((current.meta as Record<string, unknown> | null) ?? {}), ...(args.extraMeta ?? {}), reconciliation } },
  });
  await tx.auditLog.create({
    data: {
      action: PAYMENT_UNAPPLIED_AUDIT,
      entity: "Payment",
      entityId: args.paymentId,
      newData: { orderId: args.orderId, ...reconciliation, resolution: "Review and refund the customer for this payment" },
    },
  });
  return { recorded: true };
}
