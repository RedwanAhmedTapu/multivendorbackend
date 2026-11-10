// routes/review-vendor.routes.ts
//
// Mounted at /api/vendor/reviews in server.ts
//   GET  /                 → the vendor's own products' reviews
//   POST /:reviewId/reply  → one seller response per review
//
// VENDOR and vendor EMPLOYEE both authenticate; the service scopes every query
// by req.user.vendorId, so an employee of vendor A can never read vendor B.

import { Router } from "express";
import { ReviewVendorController } from "../controllers/review-vendor.controller.ts";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("VENDOR", "EMPLOYEE"));

router.get("/", ReviewVendorController.list);
router.post("/:reviewId/reply", ReviewVendorController.reply);

export default router;
