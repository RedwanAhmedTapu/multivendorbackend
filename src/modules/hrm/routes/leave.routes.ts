// src/modules/hrm/routes/leave.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr, requirePermission } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { leaveController } from "../controllers/leave.controller.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

// self-service — any staff member
router.get("/types", leaveController.listTypes);
router.post("/requests/mine", leaveController.createRequest);
router.get("/requests/mine", leaveController.myRequests);
router.get("/balances/mine", leaveController.myBalances);

// HR/manager config & approvals — gated
router.get("/types/manage", requireHr("hrLeaveTypesEdit"), leaveController.listAllTypes);
router.post("/types", requireHr("hrLeaveTypesEdit"), leaveController.createType);
router.put("/types/:id", requireHr("hrLeaveTypesEdit"), leaveController.updateType);
router.get("/requests", requirePermission("hrManagement"), leaveController.list);
router.get("/requests/:id", requirePermission("hrManagement"), leaveController.getById);
router.patch("/requests/:id/act", requirePermission("hrManagement"), leaveController.actOn);

export default router;
