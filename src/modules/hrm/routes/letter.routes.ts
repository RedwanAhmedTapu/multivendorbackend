// src/modules/hrm/routes/letter.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requirePermission, requireHr } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { letterTemplateController, letterController } from "../controllers/letter.controller.ts";

const router = Router();
router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

// self-service
router.get("/mine", letterController.myLetters);

// HR/manager — letter templates
router.post("/templates", requirePermission("hrManagement"), letterTemplateController.create);
router.get("/templates", requirePermission("hrManagement"), letterTemplateController.list);
router.get("/templates/manage", requireHr("hrEmployeeView"), letterTemplateController.listAll);
router.put("/templates/:id", requirePermission("hrManagement"), letterTemplateController.update);
router.delete("/templates/:id", requireHr("hrEmployeeDelete"), letterTemplateController.remove);

// HR/manager — letters
router.post("/", requirePermission("hrManagement"), letterController.generate);
router.get("/", requirePermission("hrManagement"), letterController.list);
router.get("/:id", requirePermission("hrManagement"), letterController.getById);
router.patch("/:id/prepare", requireHr("hrEmployeeEdit"), letterController.prepare);
router.patch("/:id/approve", requireHr("hrEmployeeEdit"), letterController.approve);
router.patch("/:id/reject", requireHr("hrEmployeeEdit"), letterController.reject);
router.patch("/:id/issue", requireHr("hrEmployeeEdit"), letterController.issue);

router.get("/:id/pdf", requirePermission("hrManagement"), letterController.downloadPdf);

// self-service — an employee can download their own issued letter's PDF (ownership checked)
router.get("/mine/:id/pdf", letterController.downloadMyPdf);

export default router;
