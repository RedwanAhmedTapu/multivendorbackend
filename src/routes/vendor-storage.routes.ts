// src/routes/vendor-storage.routes.ts
import { Router } from "express";
import { vendorStorageController } from "../controllers/vendor-storage.controller.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";
import { imageUpload } from "../middlewares/up.middleware.ts";

const router = Router();

// All routes require authentication
router.use(authenticateUser);

// ---------------- Vendor routes ----------------
router.post(
  "/upload",
  authorizeRoles("VENDOR"),
  imageUpload("product", "VENDOR"),
  vendorStorageController.uploadFile
);

router.post(
  "/upload-multiple",
  authorizeRoles("VENDOR"),
  imageUpload("product", "VENDOR", undefined, 10),
  vendorStorageController.uploadMultipleFiles
);

router.delete(
  "/files/:fileId",
  authorizeRoles("VENDOR"),
  vendorStorageController.deleteFile
);

router.get(
  "/stats",
  authorizeRoles("VENDOR"),
  vendorStorageController.getStorageStats
);

router.post(
  "/check-quota",
  authorizeRoles("VENDOR"),
  vendorStorageController.checkQuota
);

router.post(
  "/purchase",
  authorizeRoles("VENDOR"),
  vendorStorageController.purchaseStorage
);

router.get(
  "/files",
  authorizeRoles("VENDOR"),
  vendorStorageController.getVendorFiles
);

// ---------------- Admin routes ----------------
router.post(
  "/admin/calculate-charges",
  authorizeRoles("ADMIN"),
  vendorStorageController.calculateMonthlyCharges
);

export default router;
