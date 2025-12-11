import { Router } from "express";
import { TermsController } from "../controllers/terms.controller.ts";
import {
  authenticateUser,
  authorizeRoles,
} from "../middlewares/auth.middleware.ts";

const router = Router();

// Admin routes
router.post(
  "/",
  authenticateUser,
  authorizeRoles("ADMIN"),
  TermsController.create
);
router.put(
  "/:id",
  authenticateUser,
  authorizeRoles("ADMIN"),
  TermsController.update
);
router.post(
  "/:id/publish",
  authenticateUser,
  authorizeRoles("ADMIN"),
  TermsController.publish
);
router.post(
  "/:id/activate",
  authenticateUser,
  authorizeRoles("ADMIN"),
  TermsController.setActive
);
router.delete(
  "/:id",
  authenticateUser,
  authorizeRoles("ADMIN"),
  TermsController.delete
);

// Public routes
router.get("/active", TermsController.getActive);

router.get("/", TermsController.list);

export default router;
