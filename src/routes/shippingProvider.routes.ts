import { Router } from "express";
import {
  createProvider,
  updateProvider,
  deleteProvider,
  getProviders,
  getActiveProvider,
  activateProvider,
  deactivateProvider
} from "../controllers/shippingProvider.controller.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();

// Only authenticated admins can manage shipping providers
router.post("/", authenticateUser, authorizeRoles("ADMIN"), createProvider);
router.get("/", authenticateUser, authorizeRoles("ADMIN"), getProviders);
router.get("/active", getActiveProvider); // public (used at checkout)
router.put("/:id", authenticateUser, authorizeRoles("ADMIN"), updateProvider);
router.delete("/:id", authenticateUser, authorizeRoles("ADMIN"), deleteProvider);
router.patch("/:id/activate", authenticateUser, authorizeRoles("ADMIN"), activateProvider);
router.patch("/:id/deactivate", authenticateUser, authorizeRoles("ADMIN"), deactivateProvider);

export default router;
