// src/services/pay-now.service.ts
//
// Customer "Pay Now" for a PAYMENT_PENDING online order (POST
// /api/orders/:orderId/pay-now). Returns the gateway page URL issued by the
// ACTIVE gateway (SSLCommerz / EPS / PayStation) — the same initialisation the
// checkout uses (paymentGatewayService.initiatePayment). Nothing is marked
// paid here; only the gateway's verified callback / IPN does that.
//
//   1. eligibility + stock: OrderService.payNowOrder (owner, PENDING/PENDING,
//      not COD; re-reserves released stock in one Serializable transaction);
//   2. one gateway session at a time: under a row lock on the order, refuse
//      (409 PAYMENT_IN_PROGRESS) while another gateway session for this order
//      was opened within PAY_NOW_SESSION_WINDOW_MS, re-check eligibility and
//      the reservation, then open the session.
//
// The lock is FOR NO KEY UPDATE: concurrent Pay Now calls for the same order
// queue on it (the second sees the first one's session and gets 409), while
// the gateway initialiser's own inserts (FK checks take FOR KEY SHARE on the
// order) are not blocked by it. It is held only for the gateway call.
// Separate module: order.service ↔ payment services would otherwise import
// each other.

import { OrderService, orderServiceDb, payNowEligible } from "./order.service.ts";
import { paymentGatewayService } from "./payment-gateway.service.ts";
import { isReservationIntact } from "./order-reservation.ts";

/** A gateway session opened less than this long ago blocks a new one. */
export const PAY_NOW_SESSION_WINDOW_MS = 5 * 60 * 1000;
const LOCK_TX_TIMEOUT_MS = 45_000;

export const payNowDeps = {
  db: orderServiceDb as any,
  reserve: (userId: string, orderId: string) => new OrderService().payNowOrder(userId, orderId),
  initiate: (p: { orderId: string; userId: string; gatewayCode: string }) => paymentGatewayService.initiatePayment(p),
  now: () => Date.now(),
};

export type PayNowErrorCode =
  | "NOT_FOUND"
  | "NOT_PAYABLE"
  | "COD_ORDER"
  | "PAYMENT_IN_PROGRESS"
  | "STOCK_UNAVAILABLE"
  | "RESERVATION_CHANGED"
  | "GATEWAY_ERROR";

export class PayNowError extends Error {
  // Strip-only safe: explicit fields instead of constructor parameter properties
  // (Node's native TypeScript loader rejects `constructor(public readonly x)`).
  public readonly statusCode: number;
  public readonly code: PayNowErrorCode;
  public readonly retryAfterSeconds?: number;
  constructor(
    statusCode: number,
    code: PayNowErrorCode,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "PayNowError";
  }
}

/**
 * Is this payment row an open gateway session for the order total (not the
 * checkout placeholder, not a delivery fee)? A session the gateway already
 * reported as failed / cancelled (Phase 5 gatewayReport — unverified, so the
 * row stays PENDING) does not block a retry.
 */
export function isOrderGatewaySession(p: { status: string; meta?: unknown }): boolean {
  return p.status === "PENDING" && (p.meta as any)?.type === "order_payment" && !(p.meta as any)?.gatewayReport;
}

function mapReserveError(e: any): never {
  const msg = String(e?.message ?? "");
  if (/not found/i.test(msg)) throw new PayNowError(404, "NOT_FOUND", "Order not found");
  if (/COD orders/.test(msg)) throw new PayNowError(400, "COD_ORDER", "Cash on delivery orders are paid to the courier on delivery.");
  if (/PAYMENT_PENDING/.test(msg)) throw new PayNowError(409, "NOT_PAYABLE", "This order is no longer awaiting payment.");
  if (/stock for this order is no longer available|Insufficient sellable stock/i.test(msg)) {
    throw new PayNowError(409, "STOCK_UNAVAILABLE", "Some items in this order are no longer in stock, so it can't be paid. Contact support or cancel the order.");
  }
  throw e;
}

export async function startPayNow(userId: string, orderId: string, gatewayCode = "") {
  try {
    await payNowDeps.reserve(userId, orderId);
  } catch (e) {
    mapReserveError(e);
  }
  const session = await openOrderGatewaySession({ orderId, gatewayCode, ownerId: userId, rejectCod: true, requireReservation: true, requireHttps: true });
  return { gatewayPageURL: session.gatewayPageURL, transactionId: session.transactionId };
}

