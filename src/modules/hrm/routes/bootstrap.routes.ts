// src/modules/hrm/routes/bootstrap.routes.ts
//
// POST /api/hrm/bootstrap — idempotent starter master data for the caller's
// tenant (statutory leave types + the starter org tree + shifts). Safe to
// call repeatedly: any type that already has rows is skipped entirely.
// Mounted at /api/hrm/bootstrap.

import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { hrBootstrapService } from "../services/hrBootstrap.service.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

router.post("/", requireHr("hrEmployeeView"), async (req, res) => {
  try {
    const created = await hrBootstrapService.ensureDefaults(req.hrScope);
    res.status(200).json({ success: true, data: created });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
