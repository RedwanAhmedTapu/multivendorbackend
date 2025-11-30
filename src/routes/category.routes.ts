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

// ✅ Get category by ID
router.get("/:id", CategoryController.getById);
router.get("/bychild-to-parent/:id", CategoryController.getById);

// ✅ Create category (with image upload)
router.post(
  "/",
  authenticateUser,
  authorizeRoles("ADMIN"),
  categoryimageUpload("category", "ADMIN", undefined, 1, "image"), // ✅ expects "image"
  CategoryController.create
);

// ✅ Update category (with optional image upload)
router.put(
  "/:id",
  authenticateUser,
  authorizeRoles("ADMIN"),
  categoryimageUpload("category", "ADMIN", undefined, 1, "image"), // ✅ expects "image"
  CategoryController.update
);

// ✅ Delete category
router.delete(
  "/:id",
  authenticateUser,
  authorizeRoles("ADMIN"),
  CategoryController.remove
);

// ✅ Upload image only (for pre-uploaded image URLs)
router.post(
  "/upload-image",
  authenticateUser,
  authorizeRoles("ADMIN"),
  categoryimageUpload("category", "ADMIN", undefined, 1, "image"), // ✅ expects "image"
  CategoryController.uploadImage
);

export default router;
