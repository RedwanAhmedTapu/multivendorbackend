// controllers/payment.controller.ts
import { Request, Response } from "express";
import { paymentService } from "../services/payment.service.ts";
import { OrderStatus, PaymentStatus } from "@prisma/client";

export class PaymentController {
  /**
   * Initialize payment
   */
  static async createPayment(req: Request, res: Response) {
    try {
      const { orderId, gatewayCode, userId } = req.body;

      // Validate gateway code
      const validGateways = ["BKASH", "NAGAD", "UPAY", "EBL_COF", "COD"];
      if (!validGateways.includes(gatewayCode)) {
        return res.status(400).json({
          success: false,
          message: "Invalid gateway code",
        });
      }

      // Handle COD separately (no payment gateway needed)
      if (gatewayCode === "COD") {
        const result = await paymentService.handleCODOrder(orderId);
        return res.json({
          success: true,
          message: "Order confirmed with Cash on Delivery",
          data: result,
        });
      }

      // Initialize online payment
      const paymentResponse = await paymentService.initiatePayment({
        orderId,
        userId,
        gatewayCode,
      });

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
      res.status(500).json({
        success: false,
        message: error.message || "Payment initiation failed",
      });
    }
  }

  /**
   * IPN Listener - Most reliable for payment confirmation
   */
  static async ipn(req: Request, res: Response) {
    try {
      const { val_id, tran_id, status, amount } = req.body;

      console.log("IPN Received:", { val_id, tran_id, status, amount });

      // Validate payment with SSLCommerz
      const validation = await paymentService.validatePayment(val_id);

      if (validation.status !== "VALID" && validation.status !== "VALIDATED") {
        console.error("Invalid payment:", validation);
        return res.status(400).send("Invalid payment");
      }

      // Confirm payment
      await paymentService.confirmPayment(tran_id, validation);

      res.status(200).send("IPN processed successfully");
    } catch (error: any) {
      console.error("IPN Processing Error:", error);
      res.status(500).send("IPN processing failed");
    }
  }

  /**
   * Success callback
   */
  static async success(req: Request, res: Response) {
    try {
      const { val_id, tran_id } = req.body;

      // Validate payment
      const validation = await paymentService.validatePayment(val_id);

      if (validation.status !== "VALID" && validation.status !== "VALIDATED") {
        return res.redirect(`${process.env.FRONTEND_URL}/payment/failed`);
      }

      // Check if already processed by IPN
      const payment = await paymentService.getPaymentByTransactionId(tran_id);

      if (payment?.status !== PaymentStatus.PAID) {
        // Update if not already processed
        await paymentService.confirmPayment(tran_id, validation);
      }

      res.redirect(
        `${process.env.FRONTEND_URL}/payment/success?tran_id=${tran_id}`
      );
    } catch (error) {
      console.error("Success Handler Error:", error);
      res.redirect(`${process.env.FRONTEND_URL}/payment/failed`);
    }
  }

  /**
   * Fail callback
   */
  static async fail(req: Request, res: Response) {
    try {
      const { tran_id } = req.body;

      await paymentService.handleFailedPayment(tran_id);

      res.redirect(
        `${process.env.FRONTEND_URL}/payment/failed?tran_id=${tran_id}`
      );
    } catch (error) {
      console.error("Fail Handler Error:", error);
      res.redirect(`${process.env.FRONTEND_URL}/payment/failed`);
    }
  }

  /**
   * Cancel callback
   */
  static async cancel(req: Request, res: Response) {
    try {
      const { tran_id } = req.body;

      await paymentService.handleCancelledPayment(tran_id);

      res.redirect(
        `${process.env.FRONTEND_URL}/payment/cancelled?tran_id=${tran_id}`
      );
    } catch (error) {
      console.error("Cancel Handler Error:", error);
      res.redirect(`${process.env.FRONTEND_URL}/payment/cancelled`);
    }
  }

  /**
   * Get payment status by order ID
   */
  static async getPaymentStatus(req: Request, res: Response) {
    try {
      const { orderId } = req.params;

      const payments = await paymentService.getPaymentDetails(Number(orderId));

      res.json({
        success: true,
        data: payments,
      });
    } catch (error: any) {
      console.error("Get Payment Status Error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to get payment status",
      });
    }
  }

  /**
   * Get transaction details
   */
  static async getTransactionDetails(req: Request, res: Response) {
    try {
      const { transactionId } = req.params;

      const details = await paymentService.queryTransactionStatus(transactionId);

      res.json({
        success: true,
        data: details,
      });
    } catch (error: any) {
      console.error("Get Transaction Details Error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to get transaction details",
      });
    }
  }

  /**
   * Process delivery fee for COD orders
   */
  static async processDeliveryFee(req: Request, res: Response) {
    try {
      const { orderId, amount, userId, gatewayCode } = req.body;

      const result = await paymentService.processDeliveryFeePayment(
        orderId,
        amount,
        userId,
        gatewayCode
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      console.error("Process Delivery Fee Error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to process delivery fee",
      });
    }
  }

  /**
   * Complete product payment for COD (after delivery)
   */
  static async completeProductPayment(req: Request, res: Response) {
    try {
      const { orderId } = req.body;

      const result = await paymentService.completeProductPayment(orderId);

      res.json({
        success: true,
        data: result,
        message: "Product payment completed successfully",
      });
    } catch (error: any) {
      console.error("Complete Product Payment Error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to complete product payment",
      });
    }
  }

  /**
   * Initiate refund
   */
  static async initiateRefund(req: Request, res: Response) {
    try {
      const { transactionId, refundAmount, refundReason } = req.body;

      const result = await paymentService.processRefund({
        transactionId,
        refundAmount,
        refundReason,
      });

      res.json({
        success: true,
        data: result,
        message: "Refund initiated successfully",
      });
    } catch (error: any) {
      console.error("Initiate Refund Error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to initiate refund",
      });
    }
  }

  /**
   * Query refund status
   */
  static async queryRefundStatus(req: Request, res: Response) {
    try {
      const { refundRefId } = req.params;

      const result = await paymentService.queryRefundStatus(refundRefId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      console.error("Query Refund Status Error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to query refund status",
      });
    }
  }
}