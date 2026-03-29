// controllers/admin.order.controller.ts
import type { Request, Response } from "express";
import { AdminOrderService } from "../services/admin.order.service.ts";
import type {
  OrderStatus,
  PaymentStatus,
  FulfillmentStatus,
  RefundType,
  RefundStatus,
} from "@prisma/client";

const VALID_ORDER_STATUSES: OrderStatus[] = [
  "PENDING", "CONFIRMED", "PROCESSING", "PACKAGING",
  "SHIPPED", "DELIVERED", "RETURNED", "FAILED_TO_DELIVER",
  "CANCELLED", "REFUNDED",
];

const VALID_REFUND_TYPES: RefundType[] = [
  "FULL_REFUND", "PARTIAL_REFUND", "CHARGEBACK",
  "CUSTOMER_INITIATED", "VENDOR_INITIATED", "ADMIN_INITIATED",
];

/**
 * Admin Order Controller
 * All handlers require ADMIN or EMPLOYEE role — enforced at route level
 */
export const AdminOrderController = {
  // =====================================================
  // LISTING & DETAILS
  // =====================================================

  /**
   * Get all orders (all vendors, all statuses, all filters)
   * GET /api/admin-orders
   */
  async getAll(req: Request, res: Response) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;

      if (limit < 1 || limit > 100) {
        return res.status(400).json({
          success: false,
          message: "Limit must be between 1 and 100",
        });
      }

      const result = await AdminOrderService.getAll({
        page,
        limit,
        status: req.query.status as OrderStatus | undefined,
        paymentStatus: req.query.paymentStatus as PaymentStatus | undefined,
        fulfillmentStatus: req.query.fulfillmentStatus as FulfillmentStatus | undefined,
        vendorId: req.query.vendorId as string | undefined,
        userId: req.query.userId as string | undefined,
        search: req.query.search as string | undefined,
        fromDate: req.query.fromDate as string | undefined,
        toDate: req.query.toDate as string | undefined,
      });

      return res.json({
        success: true,
        data: result.orders,
        pagination: result.pagination,
        count: result.orders.length,
      });
    } catch (error: any) {
      console.error("AdminOrderController.getAll error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch orders",
      });
    }
  },

  /**
   * Get a specific order (full admin detail)
   * GET /api/admin-orders/:id
   */
  async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const order = await AdminOrderService.getById(id);

      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      return res.json({ success: true, data: order });
    } catch (error: any) {
      console.error("AdminOrderController.getById error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch order",
      });
    }
  },

  /**
   * Get orders for a specific vendor
   * GET /api/admin-orders/vendor/:vendorId
   */
  async getByVendorId(req: Request, res: Response) {
    try {
      const { vendorId } = req.params;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as OrderStatus | undefined;

      const result = await AdminOrderService.getByVendorId(vendorId, {
        page,
        limit,
        status,
      });

      return res.json({
        success: true,
        data: result.vendorOrders,
        pagination: result.pagination,
        count: result.vendorOrders.length,
      });
    } catch (error: any) {
      console.error("AdminOrderController.getByVendorId error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch vendor orders",
      });
    }
  },

  // =====================================================
  // STATISTICS & ANALYTICS
  // =====================================================

  /**
   * Get platform-wide order statistics
   * GET /api/admin-orders/statistics
   */
  async getStatistics(req: Request, res: Response) {
    try {
      const stats = await AdminOrderService.getStatistics();
      return res.json({ success: true, data: stats });
    } catch (error: any) {
      console.error("AdminOrderController.getStatistics error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch statistics",
      });
    }
  },

  /**
   * Get revenue analytics by period
   * GET /api/admin-orders/analytics?period=monthly&vendorId=...
   */
  async getAnalytics(req: Request, res: Response) {
    try {
      const period = req.query.period as string;
      const vendorId = req.query.vendorId as string | undefined;

      const validPeriods = ["daily", "weekly", "monthly"];
      if (!period || !validPeriods.includes(period)) {
        return res.status(400).json({
          success: false,
          message: `period is required and must be one of: ${validPeriods.join(", ")}`,
        });
      }

      const data = await AdminOrderService.getAnalytics(
        period as "daily" | "weekly" | "monthly",
        vendorId
      );

      return res.json({ success: true, data });
    } catch (error: any) {
      console.error("AdminOrderController.getAnalytics error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch analytics",
      });
    }
  },

  // =====================================================
  // FRAUD QUEUE
  // =====================================================

  /**
   * Get orders pending fraud review
   * GET /api/admin-orders/fraud-review
   */
  async getFraudReview(req: Request, res: Response) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;

      const result = await AdminOrderService.getFraudReview({ page, limit });

      return res.json({
        success: true,
        data: result.orders,
        pagination: result.pagination,
        count: result.orders.length,
      });
    } catch (error: any) {
      console.error("AdminOrderController.getFraudReview error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch fraud review queue",
      });
    }
  },

  // =====================================================
  // STATUS ACTIONS
  // =====================================================

  /**
   * Confirm an order (COD or fraud-cleared)
   * PATCH /api/admin-orders/:id/confirm
   */
  async confirmOrder(req: Request, res: Response) {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const { id } = req.params;
      const { note } = req.body;

      const result = await AdminOrderService.confirmOrder(id, adminId, note);

      return res.json({
        success: true,
        data: result,
        message: "Order confirmed successfully",
      });
    } catch (error: any) {
      console.error("AdminOrderController.confirmOrder error:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to confirm order",
      });
    }
  },

  /**
   * Approve a fraud-held order
   * PATCH /api/admin-orders/:id/approve
   */
  async approveOrder(req: Request, res: Response) {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const { id } = req.params;
      const { note } = req.body;

      const result = await AdminOrderService.approveOrder(id, adminId, note);

      return res.json({
        success: true,
        data: result,
        message: "Order approved and confirmed",
      });
    } catch (error: any) {
      console.error("AdminOrderController.approveOrder error:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to approve order",
      });
    }
  },

  /**
   * Reject a fraud-held order
   * PATCH /api/admin-orders/:id/reject
   */
  async rejectOrder(req: Request, res: Response) {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const { id } = req.params;
      const { reason } = req.body;

      if (!reason || reason.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "A rejection reason is required",
        });
      }

      const result = await AdminOrderService.rejectOrder(id, adminId, reason.trim());

      return res.json({
        success: true,
        data: result,
        message: "Order rejected and cancelled",
      });
    } catch (error: any) {
      console.error("AdminOrderController.rejectOrder error:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to reject order",
      });
    }
  },

  /**
   * Force cancel an order
   * PATCH /api/admin-orders/:id/cancel
   */
  async cancelOrder(req: Request, res: Response) {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const { id } = req.params;
      const { reason } = req.body;

      if (!reason || reason.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Cancellation reason is required",
        });
      }

      const result = await AdminOrderService.cancelOrder(id, adminId, reason.trim());

      return res.json({
        success: true,
        data: result,
        message: "Order cancelled successfully",
      });
    } catch (error: any) {
      console.error("AdminOrderController.cancelOrder error:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to cancel order",
      });
    }
  },

  /**
   * Override order status (admin can set any valid status)
   * PATCH /api/admin-orders/:id/status
   */
  async updateStatus(req: Request, res: Response) {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const { id } = req.params;
      const { status, note } = req.body;

      if (!status || !VALID_ORDER_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `status must be one of: ${VALID_ORDER_STATUSES.join(", ")}`,
        });
      }

      const result = await AdminOrderService.updateStatus(id, adminId, status, note);

      return res.json({
        success: true,
        data: result,
        message: `Order status updated from ${result.oldStatus} to ${result.newStatus}`,
      });
    } catch (error: any) {
      console.error("AdminOrderController.updateStatus error:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to update order status",
      });
    }
  },

  /**
   * Override a specific VendorOrder status
   * PATCH /api/admin-orders/:id/vendor-orders/:vendorOrderId/status
   */
  async updateVendorOrderStatus(req: Request, res: Response) {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const { id, vendorOrderId } = req.params;
      const { status, note } = req.body;

      if (!status || !VALID_ORDER_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `status must be one of: ${VALID_ORDER_STATUSES.join(", ")}`,
        });
      }

      const result = await AdminOrderService.updateVendorOrderStatus(
        id,
        vendorOrderId,
        adminId,
        status,
        note
      );

      return res.json({
        success: true,
        data: result,
        message: `Vendor order status updated from ${result.oldStatus} to ${result.newStatus}`,
      });
    } catch (error: any) {
      console.error("AdminOrderController.updateVendorOrderStatus error:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to update vendor order status",
      });
    }
  },

  // =====================================================
  // REFUNDS
  // =====================================================

  /**
   * Get all refund records
   * GET /api/admin-orders/refunds
   */
  async getAllRefunds(req: Request, res: Response) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as RefundStatus | undefined;

      const result = await AdminOrderService.getAllRefunds({ page, limit, status });

      return res.json({
        success: true,
        data: result.refunds,
        pagination: result.pagination,
        count: result.refunds.length,
      });
    } catch (error: any) {
      console.error("AdminOrderController.getAllRefunds error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch refunds",
      });
    }
  },

  /**
   * Process/initiate a refund for an order (admin-triggered)
   * POST /api/admin-orders/:id/refund
   */
  async processRefund(req: Request, res: Response) {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const { id } = req.params;
      const { amount, reason, refundType } = req.body;

      const parsedAmount = parseFloat(amount);
      if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: "A valid positive refund amount is required",
        });
      }

      if (!reason || reason.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Refund reason is required",
        });
      }

      if (!refundType || !VALID_REFUND_TYPES.includes(refundType)) {
        return res.status(400).json({
          success: false,
          message: `refundType must be one of: ${VALID_REFUND_TYPES.join(", ")}`,
        });
      }

      const refund = await AdminOrderService.processRefund(
        id,
        adminId,
        parsedAmount,
        reason.trim(),
        refundType
      );

      return res.status(201).json({
        success: true,
        data: refund,
        message: "Refund processed successfully",
      });
    } catch (error: any) {
      console.error("AdminOrderController.processRefund error:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to process refund",
      });
    }
  },

  /**
   * Approve a pending return/refund request
   * PATCH /api/admin-orders/refunds/:refundId/approve
   */
  async approveRefund(req: Request, res: Response) {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const { refundId } = req.params;
      const { amount, note } = req.body;

      const parsedAmount = parseFloat(amount);
      if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: "A valid positive refund amount is required",
        });
      }

      const result = await AdminOrderService.approveRefund(
        refundId,
        adminId,
        parsedAmount,
        note
      );

      return res.json({
        success: true,
        data: result,
        message: "Return request approved",
      });
    } catch (error: any) {
      console.error("AdminOrderController.approveRefund error:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to approve refund",
      });
    }
  },

  /**
   * Reject a pending return/refund request
   * PATCH /api/admin-orders/refunds/:refundId/reject
   */
  async rejectRefund(req: Request, res: Response) {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const { refundId } = req.params;
      const { reason } = req.body;

      if (!reason || reason.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Rejection reason is required",
        });
      }

      const result = await AdminOrderService.rejectRefund(
        refundId,
        adminId,
        reason.trim()
      );

      return res.json({
        success: true,
        data: result,
        message: "Return request rejected",
      });
    } catch (error: any) {
      console.error("AdminOrderController.rejectRefund error:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to reject refund",
      });
    }
  },
};