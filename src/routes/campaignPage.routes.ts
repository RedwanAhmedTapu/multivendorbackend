// routes/campaignPage.routes.ts
import { Router } from "express";
import { CampaignPageController } from "../controllers/campaignPage.controller.ts";
import { categoryimageUpload } from "../middlewares/up.middleware.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();
const controller = new CampaignPageController();

// ----------------------
// Public — used by the /campaign/[slug] storefront page
// ----------------------
router.get("/public/:slug", (req, res) => controller.getPublicBySlug(req, res));

// Everything below is admin-only
router.use(authenticateUser, authorizeRoles("ADMIN"));

// ----------------------
// Campaign CRUD
// ----------------------
router.get("/", (req, res) => controller.list(req, res));
router.post("/", (req, res) => controller.create(req, res));
router.get("/:id", (req, res) => controller.getById(req, res));
router.put("/:id", (req, res) => controller.update(req, res));
router.delete("/:id", (req, res) => controller.remove(req, res));
router.post("/:id/publish", (req, res) => controller.publish(req, res));
router.post("/:id/unpublish", (req, res) => controller.unpublish(req, res));

// ----------------------
// Components
// ----------------------
router.post("/:id/components", (req, res) => controller.addComponent(req, res));
router.put("/:id/components/reorder", (req, res) => controller.reorderComponents(req, res));
router.put("/components/:componentId", (req, res) => controller.updateComponent(req, res));
router.delete("/components/:componentId", (req, res) => controller.deleteComponent(req, res));
router.put("/components/:componentId/products", (req, res) => controller.setComponentProducts(req, res));

// ----------------------
// Image upload helper (banner images for hero/component config)
// ----------------------
router.post(
  "/upload-image",
  categoryimageUpload("campaign", "ADMIN", undefined, 1, "image"),
  (req, res) => controller.uploadImage(req, res)
);

export default router;