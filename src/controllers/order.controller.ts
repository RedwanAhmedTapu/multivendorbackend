import type { Request, Response } from "express";
import { OrderService, CheckoutChangedError, QuoteRequiredError, CourierBookingActiveError } from "../services/order.service.ts";
import { startPayNow, PayNowError } from "../services/pay-now.service.ts";
import { analyticsRecorder, trackAnalytics } from "../modules/analytics/analytics.recorder.ts";
import { analyticsContext } from "../modules/analytics/analytics.context.ts";
import { classifyCheckoutFailure } from "../modules/analytics/analytics.contract.ts";

const orderService = new OrderService();

export class OrderController {
  /**
   * POST /orders
   * Body: { userAddressId: string }
   */
  async placeOrder(req: Request, res: Response) {
    try {
      const userId = req.user.rawId || req.user!.id;
      const { userAddressId, paymentMethod } = req.body;

      if (!userAddressId) {
        return res
          .status(400)
          .json({ success: false, error: "userAddressId is required" });
      }
      const validMethods = [
        "COD",
        "SSLCOMMERZ",
        "EPS",
        "BKASH",
        "NAGAD",
        "ROCKET",
        "WALLET",
        "BANK_TRANSFER",
      ];
      if (!paymentMethod || !validMethods.includes(paymentMethod)) {
        return res
          .status(400)
          .json({
            success: false,
            error: `paymentMethod must be one of: ${validMethods.join(", ")}`,
          });
      }

      // Phase 2 (H-3): only the reviewed quote's hash and the customer's
      // acknowledgment are taken from the request — never amounts.
      const { quoteHash, acknowledgePriceChanges } = req.body;
      const order = await orderService.placeOrder(
        userId,
        userAddressId,
        paymentMethod,
        {
          quoteHash: typeof quoteHash === "string" ? quoteHash : undefined,
          acknowledgePriceChanges: acknowledgePriceChanges === true,
        },
      );
      // Business Advisor: the committed order is the authoritative "order placed" (never awaited).
      const octx = analyticsContext(req as any);
      if (octx) trackAnalytics(analyticsRecorder.orderPlaced(octx, order as any));
      return res.status(201).json({ success: true, data: order });
    } catch (error: any) {
      // Business Advisor: categorised failure (the message itself is never stored).
      const fctx = analyticsContext(req as any);
      const failedUserId = (req as any).user?.rawId || (req as any).user?.id;
      if (fctx && failedUserId) trackAnalytics(analyticsRecorder.checkoutFailed(fctx, failedUserId, classifyCheckoutFailure(error)));
      if (error instanceof QuoteRequiredError) {
        return res.status(400).json({ success: false, code: error.code, error: error.message, message: error.message });
      }
      // Nothing was written; the customer must review the fresh quote and
      // explicitly confirm before placing the order.
      if (error instanceof CheckoutChangedError) {
        return res.status(409).json({
          success: false,
          code: error.code,
          reason: error.reason,
          error: error.message,
          message: error.message,
          data: { quote: error.quote },
        });
      }
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /orders
   * Query: ?page=1&limit=10&status=PENDING
   */
  async getMyOrders(req: Request, res: Response) {
    try {
      const userId = req.user.rawId || req.user!.id;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(50, parseInt(req.query.limit as string) || 10);
      const status = req.query.status as string | undefined;

      const result = await orderService.getUserOrders(userId, {
        page,
        limit,
        status,
      });

      return res.json({
        success: true,
        data: result.orders,
        pagination: {
          page,
          limit,
          total: result.total,
          totalPages: Math.ceil(result.total / limit),
        },
      });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /orders/:orderId
   */
  async getOrderById(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { orderId } = req.params;

      const order = await orderService.getUserOrderById(userId, orderId);

      if (!order) {
        return res
          .status(404)
          .json({ success: false, error: "Order not found" });
      }

      return res.json({ success: true, data: order });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /orders/:orderId/tracking
   */
  async trackOrder(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { orderId } = req.params;

      const tracking = await orderService.getOrderTracking(userId, orderId);

      if (!tracking) {
        return res
          .status(404)
          .json({
            success: false,
            error: "Tracking information not available",
          });
      }

      return res.json({ success: true, data: tracking });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * PATCH /orders/:orderId/cancel
   * Body: { reason? }
   */
  /** PHASE 2 BATCH 1B-1 — Pay Now for PAYMENT_PENDING online orders. */
  /**
   * POST /orders/:orderId/pay-now  Body: { gatewayCode? }
   * Opens a gateway session for the customer's own PAYMENT_PENDING online
   * order and returns { gatewayPageURL, transactionId } — see pay-now.service.ts.
   * Errors carry a stable `code`; 409 PAYMENT_IN_PROGRESS adds retryAfterSeconds.
   */
  async payNow(req: Request, res: Response) {
    res.set("Cache-Control", "no-store");
    const userId = req.user?.rawId;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });
    const raw = req.body?.gatewayCode;
    // Optional SSLCommerz channel hint (bkash, nagad, card …); never COD here.
    if (raw !== undefined && (typeof raw !== "string" || !/^[A-Za-z_]{0,24}$/.test(raw) || raw.toUpperCase() === "COD")) {
      return res.status(400).json({ success: false, code: "INVALID_GATEWAY", message: "Invalid payment channel" });
    }
    try {
      const data = await startPayNow(userId, req.params.orderId, raw ?? "");
      return res.json({ success: true, data });
    } catch (error: any) {
      if (error instanceof PayNowError) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        });
      }
      console.error("OrderController.payNow error:", error);
      return res.status(500).json({ success: false, code: "PAY_NOW_FAILED", message: "Pay Now failed. Please try again." });
    }
  }

  async cancelOrder(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { orderId } = req.params;
      const reason = (req.body.reason as string) || "Cancelled by customer";

      const order = await orderService.cancelOrderByUser(
        userId,
        orderId,
        reason,
      );

      return res.json({ success: true, data: order });
    } catch (error: any) {
      // Phase 3 (H-1): an active / unresolved courier booking — nothing was
      // written. `message` is what the customer UI displays.
      if (error instanceof CourierBookingActiveError) {
        return res.status(409).json({ success: false, code: error.code, error: error.message, message: error.message });
      }
      const statusCode = /cannot be cancelled|Batch 1C/.test(error.message)
        ? 400
        : 500;
      return res
        .status(statusCode)
        .json({ success: false, error: error.message });
    }
  }
}
