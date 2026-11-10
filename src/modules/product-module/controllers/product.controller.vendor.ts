// controllers/product.controller.vendor.ts
import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import { ProductCoreService } from "../services/product/product-core.service.ts";
import { ProductFilterService } from "../services/product/product-filter.service.ts";
import { VendorStatisticsService } from "../services/statistics/vendor-statistics.service.ts";
import {
  softDeleteProduct,
  restoreProduct,
  getVendorTrash,
} from "../services/product/product-deletion.service.ts";
import { prisma, prismaDirect } from "../../../config/prisma.ts";
import { invalidateProductCache } from "../../../config/cache.ts";
import { discountPercent } from "../../shared/pricing.ts";
import {
  applyStockDelta,
  runStockMutation,
} from "../../../modules/shared/stock-mutations.ts";
import {
  createProductSchema,
  updateProductSchema,
  vendorProductFilterSchema,
  stockUpdateSchema,
  priceUpdateSchema,
  specialPriceUpdateSchema,
} from "../validators/product.validator.ts";
import { ok, fail, handleError, AppError } from "../utils/response.ts";

function requireVendorId(req: AuthRequest, res: Response): string | null {
  const vendorId = req.user?.vendorId;
  if (!vendorId) {
    fail(res, "User is not associated with a vendor account", { status: 403 });
    return null;
  }
  return vendorId;
}

