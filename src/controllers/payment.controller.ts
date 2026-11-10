// controllers/payment.controller.ts
import type { Request, Response } from "express";
import { paymentService, DeliveryFeeError } from "../services/payment.service.ts";
import { paymentGatewayService } from "../services/payment-gateway.service.ts";
import { prisma } from "../config/prisma.ts";
import { openOrderGatewaySession, PayNowError } from "../services/pay-now.service.ts";

// PHASE 2 BATCH 1C-7A (D4): refund request enum whitelist (mirrors the
// RefundType prisma enum; the admin controller keeps its own copy).
const VALID_REFUND_TYPES = [
  "FULL_REFUND",
  "PARTIAL_REFUND",
  "CHARGEBACK",
  "CUSTOMER_INITIATED",
  "VENDOR_INITIATED",
  "ADMIN_INITIATED",
];

// PHASE 2 BATCH 1C-7A (D1/D2/D4/D5): ownership is resolved from the
// authenticated identity plus DB relationships — ids coming from the client
// are never trusted. ADMIN/EMPLOYEE keep their established access; CUSTOMER
// must own the order; VENDOR must own a vendor-order slice of it.
async function resolveOrderAccess(orderId: string, user: any) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, vendorOrders: { select: { vendorId: true } } },
  });
  if (!order) return { ok: false as const, code: 404 as const, message: "Order not found" };
  const role = String(user?.role ?? "").toUpperCase();
  const isAdmin = role === "ADMIN" || role === "EMPLOYEE";
  const isCustomerOwner = role === "CUSTOMER" && !!order.userId && order.userId === user?.rawId;
  const isVendorOnOrder = role === "VENDOR" && !!user?.vendorId && order.vendorOrders.some((vo) => vo.vendorId === user.vendorId);
  if (!isAdmin && !isCustomerOwner && !isVendorOnOrder) {
    return { ok: false as const, code: 403 as const, message: "Access denied" };
  }
  return { ok: true as const, isAdmin, isCustomerOwner, isVendorOnOrder };
}

