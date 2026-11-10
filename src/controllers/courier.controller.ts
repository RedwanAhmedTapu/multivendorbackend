import type { Request, Response, NextFunction } from 'express';
import courierService from '../services/courier.service.ts';
import warehouseCourierPickupService, {
  PickupMappingError,
  type PickupActor,
} from '../services/warehouse-courier-pickup.service.ts';
import { PrismaClient } from '@prisma/client';
import { sanitizeCourierError } from '../lib/courier/redact.ts';
// 1C-11 (B1): the credential response contract lives in one reusable module so
// every handler — list, single get, create, update AND activate/deactivate —
// applies it. See src/lib/courier/credentials.ts.
import { sanitizeCredential, sanitizeCredentials } from '../lib/courier/credentials.ts';

const prisma = new PrismaClient();

// ==================== WAREHOUSE PICKUP MAPPING HELPERS ====================

function pickupActor(req: Request): PickupActor {
  const u = (req as any).user;
  return { userId: u?.rawId ?? u?.id ?? null, role: u?.role ?? null, vendorId: u?.vendorId ?? null };
}

/**
 * Phase 0: the vendor scope of a /vendor/* courier route — set by
 * requireVendorScope from the authenticated identity only. A client-supplied
 * vendorId (body or query) is ignored; a mismatch is logged (ids only).
 * These routes are deprecated, so every response carries `Deprecation: true`.
 */
function vendorRouteScope(req: Request, res: Response, route: string): string | undefined {
  res.setHeader('Deprecation', 'true');
  const scope: string | undefined = (req as any).vendorScope;
  const claimed = req.body?.vendorId ?? req.query?.vendorId;
  if (claimed !== undefined && claimed !== scope) {
    console.warn('courier.vendor_route.scope_mismatch', { route, scopeVendorId: scope, ignoredVendorId: String(claimed) });
  }
  return scope;
}

