// src/controllers/warehouse.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { WarehouseService } from '../services/warehouse.service.ts';
import { WarehouseType } from '@prisma/client';
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

  createOrUpdateBulkWarehouses = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vendorId } = req.params;
      const data: BulkWarehouseInput = req.body;

      // Validate input
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

  createWarehouse = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vendorId } = req.params;
      const data = req.body;

      const warehouse = await this.service.createWarehouse({
        ...data,
        vendorId,
      });

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
      if (type) filters.type = type as WarehouseType;
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

      const warehouse = await this.service.getWarehouseById(
        id, 
        includeHolidays === 'true'
      );

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

  createHoliday = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { warehouseId } = req.params;
      const data = req.body;

      const holiday = await this.service.createHoliday({
        ...data,
        warehouseId,
      });

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
}