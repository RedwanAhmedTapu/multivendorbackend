import express from "express";
import { FraudProviderAdminController } from "./fraud-provider.admin.controller.ts";
// Adjust this path to your project's actual admin-auth middleware —
// it depends on where you place this module (e.g. if you drop this
// whole folder into src/modules/fraud-checker/, and your middleware
// lives at src/middlewares/, the path below is "../../../middlewares/...").
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";

const router = express.Router();
const controller = new FraudProviderAdminController();

router.use(authenticateUser);
router.use(authorizeRoles("ADMIN")); // Only admins can manage fraud-checker providers

router.get("/available", controller.listAvailable);
router.get("/", controller.list);
router.get("/:id", controller.getById);
router.get("/:id/logs", controller.getLogs);
router.post("/", controller.create);
router.post("/:id/test", controller.testConnection);
router.patch("/:id", controller.update);
router.patch("/:id/active", controller.setActive);
router.delete("/:id", controller.remove);

export default router;

// Mount at the app level so it matches this project's sibling admin API
// naming (/admin-orders, /user-orders, etc.) and the adminFraudProviderApi.ts
// RTK Query slice, which calls these exact paths:
//   import fraudProviderRoutes from "./modules/fraud-checker/admin/fraud-provider.admin.routes.ts";
//   app.use("/admin-fraud-providers", fraudProviderRoutes);
