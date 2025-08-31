import { Router } from "express";
// Ensure the file exists at ../controllers/product.controller.ts
import { ProductController } from "../controllers/product.controller.ts";
// import { cache } from "../middlewares/cache.ts";

const router = Router();

router.get("/", ProductController.getAll);
router.get("/:id", ProductController.getById);
router.post("/", ProductController.create);
router.put("/:id", ProductController.update);
router.delete("/:id", ProductController.remove);

export default router;
