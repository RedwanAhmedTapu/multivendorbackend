import { Router } from "express";
import { CategoryController } from "../controllers/category.controller.ts";
import { categoryimageUpload } from "../middlewares/up.middleware.ts";
import {
  authenticateUser,
  authorizeRoles,
} from "../middlewares/auth.middleware.ts";

const router = Router();

// ✅ Get all categories
router.get("/", CategoryController.getAll);

// ✅ NEW: Search categories
router.get("/search", CategoryController.search);

// ✅ NEW: Get categories by tag
router.get("/tag/:tag", CategoryController.getByTag);

// ✅ NEW: Get categories by keyword
router.get("/keyword/:keyword", CategoryController.getByKeyword);

// ✅ Get category by ID
router.get("/:id", CategoryController.getById);

// ✅ Get category by child-to-parent (same as getById)
router.get("/bychild-to-parent/:id", CategoryController.getById);

// ✅ Create category (with image upload)
router.post(
  "/",
  authenticateUser,
  authorizeRoles("ADMIN"),
  categoryimageUpload("category", "ADMIN", undefined, 1, "image"),
  CategoryController.create
);

// ✅ Update category (with optional image upload)
router.put(
  "/:id",
  authenticateUser,
  authorizeRoles("ADMIN"),
  categoryimageUpload("category", "ADMIN", undefined, 1, "image"),
  CategoryController.update
);

// ✅ Delete category
router.delete(
  "/:id",
  authenticateUser,
  authorizeRoles("ADMIN"),
  CategoryController.remove
);

// ✅ Upload image only
router.post(
  "/upload-image",
  authenticateUser,
  authorizeRoles("ADMIN"),
  categoryimageUpload("category", "ADMIN", undefined, 1, "image"),
  CategoryController.uploadImage
);
// Vendor submits request
router.post(
  "/catalog-request",
  authenticateUser,
  authorizeRoles("VENDOR"),
  CategoryController.createCatalogRequest
);

// Vendor sees own requests
router.get(
  "/catalog-request/my",
  authenticateUser,
  authorizeRoles("VENDOR"),
  CategoryController.getMyCatalogRequests
);

// Admin sees all requests
router.get(
  "/catalog-request/all",
  authenticateUser,
  authorizeRoles("ADMIN"),
  CategoryController.getAllCatalogRequests
);

export default router;