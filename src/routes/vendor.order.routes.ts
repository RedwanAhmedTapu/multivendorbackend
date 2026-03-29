// routes/vendor.order.routes.ts
import { Router } from "express";
import { VendorOrderController } from "../controllers/vendor.order.controller.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();

// All routes require vendor authentication
router.use(authenticateUser, authorizeRoles("VENDOR"));

// =====================================================
// DASHBOARD & OVERVIEW
// =====================================================

/**
 * Get vendor's order statistics/summary
 * GET /api/vendor-orders/statistics
 */
router.get("/statistics", VendorOrderController.getStatistics);

/**
 * Get vendor's revenue summary (daily / weekly / monthly)
 * GET /api/vendor-orders/revenue?period=monthly
 */
router.get("/revenue", VendorOrderController.getRevenue);

// =====================================================
// ORDER LISTING & DETAILS
// =====================================================

/**
 * Get all vendor orders with filters and pagination
 * GET /api/vendor-orders?status=CONFIRMED&fulfillmentStatus=UNFULFILLED&page=1&limit=10
 */
router.get("/", VendorOrderController.getAll);

/**
 * Get a specific vendor order (ownership verified)
 * GET /api/vendor-orders/:vendorOrderId
 */
router.get("/:vendorOrderId", VendorOrderController.getById);

// =====================================================
// ORDER STATUS MANAGEMENT
// =====================================================

/**
 * Update vendor order status
 * Allowed vendor transitions: CONFIRMED → PROCESSING → PACKAGING
 * PATCH /api/vendor-orders/:vendorOrderId/status
 * Body: { status: "PROCESSING" | "PACKAGING" }
 */
router.patch("/:vendorOrderId/status", VendorOrderController.updateStatus);

/**
 * Mark order for delivery — triggers CourierOrder creation + shipping label
 * Status must be PACKAGING before calling this
 * PATCH /api/vendor-orders/:vendorOrderId/mark-for-delivery
 * Body: { warehouseId: string, specialInstruction?: string }
 */
router.patch(
  "/:vendorOrderId/mark-for-delivery",
  VendorOrderController.markForDelivery
);

/**
 * Manually confirm a COD order (after verifying customer by call)
 * PATCH /api/vendor-orders/:vendorOrderId/confirm-cod
 * Body: { confirmedByName: string, note?: string }
 */
router.patch(
  "/:vendorOrderId/confirm-cod",
  VendorOrderController.confirmCodOrder
);

// =====================================================
// SHIPPING & COURIER
// =====================================================

/**
 * Get shipping label data for a vendor order
 * Only available after mark-for-delivery
 * GET /api/vendor-orders/:vendorOrderId/shipping-label
 */
router.get(
  "/:vendorOrderId/shipping-label",
  VendorOrderController.getShippingLabel
);

/**
 * Get courier tracking history for a vendor order
 * GET /api/vendor-orders/:vendorOrderId/tracking
 */
router.get("/:vendorOrderId/tracking", VendorOrderController.getTracking);

// =====================================================
// ORDER ITEMS
// =====================================================

/**
 * Get all order items for a vendor order
 * GET /api/vendor-orders/:vendorOrderId/items
 */
router.get("/:vendorOrderId/items", VendorOrderController.getOrderItems);

export default router;