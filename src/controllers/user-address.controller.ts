// src/controllers/user-address.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { UserAddressService } from '../services/user-address.service.ts';

interface UpsertAddressInput {
  id?: string;
  locationId: string;
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  landmark?: string;
  isDefault?: boolean;
  addressType?: string;
}

export class UserAddressController {
  private service: UserAddressService;

  constructor() {
    this.service = new UserAddressService();
  }

  createAddress = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.id; // From auth middleware
      const data = req.body;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      // Validate required fields
      if (!data.locationId || !data.fullName || !data.phone || !data.addressLine1) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: locationId, fullName, phone, addressLine1',
        });
      }

      const address = await this.service.createAddress({
        ...data,
        userId,
      });

      return res.status(201).json({
        success: true,
        message: 'Address created successfully',
        data: address,
      });
    } catch (error) {
      next(error);
    }
  };

  getAddresses = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.id;
      const { isDefault } = req.query;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      const filters: any = {};
      if (isDefault !== undefined) {
        filters.isDefault = isDefault === 'true';
      }

      const addresses = await this.service.getAddressesByUser(userId, filters);

      return res.status(200).json({
        success: true,
        message: 'Addresses retrieved successfully',
        data: addresses,
        meta: {
          total: addresses.length,
          maxAllowed: 5,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  getAddressById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      const address = await this.service.getAddressById(id, userId);

      return res.status(200).json({
        success: true,
        message: 'Address retrieved successfully',
        data: address,
      });
    } catch (error) {
      next(error);
    }
  };

  getDefaultAddress = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      const address = await this.service.getDefaultAddress(userId);

      return res.status(200).json({
        success: true,
        message: 'Default address retrieved successfully',
        data: address,
      });
    } catch (error) {
      next(error);
    }
  };

  updateAddress = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id;
      const data = req.body;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      const address = await this.service.updateAddress(id, userId, data);

      return res.status(200).json({
        success: true,
        message: 'Address updated successfully',
        data: address,
      });
    } catch (error) {
      next(error);
    }
  };

  upsertAddress = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.id;
      const data: UpsertAddressInput = req.body;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      // Validate required fields
      if (!data.locationId || !data.fullName || !data.phone || !data.addressLine1) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: locationId, fullName, phone, addressLine1',
        });
      }

      const address = await this.service.upsertAddress(userId, data);

      return res.status(200).json({
        success: true,
        message: data.id ? 'Address updated successfully' : 'Address created successfully',
        data: address,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteAddress = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      await this.service.deleteAddress(id, userId);

      return res.status(200).json({
        success: true,
        message: 'Address deleted successfully',
        data: null,
      });
    } catch (error) {
      next(error);
    }
  };

  setDefaultAddress = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      const address = await this.service.setDefaultAddress(id, userId);

      return res.status(200).json({
        success: true,
        message: 'Default address set successfully',
        data: address,
      });
    } catch (error) {
      next(error);
    }
  };

  toggleDefaultAddress = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      const address = await this.service.toggleDefaultAddress(id, userId);

      return res.status(200).json({
        success: true,
        message: 'Address toggled as default successfully',
        data: address,
      });
    } catch (error) {
      next(error);
    }
  };

  getAddressCount = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
        });
      }

      const count = await this.service.getAddressCount(userId);

      return res.status(200).json({
        success: true,
        message: 'Address count retrieved successfully',
        data: {
          count,
          maxAllowed: 5,
          canAddMore: count < 5,
        },
      });
    } catch (error) {
      next(error);
    }
  };
}