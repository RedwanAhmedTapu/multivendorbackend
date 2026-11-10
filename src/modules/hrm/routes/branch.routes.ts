// src/modules/hrm/routes/branch.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { branchController } from "../controllers/branch.controller.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

router.get("/", requireHr("hrEmployeeView"), branchController.list);
router.get("/:id", requireHr("hrEmployeeView"), branchController.getById);
router.post("/", requireHr("hrOrgEdit"), branchController.create);
router.put("/:id", requireHr("hrOrgEdit"), branchController.update);
router.delete("/:id", requireHr("hrOrgEdit"), branchController.remove);

export default router;
