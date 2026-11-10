// services/refund-balance.ts
//
// Phase 4 (H-2): the refundable-balance rules shared by every refund writer
// (cancellation refunds, refund requests, refund approval). Every writer takes
// the SAME payment-row lock before reading the consumed sum, so concurrent
// writers for one order are serialized whatever their isolation level — the
// Serializable cancellation transactions and the READ COMMITTED refund
// request no longer race past each other.

import { randomBytes } from "node:crypto";

/** Refunds that consume the refundable balance (FAILED / REJECTED / CANCELLED do not). */
export const CONSUMING_REFUND_STATUSES = ["PENDING", "APPROVED", "PROCESSING", "REFUNDED"] as const;

/** Same tolerance as the existing H1 guard. */
export const REFUND_EPSILON = 0.005;

/**
 * Locks the payment row (FOR UPDATE) and returns the order's paid, consumed
 * and remaining refundable amounts. Must run inside the caller's transaction.
 */
export async function lockRefundableBalance(tx: any, payment: { id: string; amount: unknown }, orderId: string) {
  await tx.$executeRaw`SELECT "id" FROM "payments" WHERE "id" = ${payment.id} FOR UPDATE`;
  const consumedAgg = await tx.refund.aggregate({
    where: { orderId, status: { in: [...CONSUMING_REFUND_STATUSES] } },
    _sum: { amount: true },
  });
  const paid = Number(payment.amount);
  const consumed = Number(consumedAgg._sum.amount ?? 0);
  return { paid, consumed, remaining: paid - consumed };
}

/** Collision-safe refund number (`RF-${Date.now()}` alone collided within one millisecond). */
export function newRefundNumber(now = Date.now()): string {
  return `RF-${now}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * D1: the `refunds.idempotencyKey` column exists only after the Phase 4
 * migration is applied and the Prisma client regenerated. Until then the key
 * is never written; set REFUND_IDEMPOTENCY_KEYS=1 after both steps.
 */
export function refundIdempotencyKeysEnabled(): boolean {
  return process.env.REFUND_IDEMPOTENCY_KEYS === "1";
}
