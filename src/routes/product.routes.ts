import { Router } from "express";
// Ensure the file exists at ../controllers/product.controller.ts
import { ProductController } from "../controllers/product.controller.ts";
// import { cache } from "../middlewares/cache.ts";

const router = Router();

// Products CRUD
router.get("/", ProductController.getAll);
router.get("/:id", ProductController.getById);
router.post("/", ProductController.create);
router.put("/:id", ProductController.update);
router.delete("/:id", ProductController.remove);

// Product filtering (with category, attributes, specifications)
router.post("/filter", ProductController.filter);

export default router;
