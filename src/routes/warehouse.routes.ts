// src/routes/warehouse.routes.ts
import { Router } from 'express';
import { WarehouseController } from '../controllers/warehouse.controller.ts';
import { authenticateUser, authorizeRoles } from '../middlewares/auth.middleware.ts';

const router = Router();
const controller = new WarehouseController();

// ─────────────────────────────────────────────────────────────────
// BULK WAREHOUSE
// ─────────────────────────────────────────────────────────────────

// POST /vendors/:vendorId/warehouses/bulk
router.post(
  '/vendors/:vendorId/warehouses/bulk',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.createOrUpdateBulkWarehouses,
);

// ─────────────────────────────────────────────────────────────────
// WAREHOUSE CRUD
// ─────────────────────────────────────────────────────────────────

// POST   /vendors/:vendorId/warehouses
router.post(
  '/vendors/:vendorId/warehouses',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.createWarehouse,
);

// GET    /vendors/:vendorId/warehouses  ?type=&isDefault=&locationId=
router.get(
  '/vendors/:vendorId/warehouses',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.getWarehousesByVendor,
);

// GET    /warehouses/:id  ?includeHolidays=true
router.get(
  '/warehouses/:id',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.getWarehouseById,
);

// PATCH  /warehouses/:id
router.patch(
  '/warehouses/:id',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.updateWarehouse,
);

// DELETE /warehouses/:id
router.delete(
  '/warehouses/:id',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.deleteWarehouse,
);

// PATCH  /warehouses/:id/set-default
router.patch(
  '/warehouses/:id/set-default',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.setDefaultWarehouse,
);

// ─────────────────────────────────────────────────────────────────
// HOLIDAY CRUD
// ─────────────────────────────────────────────────────────────────

// POST   /warehouses/:warehouseId/holidays
router.post(
  '/warehouses/:warehouseId/holidays',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.createHoliday,
);

// GET    /warehouses/:warehouseId/holidays  ?startDate=&endDate=&isOpen=
router.get(
  '/warehouses/:warehouseId/holidays',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.getHolidaysByWarehouse,
);

// PATCH  /holidays/:id
router.patch(
  '/holidays/:id',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.updateHoliday,
);

// DELETE /holidays/:id
router.delete(
  '/holidays/:id',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.deleteHoliday,
);

// ─────────────────────────────────────────────────────────────────
// STOCK — RECEIVE PURCHASE ORDER
// ─────────────────────────────────────────────────────────────────

// POST /warehouses/:warehouseId/stock/receive
// Body: { purchaseOrderId, vendorId, items: [...], createdBy? }
router.post(
  '/warehouses/:warehouseId/stock/receive',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.receivePurchaseOrder,
);

// ─────────────────────────────────────────────────────────────────
// STOCK — ADJUSTMENT / DAMAGE / RETURN
// ─────────────────────────────────────────────────────────────────

// POST /stock/adjust
// Body: { variantId, warehouseId, vendorId, quantity, movementType, reason?, notes? }
router.post(
  '/stock/adjust',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.adjustStock,
);

// ─────────────────────────────────────────────────────────────────
// STOCK — WAREHOUSE TRANSFER
// ─────────────────────────────────────────────────────────────────

// POST /stock/transfer
// Body: { variantId, fromWarehouseId, toWarehouseId, vendorId, quantity, reason?, notes? }
router.post(
  '/stock/transfer',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.transferStock,
);

// ─────────────────────────────────────────────────────────────────
// STOCK — SELL DAMAGED
// ─────────────────────────────────────────────────────────────────

// POST /stock/sell-damaged
// Body: { variantId, fromWarehouseId, vendorId, quantity, saleAmount, coaAccountId?, reason?, notes? }
router.post(
  '/stock/sell-damaged',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.sellDamagedStock,
);

// ─────────────────────────────────────────────────────────────────
// STOCK — QUERY
// ─────────────────────────────────────────────────────────────────

// GET /stock  ?warehouseId=&variantId=&lowStockOnly=&outOfStockOnly=&page=&limit=
router.get(
  '/stock',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.getWarehouseStock,
);

// GET /stock/movements  ?variantId=&warehouseId=&movementType=&startDate=&endDate=&page=&limit=
router.get(
  '/stock/movements',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENDOR'),
  controller.getStockMovements,
);

export default router;