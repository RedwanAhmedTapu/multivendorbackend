// controllers/product.controller.admin.ts
import type { Request, Response } from "express";
import { AdminProductService } from "../services/product.service.ts";
import type { AuthRequest } from "../middlewares/auth.middleware.ts";

/**
 * Admin Product Controller
 * Handles administrative product operations
 * Full access to all products and approval workflows
 */
export const AdminProductController = {
  // ======================
  // Get all products (all statuses)
  // ======================
  async getAll(req: Request, res: Response) {
    try {
      const products = await AdminProductService.getAll();
      return res.json({ 
        success: true, 
        data: products,
        count: products.length 
      });
    } catch (error: any) {
      console.error("Error fetching all products:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch products" 
      });
    }
  },

  // ======================
  // Get product by ID (any status)
  // ======================
  async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const product = await AdminProductService.getById(id);

      if (!product) {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found" 
        });
      }

      return res.json({ success: true, data: product });
    } catch (error: any) {
      console.error("Error fetching product by ID:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch product" 
      });
    }
  },

  // ======================
  // Get products by vendor ID (admin view)
  // ======================
  async getByVendorId(req: AuthRequest, res: Response) {
    try {
      const { vendorId } = req.params;
      const { status } = req.query;

      // Validate status if provided
      const validStatuses = ["PENDING", "ACTIVE", "REJECTED"];
      if (status && !validStatuses.includes(status as string)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status. Must be one of: PENDING, ACTIVE, REJECTED"
        });
      }

      const options = status ? { status: status as "PENDING" | "ACTIVE" | "REJECTED" } : undefined;
      const products = await AdminProductService.getByVendorId(vendorId, options);

      return res.json({ 
        success: true, 
        data: products,
        count: products.length 
      });
    } catch (error: any) {
      console.error("Error fetching products by vendor ID:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch vendor products" 
      });
    }
  },

  // ======================
  // Get products pending approval
  // ======================
  async getPendingApproval(req: Request, res: Response) {
    try {
      const products = await AdminProductService.getPendingApproval();

      return res.json({ 
        success: true, 
        data: products,
        count: products.length 
      });
    } catch (error: any) {
      console.error("Error fetching pending products:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch pending products" 
      });
    }
  },

  // ======================
  // Approve product
  // ======================
  async approveProduct(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized: Admin ID not found"
        });
      }

      const product = await AdminProductService.approveProduct(id, adminId);

      return res.json({ 
        success: true, 
        data: product,
        message: "Product approved successfully" 
      });
    } catch (error: any) {
      console.error("Error approving product:", error);
      
      if (error.message === "Product not found") {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found" 
        });
      }

      if (error.message === "Product is already approved") {
        return res.status(400).json({ 
          success: false, 
          message: "Product is already approved" 
        });
      }

      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to approve product" 
      });
    }
  },

  // ======================
  // Reject product
  // ======================
  async rejectProduct(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized: Admin ID not found"
        });
      }

      const product = await AdminProductService.rejectProduct(id, adminId, reason);

      return res.json({ 
        success: true, 
        data: product,
        message: "Product rejected successfully" 
      });
    } catch (error: any) {
      console.error("Error rejecting product:", error);
      
      if (error.message === "Product not found") {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found" 
        });
      }

      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to reject product" 
      });
    }
  },

  // ======================
  // Bulk approve products
  // ======================
  async bulkApprove(req: AuthRequest, res: Response) {
    try {
      const { productIds } = req.body;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized: Admin ID not found"
        });
      }

      if (!Array.isArray(productIds) || productIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: "productIds must be a non-empty array"
        });
      }

      const result = await AdminProductService.bulkApprove(productIds, adminId);

      return res.json({ 
        success: true, 
        data: result,
        message: `${result.count} product(s) approved successfully` 
      });
    } catch (error: any) {
      console.error("Error bulk approving products:", error);
      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to approve products" 
      });
    }
  },

  // ======================
  // Bulk reject products
  // ======================
  async bulkReject(req: AuthRequest, res: Response) {
    try {
      const { productIds, reason } = req.body;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized: Admin ID not found"
        });
      }

      if (!Array.isArray(productIds) || productIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: "productIds must be a non-empty array"
        });
      }

      const result = await AdminProductService.bulkReject(productIds, adminId, reason);

      return res.json({ 
        success: true, 
        data: result,
        message: `${result.count} product(s) rejected successfully` 
      });
    } catch (error: any) {
      console.error("Error bulk rejecting products:", error);
      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to reject products" 
      });
    }
  },

  // ======================
  // Update product (admin override)
  // ======================
  async update(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { images, shippingWarranty, ...updateData } = req.body;

      // Format images if provided
      const formattedImages = images && Array.isArray(images)
        ? images.map((img: any, idx: number) => ({
            url: typeof img === "string" ? img : img?.url,
            altText: img?.altText ?? `Product image ${idx + 1}`,
            sortOrder: img?.sortOrder ?? idx,
          }))
        : undefined;

      const product = await AdminProductService.update(id, {
        ...updateData,
        images: formattedImages,
        shippingWarranty,
        userId: req.user?.id,
      });

      return res.json({ 
        success: true, 
        data: product,
        message: "Product updated successfully" 
      });
    } catch (error: any) {
      console.error("Error updating product:", error);
      
      if (error.message === "Product not found") {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found" 
        });
      }

      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to update product" 
      });
    }
  },

  // ======================
  // Update product status
  // ======================
  async updateStatus(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      // Validate status
      const validStatuses = ["PENDING", "ACTIVE", "REJECTED"];
      if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status. Must be one of: PENDING, ACTIVE, REJECTED"
        });
      }

      const product = await AdminProductService.update(id, {
        status: status as "PENDING" | "ACTIVE" | "REJECTED",
        approvedById: status === "ACTIVE" ? req.user?.id : undefined,
        userId: req.user?.id,
      });

      const statusMessages = {
        ACTIVE: "Product approved successfully",
        REJECTED: "Product rejected",
        PENDING: "Product status set to pending"
      };

      return res.json({ 
        success: true, 
        data: product,
        message: statusMessages[status as keyof typeof statusMessages]
      });
    } catch (error: any) {
      console.error("Error updating product status:", error);
      
      if (error.message === "Product not found") {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found" 
        });
      }

      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to update product status" 
      });
    }
  },

  // ======================
  // Delete product (force delete)
  // ======================
  async remove(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;

      await AdminProductService.remove(id, req.user?.id);
      
      return res.json({ 
        success: true, 
        message: "Product deleted successfully",
        data: null 
      });
    } catch (error: any) {
      console.error("Error deleting product:", error);
      
      if (error.message === "Product not found") {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found" 
        });
      }

      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to delete product" 
      });
    }
  },

  // ======================
  // Filter products (admin view)
  // ======================
  async filter(req: Request, res: Response) {
    try {
      const filters = req.body;

      // Validate filter parameters
      if (filters.minPrice !== undefined && filters.minPrice < 0) {
        return res.status(400).json({
          success: false,
          message: "minPrice must be a positive number"
        });
      }

      if (filters.maxPrice !== undefined && filters.maxPrice < 0) {
        return res.status(400).json({
          success: false,
          message: "maxPrice must be a positive number"
        });
      }

      if (filters.minPrice && filters.maxPrice && filters.minPrice > filters.maxPrice) {
        return res.status(400).json({
          success: false,
          message: "minPrice cannot be greater than maxPrice"
        });
      }

      // Validate approval status if provided
      if (filters.approvalStatus) {
        const validStatuses = ["PENDING", "ACTIVE", "REJECTED"];
        if (!validStatuses.includes(filters.approvalStatus)) {
          return res.status(400).json({
            success: false,
            message: "Invalid approvalStatus. Must be one of: PENDING, ACTIVE, REJECTED"
          });
        }
      }

      const products = await AdminProductService.filterProducts(filters);
      
      return res.json({ 
        success: true, 
        data: products,
        count: products.length,
        filters: filters 
      });
    } catch (error: any) {
      console.error("Error filtering products:", error);
      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to filter products" 
      });
    }
  },

  // ======================
  // Get statistics
  // ======================
  async getStatistics(req: AuthRequest, res: Response) {
    try {
      const { vendorId } = req.query;
      const stats = await AdminProductService.getStatistics(
        vendorId as string | undefined
      );

      return res.json({ 
        success: true, 
        data: stats 
      });
    } catch (error: any) {
      console.error("Error fetching product statistics:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch product statistics" 
      });
    }
  },
};