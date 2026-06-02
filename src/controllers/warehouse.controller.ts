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

      const result = await this.service.createOrUpdateBulkWarehouses(vendorId, data);

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

      const warehouse = await this.service.createWarehouse({ ...data, vendorId });

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
      const { type, isDefault, locationId } = req.query;

      const filters: any = {};
      if (type) filters.type = type as typeof WarehouseType[keyof typeof WarehouseType];
      if (isDefault !== undefined) filters.isDefault = isDefault === 'true';
      if (locationId) filters.locationId = locationId as string;

      const warehouses = await this.service.getWarehousesByVendor(vendorId, filters);

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

      const warehouse = await this.service.getWarehouseById(id, includeHolidays === 'true');

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
      const data = req.body;

      const warehouse = await this.service.updateWarehouse(id, data);

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

      await this.service.deleteWarehouse(id);

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

      const warehouse = await this.service.setDefaultWarehouse(id);

      return res.status(200).json({
        success: true,
        message: 'Default warehouse set successfully',
        data: warehouse,
      });
    } catch (error) {
      next(error);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // RACK CRUD
  // ─────────────────────────────────────────────────────────────────

  createRack = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { warehouseId } = req.params;
      const body = req.body as Omit<CreateRackInput, 'warehouseId'>;

      if (!body.code) {
        return res.status(400).json({ success: false, message: 'code is required' });
      }

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
      const { isActive, row } = req.query;

      const filters: RackFilter = { warehouseId };
      if (isActive !== undefined) filters.isActive = isActive === 'true';
      if (row) filters.row = row as string;

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
  // ─────────────────────────────────────────────────────────────────

  getWarehouseStock = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { warehouseId, variantId, rackId, lowStockOnly, outOfStockOnly, page, limit } =
        req.query;

      const filters: WarehouseStockFilter = {};
      if (warehouseId) filters.warehouseId = warehouseId as string;
      if (variantId) filters.variantId = variantId as string;
      if (rackId) filters.rackId = rackId as string;
      if (lowStockOnly) filters.lowStockOnly = lowStockOnly === 'true';
      if (outOfStockOnly) filters.outOfStockOnly = outOfStockOnly === 'true';
      if (page) filters.page = parseInt(page as string, 10);
      if (limit) filters.limit = parseInt(limit as string, 10);

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