export class PaymentController {
  /**
   * Which gateway the storefront should show/use right now — public,
   * no credentials in the response.
   */
  static async getActiveGateway(req: Request, res: Response) {
    try {
      const provider = await paymentGatewayService.getActiveGatewayPublicInfo();
      res.json({ success: true, data: provider });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Initialize payment. Dispatches to whichever gateway an admin has
   * activated (SSLCommerz, EPS, PayStation, ...) — see payment-gateway.service.ts.
   */
  static async createPayment(req: Request, res: Response) {
    try {
      // Phase 5 / Step 4: a body `userId` is ignored — the gateway gets the
      // order's own customer (openOrderGatewaySession), never a supplied id.
      const { orderId, gatewayCode } = req.body ?? {};

      // 1C-14 (B13): verify the authenticated user owns the order before
      // initializing payment. Admin/employee bypass for operational flows.
      const access = await resolveOrderAccess(orderId, (req as any).user);
      if (!access.ok) return res.status(access.code).json({ success: false, message: access.message });

      if (gatewayCode === "COD") {
        const result = await paymentService.handleCODOrder(orderId);
        return res.json({
          success: true,
          message: "Order confirmed with Cash on Delivery",
          data: result,
        });
      }

      // Online payment only for an order that is still awaiting it (never a
      // confirmed, cancelled or already-paid order), and — Phase 5 — through
      // the same order lock + duplicate-session window as Pay Now, so checkout
      // retries and Pay Now can't open two live gateway sessions at once.
      let paymentResponse;
      try {
        paymentResponse = await openOrderGatewaySession({
          orderId,
          gatewayCode: typeof gatewayCode === "string" ? gatewayCode : "",
          ownerId: null, // authorised above (owner, or admin/employee/vendor-on-order)
          rejectCod: false,
          requireReservation: false,
          requireHttps: false,
        });
      } catch (e) {
        if (e instanceof PayNowError) {
          return res.status(e.statusCode).json({
            success: false,
            code: e.code,
            message: e.message,
            ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
          });
        }
        throw e;
      }

      res.json({
        success: true,
        data: {
          gatewayPageURL: paymentResponse.gatewayPageURL,
          sessionKey: paymentResponse.sessionKey,
          transactionId: paymentResponse.transactionId,
        },
      });
    } catch (error: any) {
      console.error("Create Payment Error:", error);
      res.status(500).json({ success: false, message: error.message || "Payment initiation failed" });
    }
  }

  /**
   * IPN Listener — most reliable confirmation path (server-to-server,
   * independent of the customer's browser session). Works for whichever
   * gateway actually issued this specific transaction id, regardless of
   * which gateway is active right now.
   *
   *   SSLCommerz: form body  { val_id, tran_id, status, amount }
   *   EPS:        { merchantTransactionId }
   *   PayStation: JSON body  { invoice_number, trx_status, trx_id, trx_amount, ... }
   *
   * The payload is treated as untrusted: it only tells us WHICH transaction
   * to look at. Every gateway path re-verifies with the gateway's own API
   * before marking anything paid, and is idempotent (gateways retry IPNs).
   */
  static async ipn(req: Request, res: Response) {
    try {
      const { val_id, tran_id, merchantTransactionId, invoice_number, status, trx_status, amount, trx_amount } = req.body ?? {};
      const transactionId = tran_id || merchantTransactionId || invoice_number;
      console.log("IPN Received:", { val_id, transactionId, status: status ?? trx_status, amount: amount ?? trx_amount });

      if (!transactionId) {
        return res.status(400).send("Missing transaction identifier");
      }

      await paymentGatewayService.verifyAndConfirmByTransactionId(String(transactionId), { valId: val_id });
      res.status(200).json({ status: "success" });
    } catch (error: any) {
      console.error("IPN Processing Error:", error);
      res.status(400).send(error.message || "IPN processing failed");
    }
  }

  /**
   * PayStation return URL (callback_url). PayStation uses ONE callback for
   * every outcome, so we always verify with their transaction-status API
   * and pick the redirect from the verified result. Any `status` param on the
   * callback is only a hint for failed-vs-cancelled, never proof of payment.
   * Accepts GET (query-string redirect) and POST (form/JSON).
   */
  static async paystationCallback(req: Request, res: Response) {
    const frontend = process.env.FRONTEND_URL;
    try {
      const params = { ...(req.query ?? {}), ...(req.body ?? {}) } as Record<string, unknown>;
      // Log the raw callback in sandbox once to confirm the exact parameter names PayStation sends.
      console.log("PayStation callback:", params);

      const invoiceNumber = String(params.invoice_number ?? params.invoiceNumber ?? "");
      const hint = String(params.status ?? "");
      if (!invoiceNumber) return res.redirect(`${frontend}/payment/failed`);

      const outcome = await paymentGatewayService.handlePaystationCallback(invoiceNumber, hint);

      switch (outcome) {
        case "success":
          return res.redirect(`${frontend}/payment/success?tran_id=${encodeURIComponent(invoiceNumber)}`);
        case "cancelled":
          return res.redirect(`${frontend}/payment/cancelled?tran_id=${encodeURIComponent(invoiceNumber)}`);
        default:
          // "failed" or still "pending" (customer left before completing) — payment stays retryable server-side.
          return res.redirect(`${frontend}/payment/failed?tran_id=${encodeURIComponent(invoiceNumber)}`);
      }
    } catch (error) {
      console.error("PayStation Callback Error:", error);
      res.redirect(`${frontend}/payment/failed`);
    }
  }

  static async success(req: Request, res: Response) {
    try {
      // SSLCommerz posts tran_id in the body; EPS returns to successUrl
      // with query-string data instead (per their "Additional instruction"
      // note) — accept either.
      const val_id = req.body?.val_id;
      const transactionId = req.body?.tran_id || req.query?.merchantTransactionId || req.query?.tran_id;

      if (!transactionId) {
        return res.redirect(`${process.env.FRONTEND_URL}/payment/failed`);
      }

      await paymentGatewayService.verifyAndConfirmByTransactionId(String(transactionId), { valId: val_id });

      res.redirect(`${process.env.FRONTEND_URL}/payment/success?tran_id=${transactionId}`);
    } catch (error) {
      console.error("Success Handler Error:", error);
      res.redirect(`${process.env.FRONTEND_URL}/payment/failed`);
    }
  }

  static async fail(req: Request, res: Response) {
    try {
      const transactionId = req.body?.tran_id || req.query?.merchantTransactionId;
      await paymentGatewayService.markFailedOrCancelled(String(transactionId), "FAILED");
      res.redirect(`${process.env.FRONTEND_URL}/payment/failed?tran_id=${transactionId}`);
    } catch (error) {
      console.error("Fail Handler Error:", error);
      res.redirect(`${process.env.FRONTEND_URL}/payment/failed`);
    }
  }

  static async cancel(req: Request, res: Response) {
    try {
      const transactionId = req.body?.tran_id || req.query?.merchantTransactionId;
      await paymentGatewayService.markFailedOrCancelled(String(transactionId), "CANCELLED");
      res.redirect(`${process.env.FRONTEND_URL}/payment/cancelled?tran_id=${transactionId}`);
    } catch (error) {
      console.error("Cancel Handler Error:", error);
      res.redirect(`${process.env.FRONTEND_URL}/payment/cancelled`);
    }
  }

  /**
   * The customer's payment result screen (/payment/success|failed|cancelled).
   * Only the order's own customer gets an answer; an unknown transaction and
   * someone else's transaction look the same (404). DB-only, never cached.
   */
  static async getPaymentResult(req: Request, res: Response) {
    res.setHeader("Cache-Control", "no-store");
    try {
      const user = (req as any).user;
      if (!user?.rawId) return res.status(401).json({ success: false, message: "Unauthorized" });
      const result = await paymentService.getCustomerPaymentResult(String(req.params.transactionId ?? ""), user.rawId);
      if (!result) return res.status(404).json({ success: false, message: "Payment not found" });
      return res.json({ success: true, data: result });
    } catch (error: any) {
      console.error("Get Payment Result Error:", error);
      return res.status(500).json({ success: false, message: "Could not load the payment result" });
    }
  }

  static async getPaymentStatus(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ success: false, message: "Unauthorized" });
      const { orderId } = req.params;
      // PHASE 2 BATCH 1C-7A (D1): authorize BEFORE returning payment data.
      const access = await resolveOrderAccess(orderId, user);
      if (!access.ok) return res.status(access.code).json({ success: false, message: access.message });
      if (access.isAdmin) {
        const payments = await paymentService.getPaymentDetails(orderId);
        return res.json({ success: true, data: payments });
      }
      // customer/vendor: own-order only, sensitive SSLCommerz transaction data stripped
      const payments = await paymentService.getPaymentDetails(orderId, { includeSensitive: false });
      return res.json({ success: true, data: payments });
    } catch (error: any) {
      console.error("Get Payment Status Error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to get payment status" });
    }
  }

  static async getTransactionDetails(req: Request, res: Response) {
    try {
      const { transactionId } = req.params;
      const details = await paymentService.queryTransactionStatus(transactionId);
      res.json({ success: true, data: details });
    } catch (error: any) {
      console.error("Get Transaction Details Error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to get transaction details" });
    }
  }

  static async processDeliveryFee(req: Request, res: Response) {
    try {
      // Phase 4 (D4): identity and amount are server-side — a body `userId` or
      // `amount` is ignored; the service checks ownership and eligibility.
      const { orderId, gatewayCode } = req.body ?? {};
      if (typeof orderId !== "string" || !orderId) {
        return res.status(400).json({ success: false, message: "orderId is required" });
      }
      const requesterId = (req as any).user?.rawId ?? (req as any).user?.id;
      const result = await paymentService.processDeliveryFeePayment(
        orderId,
        requesterId,
        typeof gatewayCode === "string" && gatewayCode ? gatewayCode : undefined,
      );
      res.json({ success: true, data: result });
    } catch (error: any) {
      if (error instanceof DeliveryFeeError) {
        return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
      }
      console.error("Process Delivery Fee Error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to process delivery fee" });
    }
  }

  static async confirmDeliveryFee(req: Request, res: Response) {
    try {
      const { tranId, valId } = req.body ?? {};
      if (typeof tranId !== "string" || !tranId || typeof valId !== "string" || !valId) {
        return res.status(400).json({ success: false, message: "tranId and valId are required" });
      }
      // Phase 4 (D4): only the order's owner can confirm its delivery fee.
      const requesterId = (req as any).user?.rawId ?? (req as any).user?.id;
      const result = await paymentService.confirmDeliveryFeePayment(tranId, valId, requesterId);
      res.json({ success: true, data: result });
    } catch (error: any) {
      if (error instanceof DeliveryFeeError) {
        return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
      }
      console.error("Confirm Delivery Fee Error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to confirm delivery fee" });
    }
  }

  // ==========================================================
  // REFUND — customer/vendor-facing REQUEST only.
  // Approve/reject/execute is an admin action — see
  // AdminOrderController (approveRefund/rejectRefund), which
  // internally delegates gateway execution back to paymentService.
  // ==========================================================

  static async requestRefund(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ success: false, message: "Unauthorized" });
      const { orderId, refundAmount, refundReason, refundType } = req.body;
      // PHASE 2 BATCH 1C-7A (D4): strict validation — malformed numerics
      // (NaN/Infinity) must be rejected cleanly, never reach Prisma.
      if (!orderId || typeof orderId !== "string") {
        return res.status(400).json({ success: false, message: "orderId is required" });
      }
      const parsedAmount = typeof refundAmount === "string" ? parseFloat(refundAmount) : Number(refundAmount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ success: false, message: "A valid positive refund amount is required" });
      }
      if (!refundReason || String(refundReason).trim().length === 0) {
        return res.status(400).json({ success: false, message: "Refund reason is required" });
      }
      if (!refundType || !VALID_REFUND_TYPES.includes(refundType)) {
        return res.status(400).json({ success: false, message: `refundType must be one of: ${VALID_REFUND_TYPES.join(", ")}` });
      }
      // ownership: customer → own order; vendor → own vendor-order slice; admin/employee → established flow
      const access = await resolveOrderAccess(orderId, user);
      if (!access.ok) return res.status(access.code).json({ success: false, message: access.message });

      const result = await paymentService.requestRefund({
        orderId,
        refundAmount: parsedAmount,
        refundReason: String(refundReason).trim(),
        initiatedBy: user.id, // ⚠️ adjust to your auth middleware's user shape
        refundType,
      });
      res.json({ success: true, data: result, message: "Refund requested, pending admin approval" });
    } catch (error: any) {
      console.error("Request Refund Error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to request refund" });
    }
  }

  static async queryRefundStatus(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ success: false, message: "Unauthorized" });
      const { refundId } = req.params;
      // PHASE 2 BATCH 1C-7A (D5): authorize BEFORE any live gateway query —
      // an unauthorized caller must never be able to trigger outbound calls.
      const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: { id: true, order: { select: { userId: true, vendorOrders: { select: { vendorId: true } } } } },
      });
      if (!refund) return res.status(404).json({ success: false, message: "Refund not found" });
      const role = String(user?.role ?? "").toUpperCase();
      const isAdmin = role === "ADMIN" || role === "EMPLOYEE";
      const isOwner = role === "CUSTOMER" && !!refund.order.userId && refund.order.userId === user?.rawId;
      const isVendor = role === "VENDOR" && !!user?.vendorId && refund.order.vendorOrders.some((vo: any) => vo.vendorId === user.vendorId);
      if (!isAdmin && !isOwner && !isVendor) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      const result = await paymentService.queryRefundStatus(refundId);
      res.json({ success: true, data: result });
    } catch (error: any) {
      console.error("Query Refund Status Error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to query refund status" });
    }
  }

  static async getRefundsByOrder(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ success: false, message: "Unauthorized" });
      const { orderId } = req.params;
      // PHASE 2 BATCH 1C-7A (D2): refund history is order-ownership scoped.
      const access = await resolveOrderAccess(orderId, user);
      if (!access.ok) return res.status(access.code).json({ success: false, message: access.message });
      const result = await paymentService.getRefundsByOrder(orderId);
      res.json({ success: true, data: result });
    } catch (error: any) {
      console.error("Get Refunds By Order Error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to get refunds" });
    }
  }
}