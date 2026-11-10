// services/payment.service.ts
import {
  PrismaClient,
  PaymentStatus,
  PaymentMethod,
  OrderStatus,
  SSLCommerzStatus,
  RefundStatus,
  RefundType,
} from "@prisma/client";
import axios from "axios";
import { OrderService } from "./order.service.ts";
import { postEvent0aForConfirmedPayment, postGoodwillRefundVoucher, consumeVendorReturnsForRefund } from "./order-accounting.service.ts";
import { lockRefundableBalance, newRefundNumber, REFUND_EPSILON } from "./refund-balance.ts";
import { lockOrderForReservation, orderReservationIntact, STOCK_HOLD_AUDIT, STOCK_HOLD_REASON } from "./order-reservation.ts";
import { gatewayReportOf, reconciliationOf } from "./payment-reconciliation.ts";
import { settleVerifiedPayment, stockHoldMeta } from "./payment-settlement.ts";
import type {
  SSLCommerzInitResponse,
  SSLCommerzValidationResponse,
} from "../types/index.ts";

const prisma = new PrismaClient();
/** Test hook (same pattern as orderServiceDb / courierServiceDb): this module's own client. */
export const paymentServiceDb = prisma;

/** The currency every SSLCommerz payment is initiated in (initiatePayment sends currency: "BDT"). */
const SSLCOMMERZ_CURRENCY = "BDT";

/**
 * C1: an SSLCommerz validation response proves payment for ONE transaction.
 * Returns why `v` does not prove payment of `expected` (null = it does).
 * Fail closed — a missing field is a mismatch:
 *   - status VALID or VALIDATED (VALIDATED = this val_id was validated before;
 *     accepted only because the tran_id must still match);
 *   - tran_id is exactly the expected transaction — a valid val_id of ANY
 *     other transaction (another order, a replay) is refused;
 *   - currency and currency_type are BDT, the currency the payment was
 *     initiated in;
 *   - amount is a number that covers the expected amount (gateway charges may
 *     make it slightly higher; under-payment is refused; 0.01 rounding tolerance).
 */
export function sslcommerzValidationMismatch(
  v: Partial<SSLCommerzValidationResponse> | null | undefined,
  expected: { tranId: string; amount: unknown },
): string | null {
  if (!v || typeof v !== "object") return "no validation response";
  if (v.status !== "VALID" && v.status !== "VALIDATED") return `status is ${String(v.status ?? "missing")}`;
  if (typeof v.tran_id !== "string" || v.tran_id === "") return "tran_id is missing";
  if (!expected.tranId || v.tran_id !== expected.tranId) return `tran_id ${v.tran_id} does not match this transaction (${expected.tranId})`;
  if (v.currency !== SSLCOMMERZ_CURRENCY) return `currency is ${String(v.currency ?? "missing")}, expected ${SSLCOMMERZ_CURRENCY}`;
  if (v.currency_type !== SSLCOMMERZ_CURRENCY) return `currency_type is ${String(v.currency_type ?? "missing")}, expected ${SSLCOMMERZ_CURRENCY}`;
  const paid = typeof v.amount === "string" || typeof v.amount === "number" ? Number(v.amount) : NaN;
  const due = Number(expected.amount);
  if (!Number.isFinite(paid)) return "amount is missing";
  if (!Number.isFinite(due)) return "the expected amount is unknown";
  if (paid + 0.01 < due) return `amount ${v.amount} is less than ${due}`;
  return null;
}

const STORE_ID = process.env.SSLCOMMERZ_STORE_ID!;
const STORE_PASSWORD = process.env.SSLCOMMERZ_STORE_PASSWORD!;
const IS_LIVE = process.env.NODE_ENV === "production";

const BASE_URL = IS_LIVE
  ? "https://securepay.sslcommerz.com"
  : "https://sandbox.sslcommerz.com";

// multi_card_name key per channel — routes checkout directly to that
// gateway's UI, skipping SSLCommerz's own selection screen.
// ⚠️ NAGAD verify korte hobe sandbox e — official doc e ei key nei.
const GATEWAY_MAP: Record<string, string> = {
  BKASH: "bkash",
  NAGAD: "nagad",
  UPAY: "upay",
  EBL_COF: "visacard,mastercard,amexcard",
};

/** Phase 4 (D4): a refused delivery-fee request (ownership / eligibility / validation). */
export class DeliveryFeeError extends Error {
  readonly code = "DELIVERY_FEE_REFUSED";
  // Explicit fields (no TS parameter properties): `npm run dev` / `npx ts-node`
  // run on Node's native type stripping, which rejects parameter properties.
  readonly statusCode: 400 | 404 | 409;
  constructor(statusCode: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "DeliveryFeeError";
    this.statusCode = statusCode;
  }
}

/** Orders that can still take a delivery-fee prepayment (not shipped, not closed). */
const DELIVERY_FEE_ORDER_STATUSES: OrderStatus[] = [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.PACKAGING];

// ─── Customer payment result (the /payment/success|failed|cancelled screens) ───
// Read-only and DB-only (never asks a gateway). The redirect a gateway sends
// the customer back with is never trusted: the screen shows what is persisted.

/** What the customer-facing result screen may show — the ONE mapping, used by the API. */
export type PaymentResultState =
  | "CONFIRMED" // payment recorded and the order confirmed (or a delivery fee paid)
  | "UNAPPLIED" // Phase 5: money received but not applied (order already paid / cancelled) — recorded for review
  | "HELD" // payment recorded, the order is not confirmed yet (stock released / review)
  | "PENDING" // waiting for the gateway's verified confirmation
  | "FAILED"
  | "CANCELLED"
  | "ORDER_CANCELLED" // the order was cancelled (a paid one is refunded through the refund flow)
  | "REFUNDED";

const CONFIRMED_ORDER_STATUSES: string[] = ["CONFIRMED", "PROCESSING", "PACKAGING", "SHIPPED", "DELIVERED"];

