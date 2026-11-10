// src/controllers/warehouse.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { WarehouseService } from '../services/warehouse.service.ts';
import type {
  ReceivePurchaseOrderInput,
  StockAdjustmentInput,
  StockTransferInput,
  WarehouseStockFilter,
  CreateRackInput,
  UpdateRackInput,
  RackFilter,
} from '../services/warehouse.service.ts';
import pkg from '@prisma/client';
const { WarehouseType } = pkg;
import type { StockMovementType } from '@prisma/client';
import {
  actorFromRequest,
  assertWarehouseAccess,
  assertVendorAccess,
  isPlatformAdmin,
} from '../modules/shared/warehouse-guard.ts';

interface BulkWarehouseInput {
  pickupWarehouse: {
    locationId: string;
    address: string;
    code?: string;
    name?: string;
    email?: string;
    phone?: string;
  };
  returnWarehouse?: {
    locationId: string;
    address: string;
    code?: string;
    name?: string;
    email?: string;
    phone?: string;
    sameAsPickup?: boolean;
  };
}

export class WarehouseController {
  private service: WarehouseService;

  constructor() {
    this.service = new WarehouseService();
  }

  // Vendor isolation helpers — every handler resolves the authenticated actor
  // and proves ownership of each warehouse it touches.
  private async guardWarehouse(req: Request, warehouseId: unknown) {
    return assertWarehouseAccess(String(warehouseId ?? ''), actorFromRequest(req));
  }
  private async guardRack(req: Request, rackId: unknown) {
    await this.guardWarehouse(req, await this.service.getRackWarehouseId(String(rackId ?? '')));
  }
  private async guardHoliday(req: Request, holidayId: unknown) {
    await this.guardWarehouse(req, await this.service.getHolidayWarehouseId(String(holidayId ?? '')));
  }
  /** Vendor scope for list endpoints: non-admins only ever see their own vendor. */
  private scopedVendorId(req: Request): string | undefined {
    const actor = actorFromRequest(req);
    if (isPlatformAdmin(actor)) return undefined;
    assertVendorAccess(actor.vendorId ?? '', actor);
    return actor.vendorId ?? undefined;
  }

  // ─────────────────────────────────────────────────────────────────
  // BULK CREATE / UPDATE
  // ─────────────────────────────────────────────────────────────────

