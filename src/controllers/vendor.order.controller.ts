// controllers/vendor.order.controller.ts
import type { Request, Response } from "express";
import { VendorOrderService } from "../services/vendor.order.service.ts";
import type { OrderStatus, FulfillmentStatus } from "@prisma/client";

/**
 * Vendor Order Controller
 * All handlers require req.user.vendorId — enforced at route level via authorizeRoles("VENDOR")
 */
export const VendorOrderController = {
  // =====================================================
  // LISTING & DETAILS
  // =====================================================

  /**
   * Get all vendor orders with optional filters
   * GET /api/vendor-orders
   */
  async getAll(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found in token",
        });
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;

      if (limit < 1 || limit > 50) {
        return res.status(400).json({
          success: false,
          message: "Limit must be between 1 and 50",
        });
      }

      const result = await VendorOrderService.getAll(vendorId, {
        page,
        limit,
        status: req.query.status as OrderStatus | undefined,
        fulfillmentStatus: req.query.fulfillmentStatus as FulfillmentStatus | undefined,
        search: req.query.search as string | undefined,
        fromDate: req.query.fromDate as string | undefined,
        toDate: req.query.toDate as string | undefined,
      });

      return res.json({
        success: true,
        data: result.vendorOrders,
        pagination: result.pagination,
        count: result.vendorOrders.length,
      });
    } catch (error: any) {
      console.error("VendorOrderController.getAll error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch orders",
      });
    }
  },

  /**
   * Get a specific vendor order
   * GET /api/vendor-orders/:vendorOrderId
   */
  async getById(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found in token",
        });
      }

      const { vendorOrderId } = req.params;
      const vendorOrder = await VendorOrderService.getById(vendorOrderId, vendorId);

      if (!vendorOrder) {
        return res.status(404).json({
          success: false,
          message: "Vendor order not found",
        });
      }

      return res.json({ success: true, data: vendorOrder });
    } catch (error: any) {
      console.error("VendorOrderController.getById error:", error);
      if (error.message === "Unauthorized") {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch order",
      });
    }
  },

  /**
   * Get items for a vendor order
   * GET /api/vendor-orders/:vendorOrderId/items
   */
  async getOrderItems(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found in token",
        });
      }

      const { vendorOrderId } = req.params;
      const items = await VendorOrderService.getOrderItems(vendorOrderId, vendorId);

      return res.json({
        success: true,
        data: items,
        count: items.length,
      });
    } catch (error: any) {
      console.error("VendorOrderController.getOrderItems error:", error);
      if (error.message === "Unauthorized") {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch order items",
      });
    }
  },

  // =====================================================
  // STATISTICS & REVENUE
  // =====================================================

  /**
   * Get vendor order statistics
   * GET /api/vendor-orders/statistics
   */
  async getStatistics(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found in token",
        });
      }

      const stats = await VendorOrderService.getStatistics(vendorId);
      return res.json({ success: true, data: stats });
    } catch (error: any) {
      console.error("VendorOrderController.getStatistics error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch statistics",
      });
    }
  },

  /**
   * Get revenue breakdown by period
   * GET /api/vendor-orders/revenue?period=monthly
   */
  async getRevenue(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found in token",
        });
      }

      const period = req.query.period as string;
      const validPeriods = ["daily", "weekly", "monthly"];

      if (!period || !validPeriods.includes(period)) {
        return res.status(400).json({
          success: false,
          message: `period must be one of: ${validPeriods.join(", ")}`,
        });
      }

      const data = await VendorOrderService.getRevenue(
        vendorId,
        period as "daily" | "weekly" | "monthly"
      );

      return res.json({ success: true, data });
    } catch (error: any) {
      console.error("VendorOrderController.getRevenue error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch revenue data",
      });
    }
  },

  // =====================================================
  // STATUS MANAGEMENT
  // =====================================================

  /**
   * Update vendor order status (PROCESSING or PACKAGING only)
   * PATCH /api/vendor-orders/:vendorOrderId/status
   * Body: { status: "PROCESSING" | "PACKAGING" }
   */
  async updateStatus(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found in token",
        });
      }

      const { vendorOrderId } = req.params;
      const { status } = req.body;

      const allowedStatuses = ["PROCESSING", "PACKAGING"];
      if (!status || !allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `status must be one of: ${allowedStatuses.join(", ")}`,
        });
      }

      const updated = await VendorOrderService.updateStatus(
        vendorOrderId,
        vendorId,
        status as "PROCESSING" | "PACKAGING"
      );

      return res.json({
        success: true,
        data: updated,
        message: `Order status updated to ${status}`,
      });
    } catch (error: any) {
      console.error("VendorOrderController.updateStatus error:", error);
      if (error.message === "Unauthorized") {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to update order status",
      });
    }
  },

  /**
   * Mark order for delivery — triggers CourierOrder creation + shipping label
   * PATCH /api/vendor-orders/:vendorOrderId/mark-for-delivery
   * Body: { warehouseId: string, specialInstruction?: string }
   */
  async markForDelivery(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found in token",
        });
      }

      const { vendorOrderId } = req.params;
      const { warehouseId, specialInstruction } = req.body;

      if (!warehouseId || typeof warehouseId !== "string") {
        return res.status(400).json({
          success: false,
          message: "warehouseId is required",
        });
      }

      const result = await VendorOrderService.markForDelivery(
        vendorOrderId,
        vendorId,
        warehouseId,
        specialInstruction
      );

      return res.json({
        success: true,
        data: result,
        message:
          "Courier pickup requested. Please print the shipping label and hand over the package to the courier rider.",
      });
    } catch (error: any) {
      console.error("VendorOrderController.markForDelivery error:", error);
      if (error.message === "Unauthorized") {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to mark order for delivery",
      });
    }
  },

  /**
   * Confirm a COD order (vendor verifies customer by phone)
   * PATCH /api/vendor-orders/:vendorOrderId/confirm-cod
   * Body: { confirmedByName: string, note?: string }
   */
  async confirmCodOrder(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found in token",
        });
      }

      const { vendorOrderId } = req.params;
      const { confirmedByName, note } = req.body;

      if (!confirmedByName || typeof confirmedByName !== "string" || confirmedByName.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "confirmedByName is required — enter the name of the staff member who verified the customer",
        });
      }

      const result = await VendorOrderService.confirmCodOrder(
        vendorOrderId,
        vendorId,
        confirmedByName.trim(),
        note
      );

      return res.json({
        success: true,
        data: result,
        message: "COD order confirmed successfully",
      });
    } catch (error: any) {
      console.error("VendorOrderController.confirmCodOrder error:", error);
      if (error.message === "Unauthorized") {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to confirm COD order",
      });
    }
  },

  // =====================================================
  // SHIPPING & COURIER
  // =====================================================

  /**
   * Get shipping label data for a vendor order
   * GET /api/vendor-orders/:vendorOrderId/shipping-label
   */
  async getShippingLabel(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found in token",
        });
      }

      const { vendorOrderId } = req.params;
      const labelData = await VendorOrderService.getShippingLabel(vendorOrderId, vendorId);

      return res.json({ success: true, data: labelData });
    } catch (error: any) {
      console.error("VendorOrderController.getShippingLabel error:", error);
      if (error.message === "Unauthorized") {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      if (error.message.includes("not yet available")) {
        return res.status(422).json({
          success: false,
          message: error.message,
        });
      }
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch shipping label",
      });
    }
  },

  /**
   * Get courier tracking history for a vendor order
   * GET /api/vendor-orders/:vendorOrderId/tracking
   */
  async getTracking(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found in token",
        });
      }

      const { vendorOrderId } = req.params;
      const tracking = await VendorOrderService.getTracking(vendorOrderId, vendorId);

      return res.json({ success: true, data: tracking });
    } catch (error: any) {
      console.error("VendorOrderController.getTracking error:", error);
      if (error.message === "Unauthorized") {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      if (error.message.includes("No courier assigned")) {
        return res.status(422).json({ success: false, message: error.message });
      }
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch tracking info",
      });
    }
  },
};