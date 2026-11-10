// routes/admin.order.routes.ts
import { Router } from "express";
import { AdminOrderController } from "../controllers/admin.order.controller.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";
import { blockVendorEmployees, requirePermission } from "../middlewares/permission.middleware.ts";

const router = Router();

// All routes require admin/employee authentication. Vendor employees
// (EMPLOYEE with a vendorId, resolved from the database by authenticateUser)
// are blocked from the ENTIRE router: every route below handles platform-wide
// orders, refunds, reservations or accounting (Phase 1, C2).
// orderManagement: ADMIN always passes; admin-side staff need the permission —
// the same key the admin sidebar uses for Orders / Refunds.
router.use(authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), blockVendorEmployees, requirePermission("orderManagement"));

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
 * Supports: status, paymentStatus, vendorId, userId, search, fromDate, toDate
 */
router.get("/", AdminOrderController.getAll);

/**
 * Get orders in the fraud review queue
 * (non-COD, PENDING, no payment record yet — held for manual review)
 * GET /api/admin-orders/fraud-review?page=1
 */
router.get("/fraud-review", AdminOrderController.getFraudReview);

/**
 * Phase 5: verified payments that couldn't be applied to their order
 * (order already paid / cancelled) — recorded for review and refund.
 * GET /api/admin-orders/payment-reconciliation?page=1
 */
router.get("/payment-reconciliation", AdminOrderController.getUnappliedPayments);

/**
 * Get all refund records
 * GET /api/admin-orders/refunds?status=PENDING&page=1
 * Optional filters (1C-7B G3): orderId, refundId
 */
router.get("/refunds", AdminOrderController.getAllRefunds);

/**
 * Remaining-refundable summary for an order (READ-ONLY; H1 definition
 * mirrored — PENDING/APPROVED/PROCESSING/REFUNDED consume; FAILED/REJECTED/
 * CANCELLED do not). Must stay registered BEFORE /refunds/:refundId so
 * "summary" is never parsed as a refundId.
 * GET /api/admin-orders/refunds/summary/:orderId   (1C-7B G6)
 */
router.get("/refunds/summary/:orderId", AdminOrderController.getRefundSummary);

/**
 * Get a single refund with its RefundRecord (when present) and associated
 * VendorReturns.   GET /api/admin-orders/refunds/:refundId   (1C-7B G3)
 */
router.get("/refunds/:refundId", AdminOrderController.getRefundById);

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
 * Confirm an order — non-COD (fraud-cleared / gateway-paid) orders only.
 * COD orders must be confirmed per-vendor via
 * PATCH /api/vendor-orders/:vendorOrderId/confirm-cod instead.
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
 * Force cancel an order (courier-aware: blocks if already picked up,
 * cancels the courier booking + releases stock reservation otherwise)
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
 * Override vendor order status (admin can move any VendorOrder).
 * DELIVERED is blocked unless a courierOrder is already linked
 * (phantom-delivery guard).
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
 * Process a refund for an order.
 * Non-goodwill refunds on shipped orders are blocked until the vendor
 * has confirmed physical receipt of the returned parcel.
 * POST /api/admin-orders/:id/refund
 * Body: { amount: number, reason: string, refundType: RefundType, isGoodwill?: boolean }
 */
router.post("/:id/refund", AdminOrderController.processRefund);

/**
 * Approve a pending return/refund request.
 * Same physical-return gate as processRefund unless isGoodwill=true.
 * PATCH /api/admin-orders/refunds/:refundId/approve
 * Body: { amount: number, note?: string, isGoodwill?: boolean }
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

// Phase 0 (S1): simulated courier events change shipment/order state and post
// delivery vouchers — ADMIN only (no employees, admin-side or vendor).
router.post(
  "/courier-webhook-test/:courierOrderId",
  authorizeRoles("ADMIN"),
  AdminOrderController.simulateCourierWebhook
)
/** Run ONCE — idempotent, safe to call again (skips existing accounts). */
router.post("/seed-platform-coa", AdminOrderController.seedPlatformCOA);

/** Run once per vendor before that vendor's first delivery/refund voucher. */
router.post("/seed-vendor-coa/:vendorId", AdminOrderController.seedVendorCOA);
export default router;
// PHASE 2 BATCH 1B-1 — reservation TTL job (idempotent; safe to re-run/cron)
router.post("/reservations/release-stale", AdminOrderController.releaseStaleReservations);
