// src/modules/hrm/routes/bonusDeduction.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requirePermission } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { bonusController, deductionController } from "../controllers/bonusDeduction.controller.ts";

const router = Router();
router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope, requirePermission("hrManagement"));

router.post("/bonuses", bonusController.create);
router.get("/bonuses", bonusController.list);
router.patch("/bonuses/:id/act", bonusController.actOn);

router.post("/deductions", deductionController.create);
router.get("/deductions", deductionController.list);
router.patch("/deductions/:id/stop", deductionController.stop);

export default router;
