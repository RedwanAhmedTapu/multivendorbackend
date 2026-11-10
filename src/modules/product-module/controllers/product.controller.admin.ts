// controllers/product.controller.admin.ts
import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import { ProductFilterService } from "../services/product/product-filter.service.ts";
import { AdminStatisticsService } from "../services/statistics/admin-statistics.service.ts";
import { approveProduct, rejectProduct, bulkApprove, bulkReject } from "../services/product/product-approval.service.ts";
import { hardDeleteProduct, restoreProduct } from "../services/product/product-deletion.service.ts";
import { ProductCoreService } from "../services/product/product-core.service.ts";
import { ProductRepository } from "../repositories/product.repository.ts";
import { prisma } from "../../../config/prisma.ts";
import {
  adminProductFilterSchema,
  updateProductSchema,
  rejectProductSchema,
  bulkIdsSchema,
} from "../validators/product.validator.ts";
import { ok, fail, handleError } from "../utils/response.ts";

export const AdminProductController = {
  async getAll(req: AuthRequest, res: Response) {
    try {
      const filters = adminProductFilterSchema.parse({
        ...req.query,
        page: req.query.page ? Number(req.query.page) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      const { items, pagination } = await ProductFilterService.filterForAdmin(filters);
      return ok(res, items, { pagination, message: "Products fetched" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch products");
    }
  },

  async filter(req: AuthRequest, res: Response) {
    try {
      const filters = adminProductFilterSchema.parse({ ...req.body, ...req.query });
      const { items, pagination } = await ProductFilterService.filterForAdmin(filters);
      return ok(res, items, { pagination, message: "Filtered products fetched", meta: { filtersApplied: filters } });
    } catch (error: any) {
      return handleError(res, error, "Failed to filter products");
    }
  },

  async getPendingApproval(req: AuthRequest, res: Response) {
    try {
      const { items, pagination } = await ProductFilterService.filterForAdmin({
        approvalStatus: "PENDING",
        sortBy: "oldest",
        page: req.query.page ? Number(req.query.page) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      } as any);
      return ok(res, items, { pagination, message: "Pending products fetched" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch pending products");
    }
  },

  async getByVendorId(req: AuthRequest, res: Response) {
    try {
      const filters = adminProductFilterSchema.parse({ ...req.query, vendorId: req.params.vendorId });
      const { items, pagination } = await ProductFilterService.filterForAdmin(filters);
      return ok(res, items, { pagination });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch vendor products");
    }
  },

  async getById(req: AuthRequest, res: Response) {
    try {
      const product = await ProductRepository.findDetailById(req.params.id);
      if (!product) return fail(res, "Product not found", { status: 404 });
      return ok(res, product);
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch product");
    }
  },

  async getStatistics(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.query.vendorId as string | undefined;
      const stats = await AdminStatisticsService.getStatistics(vendorId);
      return ok(res, stats);
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch statistics");
    }
  },

  /**
   * APPROVE — this is the single trigger point for SEO auto-generation.
   * See services/product/product-approval.service.ts::approveProduct.
   */
  async approveProduct(req: AuthRequest, res: Response) {
    try {
      const adminId = req.user?.rawId;
      if (!adminId) return fail(res, "Unauthorized: Admin ID not found", { status: 401 });
      const product = await approveProduct(req.params.id, adminId);
      return ok(res, product, { message: "Product approved successfully. SEO metadata has been generated." });
    } catch (error: any) {
      return handleError(res, error, "Failed to approve product");
    }
  },

  async rejectProduct(req: AuthRequest, res: Response) {
    try {
      const adminId = req.user?.rawId;
      if (!adminId) return fail(res, "Unauthorized: Admin ID not found", { status: 401 });
      const { reason } = rejectProductSchema.parse(req.body);
      const product = await rejectProduct(req.params.id, adminId, reason);
      return ok(res, product, { message: "Product rejected successfully" });
    } catch (error: any) {
      return handleError(res, error, "Failed to reject product");
    }
  },

  async bulkApprove(req: AuthRequest, res: Response) {
    try {
      const adminId = req.user?.rawId;
      if (!adminId) return fail(res, "Unauthorized: Admin ID not found", { status: 401 });
      const { productIds } = bulkIdsSchema.parse(req.body);
      const result = await bulkApprove(productIds, adminId);
      return ok(res, result, { message: `${result.count} product(s) approved successfully; SEO generated for each` });
    } catch (error: any) {
      return handleError(res, error, "Failed to bulk approve products");
    }
  },

  async bulkReject(req: AuthRequest, res: Response) {
    try {
      const adminId = req.user?.rawId;
      if (!adminId) return fail(res, "Unauthorized: Admin ID not found", { status: 401 });
      const { productIds, reason } = bulkIdsSchema.parse(req.body);
      const result = await bulkReject(productIds, adminId, reason);
      return ok(res, result, { message: `${result.count} product(s) rejected successfully` });
    } catch (error: any) {
      return handleError(res, error, "Failed to bulk reject products");
    }
  },

  async update(req: AuthRequest, res: Response) {
    try {
      const input = updateProductSchema.parse(req.body);
      const product = await ProductCoreService.update(req.params.id, undefined, req.user?.id, input);
      return ok(res, product, { message: "Product updated successfully" });
    } catch (error: any) {
      return handleError(res, error, "Failed to update product");
    }
  },

  async updateStatus(req: AuthRequest, res: Response) {
    try {
      const { status } = req.body;
      const valid = ["PENDING", "ACTIVE", "REJECTED", "DRAFT", "INACTIVE"];
      if (!status || !valid.includes(status)) {
        return fail(res, `Invalid status. Must be one of: ${valid.join(", ")}`, { status: 400 });
      }
      const adminId = req.user?.rawId;

      if (status === "ACTIVE") {
        const product = await approveProduct(req.params.id, adminId!);
        return ok(res, product, { message: "Product approved successfully. SEO metadata has been generated." });
      }
      if (status === "REJECTED") {
        const product = await rejectProduct(req.params.id, adminId!, "Status changed by admin");
        return ok(res, product, { message: "Product rejected" });
      }

      const product = await prisma.product.update({ where: { id: req.params.id }, data: { approvalStatus: status } });
      return ok(res, product, { message: `Product status set to ${status}` });
    } catch (error: any) {
      return handleError(res, error, "Failed to update product status");
    }
  },

  /**
   * Admin force-delete bypasses the vendor's 90-day grace period entirely
   * and removes the product right now. Vendor DELETE never does this —
   * see VendorProductController.remove (soft delete only).
   */
  async remove(req: AuthRequest, res: Response) {
    try {
      const result = await hardDeleteProduct(req.params.id, req.user?.id);
      return ok(res, result, { message: "Product permanently deleted" });
    } catch (error: any) {
      return handleError(res, error, "Failed to delete product");
    }
  },

  // PATCH /api/products/admin/:id/restore — admin can restore any vendor's soft-deleted product
  async restore(req: AuthRequest, res: Response) {
    try {
      const restored = await restoreProduct(req.params.id, { userId: req.user?.id });
      return ok(res, restored, { message: "Product restored successfully" });
    } catch (error: any) {
      return handleError(res, error, "Failed to restore product");
    }
  },
};
