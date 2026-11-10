// src/modules/hrm/routes/resignation.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requirePermission } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import {
  resignationController,
  exitClearanceController,
  finalSettlementController,
} from "../controllers/resignation.controller.ts";

const router = Router();
router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

// self-service — an employee submits/withdraws their own resignation
router.post("/", resignationController.submit);
router.patch("/:id/withdraw", resignationController.withdraw);

// HR/manager
router.get("/", requirePermission("hrManagement"), resignationController.list);
router.get("/:id", requirePermission("hrManagement"), resignationController.getById);
router.patch("/:id/act", requirePermission("hrManagement"), resignationController.actOn);

router.get("/:resignationId/clearance", requirePermission("hrManagement"), exitClearanceController.getByResignation);
router.patch("/:resignationId/clearance", requirePermission("hrManagement"), exitClearanceController.updateChecklist);

router.post("/:resignationId/settlement/compute", requirePermission("hrManagement"), finalSettlementController.compute);
router.patch("/:resignationId/settlement/approve", requirePermission("hrManagement"), finalSettlementController.approve);
router.patch("/:resignationId/settlement/mark-paid", requirePermission("hrManagement"), finalSettlementController.markPaid);

export default router;
