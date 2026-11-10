// src/modules/hrm/routes/loan.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requirePermission } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { loanController } from "../controllers/loan.controller.ts";

const router = Router();
router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

// self-service
router.post("/apply", loanController.apply);
router.get("/mine", loanController.myLoans);

// HR/manager
router.get("/", requirePermission("hrManagement"), loanController.list);
router.get("/:id", requirePermission("hrManagement"), loanController.getById);
router.patch("/:id/act", requirePermission("hrManagement"), loanController.actOn);
router.post("/:id/payments", requirePermission("hrManagement"), loanController.recordPayment);

export default router;
