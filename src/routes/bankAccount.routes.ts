// src/routes/bankAccount.routes.ts
//
// ⚠ NOT MOUNTED (verified 2026-11-07): server.ts does not import this router.
// The live vendor payment-account endpoints are:
//     /api/vendormanagement/:id/payment-accounts        (vendor.routes.ts:230-232)
// guarded by ownVendor() = authorizeRoles("ADMIN","VENDOR") + requireOwnVendorParam("id").
//
// This file is kept because its frontend counterpart (features/bankApi.ts
// vendor/admin bank-account endpoints) still targets these paths. S-5 fix
// (2026-11-07): the routes below previously had authenticateUser ONLY — any
// logged-in user could read/add/set-default ANY vendor's payout accounts
// (IDOR / payout-diversion) the moment this router was ever mounted. The
// guards now mirror the live vendor.routes.ts semantics exactly, so this
// file can never be mounted unsafely:
//   vendor write routes — ADMIN or the owning VENDOR (foreign id → 404)
//   vendor list route   — ADMIN, owning VENDOR, or owning vendor's EMPLOYEE
//                         with the inventoryManagement permission
//   admin route         — ADMIN only
import { Router } from "express";
import { BankAccountController } from "../controllers/bankAccount.controller.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";
import { requireOwnVendorParam } from "../middlewares/permission.middleware.ts";

const router = Router();

// Vendor-side (ownership from the authenticated identity, never the path alone)
router.post(
  "/vendor/:vendorId/bank-accounts",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  requireOwnVendorParam("vendorId"),
  BankAccountController.addVendorBankAccount,
);
router.get(
  "/vendor/:vendorId/bank-accounts",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"),
  requireOwnVendorParam("vendorId", "inventoryManagement"),
  BankAccountController.listVendorBankAccounts,
);
router.patch(
  "/vendor/:vendorId/bank-accounts/:bankAccountId/default",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  requireOwnVendorParam("vendorId"),
  BankAccountController.setDefaultVendorBankAccount,
);

// Admin-side
router.post(
  "/admin/bank-accounts",
  authenticateUser,
  authorizeRoles("ADMIN"),
  BankAccountController.addAdminBankAccount,
);

export default router;
