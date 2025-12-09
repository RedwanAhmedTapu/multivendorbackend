// src/routes/template.routes.ts
import { Router } from "express";
import { TemplateController } from "../controllers/category.template.controller.ts";
import {
  authenticateUser,
  authorizeRoles,
} from "../middlewares/auth.middleware.ts";

const router = Router();

/**
 * @route   GET /api/templates/info
 * @desc    Get template information and available templates
 * @access  Public (or authenticated based on your needs)
 */
router.get("/info", TemplateController.getTemplateInfo);

/**
 * @route   GET /api/templates/download/standard
 * @desc    Download standard category template with examples
 * @access  Authenticated + Admin
 * @query   maxLevels (optional) - Number of category levels (1-10)
 * @query   includeAttributes (optional) - Number of attribute groups (1-5)
 */
router.get(
  "/download/standard",
  authenticateUser,
  authorizeRoles("ADMIN"),
  TemplateController.downloadStandardTemplate
);

/**
 * @route   GET /api/templates/download/custom
 * @desc    Download custom category template
 * @access  Authenticated + Admin
 * @query   maxLevels (optional) - Number of category levels (1-15)
 * @query   includeAttributes (optional) - Number of attribute groups (1-5)
 */
router.get(
  "/download/custom",
  authenticateUser,
  authorizeRoles("ADMIN"),
  TemplateController.downloadCustomTemplate
);

export default router;