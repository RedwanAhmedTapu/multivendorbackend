// controllers/brand.controller.vendor.ts
import type { Response } from "express";
import { uploadToR2Vendor,deleteFromR2Vendor } from "../lib/r2-vendor-config.ts";
import { VendorBrandService } from "../services/brand.service.ts";
import type { AuthRequest } from "../middlewares/auth.middleware.ts";
import {
  brandDocumentUpload,
  buildBrandDocumentKey,
} from "../middlewares/brandDocument.upload.middleware.ts";


const VALID_RELATIONSHIPS = [
  "BRAND_OWNER",
  "EXCLUSIVE_DISTRIBUTOR",
  "NON_EXCLUSIVE_DISTRIBUTOR",
  "RESELLER",
];

const VALID_STATUSES = ["PENDING", "APPROVED", "REJECTED"];

/**
 * Vendor Brand Controller
 * Handles vendor-specific brand operations.
 * All mutating operations include ownership verification.
 */
export const VendorBrandController = {
  // ======================
  // Upload brand authentication document
  // ======================
async uploadDocument(req: AuthRequest, res: Response) {
  const vendorId = req.user?.vendorId;

  if (!vendorId) {
    return res.status(403).json({
      success: false,
      message: "User is not associated with a vendor account",
    });
  }

  brandDocumentUpload(vendorId)(req, res, async (err: any) => {
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.message || "Failed to upload document",
      });
    }

    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded",
      });
    }

    try {
      const key = buildBrandDocumentKey(vendorId, file.originalname);

      const { url } = await uploadToR2Vendor({
        file: file.buffer,
        key,
        contentType: file.mimetype,
      });

      return res.json({ success: true, data: { url, key } });
    } catch (uploadErr: any) {
      console.error("Error uploading brand document to R2:", uploadErr);
      return res.status(500).json({
        success: false,
        message: "Failed to upload document to storage",
      });
    }
  });
},
 // ======================
  // Delete brand authentication document
  // ======================
  async deleteDocument(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
 
      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account",
        });
      }
 
      // Accept the key from either the body or a query param so this works
      // for both a DELETE with a JSON body and a plain `?key=` call.
      const key = (req.body?.key || req.query?.key) as string | undefined;
 
      if (!key) {
        return res.status(400).json({
          success: false,
          message: "Document key is required",
        });
      }
 
      // Ownership check: the key must live under this vendor's own folder
      // (buildBrandDocumentKey produces keys like
      // `vendor/{vendorId}/branddocument/{timestamp}-{filename}`) so a
      // vendor can never delete another vendor's file by guessing/passing
      // an arbitrary key.
      const expectedPrefix = `vendor/${vendorId}/branddocument/`;
      if (!key.startsWith(expectedPrefix)) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to delete this document",
        });
      }
 
      await deleteFromR2Vendor(key);
 
      return res.json({
        success: true,
        message: "Document deleted successfully",
      });
    } catch (error: any) {
      console.error("Error deleting brand document from R2:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to delete document",
      });
    }
  },
  // ======================
  // Get vendor's own brands
  // ======================
  async getMyBrands(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account",
        });
      }

      const {
        status,
        search,
        sortBy = "createdAt",
        sortOrder = "desc",
        page = "1",
        limit = "10",
      } = req.query;

      if (status && !VALID_STATUSES.includes(status as string)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        });
      }

      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);

      if (pageNum < 1 || limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
          success: false,
          message: "Invalid pagination parameters. Page must be >= 1, limit between 1 and 100",
        });
      }

      const result = await VendorBrandService.getMyBrands(vendorId, {
        status: status as any,
        search: search as string,
        sortBy: sortBy as string,
        sortOrder: sortOrder as "asc" | "desc",
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
      console.error("Error fetching vendor brands:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch brands",
      });
    }
  },

  // ======================
  // Get single brand (ownership verified)
  // ======================
  async getById(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account",
        });
      }

      const brand = await VendorBrandService.getById(id, vendorId);

      if (!brand) {
        return res.status(404).json({
          success: false,
          message: "Brand not found or access denied",
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
  // Create new brand
  // ======================
  async create(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account",
        });
      }

      const {
        name,
        relationship,
        authorizationStart,
        authorizationEnd,
        hasEndDate,
        authenticationDoc,
        links,
      } = req.body;

      if (!name || !relationship || !authorizationStart) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields: name, relationship, authorizationStart",
        });
      }

      if (!VALID_RELATIONSHIPS.includes(relationship)) {
        return res.status(400).json({
          success: false,
          message: `Invalid relationship. Must be one of: ${VALID_RELATIONSHIPS.join(", ")}`,
        });
      }

      if (hasEndDate && !authorizationEnd) {
        return res.status(400).json({
          success: false,
          message: "authorizationEnd is required when hasEndDate is true",
        });
      }

      const brand = await VendorBrandService.create(vendorId, {
        name,
        relationship,
        authorizationStart,
        authorizationEnd,
        hasEndDate,
        authenticationDoc,
        links,
        userId: req.user?.rawId,
      });

      return res.status(201).json({
        success: true,
        data: brand,
        message: "Brand created successfully and is pending approval",
      });
    } catch (error: any) {
      console.error("Error creating brand:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to create brand",
      });
    }
  },

  // ======================
  // Update brand
  // ======================
  async update(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account",
        });
      }

      const {
        name,
        relationship,
        authorizationStart,
        authorizationEnd,
        hasEndDate,
        authenticationDoc,
        links,
      } = req.body;

      if (relationship && !VALID_RELATIONSHIPS.includes(relationship)) {
        return res.status(400).json({
          success: false,
          message: `Invalid relationship. Must be one of: ${VALID_RELATIONSHIPS.join(", ")}`,
        });
      }

      const brand = await VendorBrandService.update(id, vendorId, {
        name,
        relationship,
        authorizationStart,
        authorizationEnd,
        hasEndDate,
        authenticationDoc,
        links,
        userId: req.user?.id,
      });

      return res.json({
        success: true,
        data: brand,
        message: "Brand updated successfully and is pending approval",
      });
    } catch (error: any) {
      console.error("Error updating brand:", error);

      if (error.message === "Brand not found or unauthorized") {
        return res.status(404).json({
          success: false,
          message: "Brand not found or access denied",
        });
      }

      return res.status(400).json({
        success: false,
        message: error.message || "Failed to update brand",
      });
    }
  },

  // ======================
  // Delete brand
  // ======================
  async remove(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account",
        });
      }

      await VendorBrandService.remove(id, vendorId, req.user?.id);

      return res.json({
        success: true,
        message: "Brand deleted successfully",
        data: null,
      });
    } catch (error: any) {
      console.error("Error deleting brand:", error);

      if (error.message === "Brand not found or unauthorized") {
        return res.status(404).json({
          success: false,
          message: "Brand not found or access denied",
        });
      }

      return res.status(400).json({
        success: false,
        message: error.message || "Failed to delete brand",
      });
    }
  },
};