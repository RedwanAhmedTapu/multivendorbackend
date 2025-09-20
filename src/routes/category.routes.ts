import { Router } from "express";
import { CategoryController } from "../controllers/category.controller.ts";
import { imageUpload } from "../middlewares/upload.middleware.ts";

const router = Router();

router.get("/", CategoryController.getAll);
router.get("/:id", CategoryController.getById);

// Use dynamic middleware for single image upload
router.post("/", imageUpload("category"), CategoryController.create);
router.put("/:id", imageUpload("category"), CategoryController.update);
router.delete("/:id", CategoryController.remove);

// Upload image only (get URL without DB update)
router.post("/upload-image", imageUpload("category"), CategoryController.uploadImage);

export default router;
