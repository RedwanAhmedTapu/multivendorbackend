import { Router } from "express";
import { SliderController } from "../controllers/slider.controller.ts";
import { upload } from "../middlewares/upload.middleware.ts";

const router = Router();
const sliderController = new SliderController();

// Create slider (with image upload)
router.post("/", upload.single("image"), (req, res) =>
  sliderController.create(req, res)
);

// Update slider (optional image upload)
router.put("/:id", upload.single("image"), (req, res) =>
  sliderController.update(req, res)
);

router.get("/", (req, res) => sliderController.findAll(req, res));
router.get("/:id", (req, res) => sliderController.findOne(req, res));
router.delete("/:id", (req, res) => sliderController.remove(req, res));

export default router;
