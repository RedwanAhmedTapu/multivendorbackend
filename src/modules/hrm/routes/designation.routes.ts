// src/modules/hrm/routes/designation.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { designationController } from "../controllers/designation.controller.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

router.get("/", requireHr("hrEmployeeView"), designationController.list);
router.get("/:id", requireHr("hrEmployeeView"), designationController.getById);
router.post("/", requireHr("hrOrgEdit"), designationController.create);
router.put("/:id", requireHr("hrOrgEdit"), designationController.update);
router.delete("/:id", requireHr("hrOrgEdit"), designationController.remove);

export default router;
