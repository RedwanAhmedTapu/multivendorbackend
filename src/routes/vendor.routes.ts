// routes/vendor.routes.ts
import { Router } from "express";
import { VendorController } from "../controllers/vendor.controller.ts";
import { validate } from "../middlewares/vendor.schema.validation.middleware.ts";
import {
  createVendorSchema,
  updateVendorProfileSchema,
  setCommissionSchema,
  createPayoutSchema,
  setMonthlyChargeSchema,
  flagVendorSchema,
  bulkCommissionSchema,
  bulkChargeSchema,
} from "../../schemas/vendor.schemas.ts";
import {
  categoryimageUpload,
  documentUpload,
} from "../middlewares/up.middleware.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";
import {
  blockVendorEmployees,
  requirePermission,
  requireOwnVendorParam,
} from "../middlewares/permission.middleware.ts";

const router = Router();
const vendorController = new VendorController();

// ================================
// ACCESS CONTROL (vendor-management security remediation)
// ================================
// Every route requires a logged-in user (anonymous → 401). Then:
//   adminOnly      — vendor administration: ADMIN only (403 for everyone else)
//   ownVendor(p)   — vendor self-service: ADMIN, or the VENDOR whose own id is
//                    the `:p` param; another vendor's id → 404
//   vendorList     — GET /: ADMIN, or admin-side staff with orderManagement
//                    (the admin orders page uses it for its vendor filter)
// Vendor ids are matched against the session, never trusted from the URL.
router.use(authenticateUser);
const adminOnly = [authorizeRoles("ADMIN")];
const ownVendor = (param: string = "id") => [authorizeRoles("ADMIN", "VENDOR"), requireOwnVendorParam(param)];
const vendorList = [authorizeRoles("ADMIN", "EMPLOYEE"), blockVendorEmployees, requirePermission("orderManagement")];

// ================================
// VENDOR CRUD OPERATIONS
// ================================

// Create new vendor (Admin only)
router.post("/", ...adminOnly, validate(createVendorSchema), vendorController.createVendor);

// Get all vendors with filtering and pagination (Admin/Employee)
router.get("/", ...vendorList, vendorController.getVendors);

// Get vendor by ID (Admin/Employee/Own vendor)
router.get("/:id", ...ownVendor(), vendorController.getVendorById);

// Update vendor profile (Admin/Own vendor)
router.patch(
  "/:id/profile", ...ownVendor(),
  categoryimageUpload("vendor", "VENDOR", undefined, 1, "avatar"), 
  validate(updateVendorProfileSchema),
  vendorController.updateVendorProfile
);

// Approve vendor (Admin only)
router.patch("/:id/active", ...adminOnly, vendorController.approveVendor);

// Suspend vendor (Admin only)
router.patch("/:id/suspended", ...adminOnly, vendorController.suspendVendor);

// Deactivate vendor (Admin only)
router.patch("/:id/deactivated", ...adminOnly, vendorController.deactivateVendor);

// Delete vendor (Admin only)
router.delete("/:id", ...adminOnly, vendorController.deleteVendor);

// Update verification status to UNDER_REVIEW (Admin only)
router.patch("/:id/verification/under-review", ...adminOnly, vendorController.setUnderReview);

// Verify vendor - approve documents (Admin only)
router.patch("/:id/verification/verify", ...adminOnly, vendorController.verifyVendor);

// Reject vendor verification (Admin only)
router.patch("/:id/verification/reject", ...adminOnly, vendorController.rejectVendorVerification);

// Suspend vendor verification (Admin only)
router.patch("/:id/verification/suspend", ...adminOnly, vendorController.suspendVendorVerification);

// Request re-verification (Vendor can request after rejection)
router.post("/:id/verification/request-reverification", ...ownVendor(), vendorController.requestReVerification);

// ================================
// COMMISSION MANAGEMENT
// ================================

// Set commission rate for vendor (Admin only)
router.post(
  "/:id/commission", ...adminOnly,
  validate(setCommissionSchema),
  vendorController.setCommissionRate
);

// Get commission history for vendor
router.get("/:id/commission/history", ...ownVendor(), vendorController.getCommissionHistory);

// Bulk update commission rates (Admin only)
router.post(
  "/set/bulk/commission", ...adminOnly,
  validate(bulkCommissionSchema),
  vendorController.bulkUpdateCommissions
);

// ================================
// PAYOUT MANAGEMENT
// ================================

// Create payout for vendor (Admin only)
router.post(
  "/:id/payouts", ...adminOnly,
  validate(createPayoutSchema),
  vendorController.createPayout
);

