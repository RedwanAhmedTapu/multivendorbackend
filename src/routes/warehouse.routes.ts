// src/routes/warehouse.routes.ts
import { Router } from "express";
import { WarehouseController } from "../controllers/warehouse.controller.ts";
import {
  authenticateUser,
  authorizeRoles,
} from "../middlewares/auth.middleware.ts";

const router = Router();
const controller = new WarehouseController();
router.post(
  "/vendors/:vendorId/warehouses/bulk",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  controller.createOrUpdateBulkWarehouses,
);
// Warehouse routes
router.post(
  "/vendors/:vendorId/warehouses",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),

  controller.createWarehouse,
);

router.get(
  "/vendors/:vendorId/warehouses",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  controller.getWarehousesByVendor,
);

router.get(
  "/warehouses/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  controller.getWarehouseById,
);

router.patch(
  "/warehouses/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  controller.updateWarehouse,
);

router.delete(
  "/warehouses/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  controller.deleteWarehouse,
);

router.patch(
  "/warehouses/:id/set-default",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  controller.setDefaultWarehouse,
);

// Holiday routes
router.post(
  "/warehouses/:warehouseId/holidays",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),

  controller.createHoliday,
);

router.get(
  "/warehouses/:warehouseId/holidays",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  controller.getHolidaysByWarehouse,
);

router.patch(
  "/holidays/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  controller.updateHoliday,
);

router.delete(
  "/holidays/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  controller.deleteHoliday,
);

export default router;
