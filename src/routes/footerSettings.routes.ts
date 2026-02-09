// src/routes/footerSettings.routes.ts
import { Router } from "express";
import {
  getFooterSettings,
  getFooterSettingsById,
  createFooterSettings,
  updateFooterSettings,
  updateFooterSettingsById,
  deleteFooterSettings,
  deleteFooterSettingsById,
  addFooterColumn,
  updateFooterColumn,
  deleteFooterColumn,
  addFooterElement,
  updateFooterElement,
  deleteFooterElement,
} from "../controllers/footerSettings.controller";

const router = Router();

// ===== FOOTER SETTINGS ROUTES =====
// Public route - Get active footer settings
router.get("/", getFooterSettings);

// Protected routes - Admin only
router.post("/", createFooterSettings);
router.put("/", updateFooterSettings);
router.delete("/", deleteFooterSettings);

// Routes with ID parameter
router.get("/:id", getFooterSettingsById);
router.put("/:id", updateFooterSettingsById);
router.delete("/:id", deleteFooterSettingsById);

// ===== COLUMN MANAGEMENT ROUTES =====
router.post("/:footerSettingsId/columns", addFooterColumn);
router.put("/columns/:columnId", updateFooterColumn);
router.delete("/columns/:columnId", deleteFooterColumn);

// ===== ELEMENT MANAGEMENT ROUTES =====
router.post("/columns/:columnId/elements", addFooterElement);
router.put("/elements/:elementId", updateFooterElement);
router.delete("/elements/:elementId", deleteFooterElement);

export default router;