export const VendorProductController = {
  async getMyProducts(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;

      const filters = vendorProductFilterSchema.parse({
        ...req.query,
        page: req.query.page ? Number(req.query.page) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });

      const { items, pagination } = await ProductFilterService.filterForVendor(
        vendorId,
        filters,
      );
      return ok(res, items, { pagination, message: "Vendor products fetched" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch vendor products");
    }
  },

  async getById(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;

      const { ProductRepository } =
        await import("../repositories/product.repository.ts");
      const product = await ProductRepository.findDetailById(req.params.id, {
        vendorId,
      });
      if (!product)
        return fail(res, "Product not found or access denied", { status: 404 });
      return ok(res, product);
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch product");
    }
  },

  async getStatistics(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;
      const stats = await VendorStatisticsService.getStatistics(vendorId);
      return ok(res, stats);
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch statistics");
    }
  },

  async getMonthlyTrends(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;
      const trends = await VendorStatisticsService.getMonthlyTrends(vendorId);
      return ok(res, trends);
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch monthly trends");
    }
  },

  async getContentScoreOfVendorProduct(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;
      const { VendorProductContentService } =
        await import("../services/product/product-content-score.service.ts");
      const summary = await VendorProductContentService.getSummary(vendorId);
      return ok(res, summary);
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch product content score");
    }
  },

  async create(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;

      const input = createProductSchema.parse(req.body);
      console.log(req.user?.rawId);
      const product = await ProductCoreService.create(
        vendorId,
        req.user?.rawId,
        input,
      );
      return ok(res, product, {
        status: 201,
        message: "Product created successfully and is pending approval",
      });
    } catch (error: any) {
      return handleError(res, error, "Failed to create product");
    }
  },

  async update(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;

      const input = updateProductSchema.parse(req.body);
      const product = await ProductCoreService.update(
        req.params.id,
        vendorId,
        req.user?.id,
        input,
      );
      return ok(res, product, {
        message: "Product updated successfully and is pending approval",
      });
    } catch (error: any) {
      return handleError(res, error, "Failed to update product");
    }
  },

  /**
   * DELETE — soft delete only. The product disappears from all listings
   * immediately but the row (and its variants/images/reviews) stays for
   * 90 days so it can be restored, then a nightly job purges it for real.
   */
  async remove(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;

      const result = await softDeleteProduct(
        req.params.id,
        vendorId,
        req.user?.id,
      );
      return ok(
        res,
        { id: result.id, scheduledPurgeAt: result.scheduledPurgeAt },
        { message: result.message },
      );
    } catch (error: any) {
      return handleError(res, error, "Failed to delete product");
    }
  },

  // GET /api/products/vendor/trash — soft-deleted products still in the grace period
  async getTrash(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;
      const items = await getVendorTrash(vendorId);
      return ok(res, items, {
        message: "Deleted products (pending permanent removal)",
      });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch trash");
    }
  },

  // PATCH /api/products/vendor/:id/restore — undo a soft delete before purge
  async restore(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;
      const restored = await restoreProduct(req.params.id, {
        vendorId,
        userId: req.user?.id,
      });
      return ok(res, restored, { message: "Product restored successfully" });
    } catch (error: any) {
      return handleError(res, error, "Failed to restore product");
    }
  },

  /**
   * PATCH /vendor/:id/variants/:variantId/stock
   *
   * Sets an absolute quantity for this variant's DEFAULT-WAREHOUSE
   * "unassigned bin" only (rackId/rowNumber/shelfNumber all null) — not
   * the variant's grand total across all warehouses/racks.
   *
   * IMPORTANT: the delta is computed from that bin's own current quantity
   * (not from ProductVariant.stock, which is the sum across every
   * warehouse/rack). Writing is delegated entirely to applyStockDelta()
   * (modules/shared/stock-mutations.ts) — the same single-writer helper
   * used by purchase receive/return, order placement/dispatch, and POS
   * sale/refund — so WarehouseStock (source of truth) and
   * ProductVariant.stock (denormalized total) always move together and
   * this can never silently clobber stock that concurrently changed in
   * another warehouse/rack.
   *
   * For rack-level adjustments or a full audit trail + accounting entries,
   * use POST /api/stock/adjust (stock.service.ts) instead.
   */
  async updateStock(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;
      const { stock } = stockUpdateSchema.parse(req.body);

      const product = await prisma.product.findFirst({
        where: { id: req.params.id, vendorId, isDeleted: false },
      });
      if (!product)
        return fail(res, "Product not found or access denied", { status: 404 });

      const defaultWarehouse = await prisma.vendorWarehouse.findFirst({
        where: { vendorId, isDefault: true, isActive: true },
        select: { id: true },
      });
      if (!defaultWarehouse) {
        return fail(
          res,
          "No default warehouse configured for this vendor — set one up before updating stock this way",
          { status: 400 },
        );
      }

      const variantExists = await prisma.productVariant.findUnique({
        where: { id: req.params.variantId },
        select: { id: true },
      });
      if (!variantExists)
        return fail(res, "Variant not found", { status: 404 });

      // WarehouseStock's unique key is [variantId, warehouseId, rackId,
      // rowNumber, shelfNumber] — a variant+warehouse pair can have several
      // rows split across racks/shelves, not just one. This endpoint has no
      // rack concept, so it targets the "unassigned bin" row only. If the
      // vendor also has rack-assigned stock in this warehouse, this
      // intentionally won't touch it (use the per-warehouse
      // /api/stock/adjust flow for rack-level changes instead).
      const binWhere = {
        variantId: req.params.variantId,
        warehouseId: defaultWarehouse.id,
        rackId: null,
        rowNumber: null,
        shelfNumber: null,
      } as const;

      const existingWs = await prisma.warehouseStock.findFirst({
        where: binWhere,
        select: { quantity: true },
      });
      const currentBinQty = existingWs?.quantity ?? 0;

      // Delta is computed against THIS bin's own quantity — never against
      // ProductVariant.stock, which is a sum across every warehouse/rack
      // and would produce a wildly wrong delta here.
      const delta = stock - currentBinQty;

      if (delta < 0 && currentBinQty + delta < 0) {
        return fail(
          res,
          `Cannot set this bin's stock to ${stock} — the default warehouse's unassigned bin only holds ${currentBinQty} units and other warehouses/racks may hold the rest. Use the per-warehouse stock adjustment instead.`,
          { status: 400 },
        );
      }

      const variant = await runStockMutation(prisma, async (tx) => {
        await applyStockDelta(tx, {
          variantId: req.params.variantId,
          warehouseId: defaultWarehouse.id,
          rackId: null,
          rowNumber: null,
          shelfNumber: null,
          quantityDelta: delta,
          reason: `Manual stock set by vendor (product ${req.params.id})`,
        });
        return tx.productVariant.findUniqueOrThrow({
          where: { id: req.params.variantId },
        });
      });

      await invalidateProductCache({
        productId: req.params.id,
        slug: product.slug,
        vendorId,
      });
      return ok(res, variant, { message: "Stock updated successfully" });
    } catch (error: any) {
      return handleError(res, error, "Failed to update stock");
    }
  },

  /**
   * PATCH /vendor/:id/variants/:variantId/price
   *
   * Sets priceManuallyOverridden = true so that a subsequent purchase
   * receive (purchase.service.ts -> receivePurchaseOrder) does NOT
   * silently overwrite this vendor-set price with the PO's mrpPrice —
   * see the matching guard there.
   */
  async updatePrice(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;
      const { price, autoCalculateDiscount } = priceUpdateSchema.parse(
        req.body,
      );

      const product = await prisma.product.findFirst({
        where: {
          id: req.params.id,
          vendorId,
          isDeleted: false,
          variants: { some: { id: req.params.variantId } },
        },
        include: { variants: { where: { id: req.params.variantId } } },
      });
      if (!product)
        return fail(res, "Product not found or access denied", { status: 404 });

      const variant = product.variants[0];
      const updateData: any = { price, priceManuallyOverridden: true };
      if (autoCalculateDiscount && variant.specialPrice) {
        // specialPrice is the discounted selling price (modules/shared/pricing.ts):
        // discount % = (price − specialPrice) / price, only while 0 < special < price.
        updateData.discount = discountPercent(price, variant.specialPrice);
      }

      // 1C-23: server-side purchase gate — a manual commercial price update
      // requires a FULLY_RECEIVED purchase order with receivedQuantity > 0
      // for this variant. The purchase receive flows themselves remain the
      // exempt source of commercial values. Serializable + P2034 retry via
      // runStockMutation closes the receive-race window.
      const updated = await runStockMutation(prismaDirect, async (tx) => {
        const received = await tx.purchaseOrderItem.findFirst({
          where: {
            variantId: req.params.variantId,
            receivedQuantity: { gt: 0 },
            purchaseOrder: { receivingStatus: "FULLY_RECEIVED" },
          },
          select: { id: true },
        });
        if (!received) {
          throw new Error(
            "Price update blocked: this variant has no fully received purchase order. Create and receive a purchase order for it first.",
          );
        }
        return tx.productVariant.update({
          where: { id: req.params.variantId },
          data: updateData,
        });
      });
      await invalidateProductCache({
        productId: req.params.id,
        slug: product.slug,
        vendorId,
      });
      return ok(res, updated, {
        message:
          "Price updated successfully. This price is now locked from automatic updates by future purchase receipts.",
      });
    } catch (error: any) {
      return handleError(res, error, "Failed to update price");
    }
  },

  /**
   * PATCH /vendor/:id/variants/:variantId/special-price
   *
   * Same override-lock behavior as updatePrice — see comment there.
   */
  async updateSpecialPrice(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;
      const { specialPrice, autoCalculateDiscount } =
        specialPriceUpdateSchema.parse(req.body);

      const product = await prisma.product.findFirst({
        where: {
          id: req.params.id,
          vendorId,
          isDeleted: false,
          variants: { some: { id: req.params.variantId } },
        },
        include: { variants: { where: { id: req.params.variantId } } },
      });
      if (!product)
        return fail(res, "Product not found or access denied", { status: 404 });

      const variant = product.variants[0];
      const updateData: any = { specialPrice, priceManuallyOverridden: true };
      if (specialPrice === null) updateData.discount = null;
      else if (autoCalculateDiscount && variant.price) {
        // Same rule and formula as before, from the shared pricing helper.
        updateData.discount = discountPercent(variant.price, specialPrice);
      }

      // 1C-23: same server-side purchase gate as updatePrice — specialPrice
      // (sellPrice) is a commercial value and requires a FULLY_RECEIVED
      // purchase with receivedQuantity > 0 for this variant.
      const updated = await runStockMutation(prismaDirect, async (tx) => {
        const received = await tx.purchaseOrderItem.findFirst({
          where: {
            variantId: req.params.variantId,
            receivedQuantity: { gt: 0 },
            purchaseOrder: { receivingStatus: "FULLY_RECEIVED" },
          },
          select: { id: true },
        });
        if (!received) {
          throw new Error(
            "Special price update blocked: this variant has no fully received purchase order. Create and receive a purchase order for it first.",
          );
        }
        return tx.productVariant.update({
          where: { id: req.params.variantId },
          data: updateData,
        });
      });
      await invalidateProductCache({
        productId: req.params.id,
        slug: product.slug,
        vendorId,
      });
      return ok(res, updated, {
        message:
          specialPrice === null
            ? "Special price removed successfully"
            : "Special price updated successfully. This price is now locked from automatic updates by future purchase receipts.",
      });
    } catch (error: any) {
      return handleError(res, error, "Failed to update special price");
    }
  },
  async resetPriceOverride(req: AuthRequest, res: Response) {
    try {
      const vendorId = requireVendorId(req, res);
      if (!vendorId) return;

      const product = await prisma.product.findFirst({
        where: {
          id: req.params.id,
          vendorId,
          isDeleted: false,
          variants: { some: { id: req.params.variantId } }, // ← ownership যাচাই
        },
      });
      if (!product)
        return fail(res, "Product not found or access denied", { status: 404 });

      const updated = await prisma.productVariant.update({
        where: { id: req.params.variantId },
        data: { priceManuallyOverridden: false },
      });
      await invalidateProductCache({
        productId: req.params.id,
        slug: product.slug,
        vendorId,
      });
      return ok(res, updated, {
        message:
          "Price will now update automatically from future purchase receipts.",
      });
    } catch (error: any) {
      return handleError(res, error, "Failed to reset price override");
    }
  },
};
