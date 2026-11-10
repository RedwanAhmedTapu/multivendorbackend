// src/modules/hrm/routes/employeeProfile.routes.ts
import { Router } from "express";
import { z } from "zod";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr } from "../../../middlewares/permission.middleware.ts";
import { validate } from "../../../middlewares/vendor.schema.validation.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { employeeProfileController } from "../controllers/employeeProfile.controller.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

// "my profile" — any authenticated staff member, no extra permission needed
router.get("/me", employeeProfileController.getMyProfile);

router.get("/", requireHr("hrEmployeeView"), employeeProfileController.list);
router.get("/:id", requireHr("hrEmployeeView"), employeeProfileController.getById);
router.post("/", requireHr("hrEmployeeCreate"), employeeProfileController.create);
router.put("/:id", requireHr("hrEmployeeEdit"), employeeProfileController.update);
router.delete("/:id", requireHr("hrEmployeeDelete"), employeeProfileController.remove);

// Permanent delete — typed employee code confirmation is re-verified
// server-side; the client confirmation alone is never trusted.
router.post(
  "/:id/hard-delete",
  requireHr("hrEmployeeDelete"),
  validate(z.object({ params: z.object({ id: z.string().min(1) }), body: z.object({ confirm: z.string() }) })),
  employeeProfileController.hardDelete
);

export default router;
