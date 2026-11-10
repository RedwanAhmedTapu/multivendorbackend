// routes/payment.routes.ts
import { Router } from "express";
import { PaymentController } from "../controllers/payment.controller.ts";
import { PaymentAdminController } from "../controllers/payment-admin.controller.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();

// ==================== PUBLIC (no login) ====================
// These MUST sit above router.use(authenticateUser): payment gateways call
// the IPN server-to-server with no user token, and the browser redirects
// back from the gateway aren't guaranteed to carry your auth cookie/header.
// Every handler below re-verifies with the gateway before trusting anything.

// Storefront checkout uses this to know which gateway is live right now
// (no credentials in the response).
router.get("/active-gateway", PaymentController.getActiveGateway);

// SSLCommerz callbacks (POST) — EPS redirects with a query-string, so accept GET too.
router.post("/success", PaymentController.success);
router.post("/fail", PaymentController.fail);
router.post("/cancel", PaymentController.cancel);
router.get("/success", PaymentController.success);
router.get("/fail", PaymentController.fail);
router.get("/cancel", PaymentController.cancel);

// Server-to-server IPN (SSLCommerz form body / PayStation JSON body).
// Tell PayStation support this URL: {BACKEND_URL}/api/payment/ipn
router.post("/ipn", PaymentController.ipn);

// PayStation single return URL (callback_url) — GET redirect or POST.
router.get("/paystation/callback", PaymentController.paystationCallback);
router.post("/paystation/callback", PaymentController.paystationCallback);

// ==================== AUTHENTICATED ====================
router.use(authenticateUser);

// ==================== ADMIN: PAYMENT GATEWAY MANAGEMENT ====================
// Same shape as /api/courier/admin/providers — register a gateway (e.g.
// SSLCommerz, EPS or PayStation), add its credentials, then flip it active.
// Only one gateway can be active at a time; activating one deactivates the rest.
router.get("/admin/providers", authorizeRoles("ADMIN"), PaymentAdminController.listProviders);
router.post("/admin/providers", authorizeRoles("ADMIN"), PaymentAdminController.createProvider);
router.post("/admin/providers/:providerId/credentials", authorizeRoles("ADMIN"), PaymentAdminController.upsertCredential);
router.patch("/admin/providers/:providerId/activate", authorizeRoles("ADMIN"), PaymentAdminController.activateProvider);
router.patch("/admin/providers/:providerId/deactivate", authorizeRoles("ADMIN"), PaymentAdminController.deactivateProvider);

// Payment initiation
router.post("/init", PaymentController.createPayment);

// Payment queries
// Customer result screen after a gateway redirect: owner-only, persisted state only.
router.get("/result/:transactionId", PaymentController.getPaymentResult);
router.get("/status/:orderId", PaymentController.getPaymentStatus);
router.get("/details/:transactionId", PaymentController.getTransactionDetails);

// COD specific routes
router.post("/cod/delivery-fee", PaymentController.processDeliveryFee);
router.post("/cod/confirm-delivery-fee", PaymentController.confirmDeliveryFee);

// Refund — customer/vendor REQUEST only. Admin approve/reject/execute
// lives under admin order routes (see admin.order.routes.ts), which
// delegates gateway execution back into paymentService internally.
router.post("/refund/request", PaymentController.requestRefund);
router.get("/refund/:refundId/status", PaymentController.queryRefundStatus);
router.get("/refund/order/:orderId", PaymentController.getRefundsByOrder);

export default router;