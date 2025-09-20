import { Router } from "express";
import { SliderController } from "../controllers/slider.controller.ts";
import { imageUpload } from "../middlewares/upload.middleware.ts";

const router = Router();
const sliderController = new SliderController();

// ----------------------
// Create slider (with image upload)
// ----------------------
// Pass type = "slider" and role/vendorId dynamically
router.post("/", (req, res, next) => {
  const role = req.body.role || "admin"; // default admin if not provided
  const vendorId = req.body.vendorId;    // optional for vendor
  imageUpload("slider", role, vendorId)(req, res, next);
}, (req, res) => sliderController.create(req, res));

// ----------------------
// Update slider (optional image upload)
// ----------------------
router.put("/:id", (req, res, next) => {
  const role = req.body.role || "admin";
  const vendorId = req.body.vendorId;
  imageUpload("slider", role, vendorId)(req, res, next);
}, (req, res) => sliderController.update(req, res));

// ----------------------
// Get all sliders
// ----------------------
router.get("/", (req, res) => sliderController.findAll(req, res));

// ----------------------
// Get single slider by ID
// ----------------------
router.get("/:id", (req, res) => sliderController.findOne(req, res));

// ----------------------
// Delete slider
// ----------------------
router.delete("/:id", (req, res) => sliderController.remove(req, res));

export default router;
