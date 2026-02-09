import type { Request, Response, NextFunction } from 'express';
import courierService from '../services/courier.service.ts';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class CourierController {
  // ==================== COURIER PROVIDER ENDPOINTS ====================

  /**
   * Get all courier providers
   * GET /api/courier/admin/providers
   */
  async getCourierProviders(req: Request, res: Response, next: NextFunction) {
    try {
      const { isActive, authType, includeCredentials } = req.query;

      const filters: any = {};
      
      if (isActive !== undefined) {
        filters.isActive = isActive === 'true';
      }
      
      if (authType) {
        filters.authType = authType;
      }
      
      if (includeCredentials !== undefined) {
        filters.includeCredentials = includeCredentials === 'true';
      }

      const result = await courierService.getAllCourierProviders(filters);

      res.status(200).json({
        success: true,
        data: result,
        count: result.length,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get single courier provider
   * GET /api/courier/admin/providers/:providerId
   */
  async getCourierProviderById(req: Request, res: Response, next: NextFunction) {
    try {
      const { providerId } = req.params;

      const result = await courierService.getCourierProviderById(providerId);

      if (!result) {
        return res.status(404).json({
          success: false,
          message: 'Courier provider not found',
        });
      }

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Create courier provider
   * POST /api/courier/admin/providers
   */
  async createCourierProvider(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        name,
        displayName,
        description,
        logo,
        sandboxBaseUrl,
        productionBaseUrl,
        authType,
        supportsCOD,
        supportsTracking,
        supportsBulkOrder,
        supportsWebhook,
        priority,
        isPreferred,
        statusMappings,
      } = req.body;

      // Validation
      if (!name || !productionBaseUrl || !authType) {
        return res.status(400).json({
          success: false,
          message: 'name, productionBaseUrl, and authType are required',
        });
      }

      const result = await courierService.createCourierProvider({
        name,
        displayName,
        description,
        logo,
        sandboxBaseUrl,
        productionBaseUrl,
        authType,
        supportsCOD,
        supportsTracking,
        supportsBulkOrder,
        supportsWebhook,
        priority,
        isPreferred,
        statusMappings,
      });

      res.status(201).json({
        success: true,
        message: 'Courier provider created successfully',
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Update courier provider
   * PUT /api/courier/admin/providers/:providerId
   */
  async updateCourierProvider(req: Request, res: Response, next: NextFunction) {
    try {
      const { providerId } = req.params;
      const updateData = req.body;

      const result = await courierService.updateCourierProvider(providerId, updateData);

      res.status(200).json({
        success: true,
        message: 'Courier provider updated successfully',
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Delete courier provider
   * DELETE /api/courier/admin/providers/:providerId
   */
  async deleteCourierProvider(req: Request, res: Response, next: NextFunction) {
    try {
      const { providerId } = req.params;

      await courierService.deleteCourierProvider(providerId);

      res.status(200).json({
        success: true,
        message: 'Courier provider deleted successfully',
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Toggle provider active status
   * PATCH /api/courier/admin/providers/:providerId/toggle
   */
  async toggleProviderStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { providerId } = req.params;

      const result = await courierService.toggleProviderStatus(providerId);

      res.status(200).json({
        success: true,
        message: `Provider ${result.isActive ? 'activated' : 'deactivated'} successfully`,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== CREDENTIALS ENDPOINTS ====================

  /**
   * Get all credentials
   * GET /api/courier/admin/credentials
   */
  async getAllCredentials(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment, isActive, vendorId } = req.query;

      const filters: any = {};
      
      if (courierProviderId) {
        filters.courierProviderId = courierProviderId as string;
      }
      
      if (environment) {
        filters.environment = environment as 'SANDBOX' | 'PRODUCTION';
      }
      
      if (isActive !== undefined) {
        filters.isActive = isActive === 'true';
      }
      
      if (vendorId !== undefined) {
        filters.vendorId = vendorId === 'null' ? null : (vendorId as string);
      }

      const result = await courierService.getAllCredentials(filters);

      res.status(200).json({
        success: true,
        data: result,
        count: result.length,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get credential by ID
   * GET /api/courier/admin/credentials/:credentialId
   */
  async getCredentialById(req: Request, res: Response, next: NextFunction) {
    try {
      const { credentialId } = req.params;

      const result = await courierService.getCredentialById(credentialId);

      if (!result) {
        return res.status(404).json({
          success: false,
          message: 'Credentials not found',
        });
      }

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Create platform courier credentials
   * POST /api/courier/admin/credentials
   */
  async createCourierCredentials(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        courierProviderId,
        environment,
        clientId,
        clientSecret,
        username,
        password,
        apiKey,
        bearerToken,
        storeId,
        merchantId,
        vendorId,
      } = req.body;

      // Validation
      if (!courierProviderId || !environment) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId and environment are required',
        });
      }

      const result = await courierService.createPlatformCourierCredentials({
        courierProviderId,
        environment,
        clientId,
        clientSecret,
        username,
        password,
        apiKey,
        bearerToken,
        storeId,
        merchantId,
        vendorId,
      });

      res.status(201).json({
        success: true,
        message: 'Courier credentials created successfully',
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Update platform courier credentials
   * PUT /api/courier/admin/credentials/:credentialId
   */
  async updateCourierCredentials(req: Request, res: Response, next: NextFunction) {
    try {
      const { credentialId } = req.params;
      const updateData = req.body;

      const result = await courierService.updatePlatformCourierCredentials(
        credentialId,
        updateData
      );

      res.status(200).json({
        success: true,
        message: 'Courier credentials updated successfully',
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Delete platform courier credentials
   * DELETE /api/courier/admin/credentials/:credentialId
   */
  async deleteCourierCredentials(req: Request, res: Response, next: NextFunction) {
    try {
      const { credentialId } = req.params;

      await courierService.deletePlatformCourierCredentials(credentialId);

      res.status(200).json({
        success: true,
        message: 'Courier credentials deleted successfully',
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Toggle credential active status
   * PATCH /api/courier/admin/credentials/:credentialId/toggle
   */
  async toggleCredentialStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { credentialId } = req.params;

      const result = await courierService.toggleCredentialStatus(credentialId);

      res.status(200).json({
        success: true,
        message: `Credentials ${result.isActive ? 'activated' : 'deactivated'} successfully`,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Test courier credentials
   * POST /api/courier/admin/credentials/:credentialId/test
   */
  async testCourierCredentials(req: Request, res: Response, next: NextFunction) {
    try {
      const { credentialId } = req.params;

      const credential = await prisma.courier_credentials.findUnique({
        where: { id: credentialId },
        include: { courier_providers: true },
      });

      if (!credential) {
        return res.status(404).json({
          success: false,
          message: 'Credentials not found',
        });
      }

      let testResult: any = { success: false, message: '' };

      // Test based on courier provider
      if (credential.courier_providers.name === 'Pathao') {
        try {
          await courierService.pathaoIssueToken(
            credential.courierProviderId,
            credential.environment
          );
          testResult = { success: true, message: 'Pathao credentials are valid' };
        } catch (error: any) {
          testResult = { success: false, message: `Pathao test failed: ${error.message}` };
        }
      } else if (credential.courier_providers.name === 'RedX') {
        try {
          await courierService.redxGetAreas(
            credential.courierProviderId,
            undefined,
            credential.environment
          );
          testResult = { success: true, message: 'RedX credentials are valid' };
        } catch (error: any) {
          testResult = { success: false, message: `RedX test failed: ${error.message}` };
        }
      } else {
        testResult = { success: false, message: 'Credential testing not implemented for this provider' };
      }

      res.status(200).json({
        success: testResult.success,
        message: testResult.message,
        data: {
          courierName: credential.courier_providers.name,
          environment: credential.environment,
        },
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Refresh OAuth token
   * POST /api/courier/admin/credentials/:credentialId/refresh-token
   */
  async refreshCredentialToken(req: Request, res: Response, next: NextFunction) {
    try {
      const { credentialId } = req.params;

      const credential = await prisma.courier_credentials.findUnique({
        where: { id: credentialId },
        include: { courier_providers: true },
      });

      if (!credential) {
        return res.status(404).json({
          success: false,
          message: 'Credentials not found',
        });
      }

      if (credential.courier_providers.authType !== 'OAUTH2') {
        return res.status(400).json({
          success: false,
          message: 'Token refresh is only available for OAuth2 authentication',
        });
      }

      if (credential.courier_providers.name === 'Pathao') {
        const tokenResponse = await courierService.pathaoRefreshToken(
          credential.courierProviderId,
          credential.environment
        );

        res.status(200).json({
          success: true,
          message: 'Token refreshed successfully',
          data: {
            expiresIn: tokenResponse.expires_in,
          },
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Token refresh not implemented for this provider',
        });
      }
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== SERVICEABLE AREAS ENDPOINTS ====================

  /**
   * Get serviceable areas
   * GET /api/courier/admin/serviceable-areas
   */
  async getServiceableAreas(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        courierProviderId,
        locationId,
        homeDeliveryAvailable,
        pickupAvailable,
        isActive,
        search,
      } = req.query;

      const filters: any = {};
      
      if (courierProviderId) {
        filters.courierProviderId = courierProviderId as string;
      }
      
      if (locationId) {
        filters.locationId = locationId as string;
      }
      
      if (homeDeliveryAvailable !== undefined) {
        filters.homeDeliveryAvailable = homeDeliveryAvailable === 'true';
      }
      
      if (pickupAvailable !== undefined) {
        filters.pickupAvailable = pickupAvailable === 'true';
      }
      
      if (isActive !== undefined) {
        filters.isActive = isActive === 'true';
      }
      
      if (search) {
        filters.search = search as string;
      }

      const result = await courierService.getServiceableAreas(filters);

      res.status(200).json({
        success: true,
        data: result,
        count: result.length,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Sync courier serviceable areas
   * POST /api/courier/admin/serviceable-areas/sync
   */
  async syncServiceableAreas(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, areas } = req.body;

      if (!courierProviderId || !areas || !Array.isArray(areas)) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId and areas array are required',
        });
      }

      const result = await courierService.syncServiceableAreas(courierProviderId, areas);

      res.status(200).json({
        success: true,
        message: `Successfully synced ${result.length} serviceable areas`,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Delete serviceable area
   * DELETE /api/courier/admin/serviceable-areas/:areaId
   */
  async deleteServiceableArea(req: Request, res: Response, next: NextFunction) {
    try {
      const { areaId } = req.params;

      await courierService.deleteServiceableArea(areaId);

      res.status(200).json({
        success: true,
        message: 'Serviceable area deleted successfully',
      });
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== PATHAO SPECIFIC ENDPOINTS ====================

  /**
   * Get Pathao cities
   * GET /api/courier/admin/pathao/cities
   */
  async pathaoGetCities(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment = 'PRODUCTION' } = req.query;

      if (!courierProviderId) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId is required',
        });
      }

      const result = await courierService.pathaoGetCities(
        courierProviderId as string,
        environment as 'SANDBOX' | 'PRODUCTION'
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get Pathao zones
   * GET /api/courier/admin/pathao/cities/:cityId/zones
   */
  async pathaoGetZones(req: Request, res: Response, next: NextFunction) {
    try {
      const { cityId } = req.params;
      const { courierProviderId, environment = 'PRODUCTION' } = req.query;

      if (!courierProviderId || !cityId) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId and cityId are required',
        });
      }

      const result = await courierService.pathaoGetZones(
        courierProviderId as string,
        parseInt(cityId),
        environment as 'SANDBOX' | 'PRODUCTION'
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get Pathao areas
   * GET /api/courier/admin/pathao/zones/:zoneId/areas
   */
  async pathaoGetAreas(req: Request, res: Response, next: NextFunction) {
    try {
      const { zoneId } = req.params;
      const { courierProviderId, environment = 'PRODUCTION' } = req.query;

      if (!courierProviderId || !zoneId) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId and zoneId are required',
        });
      }

      const result = await courierService.pathaoGetAreas(
        courierProviderId as string,
        parseInt(zoneId),
        environment as 'SANDBOX' | 'PRODUCTION'
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get Pathao stores
   * GET /api/courier/admin/pathao/stores
   */
  async pathaoGetStores(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment = 'PRODUCTION' } = req.query;

      if (!courierProviderId) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId is required',
        });
      }

      const result = await courierService.pathaoGetStores(
        courierProviderId as string,
        environment as 'SANDBOX' | 'PRODUCTION'
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Create Pathao store
   * POST /api/courier/admin/pathao/stores
   */
  async pathaoCreateStore(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment = 'PRODUCTION', storeData } = req.body;

      if (!courierProviderId || !storeData) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId and storeData are required',
        });
      }

      const result = await courierService.pathaoCreateStore(
        courierProviderId,
        storeData,
        environment
      );

      res.status(201).json({
        success: true,
        message: 'Pathao store created successfully',
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get Pathao order info
   * GET /api/courier/orders/pathao/:consignmentId
   */
  async pathaoGetOrderInfo(req: Request, res: Response, next: NextFunction) {
    try {
      const { consignmentId } = req.params;
      const { courierProviderId, environment = 'PRODUCTION' } = req.query;

      if (!courierProviderId || !consignmentId) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId and consignmentId are required',
        });
      }

      const result = await courierService.pathaoGetOrderInfo(
        courierProviderId as string,
        consignmentId,
        environment as 'SANDBOX' | 'PRODUCTION'
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== REDX SPECIFIC ENDPOINTS ====================

  /**
   * Get RedX areas
   * GET /api/courier/admin/redx/areas
   */
  async redxGetAreas(req: Request, res: Response, next: NextFunction) {
    console.log(req.query,"query")
    try {
      const { courierProviderId, environment = 'PRODUCTION', post_code, district_name } = req.query;

      if (!courierProviderId) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId is required',
        });
      }

      const filters: any = {};
      if (post_code) filters.post_code = parseInt(post_code as string);
      if (district_name) filters.district_name = district_name as string;

      const result = await courierService.redxGetAreas(
        courierProviderId as string,
        filters,
        environment as 'SANDBOX' | 'PRODUCTION'
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get RedX pickup stores
   * GET /api/courier/admin/redx/stores
   */
  async redxGetPickupStores(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment = 'PRODUCTION' } = req.query;

      if (!courierProviderId) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId is required',
        });
      }

      const result = await courierService.redxGetPickupStores(
        courierProviderId as string,
        environment as 'SANDBOX' | 'PRODUCTION'
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Create RedX pickup store
   * POST /api/courier/admin/redx/stores
   */
  async redxCreatePickupStore(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment = 'PRODUCTION', storeData } = req.body;

      if (!courierProviderId || !storeData) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId and storeData are required',
        });
      }

      const result = await courierService.redxCreatePickupStore(
        courierProviderId,
        storeData,
        environment
      );

      res.status(201).json({
        success: true,
        message: 'RedX pickup store created successfully',
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Track RedX parcel
   * GET /api/courier/orders/redx/:trackingId/track
   */
  async redxTrackParcel(req: Request, res: Response, next: NextFunction) {
    try {
      const { trackingId } = req.params;
      const { courierProviderId, environment = 'PRODUCTION' } = req.query;

      if (!courierProviderId || !trackingId) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId and trackingId are required',
        });
      }

      const result = await courierService.redxTrackParcel(
        courierProviderId as string,
        trackingId,
        environment as 'SANDBOX' | 'PRODUCTION'
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== ORDER PLACEMENT ENDPOINTS ====================

  /**
   * Create courier order for vendor
   * POST /api/courier/orders/create
   */
  async createCourierOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId, vendorId, orderDetails } = req.body;

      if (!orderId || !vendorId || !orderDetails) {
        return res.status(400).json({
          success: false,
          message: 'orderId, vendorId, and orderDetails are required',
        });
      }

      const result = await courierService.createCourierOrderForVendor(
        orderId,
        vendorId,
        orderDetails
      );

      res.status(201).json({
        success: true,
        message: 'Courier order created successfully',
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get best courier options for route
   * POST /api/courier/quote
   */
  async getCourierQuote(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        vendorWarehouseLocationId,
        customerDeliveryLocationId,
        orderWeight,
        codAmount,
        deliveryType = 'NORMAL',
      } = req.body;

      if (!vendorWarehouseLocationId || !customerDeliveryLocationId || !orderWeight) {
        return res.status(400).json({
          success: false,
          message:
            'vendorWarehouseLocationId, customerDeliveryLocationId, and orderWeight are required',
        });
      }

      const result = await courierService.selectBestCourier({
        vendorWarehouseLocationId,
        customerDeliveryLocationId,
        orderWeight,
        codAmount: codAmount || 0,
        deliveryType,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== VENDOR ENDPOINTS ====================

  /**
   * Vendor marks order as ready for pickup
   * POST /api/courier/vendor/orders/:orderId/ready
   */
  async vendorMarkReadyForPickup(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;
      const vendorId = req.body.vendorId || (req as any).vendor?.id;

      if (!vendorId) {
        return res.status(401).json({
          success: false,
          message: 'Vendor authentication required',
        });
      }

      await courierService.vendorMarkReadyForPickup(vendorId, parseInt(orderId));

      res.status(200).json({
        success: true,
        message: 'Order marked as ready for pickup',
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Generate shipping label for vendor
   * GET /api/courier/vendor/orders/:orderId/label
   */
  async getShippingLabel(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;
      const vendorId = req.query.vendorId || (req as any).vendor?.id;

      if (!vendorId) {
        return res.status(401).json({
          success: false,
          message: 'Vendor authentication required',
        });
      }

      const labelData = await courierService.generateShippingLabel(parseInt(orderId));

      res.status(200).json({
        success: true,
        data: labelData,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get vendor's courier orders
   * GET /api/courier/vendor/orders
   */
  async getVendorCourierOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const vendorId = req.query.vendorId || (req as any).vendor?.id;
      const { status, page = 1, limit = 20 } = req.query;

      if (!vendorId) {
        return res.status(401).json({
          success: false,
          message: 'Vendor authentication required',
        });
      }

      // TODO: Implement pagination and filtering
      res.status(200).json({
        success: true,
        data: [],
        message: 'Implementation pending',
      });
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== TRACKING ENDPOINTS ====================

  /**
   * Get courier order by tracking ID
   * GET /api/courier/track/:trackingId
   */
  async trackOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { trackingId } = req.params;

      if (!trackingId) {
        return res.status(400).json({
          success: false,
          message: 'trackingId is required',
        });
      }

      const result = await courierService.getCourierOrderByTrackingId(trackingId);

      if (!result) {
        return res.status(404).json({
          success: false,
          message: 'Order not found',
        });
      }

      // Return only public information
      const publicData = {
        trackingId: result.courierTrackingId,
        courierName: result.courier_providers.name,
        status: result.status,
        courierStatus: result.courierStatus,
        recipientCity: result.deliveryLocationId,
        trackingHistory: result.courier_tracking_history.map((h) => ({
          status: h.status,
          message: h.messageEn,
          timestamp: h.timestamp,
        })),
      };

      res.status(200).json({
        success: true,
        data: publicData,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get courier orders by order ID
   * GET /api/courier/orders/:orderId
   */
  async getCourierOrdersByOrderId(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;

      if (!orderId) {
        return res.status(400).json({
          success: false,
          message: 'orderId is required',
        });
      }

      const result = await courierService.getCourierOrdersByOrderId(parseInt(orderId));

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  // ==================== WEBHOOK ENDPOINTS ====================

  /**
   * Webhook handler for Pathao
   * POST /api/courier/webhook/pathao
   */
  async pathaoWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      const webhookData = req.body;

      console.log('Pathao Webhook received:', JSON.stringify(webhookData, null, 2));

      await courierService.handlePathaoWebhook(webhookData);

      res.status(200).json({
        success: true,
        message: 'Webhook processed successfully',
      });
    } catch (error: any) {
      console.error('Pathao webhook error:', error);
      res.status(200).json({
        success: false,
        message: 'Webhook received but processing failed',
      });
    }
  }

  /**
   * Webhook handler for RedX
   * POST /api/courier/webhook/redx
   */
  async redxWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      const webhookData = req.body;

      console.log('RedX Webhook received:', JSON.stringify(webhookData, null, 2));

      await courierService.handleRedXWebhook(webhookData);

      res.status(200).json({
        success: true,
        message: 'Webhook processed successfully',
      });
    } catch (error: any) {
      console.error('RedX webhook error:', error);
      res.status(200).json({
        success: false,
        message: 'Webhook received but processing failed',
      });
    }
  }
}

export default new CourierController();