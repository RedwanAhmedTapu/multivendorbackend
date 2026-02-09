// routes/product.routes.ts
import { Router } from "express";
import { 
  PublicProductController,
  VendorProductController,
  AdminProductController 
} from "../controllers/product.controller.ts";
import { imageUpload } from "../middlewares/upload.middleware.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();

// =====================================================
// IMAGE UPLOAD ROUTES
// =====================================================

/**
 * Upload product images (Vendor only)
 * POST /api/products/upload
 */
router.post(
  "/upload",
  authenticateUser,
  authorizeRoles("VENDOR"),
  (req, res, next) => {
    const vendorId = req.user?.vendorId?.toString();
    if (!vendorId) {
      return res.status(400).json({ 
        success: false, 
        message: "Vendor ID not found" 
      });
    }
    return imageUpload("product", "VENDOR", vendorId)(req, res, next);
  },
  (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ 
          success: false, 
          message: "No files uploaded" 
        });
      }

      const vendorId = req.user?.vendorId;
      const urls = files.map(file => `/uploads/products/${vendorId}/${file.filename}`);
      
      res.json({ 
        success: true, 
        urls,
        count: urls.length 
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to upload images" 
      });
    }
  }
);

// =====================================================
// PUBLIC ROUTES (No Authentication Required)
// =====================================================

/**
 * Search products
 * GET /api/products/search?q=...&limit=20
 */
router.get("/search", PublicProductController.search);

/**
 * Get featured products
 * GET /api/products/featured?limit=10
 */
router.get("/featured", PublicProductController.getFeatured);

/**
 * Filter products
 * POST /api/products/filter
 */
router.post("/filter", PublicProductController.filter);

/**
 * Get products by category
 * GET /api/products/category/:categoryId
 */
router.get("/category/:categoryId", PublicProductController.getByCategoryId);

/**
 * Get all active products
 * GET /api/products
 */
router.get("/", PublicProductController.getAll);

/**
 * Get product by ID (public view)
 * GET /api/products/:id
 */
router.get("/:id", PublicProductController.getById);

// =====================================================
// VENDOR ROUTES (Vendor Authentication Required)
// =====================================================

/**
 * Get vendor's own products
 * GET /api/products/vendor/my-products?status=ACTIVE
 */
router.get(
  "/vendor/my-products",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductController.getMyProducts
);

/**
 * Get vendor's product statistics
 * GET /api/products/vendor/statistics
 */
router.get(
  "/vendor/statistics",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductController.getStatistics
);
/**
 * Get vendor's product statistics
 * GET /api/products/vendor/statistics
 */
router.get(
  "/vendor/product-contents-score",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductController.getContentScoreOfVendorProduct
);

/**
 * Get vendor's specific product (ownership verified)
 * GET /api/products/vendor/:id
 */
router.get(
  "/vendor/:id",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductController.getById
);

/**
 * Create new product (Vendor only)
 * POST /api/products/vendor
 */
router.post(
  "/vendor",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductController.create
);

/**
 * Update vendor's product
 * PUT /api/products/vendor/:id
 */
router.put(
  "/vendor/:id",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductController.update
);

/**
 * Delete vendor's product
 * DELETE /api/products/vendor/:id
 */
router.delete(
  "/vendor/:id",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductController.remove
);

/**
 * Update product variant stock
 * PATCH /api/products/vendor/:id/variants/:variantId/stock
 */
router.patch(
  "/vendor/:id/variants/:variantId/stock",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductController.updateStock
);
router.patch(
  "/vendor/:id/variants/:variantId/price",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductController.updatePrice
);

router.patch(
  "/vendor/:id/variants/:variantId/special-price",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductController.updateSpecialPrice
);
// =====================================================
// ADMIN ROUTES (Admin/Employee Authentication Required)
// =====================================================

/**
 * Get all products (admin view - all statuses)
 * GET /api/products/admin/all
 */
router.get(
  "/admin/all",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.getAll
);

/**
 * Get products pending approval
 * GET /api/products/admin/pending
 */
router.get(
  "/admin/pending",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.getPendingApproval
);

/**
 * Get admin statistics
 * GET /api/products/admin/statistics?vendorId=...
 */
router.get(
  "/admin/statistics",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.getStatistics
);

/**
 * Filter products (admin view)
 * POST /api/products/admin/filter
 */
router.post(
  "/admin/filter",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.filter
);

/**
 * Get products by vendor ID (admin view)
 * GET /api/products/admin/vendor/:vendorId?status=PENDING
 */
router.get(
  "/admin/vendor/:vendorId",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.getByVendorId
);

/**
 * Approve product
 * PATCH /api/products/admin/:id/approve
 */
router.patch(
  "/admin/:id/approve",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.approveProduct
);

/**
 * Reject product
 * PATCH /api/products/admin/:id/reject
 */
router.patch(
  "/admin/:id/reject",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.rejectProduct
);

/**
 * Bulk approve products
 * POST /api/products/admin/bulk-approve
 */
router.post(
  "/admin/bulk-approve",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.bulkApprove
);

/**
 * Bulk reject products
 * POST /api/products/admin/bulk-reject
 */
router.post(
  "/admin/bulk-reject",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.bulkReject
);

/**
 * Update product status (admin)
 * PATCH /api/products/admin/:id/status
 */
router.patch(
  "/admin/:id/status",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.updateStatus
);

/**
 * Get product by ID (admin view)
 * GET /api/products/admin/:id
 */
router.get(
  "/admin/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.getById
);

/**
 * Update product (admin override)
 * PUT /api/products/admin/:id
 */
router.put(
  "/admin/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.update
);

/**
 * Delete product (admin force delete)
 * DELETE /api/products/admin/:id
 */
router.delete(
  "/admin/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminProductController.remove
);

export default router;