export function paymentResultState(
  payment: { status: string; meta?: unknown },
  order: { status: string; paymentStatus: string },
  opts: { gatewayCancelled?: boolean } = {},
): PaymentResultState {
  const meta = (payment.meta ?? {}) as Record<string, unknown>;
  if (reconciliationOf(meta)) return "UNAPPLIED";
  if (payment.status === "REFUNDED" || payment.status === "PARTIALLY_REFUNDED") return "REFUNDED";
  if (payment.status === "FAILED") {
    const cancelled = opts.gatewayCancelled || !!meta.cancelReason || meta.epsOutcome === "CANCELLED" || meta.paystationOutcome === "CANCELLED";
    return cancelled ? "CANCELLED" : "FAILED";
  }
  if (payment.status !== "PAID") return order.status === "CANCELLED" ? "ORDER_CANCELLED" : "PENDING";
  if (meta.type === "delivery_fee") return "CONFIRMED"; // a fee payment never changes the order
  if (order.status === "CANCELLED" || order.status === "REFUNDED") return "ORDER_CANCELLED";
  if (order.paymentStatus === "PAID" && CONFIRMED_ORDER_STATUSES.includes(order.status)) return "CONFIRMED";
  return "HELD"; // money recorded, order not (yet) confirmed for fulfilment
}

const RESULT_PAYMENT_SELECT = {
  id: true,
  method: true,
  status: true,
  amount: true,
  paidAt: true,
  meta: true,
  order: { select: { id: true, orderNumber: true, status: true, paymentStatus: true, userId: true } },
} as const;
const TRANSACTION_ID = /^[A-Za-z0-9_-]{1,120}$/;

class PaymentService {
  // ============================================================
  // INITIATE / VALIDATE / CONFIRM
  // ============================================================

