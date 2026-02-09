// routes/payment.routes.ts
import { Router } from "express";
import { PaymentController } from "../controllers/payment.controller";

const router = Router();

// Payment initiation
router.post("/init", PaymentController.createPayment);

// SSLCommerz callbacks
router.post("/success", PaymentController.success);
router.post("/fail", PaymentController.fail);
router.post("/cancel", PaymentController.cancel);
router.post("/ipn", PaymentController.ipn);

// Payment queries
router.get("/status/:orderId", PaymentController.getPaymentStatus);
router.get("/details/:transactionId", PaymentController.getTransactionDetails);

// COD specific routes
router.post("/cod/delivery-fee", PaymentController.processDeliveryFee);
router.post("/cod/complete-product", PaymentController.completeProductPayment);

// Refund
router.post("/refund", PaymentController.initiateRefund);
router.get("/refund/:refundRefId", PaymentController.queryRefundStatus);

export default router;