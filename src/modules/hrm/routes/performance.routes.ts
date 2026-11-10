// src/modules/hrm/routes/performance.routes.ts
import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requirePermission } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { reviewCycleController, performanceReviewController, kpiController } from "../controllers/performance.controller.ts";

const router = Router();
router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

// self-service
router.get("/reviews/mine", performanceReviewController.myReviews);
router.patch("/reviews/:id/acknowledge", performanceReviewController.acknowledge);
router.get("/kpi/assignments/mine", kpiController.myAssignments);
router.patch("/kpi/assignments/:id/submit", kpiController.submitResults);

// HR/manager
router.post("/cycles", requirePermission("hrManagement"), reviewCycleController.create);
router.get("/cycles", requirePermission("hrManagement"), reviewCycleController.list);
router.patch("/cycles/:id/close", requirePermission("hrManagement"), reviewCycleController.close);

router.post("/reviews", requirePermission("hrManagement"), performanceReviewController.create);
router.patch("/reviews/:id/submit", requirePermission("hrManagement"), performanceReviewController.submit);
router.patch("/reviews/:id/finalize", requirePermission("hrManagement"), performanceReviewController.finalize);
router.get("/reviews", requirePermission("hrManagement"), performanceReviewController.list);

router.post("/kpi/templates", requirePermission("hrManagement"), kpiController.createTemplate);
router.get("/kpi/templates", requirePermission("hrManagement"), kpiController.listTemplates);
router.post("/kpi/assignments", requirePermission("hrManagement"), kpiController.assign);
router.patch("/kpi/assignments/:id/review", requirePermission("hrManagement"), kpiController.review);
router.get("/kpi/assignments", requirePermission("hrManagement"), kpiController.list);

export default router;
