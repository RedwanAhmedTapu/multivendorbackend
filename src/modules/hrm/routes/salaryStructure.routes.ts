// src/modules/hrm/routes/salaryStructure.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { salaryStructureController } from "../controllers/salaryStructure.controller.ts";

const router = Router();
router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

// Salary read/edit are SENSITIVE gates — VENDOR does not auto-pass.
router.get("/:employeeId/current", requireHr("hrSalaryView"), salaryStructureController.getCurrent);
router.get("/:employeeId/history", requireHr("hrSalaryView"), salaryStructureController.history);
router.post("/", requireHr("hrSalaryEdit"), salaryStructureController.assign);

export default router;
