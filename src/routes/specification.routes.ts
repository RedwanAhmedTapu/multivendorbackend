// routes/specifications.ts
import { Router } from "express";
import { SpecificationController } from "../controllers/specification.controller.ts";

const router = Router();

router.get("/:categoryId", SpecificationController.getAll);
router.post("/", SpecificationController.create);
router.put("/:id", SpecificationController.update);
router.delete("/:id", SpecificationController.delete);

export default router;