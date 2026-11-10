// src/services/order-reservation.ts
//
// H1: an order is confirmed for fulfilment ONLY while it still holds its stock
// reservation. A reservation is released when an unpaid order outlives the
// reservation TTL or its payment fails (OrderService.releaseStockForOrder —
// the allocation rows are removed). Confirming such an order would let the
// vendor process it although courier booking can never ship it ("No pending
// stock allocation"), and the stock may already have been sold to someone else.
//
// "Intact" is the same rule Pay Now uses to decide re-reservation
// (OrderService.payNowOrder): no release marker AND every item of every live
// (non-cancelled) vendor order still has its allocation rows. The allocation
// rows are the ground truth — the marker is written after the release commits.
//
// Call both helpers INSIDE the transaction that confirms the order, lock first:
// releaseStockForOrder takes the same row lock, so a release and a confirmation
// of the same order never interleave between the check and the write.
// No service imports here (payment, admin-order and vendor-order services use it).

/** Row lock on the order (SELECT … FOR UPDATE) for the rest of the transaction. */
export async function lockOrderForReservation(tx: any, orderId: string): Promise<void> {
  await tx.$executeRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
}

/**
 * Phase 6: the lock a verified-payment settlement holds while it decides and
 * posts Event 0a (payment-settlement.ts). FOR NO KEY UPDATE conflicts with
 * itself (another settlement, Pay Now / init session opening) and with
 * lockOrderForReservation's FOR UPDATE (stock release, COD init, admin and
 * vendor confirmation), so all of them serialize on the order — but it does
 * NOT block the KEY SHARE lock a voucher insert (Voucher.orderId FK) takes, so
 * the accounting engine can post Event 0a on its own connection meanwhile.
 */
export async function lockOrderForPaymentSettlement(tx: any, orderId: string): Promise<void> {
  await tx.$executeRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR NO KEY UPDATE`;
}

/** True only while the order still holds the stock reserved at placement (or re-reserved by Pay Now). */
export async function orderReservationIntact(tx: any, orderId: string): Promise<boolean> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      reservationReleasedAt: true,
      vendorOrders: {
        where: { status: { not: "CANCELLED" } },
        select: { items: { select: { allocations: { select: { id: true } } } } },
      },
    },
  });
  return isReservationIntact(order);
}

/**
 * The same rule on already-loaded rows (lists): marker cleared AND every item
 * of every live vendor order allocated. Items may carry `allocations` (array)
 * or `_count.allocations`; pass vendor orders WITH their status.
 */
export function isReservationIntact(order: { reservationReleasedAt?: Date | string | null; vendorOrders?: any[] } | null | undefined): boolean {
  if (!order || order.reservationReleasedAt) return false;
  const items = (order.vendorOrders ?? []).filter((vo: any) => vo.status === undefined || vo.status !== "CANCELLED").flatMap((vo: any) => vo.items ?? []);
  return items.length > 0 && items.every((it: any) => (it.allocations?.length ?? it._count?.allocations ?? 0) > 0);
}

/**
 * Why a verified payment was recorded without confirming the order. Written to
 * Payment.meta.stockHold and the PAYMENT_HELD_STOCK_RELEASED audit row. The
 * order stays PENDING with paymentStatus PAID ("paid, awaiting review") until
 * an admin (or the customer) cancels it — the existing cancel flow creates one
 * refund and reverses Event 0a.
 */
export const STOCK_HOLD_REASON = "STOCK_RESERVATION_RELEASED";
export const STOCK_HOLD_AUDIT = "PAYMENT_HELD_STOCK_RELEASED";
