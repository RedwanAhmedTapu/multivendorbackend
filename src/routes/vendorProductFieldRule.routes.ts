// routes/vendorProductFieldRule.routes.ts
import { Router } from "express";
import { VendorProductFieldRuleController } from "../controllers/vendorProductFieldRule.controller.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();

// =====================================================
// VENDOR ROUTES
// =====================================================

/**
 * Get resolved product-field rules for the logged-in vendor
 * (used to build the dynamic add/edit product form)
 * GET /api/product-field-rules/vendor/my-rules?categoryId=xxx
 */
router.get(
  "/vendor/my-rules",
  authenticateUser,
  authorizeRoles("VENDOR"),
  VendorProductFieldRuleController.vendorGetMyRules
);

// =====================================================
// ADMIN ROUTES
// =====================================================

/**
 * List the fields that can be toggled
 * GET /api/product-field-rules/admin/fields
 */
router.get(
  "/admin/fields",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  VendorProductFieldRuleController.adminGetFields
);

/**
 * Get all field rules configured for a vendor
 * GET /api/product-field-rules/admin/vendor/:vendorId?categoryId=xxx
 */
router.get(
  "/admin/vendor/:vendorId",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  VendorProductFieldRuleController.adminGetByVendor
);

/**
 * Upsert a single field rule for a vendor
 * PUT /api/product-field-rules/admin/vendor/:vendorId
 * body: { categoryId?: string|null, field: ProductField, isEnabled?: boolean, isRequired?: boolean }
 */
router.put(
  "/admin/vendor/:vendorId",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  VendorProductFieldRuleController.adminUpsert
);

/**
 * Bulk upsert field rules for a vendor
 * PUT /api/product-field-rules/admin/vendor/:vendorId/bulk
 * body: { categoryId?: string|null, rules: { field, isEnabled?, isRequired? }[] }
 */
router.put(
  "/admin/vendor/:vendorId/bulk",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  VendorProductFieldRuleController.adminBulkUpsert
);

/**
 * Remove a field rule (reverts to system default)
 * DELETE /api/product-field-rules/admin/:id
 */
router.delete(
  "/admin/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  VendorProductFieldRuleController.adminRemove
);
/**
 * List all configured vendor/scope permission assignments
 * GET /api/product-field-rules/admin/scopes?search=&page=&limit=
 */
router.get(
  "/admin/scopes",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  VendorProductFieldRuleController.adminListScopes
);

/**
 * Remove every field rule for a vendor/scope pair
 * DELETE /api/product-field-rules/admin/vendor/:vendorId/scope
 * body: { categoryId: string | null }
 */
router.delete(
  "/admin/vendor/:vendorId/scope",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  VendorProductFieldRuleController.adminRemoveScope
);

export default router;