  /**
   * Initialize payment with a specific gateway channel pre-selected
   * (bKash/Nagad/Upay/card), or handled separately for COD.
   */
  async initiatePayment(params: {
    orderId: string;
    userId: string;
    gatewayCode: string;
    /** Phase 4 (D4): "delivery_fee" charges the order's shipping cost, never the order total. */
    purpose?: "order_payment" | "delivery_fee";
  }) {
    const { orderId, userId } = params;
    const purpose = params.purpose ?? "order_payment";
    const gatewayCode = params.gatewayCode.toUpperCase();
    console.log("gatewayCode received:", JSON.stringify(gatewayCode));
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        address: true,
        vendorOrders: {
          include: {
            items: {
              include: { variant: { include: { product: { select: { name: true, vendorId: true } } } } },
            },
          },
        },
      },
    });
    if (!order) throw new Error("Order not found");
    if (!order.user) throw new Error("Order has no associated user");

    const user = order.user;
    const tranId = `TXN_${Date.now()}_${orderId}`;

    // Multi-vendor split orders: SSLCommerzTransaction.vendorId is singular,
    // so we record the first vendor here. Real per-vendor settlement should
    // be driven by CommissionRecord/VendorPayable, not this field.
    const firstItem = order.vendorOrders[0]?.items[0];
    const vendorId = firstItem?.variant.product.vendorId;
    if (!vendorId) throw new Error("Vendor not found for this order");

    // Stamp which PaymentProvider row this is, so IPN/success/fail callbacks
    // verify against the gateway that actually issued this transaction —
    // not whichever gateway an admin might have made "active" since then.
    const sslcommerzProvider = await prisma.paymentProvider.findUnique({ where: { name: "SSLCOMMERZ" } });

    const chargeAmount = purpose === "delivery_fee" ? Number(order.shippingCost ?? 0) : order.totalAmount;
    const payment = await prisma.payment.create({
      data: {
        orderId,
        method: PaymentMethod.SSLCOMMERZ, // channel (bkash/nagad/card) lives in meta.gatewayCode
        amount: chargeAmount,
        status: PaymentStatus.PENDING,
        meta: { gatewayCode, type: purpose },
        paymentProviderId: sslcommerzProvider?.id,
      },
    });

    await prisma.sSLCommerzTransaction.create({
      data: {
        paymentId: payment.id,
        tranId,
        vendorId,
        customerId: userId,
        currencyCode: "BDT",
        status: SSLCommerzStatus.PENDING,
      },
    });

    const productNames = order.vendorOrders
      .flatMap((vo) => vo.items.map((i) => i.variant.product.name))
      .join(", ");

    const addr = order.address;

    const paymentData = {
      store_id: STORE_ID,
      store_passwd: STORE_PASSWORD,
      total_amount: Number(chargeAmount).toFixed(2),
      currency: "BDT",
      tran_id: tranId,
      success_url: `${process.env.BACKEND_URL}/api/payment/success`,
      fail_url: `${process.env.BACKEND_URL}/api/payment/fail`,
      cancel_url: `${process.env.BACKEND_URL}/api/payment/cancel`,
      ipn_url: `${process.env.BACKEND_URL}/api/payment/ipn`,

      cus_name: user.name || "Customer",
      cus_email: user.email || "customer@example.com",
      cus_add1: addr?.address || "Dhaka",
      cus_add2: addr?.address || "Dhaka",
      cus_city: addr?.city || "Dhaka",
      cus_state: addr?.zone || "Dhaka",
      cus_postcode: "1000",
      cus_country: addr?.country || "Bangladesh",
      cus_phone: user.phone || addr?.phone || "01700000000",

      product_name: productNames.substring(0, 250) || "E-commerce Order",
      product_category: "general",
      product_profile: "general",

      shipping_method: "YES",
      ship_name: addr?.receiverFullName || user.name || "Customer",
      ship_add1: addr?.address || "Dhaka",
      ship_add2: addr?.address || "Dhaka",
      ship_city: addr?.city || "Dhaka",
      ship_state: addr?.zone || "Dhaka",
      ship_postcode: "1000",
      ship_country: addr?.country || "Bangladesh",

      multi_card_name: GATEWAY_MAP[gatewayCode] || "",

      value_a: orderId,
      value_b: userId,
      value_c: gatewayCode,
      value_d: purpose,
    };

    try {
      console.log("multi_card_name being sent:", paymentData.multi_card_name);
      const response = await axios.post<SSLCommerzInitResponse>(
        `${BASE_URL}/gwprocess/v4/api.php`,
        new URLSearchParams(paymentData as any).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
console.log("SSLCommerz gw response:", JSON.stringify(response.data.gw, null, 2));
      if (response.data.status !== "SUCCESS") {
        throw new Error(response.data.failedreason || "Payment initiation failed");
      }

      await prisma.sSLCommerzTransaction.update({
        where: { tranId },
        data: { storeTranId: response.data.sessionkey, status: SSLCommerzStatus.INITIATED },
      });

      return {
        payment,
        sessionKey: response.data.sessionkey,
        gatewayPageURL: response.data.GatewayPageURL,
        redirectGatewayURL: response.data.redirectGatewayURL,
        transactionId: tranId,
      };
    } catch (error: any) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });
      await prisma.sSLCommerzTransaction
        .update({
          where: { tranId },
          data: {
            status: SSLCommerzStatus.FAILED,
            failedReason: error.message,
            failedAt: new Date(),
          },
        })
        .catch(() => {});
      console.error("SSLCommerz Init Error:", error.response?.data || error.message);
      throw new Error("Failed to initiate payment");
    }
  }

  /**
   * Hosted SSLCommerz session for a payment that is NOT an order (POS
   * subscriptions). Same store credentials and API as initiatePayment; the
   * caller owns its own payment record and callback routes, and must verify
   * the result with validatePayment + sslcommerzValidationMismatch before
   * trusting it. Creates no Payment / SSLCommerzTransaction rows.
   */
  async createExternalSslcommerzSession(p: {
    tranId: string;
    /** Two-decimal string, e.g. "1500.00". */
    amount: string;
    productName: string;
    /** Absolute base for success/fail/cancel/ipn, e.g. `${BACKEND_URL}/api/pos-billing/sslcommerz`. */
    callbackBase: string;
    customer: { name: string; email: string; phone: string };
    reference?: string;
  }): Promise<{ gatewayPageURL: string; sessionKey: string }> {
    const paymentData: Record<string, string> = {
      store_id: STORE_ID,
      store_passwd: STORE_PASSWORD,
      total_amount: p.amount,
      currency: SSLCOMMERZ_CURRENCY,
      tran_id: p.tranId,
      success_url: `${p.callbackBase}/success`,
      fail_url: `${p.callbackBase}/fail`,
      cancel_url: `${p.callbackBase}/cancel`,
      ipn_url: `${p.callbackBase}/ipn`,
      cus_name: p.customer.name || "Vendor",
      cus_email: p.customer.email || "vendor@example.com",
      cus_add1: "Dhaka",
      cus_city: "Dhaka",
      cus_postcode: "1000",
      cus_country: "Bangladesh",
      cus_phone: p.customer.phone || "01700000000",
      product_name: p.productName.substring(0, 250),
      product_category: "subscription",
      product_profile: "non-physical-goods",
      shipping_method: "NO",
      num_of_item: "1",
      value_a: p.reference ?? "",
      value_d: "pos_subscription",
    };
    const response = await axios.post<SSLCommerzInitResponse>(
      `${BASE_URL}/gwprocess/v4/api.php`,
      new URLSearchParams(paymentData).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    if (response.data.status !== "SUCCESS" || !response.data.GatewayPageURL) {
      throw new Error(response.data.failedreason || "Payment initiation failed");
    }
    return { gatewayPageURL: response.data.GatewayPageURL, sessionKey: response.data.sessionkey };
  }

  async validatePayment(val_id: string): Promise<SSLCommerzValidationResponse> {
    const response = await axios.get<SSLCommerzValidationResponse>(
      `${BASE_URL}/validator/api/validationserverAPI.php`,
      { params: { val_id, store_id: STORE_ID, store_passwd: STORE_PASSWORD, format: "json" } },
    );
    return response.data;
  }

  /**
   * Confirm payment after SSLCommerz validation (IPN or success callback).
   */
  async confirmPayment(tranId: string, validationData: SSLCommerzValidationResponse) {
    if (validationData.status !== "VALID" && validationData.status !== "VALIDATED") {
      throw new Error("Invalid payment status");
    }

    const txn = await prisma.sSLCommerzTransaction.findUnique({
      where: { tranId },
      include: {
        payment: {
          include: {
            order: {
              include: {
                vendorOrders: {
                  include: {
                    items: { include: { variant: { include: { product: { select: { vendorId: true } } } } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!txn) throw new Error("Transaction not found");

    // 1C-21: mirror the PayStation verifier's confirmation contract onto the
    // SSLCOMMERZ path — idempotent on already-paid, no confirmation of a
    // FAILED/CANCELLED intent, no under-payment, and no resurrection of an
    // order that moved on while this success callback was in flight
    // (SSLCommerz delivers success via BOTH the browser return_url and the
    // IPN, so duplicates and races here are the norm, not the exception).
    const currentPayment = await prisma.payment.findUnique({ where: { id: txn.paymentId } });
    if (!currentPayment) throw new Error("Payment not found for transaction");
    // C1: the gateway validation must be for THIS transaction (tran_id), in
    // BDT, covering this payment — checked before anything is read as paid or
    // written. A valid val_id of another transaction proves nothing here.
    const mismatch = sslcommerzValidationMismatch(validationData, { tranId: txn.tranId, amount: currentPayment.amount });
    if (mismatch) throw new Error(`SSLCOMMERZ validation rejected: ${mismatch}`);
    if (currentPayment.status === PaymentStatus.PAID) {
      return currentPayment; // duplicate success (callback + IPN racing) — nothing to do
    }
    // Phase 5: a verified success on a row marked FAILED (a timed-out or
    // abandoned session, a stray fail callback) is still money received — it
    // is applied or recorded below, never dropped.
    if (currentPayment.status !== PaymentStatus.PENDING && currentPayment.status !== PaymentStatus.FAILED) {
      throw new Error(`Payment is ${currentPayment.status}; cannot confirm`);
    }
    if (reconciliationOf(currentPayment.meta)) {
      return currentPayment; // already recorded as received-but-unapplied — idempotent
    }
    // (A CANCELLED order is no longer refused here: the money is recorded for
    // reconciliation below instead of being dropped.)
    // (Amount: verified above by sslcommerzValidationMismatch — fail closed.)

    // Phase 4 (D4): a delivery-fee payment is recorded on its own — it never
    // confirms the order, marks it PAID or posts Event 0a (the fee is not the
    // order total).
    if ((currentPayment.meta as any)?.type === "delivery_fee") {
      return this.applyDeliveryFeeConfirmation(tranId, txn.paymentId, validationData);
    }

    await prisma.sSLCommerzTransaction.update({
      where: { tranId },
      data: {
        valId: validationData.val_id,
        bankTranId: validationData.bank_tran_id,
        cardType: validationData.card_type,
        cardNo: validationData.card_no,
        cardIssuer: validationData.card_issuer,
        cardBrand: validationData.card_brand,
        riskLevel: validationData.risk_level,
        riskTitle: validationData.risk_title,
        paymentStatus: validationData.status,
        status: SSLCommerzStatus.SUCCESS,
        validationData: validationData as any,
        validatedAt: new Date(),
        successAt: new Date(),
      },
    });

    // Phase 6: settled under the order lock (payment-settlement.ts). Event 0a
    // is posted only for a payment that is actually applied — concurrent
    // sessions, a cancellation or a shipment landing meanwhile can no longer
    // leave a receipt behind for money that is then recorded as unapplied.
    // 1C-21: the accounting engine can still race inside its own draft
    // finalisation ("No draft entries found" / P2002) — retry briefly; the
    // winner's posted voucher makes the key exist and the retry converges.
    const orderId = txn.payment.orderId;
    const currentMeta = (currentPayment.meta as Record<string, unknown> | null) ?? {};
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await settleVerifiedPayment(prisma, {
          orderId,
          paymentId: txn.paymentId,
          amount: currentPayment.amount,
          gateway: "SSLCOMMERZ",
          gatewayRef: (validationData as any).bank_tran_id ?? (validationData as any).val_id ?? null,
          holdAuditData: { tranId },
          postEvent0a: () =>
            postEvent0aForConfirmedPayment({
              orderId,
              paymentId: txn.paymentId,
              customerId: txn.payment.order?.userId ?? undefined,
              amount: txn.payment.amount,
              paymentGatewayId: txn.payment.paymentProviderId ?? "SSLCOMMERZ",
              createdBy: "system",
            }),
          applyPayment: (tx, outcome, at) =>
            tx.payment.update({
              where: { id: txn.paymentId },
              data: { status: PaymentStatus.PAID, paidAt: at, ...(outcome === "HELD" ? { meta: { ...currentMeta, ...stockHoldMeta(at) } } : {}) },
            }),
        });
        // NOTE: real per-vendor commission/payable posting should go through
        // AccountingService (Voucher + LedgerEntry + CommissionRecord), not a
        // naive balance increment. Left out here — wire it in when that
        // service's SALES-event API is finalized.
        return prisma.payment.findUniqueOrThrow({ where: { id: txn.paymentId } });
      } catch (err: any) {
        // a racing winner may have completed the whole confirmation already
        const fresh = await prisma.payment.findUnique({ where: { id: txn.paymentId } });
        if (fresh?.status === PaymentStatus.PAID) return fresh;
        const msg = err?.message ?? "";
        if (/No draft entries found/.test(msg) || err?.code === "P2002") {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Payment confirmation failed");
  }

  /**
   * COD initialization — creates (or reuses) exactly ONE COD Payment for a
   * COD order. It NEVER changes Order.status / VendorOrder.status and never
   * touches stock: the order state stays exactly what placeOrder (risk-based
   * auto-confirm vs PENDING review) and the normal transitions established.
   * Ownership is enforced by the caller (PaymentController.createPayment →
   * resolveOrderAccess).
   */
  async handleCODOrder(orderId: string) {
    return prisma.$transaction(async (tx) => {
      // Serializes concurrent COD inits for the same order (same FOR UPDATE
      // row-lock pattern the refund paths use): the second request waits,
      // then sees the first request's committed Payment and reuses it.
      await tx.$executeRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;

      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new Error("Order not found");
      if (order.paymentmethod !== PaymentMethod.COD) {
        throw new Error(
          `COD initialization rejected: order payment method is ${order.paymentmethod}, not COD`,
        );
      }
      // Same terminal-state set the admin status/cancel rules use (1C-18).
      const terminal: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.CANCELLED, OrderStatus.REFUNDED];
      if (terminal.includes(order.status)) {
        throw new Error(`COD initialization rejected: order is ${order.status}`);
      }

      const existing = await tx.payment.findFirst({
        where: { orderId, method: PaymentMethod.COD },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!existing) {
        await tx.payment.create({
          data: {
            orderId,
            method: PaymentMethod.COD,
            amount: order.totalAmount,
            status: PaymentStatus.PENDING,
            meta: { type: "cod_order", paymentOnDelivery: true },
          },
        });
      }
      // Unchanged order (same response shape as before: { id, status, ... }).
      return order;
    });
  }

  async handleFailedPayment(tranId: string, reason?: string) {
    // 1C-14 (B12): if the payment is already PAID (a racing success callback),
    // do NOT release stock or mark FAILED — the paid state is authoritative.
    const current = await prisma.payment.findFirst({
      where: { sslCommerzDetail: { tranId } },
      select: { id: true, status: true, orderId: true, meta: true },
    });
    if (!current) throw new Error("Payment not found for transaction");
    // Phase 5: money already received (PAID, or recorded as unapplied) is never downgraded.
    if (current.status === PaymentStatus.PAID || reconciliationOf(current.meta)) {
      console.warn(`[payment-race] handleFailedPayment skipped: payment ${current.id} already PAID or recorded`);
      return prisma.payment.findUniqueOrThrow({ where: { id: current.id } });
    }

    const txn = await prisma.sSLCommerzTransaction.update({
      where: { tranId },
      data: { status: SSLCommerzStatus.FAILED, failedReason: reason, failedAt: new Date() },
    });
    // PHASE 2 BATCH 1B-1: a failed payment releases the stock reservation so
    // other customers can buy, but the ORDER STAYS PENDING (PAYMENT_PENDING —
    // the user can Pay Now again, which re-reserves). NO voucher is posted.
    const payment = await prisma.payment.findUnique({ where: { id: txn.paymentId }, select: { orderId: true } });
    if (payment) {
      // 1C-20: releaseStockForOrder skips orders that are no longer
      // PENDING/PENDING (e.g. a delayed failure IPN for an older intent after
      // a later payment succeeded) — only set the release marker when stock
      // was actually released.
      const release = await new OrderService().releaseStockForOrder(payment.orderId);
      if (!release.skipped) {
        // marker: stock no longer held; Pay Now re-reserves and clears it
        await prisma.order.update({ where: { id: payment.orderId }, data: { reservationReleasedAt: new Date() } });
      }
    }
    return prisma.payment.update({
      where: { id: txn.paymentId },
      data: { status: PaymentStatus.FAILED, meta: { failureReason: reason } },
    });
  }

  async handleCancelledPayment(tranId: string) {
    // 1C-14 (B12): same paid-state guard as handleFailedPayment.
    const current = await prisma.payment.findFirst({
      where: { sslCommerzDetail: { tranId } },
      select: { id: true, status: true, orderId: true, meta: true },
    });
    if (!current) throw new Error("Payment not found for transaction");
    // Phase 5: money already received (PAID, or recorded as unapplied) is never downgraded.
    if (current.status === PaymentStatus.PAID || reconciliationOf(current.meta)) {
      console.warn(`[payment-race] handleCancelledPayment skipped: payment ${current.id} already PAID or recorded`);
      return prisma.payment.findUniqueOrThrow({ where: { id: current.id } });
    }

    const txn = await prisma.sSLCommerzTransaction.update({
      where: { tranId },
      data: { status: SSLCommerzStatus.CANCELLED },
    });
    // PaymentStatus enum has no CANCELLED value — map to FAILED, detail in meta.
    // PHASE 2 BATCH 1B-1: release the reservation; order stays PENDING; no voucher.
    const payment = await prisma.payment.findUnique({ where: { id: txn.paymentId }, select: { orderId: true } });
    if (payment) {
      // 1C-20: same skip semantics as handleFailedPayment.
      const release = await new OrderService().releaseStockForOrder(payment.orderId);
      if (!release.skipped) {
        await prisma.order.update({ where: { id: payment.orderId }, data: { reservationReleasedAt: new Date() } });
      }
    }
    return prisma.payment.update({
      where: { id: txn.paymentId },
      data: { status: PaymentStatus.FAILED, meta: { cancelReason: "cancelled_by_customer" } },
    });
  }

  /**
   * The persisted result of ONE payment transaction, for the customer who owns
   * its order (`userId` = User id). Anyone else — and unknown or malformed
   * transaction ids — get null (the API answers 404 without saying which).
   * Looks the transaction up in every gateway's own place: SSLCommerz's table,
   * EPS's merchantTransactionId and PayStation's invoiceNumber in Payment.meta.
   */
  async getCustomerPaymentResult(transactionId: string, userId: string) {
    if (!userId || typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId)) return null;
    const txn = await prisma.sSLCommerzTransaction.findUnique({
      where: { tranId: transactionId },
      select: { status: true, payment: { select: RESULT_PAYMENT_SELECT } },
    });
    const payment =
      txn?.payment ??
      (await prisma.payment.findFirst({
        where: {
          OR: [
            { meta: { path: ["merchantTransactionId"], equals: transactionId } },
            { meta: { path: ["invoiceNumber"], equals: transactionId } },
          ],
        },
        select: RESULT_PAYMENT_SELECT,
      }));
    if (!payment?.order || payment.order.userId !== userId) return null;
    const meta = (payment.meta ?? {}) as Record<string, unknown>;
    const state = paymentResultState(payment, payment.order, { gatewayCancelled: txn?.status === SSLCommerzStatus.CANCELLED });
    return {
      transactionId,
      state,
      purpose: meta.type === "delivery_fee" ? ("delivery_fee" as const) : ("order_payment" as const),
      holdReason: state === "HELD" ? (meta.stockHold ? ("STOCK" as const) : ("REVIEW" as const)) : null,
      // Phase 5: why received money wasn't applied (ORDER_ALREADY_PAID / ORDER_CANCELLED / ORDER_NOT_PAYABLE).
      unappliedReason: state === "UNAPPLIED" ? (reconciliationOf(meta)?.reason ?? null) : null,
      // Phase 5: a fail / cancel the gateway has NOT confirmed (the payment is still PENDING).
      gatewayReport: state === "PENDING" ? (gatewayReportOf(meta)?.outcome ?? null) : null,
      amount: String(payment.amount),
      method: payment.method,
      paidAt: payment.paidAt,
      order: { id: payment.order.id, orderNumber: payment.order.orderNumber, status: payment.order.status },
    };
  }

  async getPaymentByTransactionId(tranId: string) {
    const txn = await prisma.sSLCommerzTransaction.findUnique({
      where: { tranId },
      include: { payment: { include: { order: true } } },
    });
    return txn?.payment ?? null;
  }

  async getPaymentDetails(orderId: string, opts?: { includeSensitive?: boolean }) {
    // PHASE 2 BATCH 1C-7A (D1): sensitive gateway transaction data is only
    // included for explicitly-authorized (admin) callers; customer/vendor
    // responses get the safe scalar set only.
    const includeSensitive = opts?.includeSensitive ?? true;
    if (includeSensitive) {
      return prisma.payment.findMany({
        where: { orderId },
        include: { order: true, sslCommerzDetail: true },
        orderBy: { createdAt: "desc" },
      });
    }
    return prisma.payment.findMany({
      where: { orderId },
      select: { id: true, orderId: true, amount: true, status: true, method: true, paidAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async queryTransactionStatus(tranId: string) {
    const response = await axios.get(`${BASE_URL}/validator/api/merchantTransIDvalidationAPI.php`, {
      params: { tran_id: tranId, store_id: STORE_ID, store_passwd: STORE_PASSWORD, format: "json" },
    });
    return response.data;
  }

  /**
   * Phase 5 / Step 3: what SSLCommerz itself reports for `tranId` (transaction
   * query API), used before acting on a public fail / cancel callback. Fail-
   * safe: only elements for THIS tran_id count; a VALID/VALIDATED one with a
   * val_id is a payment (verified again through the validation API by the
   * caller); FAILED / CANCELLED / EXPIRED for every element is a definitive
   * failure; anything else — an error, an unexpected shape, PENDING,
   * UNATTEMPTED — is UNVERIFIED and must not change state.
   */
  async verifiedSslcommerzOutcome(
    tranId: string,
  ): Promise<{ kind: "PAID"; valId: string } | { kind: "FAILED" } | { kind: "CANCELLED" } | { kind: "UNVERIFIED" }> {
    let data: any;
    try {
      data = await this.queryTransactionStatus(tranId);
    } catch {
      return { kind: "UNVERIFIED" };
    }
    if (data?.APIConnect !== "DONE" || !Array.isArray(data?.element)) return { kind: "UNVERIFIED" };
    const elements = data.element.filter((e: any) => e && e.tran_id === tranId);
    if (elements.length === 0) return { kind: "UNVERIFIED" };
    const statusOf = (e: any) => String(e.status ?? "").toUpperCase();
    const paid = elements.find((e: any) => ["VALID", "VALIDATED"].includes(statusOf(e)) && typeof e.val_id === "string" && e.val_id);
    if (paid) return { kind: "PAID", valId: paid.val_id };
    const statuses = elements.map(statusOf);
    if (statuses.every((s: string) => ["FAILED", "CANCELLED", "EXPIRED"].includes(s))) {
      return statuses.includes("CANCELLED") ? { kind: "CANCELLED" } : { kind: "FAILED" };
    }
    return { kind: "UNVERIFIED" };
  }

  private async validateSSLCommerzPayment(valId: string) {
    const response = await axios.get(`${BASE_URL}/validator/api/validationserverAPI.php`, {
      params: { val_id: valId, store_id: STORE_ID, store_passwd: STORE_PASSWORD, format: "json" },
    });
    return response.data as SSLCommerzValidationResponse;
  }

  /**
   * Phase 4 (D4): COD delivery-fee confirmation after the gateway redirect.
   * The caller is the authenticated customer (requesterId, server-side); the
   * transaction must belong to their order and be a delivery-fee payment, and
   * the gateway validation must be for THIS transaction and cover its amount.
   * The order's status is never changed (the old version set CONFIRMED,
   * bypassing fraud review and reviving cancelled orders).
   */
  async confirmDeliveryFeePayment(tranId: string, valId: string, requesterId: string) {
    const txn = await prisma.sSLCommerzTransaction.findUnique({
      where: { tranId },
      include: {
        payment: {
          select: { id: true, amount: true, status: true, meta: true, order: { select: { userId: true } } },
        },
      },
    });
    if (!txn?.payment?.order?.userId || txn.payment.order.userId !== requesterId) {
      throw new DeliveryFeeError(404, "Transaction not found");
    }
    if ((txn.payment.meta as any)?.type !== "delivery_fee") {
      throw new DeliveryFeeError(409, "This transaction is not a delivery-fee payment");
    }
    if (txn.payment.status === PaymentStatus.PAID) {
      return prisma.payment.findUniqueOrThrow({ where: { id: txn.payment.id } }); // idempotent
    }
    if (txn.payment.status !== PaymentStatus.PENDING) {
      throw new DeliveryFeeError(409, `Payment is ${txn.payment.status}; cannot confirm`);
    }

    const validation = await this.validateSSLCommerzPayment(valId);
    if (validation.status !== "VALID" && validation.status !== "VALIDATED") {
      throw new DeliveryFeeError(400, "Payment validation failed");
    }
    if (validation.tran_id !== tranId) {
      throw new DeliveryFeeError(400, "Payment validation does not match this transaction");
    }
    const validatedAmount = Number(validation.amount);
    if (!Number.isFinite(validatedAmount) || validatedAmount + 0.01 < Number(txn.payment.amount)) {
      throw new DeliveryFeeError(400, "Payment amount does not cover the delivery fee");
    }
    return this.applyDeliveryFeeConfirmation(tranId, txn.payment.id, validation);
  }

  /**
   * Phase 4 (D4): records a verified delivery-fee payment exactly once (guarded
   * on PENDING). Never touches Order.status / paymentStatus or accounting.
   */
  async applyDeliveryFeeConfirmation(tranId: string, paymentId: string, validation: SSLCommerzValidationResponse) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.PAID, paidAt: new Date() },
      });
      if (claimed.count !== 1) return; // duplicate callback — already recorded
      await tx.sSLCommerzTransaction.update({
        where: { tranId },
        data: {
          valId: validation.val_id,
          status: SSLCommerzStatus.SUCCESS,
          validationData: validation as any,
          validatedAt: new Date(),
        },
      });
    });
    return prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  }

  /**
   * Phase 4 (D4): COD delivery-fee prepayment. Identity and amount are
   * server-side: the requester must own the order, the order must be a
   * cash-on-delivery order that is not yet shipped / closed, the fee is the
   * order's own shipping cost, and an already-paid fee is never charged again.
   */
  async processDeliveryFeePayment(orderId: string, requesterId: string, gatewayCode = "BKASH") {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, paymentmethod: true, status: true, shippingCost: true },
    });
    if (!order?.userId || order.userId !== requesterId) throw new DeliveryFeeError(404, "Order not found");
    if (order.paymentmethod !== PaymentMethod.COD) {
      throw new DeliveryFeeError(409, "Delivery-fee prepayment is only available for cash-on-delivery orders");
    }
    if (!DELIVERY_FEE_ORDER_STATUSES.includes(order.status)) {
      throw new DeliveryFeeError(409, "This order can no longer take a delivery-fee payment");
    }
    if (!(Number(order.shippingCost) > 0)) {
      throw new DeliveryFeeError(409, "This order has no delivery fee to pay");
    }
    const alreadyPaid = await prisma.payment.findFirst({
      where: { orderId, status: PaymentStatus.PAID, meta: { path: ["type"], equals: "delivery_fee" } },
      select: { id: true },
    });
    if (alreadyPaid) throw new DeliveryFeeError(409, "The delivery fee for this order is already paid");

    const sslResponse = await this.initiatePayment({ orderId, userId: order.userId, gatewayCode, purpose: "delivery_fee" });
    return { payment: sslResponse.payment, sslResponse };
  }

  // ============================================================
  // REFUND — GATEWAY EXECUTION LAYER ONLY
  // Policy decisions (approve/reject, physical-return gating) live
  // in AdminOrderService. This service only:
  //   1) creates the initial PENDING refund request record
  //   2) executes an APPROVED refund against SSLCommerz
  //   3) marks a goodwill refund complete without a gateway call
  // AdminOrderService calls (2)/(3) after its own approval checks.
  // ============================================================

  /**
   * Step 1: create a PENDING refund request (customer/vendor/admin
   * initiated). Does NOT call SSLCommerz and does NOT approve anything.
   */
  async requestRefund(params: {
    orderId: string;
    refundAmount: number;
    refundReason: string;
    initiatedBy: string;
    refundType: RefundType;
  }) {
    const { orderId, refundAmount, refundReason, initiatedBy, refundType } = params;

    const payment = await prisma.payment.findFirst({
      where: { orderId, status: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] } },
      include: { sslCommerzDetail: true },
    });
    if (!payment) throw new Error("No paid payment found for this order to refund");

    const originalAmount = Number(payment.amount);
    if (refundAmount > originalAmount) throw new Error("Refund amount exceeds original payment");

    // PHASE 2 BATCH 1C-3A (H1): transaction-safe cumulative refund guard.
    // FOR UPDATE on the payment row serializes concurrent refund requests for
    // the same order; the sum counts only refunds that actually consume the
    // refundable balance (FAILED / REJECTED / CANCELLED are excluded).
    const txn = payment.sslCommerzDetail; // used below by the refund-record creation
    // Phase 4 (H-2): the Refund and its RefundRecord are created in ONE
    // transaction, under the payment-row lock every refund writer shares
    // (lockRefundableBalance) — a failure can no longer leave a Refund with no
    // record that consumes the balance but can never be approved, and the
    // refund number no longer collides within one millisecond.
    const { refund, detail } = await prisma.$transaction(async (tx) => {
      const { remaining } = await lockRefundableBalance(tx, payment, orderId);
      if (refundAmount > remaining + REFUND_EPSILON) {
        throw new Error(
          `Refund amount exceeds remaining refundable balance: requested ${refundAmount}, remaining ${remaining.toFixed(2)}`,
        );
      }
      const refund = await tx.refund.create({
        data: { orderId, amount: refundAmount, reason: refundReason, status: RefundStatus.PENDING },
      });
      const detail = await tx.refundRecord.create({
        data: {
          refundId: refund.id,
          refundNumber: newRefundNumber(),
          sslTranId: txn?.tranId ?? null,
          vendorId: txn?.vendorId ?? "UNKNOWN",
          customerId: txn?.customerId ?? "",
          refundType,
          originalAmount,
          refundAmount,
          refundReason,
          status: RefundStatus.PENDING,
          initiatedBy,
        },
      });
      return { refund, detail };
    });
    return { refund, detail };
  }

  /**
   * Step 3 (non-goodwill): an already-APPROVED refund gets executed
   * against SSLCommerz. Called by AdminOrderService right after it
   * sets Refund.status = APPROVED.
   */
  async processApprovedRefund(refundId: string) {
    const refund = await prisma.refund.findUnique({
      where: { id: refundId },
      include: { detail: true },
    });
    if (!refund || !refund.detail) throw new Error("Refund not found");
    if (refund.detail.status !== RefundStatus.APPROVED) {
      throw new Error("Only approved refunds can be processed");
    }
    // PHASE 2 BATCH 1C-4 (I1): COD refunds complete WITHOUT a gateway — the
    // customer paid cash on delivery; the platform refunds via a manual
    // non-gateway channel. No SSLCommerz transaction is required or faked.
    // Accounting: Event 3/4 via the shared order-accounting function; the
    // refund credit lands on the existing refund-payable account abstraction.
    const codPayment = await prisma.payment.findFirst({
      where: { orderId: refund.orderId, method: PaymentMethod.COD, status: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] } },
      select: { id: true, method: true, status: true },
    });
    if (codPayment) {
      await prisma.refundRecord.update({ where: { refundId }, data: { status: RefundStatus.PROCESSING } });
      // 1C-5D: consume unconsumed CONFIRMED VendorReturns (claim is
      // FOR UPDATE-serialized; already-consumed returns are skipped) and post
      // one idempotent per-return Event 3/4 voucher each.
      await consumeVendorReturnsForRefund({
        orderId: refund.orderId,
        refundId,
        paymentMethod: "COD",
        refundAmount: refund.detail.refundAmount,
      });
      // PHASE 2 BATCH 1C-5D: full-vs-partial is CUMULATIVE across every
      // consuming refund (H1 status set — FAILED/REJECTED/CANCELLED excluded),
      // not this refund alone: 600 + 400 partials complete a 1000 payment.
      // The FOR UPDATE on the payment row makes the read+write atomic against
      // concurrent refund completions (last writer always sees the full sum).
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT "id" FROM "payments" WHERE "id" = ${codPayment.id} FOR UPDATE`;
        const consumedAgg = await tx.refund.aggregate({
          where: {
            orderId: refund.orderId,
            status: { in: [RefundStatus.PENDING, RefundStatus.APPROVED, RefundStatus.PROCESSING, RefundStatus.REFUNDED] },
          },
          _sum: { amount: true },
        });
        const isFull =
          Number(consumedAgg._sum.amount ?? 0) + 0.005 >= Number(refund.detail.originalAmount);
        await tx.refundRecord.update({ where: { refundId }, data: { status: RefundStatus.REFUNDED, completedAt: new Date() } });
        await tx.refund.update({ where: { id: refundId }, data: { status: RefundStatus.REFUNDED, processedAt: new Date() } });
        await tx.payment.update({ where: { id: codPayment.id }, data: { status: isFull ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED } });
      });
      return { COD: true };
    }

    if (!refund.detail.sslTranId) {
      throw new Error("No SSLCommerz transaction linked — use completeGoodwillRefund for non-gateway refunds");
    }

    await prisma.refundRecord.update({ where: { refundId }, data: { status: RefundStatus.PROCESSING } });

    const txn = await prisma.sSLCommerzTransaction.findUnique({ where: { tranId: refund.detail.sslTranId } });
    if (!txn?.bankTranId) throw new Error("Bank transaction ID not found");

    // PHASE 2 BATCH 1C-4 (I1 follow-up): gateway outcome classification.
    //   Definitive rejection (gateway returned an HTTP response with a
    //   non-success status) → RefundRecord + Refund → FAILED, H1 releases
    //   the amount. Unknown outcome (network error / timeout, no HTTP
    //   response) → refund stays PROCESSING; the amount remains reserved
    //   under H1 until reconciliation resolves the outcome.
    let gatewayResult: { status: string; errorReason?: string; refund_ref_id?: string };
    try {
      const response = await axios.get(`${BASE_URL}/validator/api/merchantTransIDvalidationAPI.php`, {
        params: {
          bank_tran_id: txn.bankTranId,
          refund_trans_id: refund.detail.refundNumber,
          refund_amount: Number(refund.detail.refundAmount),
          refund_remarks: refund.detail.refundReason,
          store_id: STORE_ID,
          store_passwd: STORE_PASSWORD,
          format: "json",
        },
      });
      gatewayResult = response.data;
    } catch (gatewayErr: any) {
      // HTTP-level failure — distinguish definitive rejection from unknown
      const gatewaySawIt = gatewayErr?.response?.data != null;
      if (gatewaySawIt && gatewayErr.response.data?.status != null && gatewayErr.response.data.status !== "success") {
        // Gateway definitively rejected the refund
        await prisma.$transaction([
          prisma.refundRecord.update({
            where: { refundId },
            data: {
              status: RefundStatus.FAILED,
              failedReason: gatewayErr.response.data?.errorReason || "Gateway rejected refund",
              failedAt: new Date(),
            },
          }),
          prisma.refund.update({
            where: { id: refundId },
            data: { status: RefundStatus.FAILED, processedAt: new Date() },
          }),
        ]);
        throw new Error(
          `Gateway refund definitively rejected: ${gatewayErr.response.data?.errorReason || "unknown reason"} — amount released back to refundable balance`,
        );
      }
      // Network error / timeout — unknown outcome, keep PROCESSING
      throw new Error(
        "Gateway refund outcome unknown (network/timeout) — refund remains PROCESSING for reconciliation; do NOT retry without querying the gateway first",
      );
    }

    if (gatewayResult.status !== "success") {
      // Gateway responded but definitively rejected
      await prisma.$transaction([
        prisma.refundRecord.update({
          where: { refundId },
          data: {
            status: RefundStatus.FAILED,
            failedReason: gatewayResult.errorReason || "Gateway rejected refund",
            failedAt: new Date(),
          },
        }),
        prisma.refund.update({
          where: { id: refundId },
          data: { status: RefundStatus.FAILED, processedAt: new Date() },
        }),
      ]);
      throw new Error(
        `Gateway refund definitively rejected: ${gatewayResult.errorReason || "unknown"} — amount released back to refundable balance`,
      );
    }

    // PHASE 2 BATCH 1C-5D: cumulative full-vs-partial (see COD branch), computed
    // INSIDE the payment-row FOR UPDATE transaction so concurrent refund
    // completions always finalize against the full committed sum.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT "id" FROM "payments" WHERE "id" = ${txn.paymentId} FOR UPDATE`;
      const consumedAgg = await tx.refund.aggregate({
        where: {
          orderId: refund.orderId,
          status: { in: [RefundStatus.PENDING, RefundStatus.APPROVED, RefundStatus.PROCESSING, RefundStatus.REFUNDED] },
        },
        _sum: { amount: true },
      });
      const isPartial =
        !(Number(consumedAgg._sum.amount ?? 0) + 0.005 >= Number(refund.detail.originalAmount));
      await tx.refundRecord.update({
        where: { refundId },
        data: {
          status: RefundStatus.REFUNDED,
          sslRefundRefId: gatewayResult.refund_ref_id,
          sslRefundStatus: gatewayResult.status,
          completedAt: new Date(),
        },
      });
      await tx.refund.update({
        where: { id: refundId },
        data: { status: RefundStatus.REFUNDED, processedAt: new Date() },
      });
      await tx.sSLCommerzTransaction.update({
        where: { tranId: refund.detail.sslTranId! },
        data: {
          isRefunded: true,
          refundAmount: refund.detail.refundAmount,
          refundReason: refund.detail.refundReason,
          refundedAt: new Date(),
          sslRefundRefId: gatewayResult.refund_ref_id,
          status: SSLCommerzStatus.REFUNDED,
        },
      });
      await tx.payment.update({
        where: { id: txn.paymentId },
        data: { status: isPartial ? PaymentStatus.PARTIALLY_REFUNDED : PaymentStatus.REFUNDED },
      });
    });

      // PHASE 2 BATCH 1C-2: Event 3 (full) / 4 (partial) on gateway refund.
      // 1C-5D: consumption + per-return idempotent vouchers via the shared
      // helper (unconsumed CONFIRMED VendorReturns only).
      const orderForVoucher = await prisma.order.findUnique({
        where: { id: refund.orderId },
        select: { paymentmethod: true },
      });
      if (orderForVoucher) {
        await consumeVendorReturnsForRefund({
          orderId: refund.orderId,
          refundId,
          paymentMethod: orderForVoucher.paymentmethod === PaymentMethod.COD ? "COD" : "ONLINE",
          refundAmount: refund.amount,
        });
      }
      // (Voucher + LedgerEntry + CommissionRecord reversal + VendorPayable adjustment)
    }

  /**
   * Step 3 (goodwill): approved goodwill refund — no gateway call,
   * platform absorbs the cost. Marks REFUNDED directly.
   */
  async completeGoodwillRefund(refundId: string) {
    const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: { detail: true } });
    if (!refund || !refund.detail) throw new Error("Refund not found");
    if (refund.detail.status !== RefundStatus.APPROVED) {
      throw new Error("Only approved refunds can be completed");
    }

    await prisma.$transaction([
      prisma.refundRecord.update({
        where: { refundId },
        data: { status: RefundStatus.REFUNDED, completedAt: new Date() },
      }),
      prisma.refund.update({
        where: { id: refundId },
        data: { status: RefundStatus.REFUNDED, processedAt: new Date() },
      }),
    ]);

    // PHASE 2 BATCH 1C-2: Event 5 — goodwill (platform expense, no vendor entry).
    await postGoodwillRefundVoucher({
      orderId: refund.orderId, refundId: refund.id, amount: refund.amount,
      refundMethod: "WALLET",
    });

    return { success: true };
  }

  async queryRefundStatus(refundId: string) {
    const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: { detail: true } });
    if (!refund?.detail?.sslRefundRefId) {
      return { source: "internal", status: refund?.status ?? "NOT_FOUND" };
    }
    const response = await axios.get(`${BASE_URL}/validator/api/merchantTransIDvalidationAPI.php`, {
      params: { refund_ref_id: refund.detail.sslRefundRefId, store_id: STORE_ID, store_passwd: STORE_PASSWORD, format: "json" },
    });
    return { source: "sslcommerz", internal: refund, gateway: response.data };
  }

  async getRefundById(refundId: string) {
    return prisma.refund.findUnique({ where: { id: refundId }, include: { detail: true, order: true } });
  }

  async getRefundsByOrder(orderId: string) {
    return prisma.refund.findMany({ where: { orderId }, include: { detail: true }, orderBy: { createdAt: "desc" } });
  }
}

export const paymentService = new PaymentService();