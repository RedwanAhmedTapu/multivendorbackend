// src/modules/hrm/routes/advanceExpense.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requirePermission } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { advanceController, expenseController } from "../controllers/advanceExpense.controller.ts";

const router = Router();
router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

// self-service
router.post("/advances/apply", advanceController.apply);
router.get("/advances/mine", advanceController.myAdvances);
router.post("/expenses/submit", expenseController.submit);
router.get("/expenses/mine", expenseController.myExpenses);

// HR/manager
router.get("/advances", requirePermission("hrManagement"), advanceController.list);
router.patch("/advances/:id/act", requirePermission("hrManagement"), advanceController.actOn);
router.post("/advances/:id/recover", requirePermission("hrManagement"), advanceController.recordRecovery);

router.get("/expenses", requirePermission("hrManagement"), expenseController.list);
router.patch("/expenses/:id/act", requirePermission("hrManagement"), expenseController.actOn);
router.post("/expenses/:id/reimburse", requirePermission("hrManagement"), expenseController.markReimbursed);

export default router;
