// routes/review-admin.routes.ts
//
// Mounted at /api/admin/reviews in server.ts
//   GET   /                    → platform-wide review queue (ALL statuses)
//   PATCH /:reviewId/status    → PUBLISHED | HIDDEN + aggregate recalculation
//
// ADMIN only. Admin-side EMPLOYEE accounts are intentionally excluded until the
// permission matrix has a review-moderation key — guessing one here could let
// staff moderate without the permission being granted anywhere.

import { Router } from "express";
import { ReviewAdminController } from "../controllers/review-admin.controller.ts";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("ADMIN"));

router.get("/", ReviewAdminController.list);
router.patch("/:reviewId/status", ReviewAdminController.setStatus);

export default router;