  createOrUpdateBulkWarehouses = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vendorId } = req.params;
      const data: BulkWarehouseInput = req.body;

      if (!data.pickupWarehouse) {
        return res.status(400).json({
          success: false,
          message: 'Pickup warehouse data is required',
        });
      }

      const result = await this.service.createOrUpdateBulkWarehouses(vendorId, data, actorFromRequest(req));

      return res.status(200).json({
        success: true,
        message: 'Warehouses saved successfully',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // WAREHOUSE CRUD
  // ─────────────────────────────────────────────────────────────────

  createWarehouse = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vendorId } = req.params;
      const data = req.body;

      // vendorId comes from the route only; the service picks allow-listed fields.
      const warehouse = await this.service.createWarehouse({ ...data, vendorId }, actorFromRequest(req));

      return res.status(201).json({
        success: true,
        message: 'Warehouse created successfully',
        data: warehouse,
      });
    } catch (error) {
      next(error);
    }
  };

  getWarehousesByVendor = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vendorId } = req.params;
      const { type, isDefault, locationId, isActive } = req.query;

      const filters: any = {};
      if (type) filters.type = type as typeof WarehouseType[keyof typeof WarehouseType];
      if (isDefault !== undefined) filters.isDefault = isDefault === 'true';
      if (locationId) filters.locationId = locationId as string;
      if (isActive !== undefined) filters.isActive = isActive === 'true';

      const warehouses = await this.service.getWarehousesByVendor(vendorId, filters, actorFromRequest(req));

      return res.status(200).json({
        success: true,
        message: 'Warehouses retrieved successfully',
        data: warehouses,
      });
    } catch (error) {
      next(error);
    }
  };

  getWarehouseById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { includeHolidays } = req.query;

      const warehouse = await this.service.getWarehouseById(id, includeHolidays === 'true', actorFromRequest(req));

      return res.status(200).json({
        success: true,
        message: 'Warehouse retrieved successfully',
        data: warehouse,
      });
    } catch (error) {
      next(error);
    }
  };

  updateWarehouse = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      // The body is never passed to Prisma: the service applies an explicit
      // allow-list, rejects vendorId/id, and enforces field locks.
      const warehouse = await this.service.updateWarehouse(id, req.body, actorFromRequest(req));

      return res.status(200).json({
        success: true,
        message: 'Warehouse updated successfully',
        data: warehouse,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteWarehouse = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      await this.service.deleteWarehouse(id, actorFromRequest(req));

      return res.status(200).json({
        success: true,
        message: 'Warehouse deleted successfully',
        data: null,
      });
    } catch (error) {
      next(error);
    }
  };

  setDefaultWarehouse = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const warehouse = await this.service.setDefaultWarehouse(id, actorFromRequest(req));

      return res.status(200).json({
        success: true,
        message: 'Default warehouse set successfully',
        data: warehouse,
      });
    } catch (error) {
      next(error);
    }
  };

  /** GET /warehouses/:id/usage — derived operational state, field locks, deactivate/delete eligibility. */
  getWarehouseUsage = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const usage = await this.service.getWarehouseUsageForActor(String(req.params.id), actorFromRequest(req));
      return res.status(200).json({ success: true, message: 'Warehouse usage retrieved successfully', data: usage });
    } catch (error) {
      next(error);
    }
  };

  /** PATCH /warehouses/:id/deactivate */
  deactivateWarehouse = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const warehouse = await this.service.deactivateWarehouse(String(req.params.id), actorFromRequest(req));
      return res.status(200).json({ success: true, message: 'Warehouse deactivated successfully', data: warehouse });
    } catch (error) {
      next(error);
    }
  };

  /** PATCH /warehouses/:id/reactivate */
  reactivateWarehouse = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const warehouse = await this.service.reactivateWarehouse(String(req.params.id), actorFromRequest(req));
      return res.status(200).json({ success: true, message: 'Warehouse reactivated successfully', data: warehouse });
    } catch (error) {
      next(error);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // RACK CRUD
  // body: { code, label?, totalRows?, totalShelves?, isActive? }
  // ─────────────────────────────────────────────────────────────────

  createRack = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { warehouseId } = req.params;
      const body = req.body as Omit<CreateRackInput, 'warehouseId'>;

      if (!body.code) {
        return res.status(400).json({ success: false, message: 'code is required' });
      }
      if (body.totalRows !== undefined && (!Number.isInteger(body.totalRows) || body.totalRows < 1)) {
        return res.status(400).json({ success: false, message: 'totalRows must be a positive integer' });
      }
      if (body.totalShelves !== undefined && (!Number.isInteger(body.totalShelves) || body.totalShelves < 1)) {
        return res.status(400).json({ success: false, message: 'totalShelves must be a positive integer' });
      }

      await this.guardWarehouse(req, warehouseId);
      const rack = await this.service.createRack({ ...body, warehouseId });

      return res.status(201).json({
        success: true,
        message: 'Rack created successfully',
        data: rack,
      });
    } catch (error) {
      next(error);
    }
  };

  getRacksByWarehouse = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { warehouseId } = req.params;
      const { isActive } = req.query;

      const filters: RackFilter = { warehouseId };
      if (isActive !== undefined) filters.isActive = isActive === 'true';

      await this.guardWarehouse(req, warehouseId);
      const racks = await this.service.getRacksByWarehouse(warehouseId, filters);

      return res.status(200).json({
        success: true,
        message: 'Racks retrieved successfully',
        data: racks,
      });
    } catch (error) {
      next(error);
    }
  };

  getRackById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      await this.guardRack(req, id);
      const rack = await this.service.getRackById(id);

      return res.status(200).json({
        success: true,
        message: 'Rack retrieved successfully',
        data: rack,
      });
    } catch (error) {
      next(error);
    }
  };

  updateRack = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = req.body as UpdateRackInput;

      if (data.totalRows !== undefined && (!Number.isInteger(data.totalRows) || data.totalRows < 1)) {
        return res.status(400).json({ success: false, message: 'totalRows must be a positive integer' });
      }
      if (data.totalShelves !== undefined && (!Number.isInteger(data.totalShelves) || data.totalShelves < 1)) {
        return res.status(400).json({ success: false, message: 'totalShelves must be a positive integer' });
      }

      await this.guardRack(req, id);
      const rack = await this.service.updateRack(id, data);

      return res.status(200).json({
        success: true,
        message: 'Rack updated successfully',
        data: rack,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteRack = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      await this.guardRack(req, id);
      await this.service.deleteRack(id);

      return res.status(200).json({
        success: true,
        message: 'Rack deleted successfully',
        data: null,
      });
    } catch (error) {
      next(error);
    }
  };

  toggleRackActive = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      await this.guardRack(req, id);
      const rack = await this.service.toggleRackActive(id);

      return res.status(200).json({
        success: true,
        message: `Rack ${rack.isActive ? 'activated' : 'deactivated'} successfully`,
        data: rack,
      });
    } catch (error) {
      next(error);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // HOLIDAY CRUD
  // ─────────────────────────────────────────────────────────────────

  createHoliday = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { warehouseId } = req.params;
      const data = req.body;

      await this.guardWarehouse(req, warehouseId);
      const holiday = await this.service.createHoliday({ ...data, warehouseId });

      return res.status(201).json({
        success: true,
        message: 'Holiday created successfully',
        data: holiday,
      });
    } catch (error) {
      next(error);
    }
  };

  getHolidaysByWarehouse = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { warehouseId } = req.params;
      const { startDate, endDate, isOpen } = req.query;

      const filters: any = {};
      if (startDate) filters.startDate = new Date(startDate as string);
      if (endDate) filters.endDate = new Date(endDate as string);
      if (isOpen !== undefined) filters.isOpen = isOpen === 'true';

      await this.guardWarehouse(req, warehouseId);
      const holidays = await this.service.getHolidaysByWarehouse(warehouseId, filters);

      return res.status(200).json({
        success: true,
        message: 'Holidays retrieved successfully',
        data: holidays,
      });
    } catch (error) {
      next(error);
    }
  };

  updateHoliday = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = req.body;

      await this.guardHoliday(req, id);
      const holiday = await this.service.updateHoliday(id, data);

      return res.status(200).json({
        success: true,
        message: 'Holiday updated successfully',
        data: holiday,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteHoliday = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      await this.guardHoliday(req, id);
      await this.service.deleteHoliday(id);

      return res.status(200).json({
        success: true,
        message: 'Holiday deleted successfully',
        data: null,
      });
    } catch (error) {
      next(error);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // STOCK — RECEIVE PURCHASE ORDER
  // items[].rackId / rowNumber / shelfNumber are optional bin placement
  // ─────────────────────────────────────────────────────────────────

  receivePurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { warehouseId } = req.params;
      const body = req.body as Omit<ReceivePurchaseOrderInput, 'warehouseId'>;

      if (!body.purchaseOrderId) {
        return res.status(400).json({ success: false, message: 'purchaseOrderId is required' });
      }
      if (!body.vendorId) {
        return res.status(400).json({ success: false, message: 'vendorId is required' });
      }
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'items array is required and must not be empty',
        });
      }
      for (const item of body.items) {
        if ((item.rowNumber !== undefined || item.shelfNumber !== undefined) && !item.rackId) {
          return res.status(400).json({
            success: false,
            message: 'rowNumber/shelfNumber require a rackId on each item',
          });
        }
      }

      const wh = await this.guardWarehouse(req, warehouseId);
      if (body.vendorId !== wh.vendorId) {
        return res.status(403).json({ success: false, message: 'vendorId does not match the warehouse owner' });
      }
      const result = await this.service.receivePurchaseOrder({
        ...body,
        warehouseId,
        createdBy: (req as any).user?.id,
      });

      return res.status(200).json({
        success: true,
        message: 'Purchase order received successfully',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // STOCK — ADJUSTMENT / DAMAGE / RETURN
  // body optionally includes rackId / rowNumber / shelfNumber to scope
  // the adjustment to a specific bin
  // ─────────────────────────────────────────────────────────────────

  adjustStock = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as StockAdjustmentInput;

      const allowedTypes = ['ADJUSTMENT', 'DAMAGE', 'RETURN'];
      if (!body.variantId) {
        return res.status(400).json({ success: false, message: 'variantId is required' });
      }
      if (!body.warehouseId) {
        return res.status(400).json({ success: false, message: 'warehouseId is required' });
      }
      if (!body.vendorId) {
        return res.status(400).json({ success: false, message: 'vendorId is required' });
      }
      if (!body.quantity || body.quantity <= 0) {
        return res.status(400).json({ success: false, message: 'quantity must be a positive number' });
      }
      if (!body.movementType || !allowedTypes.includes(body.movementType)) {
        return res.status(400).json({
          success: false,
          message: `movementType must be one of: ${allowedTypes.join(', ')}`,
        });
      }
      if ((body.rowNumber !== undefined || body.shelfNumber !== undefined) && !body.rackId) {
        return res.status(400).json({
          success: false,
          message: 'rowNumber/shelfNumber require a rackId',
        });
      }

      const wh = await this.guardWarehouse(req, body.warehouseId);
      if (body.vendorId !== wh.vendorId) {
        return res.status(403).json({ success: false, message: 'vendorId does not match the warehouse owner' });
      }
      const movement = await this.service.adjustStock({
        ...body,
        createdBy: (req as any).user?.id,
      });

      return res.status(200).json({
        success: true,
        message: 'Stock adjusted successfully',
        data: movement,
      });
    } catch (error) {
      next(error);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // STOCK — WAREHOUSE TRANSFER
  // body optionally includes fromRackId/fromRowNumber/fromShelfNumber
  // and toRackId/toRowNumber/toShelfNumber
  // ─────────────────────────────────────────────────────────────────

  transferStock = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as StockTransferInput;

      if (!body.variantId) {
        return res.status(400).json({ success: false, message: 'variantId is required' });
      }
      if (!body.fromWarehouseId) {
        return res.status(400).json({ success: false, message: 'fromWarehouseId is required' });
      }
      if (!body.toWarehouseId) {
        return res.status(400).json({ success: false, message: 'toWarehouseId is required' });
      }
      if (!body.vendorId) {
        return res.status(400).json({ success: false, message: 'vendorId is required' });
      }
      if (!body.quantity || body.quantity <= 0) {
        return res.status(400).json({ success: false, message: 'quantity must be a positive number' });
      }
      if ((body.fromRowNumber !== undefined || body.fromShelfNumber !== undefined) && !body.fromRackId) {
        return res.status(400).json({
          success: false,
          message: 'fromRowNumber/fromShelfNumber require a fromRackId',
        });
      }
      if ((body.toRowNumber !== undefined || body.toShelfNumber !== undefined) && !body.toRackId) {
        return res.status(400).json({
          success: false,
          message: 'toRowNumber/toShelfNumber require a toRackId',
        });
      }

      const wh = await this.guardWarehouse(req, body.fromWarehouseId);
      await this.guardWarehouse(req, body.toWarehouseId);
      if (body.vendorId !== wh.vendorId) {
        return res.status(403).json({ success: false, message: 'vendorId does not match the warehouse owner' });
      }
      const movement = await this.service.transferStock({
        ...body,
        createdBy: (req as any).user?.id,
      });

      return res.status(200).json({
        success: true,
        message: 'Stock transferred successfully',
        data: movement,
      });
    } catch (error) {
      next(error);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // STOCK — SELL DAMAGED
  // body optionally includes fromRackId/fromRowNumber/fromShelfNumber
  // to identify the specific damaged-stock bin being sold off
  // ─────────────────────────────────────────────────────────────────

  sellDamagedStock = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as StockTransferInput;

      if (!body.variantId) {
        return res.status(400).json({ success: false, message: 'variantId is required' });
      }
      if (!body.fromWarehouseId) {
        return res.status(400).json({ success: false, message: 'fromWarehouseId is required' });
      }
      if (!body.vendorId) {
        return res.status(400).json({ success: false, message: 'vendorId is required' });
      }
      if (!body.quantity || body.quantity <= 0) {
        return res.status(400).json({ success: false, message: 'quantity must be a positive number' });
      }
      if (!body.saleAmount || body.saleAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'saleAmount is required and must be positive',
        });
      }
      if ((body.fromRowNumber !== undefined || body.fromShelfNumber !== undefined) && !body.fromRackId) {
        return res.status(400).json({
          success: false,
          message: 'fromRowNumber/fromShelfNumber require a fromRackId',
        });
      }

      const wh = await this.guardWarehouse(req, body.fromWarehouseId);
      if (body.vendorId !== wh.vendorId) {
        return res.status(403).json({ success: false, message: 'vendorId does not match the warehouse owner' });
      }
      const movement = await this.service.sellDamagedStock({
        ...body,
        createdBy: (req as any).user?.id,
      });

      return res.status(200).json({
        success: true,
        message: 'Damaged stock sold successfully',
        data: movement,
      });
    } catch (error) {
      next(error);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // STOCK — QUERY
  // ?warehouseId=&variantId=&rackId=&rowNumber=&shelfNumber=&lowStockOnly=&outOfStockOnly=&page=&limit=
  // ─────────────────────────────────────────────────────────────────

  getWarehouseStock = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        warehouseId,
        variantId,
        rackId,
        rowNumber,
        shelfNumber,
        lowStockOnly,
        outOfStockOnly,
        page,
        limit,
      } = req.query;

      const filters: WarehouseStockFilter = {};
      if (warehouseId) filters.warehouseId = warehouseId as string;
      if (variantId) filters.variantId = variantId as string;
      if (rackId) filters.rackId = rackId as string;
      if (rowNumber) filters.rowNumber = parseInt(rowNumber as string, 10);
      if (shelfNumber) filters.shelfNumber = parseInt(shelfNumber as string, 10);
      if (lowStockOnly) filters.lowStockOnly = lowStockOnly === 'true';
      if (outOfStockOnly) filters.outOfStockOnly = outOfStockOnly === 'true';
      if (page) filters.page = parseInt(page as string, 10);
      if (limit) filters.limit = parseInt(limit as string, 10);
      if (filters.warehouseId) await this.guardWarehouse(req, filters.warehouseId);
      const scopedVendorId = this.scopedVendorId(req);
      if (scopedVendorId) filters.vendorId = scopedVendorId;

      const result = await this.service.getWarehouseStock(filters);

      return res.status(200).json({
        success: true,
        message: 'Warehouse stock retrieved successfully',
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  };

  getStockMovements = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { variantId, warehouseId, movementType, startDate, endDate, page, limit } = req.query;

      const filters: any = {};
      if (variantId) filters.variantId = variantId as string;
      if (warehouseId) filters.warehouseId = warehouseId as string;
      if (movementType) filters.movementType = movementType as StockMovementType;
      if (startDate) filters.startDate = new Date(startDate as string);
      if (endDate) filters.endDate = new Date(endDate as string);
      if (page) filters.page = parseInt(page as string, 10);
      if (limit) filters.limit = parseInt(limit as string, 10);
      if (filters.warehouseId) await this.guardWarehouse(req, filters.warehouseId);
      const scopedVendorId = this.scopedVendorId(req);
      if (scopedVendorId) filters.vendorId = scopedVendorId;

      const result = await this.service.getStockMovements(filters);

      return res.status(200).json({
        success: true,
        message: 'Stock movements retrieved successfully',
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  };
}