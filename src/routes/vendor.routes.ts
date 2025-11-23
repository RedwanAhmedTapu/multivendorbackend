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

const router = Router();
const vendorController = new VendorController();

// ================================
// VENDOR CRUD OPERATIONS
// ================================

// Create new vendor (Admin only)
router.post("/", validate(createVendorSchema), vendorController.createVendor);

// Get all vendors with filtering and pagination (Admin/Employee)
router.get("/", vendorController.getVendors);

// Get vendor by ID (Admin/Employee/Own vendor)
router.get("/:id", vendorController.getVendorById);

// Update vendor profile (Admin/Own vendor)
router.patch(
  "/:id/profile",
  categoryimageUpload("vendor", "VENDOR", undefined, 1, "avatar"), // 'avatar' is the field name
  validate(updateVendorProfileSchema),
  vendorController.updateVendorProfile
);

// Approve vendor (Admin only)
router.patch("/:id/active", vendorController.approveVendor);

// Suspend vendor (Admin only)
router.patch("/:id/suspended", vendorController.suspendVendor);

// Deactivate vendor (Admin only)
router.patch("/:id/deactivated", vendorController.deactivateVendor);

// Delete vendor (Admin only)
router.delete("/:id", vendorController.deleteVendor);

// ================================
// COMMISSION MANAGEMENT
// ================================

// Set commission rate for vendor (Admin only)
router.post(
  "/:id/commission",
  validate(setCommissionSchema),
  vendorController.setCommissionRate
);

// Get commission history for vendor
router.get("/:id/commission/history", vendorController.getCommissionHistory);

// Bulk update commission rates (Admin only)
router.post(
  "/set/bulk/commission",
  validate(bulkCommissionSchema),
  vendorController.bulkUpdateCommissions
);

// ================================
// PAYOUT MANAGEMENT
// ================================

// Create payout for vendor (Admin only)
router.post(
  "/:id/payouts",
  validate(createPayoutSchema),
  vendorController.createPayout
);

// Update payout status (Admin only)
router.patch("/payouts/:payoutId/status", vendorController.updatePayoutStatus);

// Get vendor payouts
router.get("/:id/payouts", vendorController.getVendorPayouts);

// Get payout summary for vendor
router.get("/:id/payouts/summary", vendorController.getPayoutSummary);

// ================================
// MONTHLY CHARGES
// ================================

// Set monthly charge for vendor (Admin only)
router.post(
  "/:id/charges",
  validate(setMonthlyChargeSchema),
  vendorController.setMonthlyCharge
);

// Bulk set monthly charges (Admin only)
router.post(
  "/bulk/charges",
  validate(bulkChargeSchema),
  vendorController.bulkSetMonthlyCharges
);

// Get vendor charges
router.get("/:id/charges", vendorController.getVendorCharges);

// ================================
// PERFORMANCE MONITORING
// ================================

// Get vendor performance metrics
router.get("/:id/performance", vendorController.getVendorPerformance);

// Update vendor performance (trigger recalculation)
router.post(
  "/:id/performance/update",
  vendorController.updateVendorPerformance
);

// ================================
// FRAUD DETECTION
// ================================

// Detect fraud for vendor (Admin only)
router.get("/:id/fraud-detection", vendorController.detectFraud);

// ================================
// FLAG MANAGEMENT
// ================================

// Flag vendor (Admin only)
router.post(
  "/:id/flags",
  validate(flagVendorSchema),
  vendorController.flagVendor
);

// Get vendor flags
router.get("/:id/flags", vendorController.getVendorFlags);

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

router.put("/:id/personal-info", vendorController.createOrUpdatePersonalInfo);
router.get("/:id/personal-info", vendorController.getPersonalInfo);
// complete profile
router.get("/:vendorId/complete-profile", vendorController.getCompleteProfile);
// ================================
// ADDRESS ROUTES
// ================================

router.put("/:id/address", vendorController.createOrUpdateAddress);
router.get("/:id/address", vendorController.getAddress);

// ================================
// BANK INFO ROUTES
// ================================

router.put("/:id/bank-info", vendorController.createOrUpdateBankInfo);
router.get("/:id/bank-info", vendorController.getBankInfo);

// ================================
// DOCUMENT ROUTES
// ================================

router.post(
  "/:id/documents",
  documentUpload,

  vendorController.uploadDocuments
);
router.get("/:id/documents", vendorController.getDocuments);
router.delete(
  '/documents/:documentId',
  vendorController.deleteDocument
);

// ================================
// SUBSCRIPTION ROUTES
// ================================

router.put("/:id/subscription", vendorController.createOrUpdateSubscription);
router.get("/:id/subscription", vendorController.getSubscription);

// ================================
// ONBOARDING & SETTINGS ROUTES
// ================================

router.get("/:id/onboarding-status", vendorController.getOnboardingStatus);
router.get("/:id/settings", vendorController.getSettings);
router.patch("/:id/settings", vendorController.updateSettings);
// ================================
// EXPORT FUNCTIONALITY
// ================================

// Export vendor list (Admin only)
router.get("/export/list", vendorController.exportVendors);

export default router;
