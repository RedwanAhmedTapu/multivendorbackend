// src/modules/hrm/routes/payroll.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { payrollController } from "../controllers/payroll.controller.ts";

const router = Router();
router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

// Payroll is SENSITIVE: reads require hrSalaryView, actions require
// hrSalaryEdit. VENDOR does not auto-pass either gate (backend policy).
const view = requireHr("hrSalaryView");
const edit = requireHr("hrSalaryEdit");

router.get("/runs", view, payrollController.list);
router.get("/runs/:id", view, payrollController.getById);
router.post("/runs", edit, payrollController.createRun);
router.post("/runs/:id/calculate", edit, payrollController.calculate);
router.post("/runs/:id/approve", edit, payrollController.approve);
router.post("/runs/:id/mark-paid", edit, payrollController.markPaid);

export default router;