// Update payout status (Admin only)
router.patch("/payouts/:payoutId/status", ...adminOnly, vendorController.updatePayoutStatus);

// Get vendor payouts
router.get("/:id/payouts", ...adminOnly, vendorController.getVendorPayouts);

// Get payout summary for vendor
router.get("/:id/payouts/summary", ...adminOnly, vendorController.getPayoutSummary);

// ================================
// MONTHLY CHARGES
// ================================

// Bulk set monthly charges (Admin only) — registered before "/:id/charges",
// which would otherwise match it with id = "bulk".
router.post(
  "/bulk/charges", ...adminOnly,
  validate(bulkChargeSchema),
  vendorController.bulkSetMonthlyCharges
);

// Set monthly charge for vendor (Admin only)
router.post(
  "/:id/charges", ...adminOnly,
  validate(setMonthlyChargeSchema),
  vendorController.setMonthlyCharge
);

// Get vendor charges
router.get("/:id/charges", ...adminOnly, vendorController.getVendorCharges);

// ================================
// PERFORMANCE MONITORING
// ================================

// Get vendor performance metrics
router.get("/:id/performance", ...adminOnly, vendorController.getVendorPerformance);

// Update vendor performance (trigger recalculation)
router.post(
  "/:id/performance/update", ...adminOnly,
  vendorController.updateVendorPerformance
);

// ================================
// FRAUD DETECTION
// ================================

// Detect fraud for vendor (Admin only)
router.get("/:id/fraud-detection", ...adminOnly, vendorController.detectFraud);

// ================================
// FLAG MANAGEMENT
// ================================

// Flag vendor (Admin only)
router.post(
  "/:id/flags", ...adminOnly,
  validate(flagVendorSchema),
  vendorController.flagVendor
);

// Get vendor flags
router.get("/:id/flags", ...adminOnly, vendorController.getVendorFlags);

// ================================
// CHAT/CONVERSATION MANAGEMENT
// ================================

// Get vendor conversations
// router.get(
//   '/conversations',
//   vendorController.getVendorConversations
// );

// Get conversation messages
// router.get(
//   '/conversations/:conversationId/messages',
//   vendorController.getConversationMessages
// );

// Send message in conversation
// router.post(
//   '/conversations/:conversationId/messages',
//   validate(sendMessageSchema),
//   vendorController.sendMessage
// );
// ================================
// PERSONAL INFO ROUTES
// ================================

router.put("/:id/personal-info", ...ownVendor(), vendorController.createOrUpdatePersonalInfo);
router.get("/:id/personal-info", ...ownVendor(), vendorController.getPersonalInfo);
// complete profile
router.get("/:vendorId/complete-profile", ...ownVendor("vendorId"), vendorController.getCompleteProfile);
// ================================
// ADDRESS ROUTES
// ================================

router.put("/:id/address", ...ownVendor(), vendorController.createOrUpdateAddress);
router.get("/:id/address", ...ownVendor(), vendorController.getAddress);

// ================================
// BANK INFO ROUTES
// ================================

router.post("/:id/payment-accounts", ...ownVendor(), vendorController.addBankAccount);
router.get("/:id/payment-accounts", authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), requireOwnVendorParam("id", "inventoryManagement"), vendorController.listBankAccounts);
router.patch("/:id/payment-accounts/:bankAccountId/default", ...ownVendor(), vendorController.setDefaultBankAccount);

// ================================
// DOCUMENT ROUTES
// ================================

router.post(
  "/:id/documents", ...ownVendor(),
  documentUpload,

  vendorController.uploadDocuments
);
router.get("/:id/documents", ...ownVendor(), vendorController.getDocuments);
router.delete(
  '/documents/:documentId', authorizeRoles("ADMIN", "VENDOR"),
  vendorController.deleteDocument
);

// ================================
// SUBSCRIPTION ROUTES
// ================================

router.put("/:id/subscription", ...adminOnly, vendorController.createOrUpdateSubscription);
router.get("/:id/subscription", ...ownVendor(), vendorController.getSubscription);

// ================================
// ONBOARDING & SETTINGS ROUTES
// ================================

router.get("/:id/onboarding-status", ...ownVendor(), vendorController.getOnboardingStatus);
router.get("/:id/settings", ...ownVendor(), vendorController.getSettings);
router.patch("/:id/settings", ...ownVendor(), vendorController.updateSettings);
// ================================
// EXPORT FUNCTIONALITY
// ================================

// Export vendor list (Admin only)
router.get("/export/list", ...adminOnly, vendorController.exportVendors);

export default router;
