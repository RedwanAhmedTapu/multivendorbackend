// routes/brand.routes.ts
import { Router } from "express";
import { VendorBrandController } from "../controllers/brand.controller.vendor.ts";
import { AdminBrandController } from "../controllers/brand.controller.admin.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();

// =====================================================
// VENDOR ROUTES (Vendor Authentication Required)
// =====================================================

/**
 * Upload brand authentication document (Vendor only)
 * POST /api/brands/vendor/upload-document
 */
router.post(
  "/vendor/upload-document",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorBrandController.uploadDocument
);
/**
 * Delete brand authentication document (Vendor only)
 * DELETE /api/brands/vendor/delete-document
 * body: { key: string }  — the R2 key returned by upload-document
 */
router.delete(
  "/vendor/delete-document",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorBrandController.deleteDocument
);
/**
 * Get vendor's own brands
 * GET /api/brands/vendor/my-brands?status=PENDING
 */
router.get(
  "/vendor/my-brands",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorBrandController.getMyBrands
);

/**
 * Get vendor's specific brand (ownership verified)
 * GET /api/brands/vendor/:id
 */
router.get(
  "/vendor/:id",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorBrandController.getById
);

/**
 * Create new brand (Vendor only)
 * POST /api/brands/vendor
 */
router.post(
  "/vendor",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorBrandController.create
);

/**
 * Update vendor's brand
 * PUT /api/brands/vendor/:id
 */
router.put(
  "/vendor/:id",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorBrandController.update
);

/**
 * Delete vendor's brand
 * DELETE /api/brands/vendor/:id
 */
router.delete(
  "/vendor/:id",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorBrandController.remove
);

// =====================================================
// BRAND CATALOG ROUTES (searchable brand-name list)
// Read access: vendor + admin/employee (e.g. vendor's brand-name dropdown).
// Write access: admin/employee only.
// NOTE: placed before "/admin/:id" below so "/admin/catalog..." isn't
// swallowed by that catch-all param route.
// =====================================================

/**
 * Search / list brand catalog names (Vendor + Admin/Employee)
 * GET /api/brands/catalog?search=sam&limit=50
 */
router.get(
  "/catalog",
  authenticateUser,
  authorizeRoles("VENDOR", "ADMIN", "EMPLOYEE"),
  AdminBrandController.getAllBrandsnames
);

/**
 * Add a single brand name to the catalog (Admin/Employee)
 * POST /api/brands/admin/catalog  body: { name }
 */
router.post(
  "/admin/catalog",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminBrandController.create
);

/**
 * Bulk add brand names to the catalog (Admin/Employee)
 * POST /api/brands/admin/catalog/bulk  body: { names: string[] }
 */
router.post(
  "/admin/catalog/bulk",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminBrandController.bulkCreate
);

/**
 * Remove a brand name from the catalog (Admin/Employee)
 * DELETE /api/brands/admin/catalog/:id
 */
router.delete(
  "/admin/catalog/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminBrandController.remove
);

// =====================================================
// ADMIN ROUTES (Admin/Employee Authentication Required)
// =====================================================

/**
 * Get all brands (admin view - all statuses)
 * GET /api/brands/admin/all?status=PENDING
 */
router.get(
  "/admin/all",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminBrandController.getAll
);

/**
 * Get brands pending approval
 * GET /api/brands/admin/pending
 */
router.get(
  "/admin/pending",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminBrandController.getPendingApproval
);

/**
 * Get brands by vendor ID (admin view)
 * GET /api/brands/admin/vendor/:vendorId?status=PENDING
 */
router.get(
  "/admin/vendor/:vendorId",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminBrandController.getByVendorId
);

/**
 * Approve brand
 * PATCH /api/brands/admin/:id/approve
 */
router.patch(
  "/admin/:id/approve",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminBrandController.approveBrand
);

/**
 * Reject brand
 * PATCH /api/brands/admin/:id/reject
 */
router.patch(
  "/admin/:id/reject",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminBrandController.rejectBrand
);

/**
 * Get brand by ID (admin view)
 * GET /api/brands/admin/:id
 */
router.get(
  "/admin/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminBrandController.getById
);

export default router;