/**
 * Phase 5: the ONE place a gateway session for an order's total is opened —
 * Pay Now and POST /payment/init both come through here, so the duplicate-
 * session window applies to both. Under the order row lock: re-check that the
 * order is still awaiting payment, refuse (409 PAYMENT_IN_PROGRESS) while
 * another order-payment session is younger than PAY_NOW_SESSION_WINDOW_MS,
 * optionally require the stock reservation, then initialise the active gateway.
 *   ownerId        — when set, the order must belong to this user (Pay Now);
 *                    /payment/init authorises before calling (staff allowed).
 *   rejectCod      — Pay Now never pays a COD order; /payment/init keeps its
 *                    previous rule (any order awaiting payment).
 *   requireHttps   — Pay Now refuses a non-https page URL; /payment/init
 *                    returns the gateway's URL unchanged, as before.
 * Phase 5 / Step 4: the customer identity sent to the gateway (SSLCommerz
 * value_b / customerId, PayStation optB — later RefundRecord.customerId) is
 * the ORDER's customer, read under the lock — never a caller-supplied id.
 */
export async function openOrderGatewaySession(opts: {
  orderId: string;
  gatewayCode: string;
  ownerId: string | null;
  rejectCod: boolean;
  requireReservation: boolean;
  requireHttps: boolean;
}): Promise<{ gatewayPageURL: string; transactionId: string; sessionKey: string | null }> {
  const { orderId } = opts;
  return payNowDeps.db.$transaction(
    async (tx: any) => {
      await tx.$executeRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR NO KEY UPDATE`;
      const since = new Date(payNowDeps.now() - PAY_NOW_SESSION_WINDOW_MS);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          userId: true,
          status: true,
          paymentStatus: true,
          paymentmethod: true,
          reservationReleasedAt: true,
          vendorOrders: {
            where: { status: { not: "CANCELLED" } },
            select: { status: true, items: { select: { allocations: { select: { id: true } } } } },
          },
          payments: {
            where: { status: "PENDING", createdAt: { gte: since } },
            select: { status: true, meta: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          },
        },
      });
      if (!order || (opts.ownerId !== null && order.userId !== opts.ownerId)) throw new PayNowError(404, "NOT_FOUND", "Order not found");
      if (!order.userId) throw new PayNowError(409, "NOT_PAYABLE", "This order has no customer account to pay for it.");
      const awaitingPayment = order.status === "PENDING" && order.paymentStatus === "PENDING";
      if (opts.rejectCod ? !payNowEligible(order) : !awaitingPayment) {
        if (opts.rejectCod && order.paymentmethod === "COD") throw new PayNowError(400, "COD_ORDER", "Cash on delivery orders are paid to the courier on delivery.");
        throw new PayNowError(409, "NOT_PAYABLE", "This order is no longer awaiting payment.");
      }
      const open = (order.payments as any[]).find(isOrderGatewaySession);
      if (open) {
        const retryAfterSeconds = Math.max(1, Math.ceil((new Date(open.createdAt).getTime() + PAY_NOW_SESSION_WINDOW_MS - payNowDeps.now()) / 1000));
        throw new PayNowError(
          409,
          "PAYMENT_IN_PROGRESS",
          "A payment for this order was started a moment ago. If you completed it, it will be confirmed shortly; otherwise try again in a few minutes.",
          retryAfterSeconds,
        );
      }
      // A TTL release can land between step 1 and the lock.
      if (opts.requireReservation && !isReservationIntact(order)) {
        throw new PayNowError(409, "RESERVATION_CHANGED", "The items in this order were released while we prepared your payment. Please try again.");
      }

      let session: any;
      try {
        session = await payNowDeps.initiate({ orderId, userId: order.userId, gatewayCode: opts.gatewayCode });
      } catch (e: any) {
        console.error("[pay-now] gateway initialisation failed:", e?.message ?? e);
        throw new PayNowError(502, "GATEWAY_ERROR", "We couldn't reach the payment gateway. Please try again.");
      }
      const url = typeof session?.gatewayPageURL === "string" ? session.gatewayPageURL : "";
      if (opts.requireHttps ? !/^https:\/\//i.test(url) : !url) {
        console.error("[pay-now] gateway returned no usable page URL");
        throw new PayNowError(502, "GATEWAY_ERROR", "We couldn't reach the payment gateway. Please try again.");
      }
      return { gatewayPageURL: url, transactionId: String(session.transactionId ?? ""), sessionKey: session.sessionKey ?? null };
    },
    { timeout: LOCK_TX_TIMEOUT_MS, maxWait: 10_000 },
  );
}
