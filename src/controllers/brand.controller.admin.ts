// controllers/brand.controller.admin.ts
import type { Response } from "express";
import { AdminBrandService } from "../services/brand.service.ts";
import type { AuthRequest } from "../middlewares/auth.middleware.ts";

const VALID_STATUSES = ["PENDING", "APPROVED", "REJECTED"];

/**
 * Admin Brand Controller
 * Handles administrative brand operations: cross-vendor visibility and approval workflow.
 */
export const AdminBrandController = {
  // ======================
  // Get all brands (any status)
  // ======================
  async getAll(req: AuthRequest, res: Response) {
    try {
      const { status, search, page = "1", limit = "20" } = req.query;

      if (status && !VALID_STATUSES.includes(status as string)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        });
      }

      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);

      const result = await AdminBrandService.getAll({
        status: status as any,
        search: search as string,
        page: pageNum,
        limit: limitNum,
      });

      return res.json({
        success: true,
        data: result.brands,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages,
          hasNext: result.hasNext,
          hasPrev: result.hasPrev,
        },
      });
    } catch (error: any) {
      console.error("Error fetching brands:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch brands",
      });
    }
  },

  // ======================
  // Get brands pending approval
  // ======================
  async getPendingApproval(_req: AuthRequest, res: Response) {
    try {
      const brands = await AdminBrandService.getPendingApproval();
      return res.json({ success: true, data: brands });
    } catch (error: any) {
      console.error("Error fetching pending brands:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch pending brands",
      });
    }
  },

  // ======================
  // Get brands by vendor ID
  // ======================
  async getByVendorId(req: AuthRequest, res: Response) {
    try {
      const { vendorId } = req.params;
      const { status } = req.query;

      if (status && !VALID_STATUSES.includes(status as string)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        });
      }

      const brands = await AdminBrandService.getByVendorId(
        vendorId,
        status as any
      );

      return res.json({ success: true, data: brands });
    } catch (error: any) {
      console.error("Error fetching vendor's brands:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch vendor's brands",
      });
    }
  },

  // ======================
  // Get brand by ID (admin view)
  // ======================
  async getById(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const brand = await AdminBrandService.getById(id);

      if (!brand) {
        return res.status(404).json({
          success: false,
          message: "Brand not found",
        });
      }

      return res.json({ success: true, data: brand });
    } catch (error: any) {
      console.error("Error fetching brand by ID:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch brand",
      });
    }
  },

  // ======================
  // Approve brand
  // ======================
  async approveBrand(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized",
        });
      }

      const brand = await AdminBrandService.approveBrand(id, adminId);

      return res.json({
        success: true,
        data: brand,
        message: "Brand approved successfully",
      });
    } catch (error: any) {
      console.error("Error approving brand:", error);

      if (error.message === "Brand not found") {
        return res.status(404).json({ success: false, message: error.message });
      }

      return res.status(400).json({
        success: false,
        message: error.message || "Failed to approve brand",
      });
    }
  },

  // ======================
  // Reject brand
  // ======================
  async rejectBrand(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized",
        });
      }

      const brand = await AdminBrandService.rejectBrand(id, adminId, reason);

      return res.json({
        success: true,
        data: brand,
        message: "Brand rejected successfully",
      });
    } catch (error: any) {
      console.error("Error rejecting brand:", error);

      if (error.message === "Brand not found") {
        return res.status(404).json({ success: false, message: error.message });
      }

      return res.status(400).json({
        success: false,
        message: error.message || "Failed to reject brand",
      });
    }
  },
   // ======================
  // Search / list brand names — used by the vendor and admin
  // ======================
  async getAllBrandsnames(req: AuthRequest, res: Response) {
    try {
      const { search, limit } = req.query;
 
      const entries = await AdminBrandService.getAllBrandsnames({
        search: search as string,
        limit: limit ? parseInt(limit as string, 10) : undefined,
      });
 
      return res.json({ success: true, data: entries });
    } catch (error: any) {
      console.error("Error fetching brand catalog:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch brand catalog",
      });
    }
  },
 
  // ======================
  // Add a single brand name (admin)
  // ======================
  async create(req: AuthRequest, res: Response) {
    try {
      const { name } = req.body;
      const adminId = req.user?.id;
 
      if (!name || typeof name !== "string") {
        return res.status(400).json({
          success: false,
          message: "Brand name is required",
        });
      }
 
      const entry = await AdminBrandService.create(name, adminId);
 
      return res.status(201).json({
        success: true,
        data: entry,
        message: "Brand name added to catalog",
      });
    } catch (error: any) {
      console.error("Error creating brand catalog entry:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to add brand name",
      });
    }
  },
 
  // ======================
  // Bulk add brand names (admin)
  // ======================
  async bulkCreate(req: AuthRequest, res: Response) {
    try {
      const { names } = req.body;
      const adminId = req.user?.id;
 
      if (!Array.isArray(names) || names.length === 0) {
        return res.status(400).json({
          success: false,
          message: "`names` must be a non-empty array of strings",
        });
      }
 
      if (names.length > 5000) {
        return res.status(400).json({
          success: false,
          message: "Maximum 5000 brand names per bulk request",
        });
      }
 
      const result = await AdminBrandService.bulkCreate(names, adminId);
 
      return res.status(201).json({
        success: true,
        data: result,
        message: `${result.created} brand name(s) added, ${result.skipped} skipped (already existed or invalid)`,
      });
    } catch (error: any) {
      console.error("Error bulk creating brand catalog entries:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to bulk add brand names",
      });
    }
  },
 
  // ======================
  // Remove a brand name (admin)
  // ======================
  async remove(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      await AdminBrandService.remove(id);
 
      return res.json({
        success: true,
        message: "Brand name removed from catalog",
      });
    } catch (error: any) {
      console.error("Error removing brand catalog entry:", error);
 
      if (error.message === "Brand catalog entry not found") {
        return res.status(404).json({ success: false, message: error.message });
      }
 
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to remove brand name",
      });
    }
  },
};