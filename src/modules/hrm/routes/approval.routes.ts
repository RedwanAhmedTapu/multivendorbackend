// src/modules/hrm/routes/approval.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requirePermission } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { approvalController } from "../controllers/approval.controller.ts";

const router = Router();
router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope, requirePermission("hrManagement"));

router.post("/workflows", approvalController.createWorkflow);
router.get("/workflows", approvalController.listWorkflows);

router.get("/requests", approvalController.listPending);
router.get("/requests/:id", approvalController.getById);
router.patch("/requests/:id/act", approvalController.actOn);

export default router;
