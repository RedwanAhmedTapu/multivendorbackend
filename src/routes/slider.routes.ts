// routes/slider.routes.ts
import { Router } from "express";
import { SliderController } from "../controllers/slider.controller.ts";
import { categoryimageUpload } from "../middlewares/up.middleware.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();
const sliderController = new SliderController();
// Get all sliders (public route - remove auth if needed)
// ----------------------
router.get("/", (req, res) => sliderController.findAll(req, res));

// ----------------------
// Get single slider by ID (public route - remove auth if needed)
// ----------------------
router.get("/:id", (req, res) => sliderController.findOne(req, res));

// Apply authentication to all slider routes
router.use(authenticateUser);

// ----------------------
// Create slider (with image upload)
// ----------------------
router.post(
  "/",
  authorizeRoles("ADMIN"),
  categoryimageUpload("slider", "ADMIN", undefined, 1, "image"),
  (req, res) => sliderController.create(req, res)
);

// ----------------------
// Update slider (optional image upload)
// ----------------------
router.put(
  "/:id",
  authorizeRoles("ADMIN"),
  categoryimageUpload("slider", "ADMIN", undefined, 1, "image"),
  (req, res) => sliderController.update(req, res)
);

// ----------------------

// ----------------------
// Delete slider
// ----------------------
router.delete("/:id", authorizeRoles("ADMIN"), (req, res) => sliderController.remove(req, res));

// ----------------------
// Upload slider image only (get URL without DB update)
// ----------------------
router.post(
  "/upload-image",
  authorizeRoles("ADMIN"),
  categoryimageUpload("slider", "ADMIN", undefined, 1, "image"),
  (req, res) => sliderController.uploadImage(req, res)
);

export default router;