/** PickupMappingError → its HTTP status; anything else → the error middleware. */
function handlePickupError(error: any, res: Response, next: NextFunction) {
  if (error instanceof PickupMappingError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  return next(sanitizeCourierError(error));
}

type ProviderStoreInfo = {
  storeId: string;
  storeName: string | null;
  cityId: string | null;
  zoneId: string | null;
  areaId: string | null;
  /** Provider-reported active/approved flag when the provider exposes one. */
  active: boolean | null;
  raw: any;
};

const toStr = (v: any): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/**
 * Look a store up in the provider account behind the PLATFORM credential of
 * `environment` (the account quote/booking use). Returns null when the account
 * does not list it. NOTE: the Pathao store listing is read as returned (first
 * page) — a store beyond it is reported as not found.
 */
async function findProviderStore(
  providerName: string,
  courierProviderId: string,
  environment: 'SANDBOX' | 'PRODUCTION',
  storeId: string,
): Promise<ProviderStoreInfo | null> {
  if (providerName === 'Pathao') {
    const res: any = await courierService.pathaoGetStores(courierProviderId, environment);
    const list: any[] = Array.isArray(res?.data?.data) ? res.data.data : Array.isArray(res?.data) ? res.data : [];
    const s = list.find((x) => String(x?.store_id) === storeId);
    if (!s) return null;
    return {
      storeId,
      storeName: toStr(s.store_name),
      cityId: toStr(s.city_id),
      zoneId: toStr(s.zone_id),
      areaId: toStr(s.area_id),
      active: s.is_active === undefined || s.is_active === null ? null : Boolean(Number(s.is_active)),
      raw: s,
    };
  }
  if (providerName === 'RedX') {
    const res: any = await courierService.redxGetPickupStores(courierProviderId, environment);
    const list: any[] = Array.isArray(res?.pickup_stores) ? res.pickup_stores : [];
    const s = list.find((x) => String(x?.id) === storeId);
    if (!s) return null;
    return { storeId, storeName: toStr(s.name), cityId: null, zoneId: null, areaId: toStr(s.area_id), active: null, raw: s };
  }
  return null;
}

/** Platform credential row for (provider, environment) — the account the store lives in. */
async function platformCredentialFor(courierProviderId: string, environment: 'SANDBOX' | 'PRODUCTION') {
  const credential = await courierService.getPlatformCourierCredentials(courierProviderId, environment);
  if (!credential) {
    throw new PickupMappingError(404, 'CREDENTIAL_NOT_FOUND', `No active platform ${environment} credential for this courier provider`);
  }
  return credential;
}

/**
 * Store payload for a store created FOR a warehouse: the provider city/zone/area
 * come from the warehouse location's pickup serviceable-area mapping. Values the
 * admin supplied must agree with it (a store elsewhere would make the courier
 * pick up from the wrong place).
 */
async function storeDataForWarehouse(
  providerName: 'Pathao' | 'RedX',
  courierProviderId: string,
  locationId: string,
  storeData: Record<string, any>,
) {
  const area = await courierService.getPickupServiceableArea(courierProviderId, locationId);
  if (!area) {
    throw new PickupMappingError(422, 'WAREHOUSE_LOCATION_NOT_MAPPED', `${providerName} has no pickup area mapping for this warehouse's location`);
  }
  const derived: Record<string, number> =
    providerName === 'Pathao'
      ? { city_id: Number(area.courierCityId), zone_id: Number(area.courierZoneId), area_id: Number(area.courierAreaId) }
      : { area_id: Number(area.courierAreaId) };
  for (const [key, value] of Object.entries(derived)) {
    if (!Number.isFinite(value)) {
      throw new PickupMappingError(422, 'WAREHOUSE_LOCATION_NOT_MAPPED', `${providerName} area mapping for this warehouse's location has no ${key}`);
    }
    const given = storeData?.[key];
    if (given !== undefined && given !== null && given !== '' && Number(given) !== value) {
      throw new PickupMappingError(400, 'STORE_AREA_MISMATCH', `storeData.${key} does not match the warehouse location's ${providerName} area (${value})`);
    }
  }
  return { ...storeData, ...derived };
}

/**
 * Proves a provider store sits in the warehouse's provider pickup location
 * (the warehouse location's pickup serviceable-area mapping):
 *   Pathao → city_id + zone_id + area_id, RedX → area_id.
 * A value the provider data does not carry cannot be proven → rejected
 * (never assumed to match).
 */
async function assertStoreMatchesWarehouseLocation(
  providerName: string,
  courierProviderId: string,
  warehouseLocationId: string,
  store: { cityId: string | null; zoneId: string | null; areaId: string | null },
) {
  const area = await courierService.getPickupServiceableArea(courierProviderId, warehouseLocationId);
  if (!area) {
    throw new PickupMappingError(422, 'WAREHOUSE_LOCATION_NOT_MAPPED', `${providerName} has no pickup area mapping for this warehouse's location`);
  }
  const checks: [string, string | null, string | null][] =
    providerName === 'Pathao'
      ? [
          ['city_id', store.cityId, toStr(area.courierCityId)],
          ['zone_id', store.zoneId, toStr(area.courierZoneId)],
          ['area_id', store.areaId, toStr(area.courierAreaId)],
        ]
      : [['area_id', store.areaId, toStr(area.courierAreaId)]];
  for (const [field, storeValue, warehouseValue] of checks) {
    if (warehouseValue === null) {
      throw new PickupMappingError(422, 'WAREHOUSE_LOCATION_NOT_MAPPED', `${providerName} area mapping for this warehouse's location has no ${field}`);
    }
    if (storeValue === null) {
      throw new PickupMappingError(
        422,
        'STORE_LOCATION_UNVERIFIABLE',
        `${providerName} does not report the store's ${field}, so it cannot be proven to be at this warehouse's location`,
      );
    }
    if (storeValue !== warehouseValue) {
      throw new PickupMappingError(
        422,
        'STORE_LOCATION_MISMATCH',
        `${providerName} store ${field} ${storeValue} does not match the warehouse location's ${field} ${warehouseValue}`,
      );
    }
  }
}

/** Store id returned by a provider "create store" call, if the provider returns one. */
function createdStoreId(providerName: string, result: any): string | null {
  if (providerName === 'Pathao') return toStr(result?.data?.store_id ?? result?.store_id);
  if (providerName === 'RedX') return toStr(result?.id ?? result?.data?.id ?? result?.pickup_store?.id);
  return null;
}

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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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

      const rows = await courierService.getAllCredentials(filters);
      const result = sanitizeCredentials(rows);

      res.status(200).json({
        success: true,
        data: result,
        count: result.length,
      });
    } catch (error: any) {
      next(sanitizeCourierError(error));
    }
  }

  /**
   * Get credential by ID
   * GET /api/courier/admin/credentials/:credentialId
   */
  async getCredentialById(req: Request, res: Response, next: NextFunction) {
    try {
      const { credentialId } = req.params;

      const result = sanitizeCredential(await courierService.getCredentialById(credentialId));

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
      next(sanitizeCourierError(error));
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
        data: sanitizeCredential(result),
      });
    } catch (error: any) {
      next(sanitizeCourierError(error));
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
        data: sanitizeCredential(result),
      });
    } catch (error: any) {
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
        // The row the service just wrote — sanitized like every other credential
        // response. This was the one handler that returned the raw record, so the
        // activate/deactivate reply carried the secret columns (1C-11 gap).
        data: sanitizeCredential(result),
      });
    } catch (error: any) {
      next(sanitizeCourierError(error));
    }
  }

  /**
   * Test courier credentials
   * POST /api/courier/admin/credentials/:credentialId/test
   */
  async testCourierCredentials(req: Request, res: Response, next: NextFunction) {
    try {
      const { credentialId } = req.params;

      const credential = await prisma.courierCredential.findUnique({
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
      next(sanitizeCourierError(error));
    }
  }

  /**
   * Refresh OAuth token
   * POST /api/courier/admin/credentials/:credentialId/refresh-token
   */
  async refreshCredentialToken(req: Request, res: Response, next: NextFunction) {
    try {
      const { credentialId } = req.params;

      const credential = await prisma.courierCredential.findUnique({
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
    }
  }

  /**
   * Create Pathao store
   * POST /api/courier/admin/pathao/stores
   */
  async pathaoCreateStore(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment = 'PRODUCTION', storeData, warehouseId } = req.body;

      if (!courierProviderId || !storeData) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId and storeData are required',
        });
      }

      // Optional warehouse link: checked BEFORE the store is created at Pathao.
      const actor = pickupActor(req);
      const credential = warehouseId ? await platformCredentialFor(courierProviderId, environment) : null;
      let effectiveStoreData = storeData;
      if (warehouseId) {
        const pre = await warehouseCourierPickupService.precheckLink(warehouseId, credential!.id, actor, 'CREATED_FOR_WAREHOUSE');
        if (pre.providerName !== 'Pathao') {
          throw new PickupMappingError(400, 'PROVIDER_MISMATCH', 'courierProviderId is not the Pathao provider');
        }
        effectiveStoreData = await storeDataForWarehouse('Pathao', courierProviderId, pre.warehouse.locationId, storeData);
      }

      const result = await courierService.pathaoCreateStore(
        courierProviderId,
        effectiveStoreData as any,
        environment
      );

      const pickup = warehouseId
        ? await this.linkCreatedStore('Pathao', result, warehouseId, credential!.id, actor, {
            providerStoreName: effectiveStoreData?.name,
            providerCityId: effectiveStoreData?.city_id,
            providerZoneId: effectiveStoreData?.zone_id,
            providerAreaId: effectiveStoreData?.area_id,
          })
        : undefined;

      res.status(201).json({
        success: true,
        message: 'Pathao store created successfully',
        data: result,
        ...(pickup !== undefined ? { pickupMapping: pickup } : {}),
      });
    } catch (error: any) {
      handlePickupError(error, res, next);
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
    }
  }

  /**
   * Create RedX pickup store
   * POST /api/courier/admin/redx/stores
   */
  async redxCreatePickupStore(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment = 'PRODUCTION', storeData, warehouseId } = req.body;

      if (!courierProviderId || !storeData) {
        return res.status(400).json({
          success: false,
          message: 'courierProviderId and storeData are required',
        });
      }

      // Optional warehouse link: checked BEFORE the store is created at RedX.
      const actor = pickupActor(req);
      const credential = warehouseId ? await platformCredentialFor(courierProviderId, environment) : null;
      let effectiveStoreData = storeData;
      if (warehouseId) {
        const pre = await warehouseCourierPickupService.precheckLink(warehouseId, credential!.id, actor, 'CREATED_FOR_WAREHOUSE');
        if (pre.providerName !== 'RedX') {
          throw new PickupMappingError(400, 'PROVIDER_MISMATCH', 'courierProviderId is not the RedX provider');
        }
        effectiveStoreData = await storeDataForWarehouse('RedX', courierProviderId, pre.warehouse.locationId, storeData);
      }

      const result = await courierService.redxCreatePickupStore(
        courierProviderId,
        effectiveStoreData as any,
        environment
      );

      const pickup = warehouseId
        ? await this.linkCreatedStore('RedX', result, warehouseId, credential!.id, actor, {
            providerStoreName: effectiveStoreData?.name,
            providerAreaId: effectiveStoreData?.area_id,
          })
        : undefined;

      res.status(201).json({
        success: true,
        message: 'RedX pickup store created successfully',
        data: result,
        ...(pickup !== undefined ? { pickupMapping: pickup } : {}),
      });
    } catch (error: any) {
      handlePickupError(error, res, next);
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
      next(sanitizeCourierError(error));
    }
  }

  // ==================== STEADFAST SPECIFIC ENDPOINTS ====================

  /**
   * Check a Steadfast consignment's live delivery status.
   * GET /api/courier/admin/steadfast/status?courierProviderId=...&consignmentId=... (or &invoice=... or &trackingCode=...)
   */
  async steadfastCheckStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment = 'PRODUCTION', consignmentId, invoice, trackingCode } = req.query;

      if (!courierProviderId) {
        return res.status(400).json({ success: false, message: 'courierProviderId is required' });
      }
      if (!consignmentId && !invoice && !trackingCode) {
        return res.status(400).json({ success: false, message: 'One of consignmentId, invoice or trackingCode is required' });
      }

      const lookup: any = consignmentId
        ? { consignmentId: consignmentId as string }
        : invoice
        ? { invoice: invoice as string }
        : { trackingCode: trackingCode as string };

      const result = await courierService.steadfastCheckStatus(
        courierProviderId as string,
        lookup,
        environment as 'SANDBOX' | 'PRODUCTION'
      );

      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      next(sanitizeCourierError(error));
    }
  }

  /**
   * GET /api/courier/admin/steadfast/balance
   */
  async steadfastGetBalance(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment = 'PRODUCTION' } = req.query;
      if (!courierProviderId) {
        return res.status(400).json({ success: false, message: 'courierProviderId is required' });
      }

      const result = await courierService.steadfastGetBalance(
        courierProviderId as string,
        environment as 'SANDBOX' | 'PRODUCTION'
      );

      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      next(sanitizeCourierError(error));
    }
  }

  /**
   * POST /api/courier/admin/steadfast/bulk-order
   * Body: { courierProviderId, environment?, orders: [...] } (max 500)
   */
  async steadfastBulkOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, environment = 'PRODUCTION', orders } = req.body;
      if (!courierProviderId || !Array.isArray(orders) || orders.length === 0) {
        return res.status(400).json({ success: false, message: 'courierProviderId and a non-empty orders array are required' });
      }

      const result = await courierService.steadfastBulkCreateOrder(courierProviderId, orders, environment);
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      next(sanitizeCourierError(error));
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

      if (!orderId || !vendorId || !orderDetails?.intentId) {
        return res.status(400).json({
          success: false,
          message: 'orderId, vendorId, and orderDetails.intentId are required',
        });
      }

      // Phase 0: the shipment (recipient, address, COD, weight, reference,
      // courier, pricing) is read from the booking-intent row on the server.
      // Any other client-supplied field is ignored; only the key names are logged.
      const ignoredFields = Object.keys(orderDetails).filter((k) => k !== 'intentId');
      if (ignoredFields.length > 0) {
        console.warn(`[courier.orders.create] ignoring client-supplied booking fields: ${ignoredFields.join(', ')}`);
      }

      // A vendor-scoped employee may only book for its own vendor. (ADMIN may
      // act for any vendor; for every actor the service then proves from the
      // database that the warehouse and booking intent belong to `vendorId`
      // before any courier API call.)
      const actor = pickupActor(req);
      if (actor.role !== 'ADMIN' && actor.vendorId && actor.vendorId !== vendorId) {
        return res.status(403).json({ success: false, message: 'Not allowed to book courier orders for another vendor' });
      }

      const result = await courierService.createCourierOrderForVendor(orderId, vendorId, {
        intentId: String(orderDetails.intentId),
      });

      res.status(201).json({
        success: true,
        message: 'Courier order created successfully',
        data: result,
      });
    } catch (error: any) {
      const outcome = error?.courierBookingOutcome;
      if (outcome === 'NOT_CLAIMED') {
        return res.status(409).json({ success: false, code: 'BOOKING_NOT_CLAIMABLE', message: error.message });
      }
      if (outcome && outcome !== 'REJECTED') {
        // UNKNOWN / CONFIRM_FAILED / STALE / OUTCOME_NOT_RECORDED
        return res.status(409).json({ success: false, code: 'RECONCILIATION_REQUIRED', outcome, message: error.message });
      }
      next(sanitizeCourierError(error));
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
        warehouseId,
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
        // Pathao/RedX quote only for a warehouse with an active pickup store mapping
        warehouseId,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(sanitizeCourierError(error));
    }
  }

  // ==================== WAREHOUSE COURIER PICKUP MAPPING ====================

  /**
   * After a provider "create store" call with a warehouseId: record the new
   * store as a PENDING_APPROVAL mapping when the provider returned its id.
   * The store already exists at the provider, so a mapping failure is reported
   * in the response (never hides the provider success).
   */
  private async linkCreatedStore(
    providerName: 'Pathao' | 'RedX',
    result: any,
    warehouseId: string,
    courierCredentialId: string,
    actor: PickupActor,
    fields: { providerStoreName?: any; providerCityId?: any; providerZoneId?: any; providerAreaId?: any },
  ) {
    const storeId = createdStoreId(providerName, result);
    if (!storeId) {
      return {
        mapping: null,
        message: `${providerName} did not return a store id — link the store to the warehouse via POST /admin/warehouse-pickups/link once it appears in the store list`,
      };
    }
    try {
      const linked = await warehouseCourierPickupService.linkStore(
        {
          warehouseId,
          courierCredentialId,
          providerStoreId: storeId,
          providerStoreName: toStr(fields.providerStoreName),
          providerCityId: toStr(fields.providerCityId),
          providerZoneId: toStr(fields.providerZoneId),
          providerAreaId: toStr(fields.providerAreaId) ?? toStr(result?.area_id),
          rawData: result,
        },
        actor,
        'CREATED_FOR_WAREHOUSE', // created by this request for this warehouse
      );
      return { mapping: linked!.mapping };
    } catch (error: any) {
      return { mapping: null, message: `Store created but not linked: ${error.message}` };
    }
  }

  /**
   * List warehouse pickup mappings
   * GET /api/courier/admin/warehouse-pickups?warehouseId=&vendorId=&courierProviderId=&status=
   */
  async listWarehousePickups(req: Request, res: Response, next: NextFunction) {
    try {
      const { warehouseId, vendorId, courierProviderId, courierCredentialId, status } = req.query as Record<string, string | undefined>;
      const data = await warehouseCourierPickupService.list(
        { warehouseId, vendorId, courierProviderId, courierCredentialId, status },
        pickupActor(req),
      );
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      handlePickupError(error, res, next);
    }
  }

  /**
   * Get one warehouse pickup mapping
   * GET /api/courier/admin/warehouse-pickups/:mappingId
   */
  async getWarehousePickup(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await warehouseCourierPickupService.getById(String(req.params.mappingId), pickupActor(req));
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      handlePickupError(error, res, next);
    }
  }

  /**
   * Link an EXISTING provider store to a warehouse (→ PENDING_APPROVAL).
   * The store must be listed by the provider account behind the platform
   * credential of `environment`; store details are taken from the provider.
   * POST /api/courier/admin/warehouse-pickups/link
   * Body: { warehouseId, courierProviderId, environment?, providerStoreId }
   */
  async linkWarehousePickup(req: Request, res: Response, next: NextFunction) {
    try {
      const { warehouseId, courierProviderId, environment = 'PRODUCTION', providerStoreId } = req.body ?? {};
      if (!warehouseId || !courierProviderId || !providerStoreId) {
        return res.status(400).json({
          success: false,
          message: 'warehouseId, courierProviderId and providerStoreId are required',
        });
      }
      if (environment !== 'PRODUCTION' && environment !== 'SANDBOX') {
        return res.status(400).json({ success: false, message: 'environment must be PRODUCTION or SANDBOX' });
      }
      const actor = pickupActor(req);
      const credential = await platformCredentialFor(courierProviderId, environment);
      // EXISTING_STORE link: ADMIN only (shared platform account — no provider-side ownership data)
      const { providerName, warehouse } = await warehouseCourierPickupService.precheckLink(warehouseId, credential.id, actor);

      const store = await findProviderStore(providerName, courierProviderId, environment, String(providerStoreId).trim());
      if (!store) {
        return res.status(422).json({
          success: false,
          code: 'STORE_NOT_FOUND_AT_PROVIDER',
          message: `${providerName} store ${providerStoreId} is not listed by the ${environment} merchant account`,
        });
      }
      // the store must provably be at this warehouse's provider location
      await assertStoreMatchesWarehouseLocation(providerName, courierProviderId, warehouse.locationId, store);

      const result = await warehouseCourierPickupService.linkStore(
        {
          warehouseId,
          courierCredentialId: credential.id,
          providerStoreId: store.storeId,
          providerStoreName: store.storeName,
          providerCityId: store.cityId,
          providerZoneId: store.zoneId,
          providerAreaId: store.areaId,
          rawData: store.raw,
          verifiedAt: new Date(),
        },
        actor,
      );
      res.status(result!.created ? 201 : 200).json({ success: true, data: result!.mapping, created: result!.created });
    } catch (error: any) {
      handlePickupError(error, res, next);
    }
  }

  /**
   * Activate a mapping after re-verifying the store with the provider. Any
   * other ACTIVE mapping of the same warehouse + credential becomes INACTIVE.
   * Existing shipments are never modified (they keep their pickupStoreId).
   * POST /api/courier/admin/warehouse-pickups/:mappingId/activate
   */
  async activateWarehousePickup(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = pickupActor(req);
      const mapping = await warehouseCourierPickupService.getById(String(req.params.mappingId), actor);
      const credential = await prisma.courierCredential.findUnique({
        where: { id: mapping.courierCredentialId },
        select: { id: true, vendorId: true, environment: true, isActive: true, courier_providers: { select: { name: true } } },
      });
      if (!credential || !credential.isActive) {
        throw new PickupMappingError(422, 'CREDENTIAL_INACTIVE', 'Courier credential is missing or inactive');
      }
      if (credential.vendorId !== null) {
        // the provider store listing is only available for platform accounts
        throw new PickupMappingError(422, 'CREDENTIAL_NOT_VERIFIABLE', 'Only platform-credential mappings can be verified and activated');
      }
      const providerName = credential.courier_providers.name;
      const store = await findProviderStore(
        providerName,
        mapping.courierProviderId,
        credential.environment as 'SANDBOX' | 'PRODUCTION',
        String(mapping.providerStoreId ?? ''),
      );
      if (!store) {
        throw new PickupMappingError(422, 'STORE_NOT_FOUND_AT_PROVIDER', `${providerName} store ${mapping.providerStoreId} is not listed by the merchant account`);
      }
      if (store.active === false) {
        throw new PickupMappingError(422, 'STORE_NOT_APPROVED', `${providerName} store ${mapping.providerStoreId} is not active/approved at ${providerName} yet`);
      }
      if (providerName === 'RedX' && store.areaId && mapping.providerAreaId && store.areaId !== mapping.providerAreaId) {
        throw new PickupMappingError(409, 'STORE_AREA_CHANGED', 'RedX reports a different area for this pickup store — link the store again');
      }
      // Location proof at activation:
      //  (1) whatever location the provider reports for the store equals the mapping's
      //      (RedX must report the area; Pathao's store list carries city/zone),
      //  (2) the mapping's location still equals the warehouse's provider pickup location.
      if (providerName === 'RedX' && store.areaId === null) {
        throw new PickupMappingError(422, 'STORE_LOCATION_UNVERIFIABLE', 'RedX does not report this pickup store\'s area_id');
      }
      for (const [field, reported, mapped] of [
        ['city_id', store.cityId, mapping.providerCityId],
        ['zone_id', store.zoneId, mapping.providerZoneId],
        ['area_id', store.areaId, mapping.providerAreaId],
      ] as const) {
        if (reported !== null && reported !== (mapped ?? null)) {
          throw new PickupMappingError(409, 'STORE_LOCATION_CHANGED', `${providerName} reports ${field} ${reported} for this store but the mapping has ${mapped ?? 'none'} — link the store again`);
        }
      }
      const warehouse = await prisma.vendorWarehouse.findUnique({ where: { id: mapping.warehouseId }, select: { locationId: true } });
      if (!warehouse) throw new PickupMappingError(404, 'WAREHOUSE_NOT_FOUND', `Warehouse ${mapping.warehouseId} not found`);
      await assertStoreMatchesWarehouseLocation(providerName, mapping.courierProviderId, warehouse.locationId, {
        cityId: mapping.providerCityId,
        zoneId: mapping.providerZoneId,
        areaId: mapping.providerAreaId,
      });
      const result = await warehouseCourierPickupService.activate(mapping.id, actor, { rawData: store.raw, verifiedAt: new Date() });
      res.status(200).json({ success: true, data: result!.mapping, replacedIds: result!.replacedIds });
    } catch (error: any) {
      handlePickupError(error, res, next);
    }
  }

  /**
   * Deactivate a mapping (the warehouse stops being eligible for that courier).
   * POST /api/courier/admin/warehouse-pickups/:mappingId/deactivate
   */
  async deactivateWarehousePickup(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await warehouseCourierPickupService.deactivate(String(req.params.mappingId), pickupActor(req));
      res.status(200).json({ success: true, data: result.mapping });
    } catch (error: any) {
      handlePickupError(error, res, next);
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
      const vendorId = vendorRouteScope(req, res, 'POST /vendor/orders/:orderId/ready');

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
      next(sanitizeCourierError(error));
    }
  }

  /**
   * Generate shipping label for vendor
   * GET /api/courier/vendor/orders/:orderId/label
   */
  async getShippingLabel(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;
      const vendorId = vendorRouteScope(req, res, 'GET /vendor/orders/:orderId/label');

      if (!vendorId) {
        return res.status(401).json({
          success: false,
          message: 'Vendor authentication required',
        });
      }

      const labelData = await courierService.generateShippingLabel(parseInt(orderId), vendorId);

      res.status(200).json({
        success: true,
        data: labelData,
      });
    } catch (error: any) {
      next(sanitizeCourierError(error));
    }
  }

  /**
   * Get vendor's courier orders
   * GET /api/courier/vendor/orders
   */
  async getVendorCourierOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const vendorId = vendorRouteScope(req, res, 'GET /vendor/orders');
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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
      next(sanitizeCourierError(error));
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

  // ==================== PRICING RULES (ADMIN) ====================

  /**
   * List courier pricing rules
   * GET /api/courier/admin/pricing-rules
   */
  async listPricingRules(req: Request, res: Response, next: NextFunction) {
    try {
      const { courierProviderId, isActive, deliveryType, fromLocationId, toLocationId, page, limit } = req.query as Record<string, string | undefined>;

      const filters: any = {};
      if (courierProviderId) filters.courierProviderId = courierProviderId;
      if (isActive !== undefined) filters.isActive = isActive === 'true';
      if (deliveryType) filters.deliveryType = deliveryType;
      if (fromLocationId !== undefined) filters.fromLocationId = fromLocationId;
      if (toLocationId !== undefined) filters.toLocationId = toLocationId;
      if (page) filters.page = Number(page);
      if (limit) filters.limit = Number(limit);

      const result = await courierService.listPricingRules(filters);

      res.status(200).json({
        success: true,
        data: result.rules,
        pagination: result.pagination,
      });
    } catch (error: any) {
      next(sanitizeCourierError(error));
    }
  }

  /**
   * Create a platform courier pricing rule
   * POST /api/courier/admin/pricing-rules
   */
  async createPricingRule(req: Request, res: Response, next: NextFunction) {
    try {
      const rule = await courierService.createPricingRule(req.body);

      res.status(201).json({
        success: true,
        message: 'Courier pricing rule created successfully',
        data: rule,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to create courier pricing rule',
      });
    }
  }

  /**
   * Update a platform courier pricing rule
   * PUT /api/courier/admin/pricing-rules/:id
   */
  async updatePricingRule(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const rule = await courierService.updatePricingRule(id, req.body);

      res.status(200).json({
        success: true,
        message: 'Courier pricing rule updated successfully',
        data: rule,
      });
    } catch (error: any) {
      const status = error.message?.includes('not found') ? 404 : 400;
      res.status(status).json({
        success: false,
        message: error.message || 'Failed to update courier pricing rule',
      });
    }
  }

  /**
   * Toggle a courier pricing rule active status
   * PATCH /api/courier/admin/pricing-rules/:id/toggle
   */
  async togglePricingRule(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const rule = await courierService.togglePricingRuleStatus(id);

      res.status(200).json({
        success: true,
        message: `Courier pricing rule ${rule.isActive ? 'activated' : 'deactivated'} successfully`,
        data: rule,
      });
    } catch (error: any) {
      const status = error.message?.includes('not found') ? 404 : 400;
      res.status(status).json({
        success: false,
        message: error.message || 'Failed to toggle courier pricing rule',
      });
    }
  }

  /**
   * Delete a courier pricing rule
   * DELETE /api/courier/admin/pricing-rules/:id
   */
  async deletePricingRule(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const result = await courierService.deletePricingRule(id);

      res.status(200).json({
        success: true,
        message: 'Courier pricing rule deleted successfully',
        data: result,
      });
    } catch (error: any) {
      const status = error.message?.includes('not found') ? 404 : 400;
      res.status(status).json({
        success: false,
        message: error.message || 'Failed to delete courier pricing rule',
      });
    }
  }
}

export default new CourierController();