// src/modules/hrm/routes/department.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { departmentController } from "../controllers/department.controller.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

router.get("/", requireHr("hrEmployeeView"), departmentController.list);
router.get("/:id", requireHr("hrEmployeeView"), departmentController.getById);
router.post("/", requireHr("hrOrgEdit"), departmentController.create);
router.put("/:id", requireHr("hrOrgEdit"), departmentController.update);
router.delete("/:id", requireHr("hrOrgEdit"), departmentController.remove);

export default router;
