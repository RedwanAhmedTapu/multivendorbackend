import { Router } from "express";
import { AttributeController } from "../controllers/attribute.controller.ts";

const router = Router();

router.get("/", AttributeController.getAllGlobal);   
router.get("/:categoryId", AttributeController.getAll);
router.post("/", AttributeController.create);
router.put("/:id", AttributeController.update);
router.delete("/:id", AttributeController.delete);
router.post("/:attributeId/values", AttributeController.addValue);
router.delete("/values/:id", AttributeController.deleteValue);

export default router;
