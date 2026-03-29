// routes/admin.order.routes.ts
import { Router } from "express";
import { AdminOrderController } from "../controllers/admin.order.controller.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();

// All routes require admin/employee authentication
router.use(authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"));

// =====================================================
// OVERVIEW & STATISTICS
// =====================================================

/**
 * Get full order statistics (platform-wide)
 * GET /api/admin-orders/statistics
 */
router.get("/statistics", AdminOrderController.getStatistics);

/**
 * Get revenue analytics (daily/weekly/monthly breakdown)
 * GET /api/admin-orders/analytics?period=monthly&vendorId=...
 */
router.get("/analytics", AdminOrderController.getAnalytics);

// =====================================================
// ORDER LISTING
// =====================================================

/**
 * Get all orders (all vendors, all statuses)
 * GET /api/admin-orders?status=PENDING&paymentStatus=PAID&vendorId=...&page=1&limit=20
 * Supports: status, paymentStatus, fulfillmentStatus, vendorId, userId, search, fromDate, toDate
 */
router.get("/", AdminOrderController.getAll);

/**
 * Get orders in the fraud review queue (PENDING + no payment, held for manual review)
 * GET /api/admin-orders/fraud-review?page=1
 */
router.get("/fraud-review", AdminOrderController.getFraudReview);

/**
 * Get all refund records
 * GET /api/admin-orders/refunds?status=PENDING&page=1
 */
router.get("/refunds", AdminOrderController.getAllRefunds);

/**
 * Get orders by a specific vendor
 * GET /api/admin-orders/vendor/:vendorId?status=CONFIRMED&page=1
 */
router.get("/vendor/:vendorId", AdminOrderController.getByVendorId);

/**
 * Get a specific order (full detail view)
 * GET /api/admin-orders/:id
 */
router.get("/:id", AdminOrderController.getById);

// =====================================================
// ORDER STATUS ACTIONS
// =====================================================

/**
 * Confirm an order (for COD orders or fraud-cleared orders)
 * PATCH /api/admin-orders/:id/confirm
 * Body: { note?: string }
 */
router.patch("/:id/confirm", AdminOrderController.confirmOrder);

/**
 * Approve a fraud-held order (clears it and confirms)
 * PATCH /api/admin-orders/:id/approve
 * Body: { note?: string }
 */
router.patch("/:id/approve", AdminOrderController.approveOrder);

/**
 * Reject a fraud-held order (cancels it permanently)
 * PATCH /api/admin-orders/:id/reject
 * Body: { reason: string }
 */
router.patch("/:id/reject", AdminOrderController.rejectOrder);

/**
 * Force cancel an order (any cancellable status)
 * PATCH /api/admin-orders/:id/cancel
 * Body: { reason: string }
 */
router.patch("/:id/cancel", AdminOrderController.cancelOrder);

/**
 * Override order status (any valid OrderStatus)
 * PATCH /api/admin-orders/:id/status
 * Body: { status: OrderStatus, note?: string }
 */
router.patch("/:id/status", AdminOrderController.updateStatus);

/**
 * Override vendor order status (admin can move any VendorOrder)
 * PATCH /api/admin-orders/:id/vendor-orders/:vendorOrderId/status
 * Body: { status: OrderStatus, note?: string }
 */
router.patch(
  "/:id/vendor-orders/:vendorOrderId/status",
  AdminOrderController.updateVendorOrderStatus
);

// =====================================================
// REFUNDS
// =====================================================

/**
 * Process a refund for an order
 * POST /api/admin-orders/:id/refund
 * Body: { amount: number, reason: string, refundType: RefundType }
 */
router.post("/:id/refund", AdminOrderController.processRefund);

/**
 * Approve a pending return/refund request
 * PATCH /api/admin-orders/refunds/:refundId/approve
 * Body: { amount: number, note?: string }
 */
router.patch(
  "/refunds/:refundId/approve",
  AdminOrderController.approveRefund
);

/**
 * Reject a return/refund request
 * PATCH /api/admin-orders/refunds/:refundId/reject
 * Body: { reason: string }
 */
router.patch(
  "/refunds/:refundId/reject",
  AdminOrderController.rejectRefund
);

export default router;