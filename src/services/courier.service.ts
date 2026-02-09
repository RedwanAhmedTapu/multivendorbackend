
import pkg from '@prisma/client';
const { PrismaClient, Prisma, CourierAuthType, Environment } = pkg;

import type { AxiosInstance } from 'axios';
import axios from 'axios';

const prisma = new PrismaClient();

interface PathaoTokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

interface CourierSelectionCriteria {
  vendorWarehouseLocationId: string;
  customerDeliveryLocationId: string;
  orderWeight: number;
  codAmount: number;
  deliveryType: 'NORMAL' | 'EXPRESS';
}

interface CourierPricing {
  courierProviderId: string;
  courierName: string;
  deliveryCharge: number;
  codCharge: number;
  totalCharge: number;
  estimatedDeliveryDays: number;
}

interface OrderDetails {
  recipientName: string;
  recipientPhone: string;
  recipientSecondaryPhone?: string;
  recipientAddress: string;
  recipientLocationId: string;
  vendorWarehouseLocationId: string;
  itemDescription: string;
  itemQuantity: number;
  itemWeight: number;
  codAmount: number;
  deliveryType: 'NORMAL' | 'EXPRESS';
  specialInstructions?: string;
  itemValue?: number;
}

export class CourierService {
  private axiosInstance: AxiosInstance;

  constructor() {
    this.axiosInstance = axios.create({
      timeout: 30000,
    });
  }

  // ==================== COURIER PROVIDER MANAGEMENT ====================

  /**
   * Get all courier providers with optional filters
   */
  async getAllCourierProviders(filters?: {
    isActive?: boolean;
    authType?: CourierAuthType;
    includeCredentials?: boolean;
  }) {
    const where: any = {};
    
    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }
    
    if (filters?.authType) {
      where.authType = filters.authType;
    }

    return await prisma.courierProviders.findMany({
      where,
      include: {
        courier_credentials: filters?.includeCredentials
          ? {
              where: { vendorId: null },
              orderBy: { createdAt: 'desc' },
            }
          : false,
        _count: {
          select: {
            courier_orders: true,
            courier_serviceable_areas: true,
          },
        },
      },
      orderBy: [
        { isPreferred: 'desc' },
        { priority: 'asc' },
        { name: 'asc' },
      ],
    });
  }

  /**
   * Get single courier provider by ID
   */
  async getCourierProviderById(providerId: string) {
    return await prisma.courierProviders.findUnique({
      where: { id: providerId },
      include: {
        courier_credentials: {
          where: { vendorId: null },
          orderBy: { createdAt: 'desc' },
        },
        courier_serviceable_areas: {
          take: 10,
          orderBy: { lastSyncedAt: 'desc' },
        },
        _count: {
          select: {
            courier_orders: true,
            courier_serviceable_areas: true,
            courier_credentials: true,
          },
        },
      },
    });
  }

  /**
   * Create courier provider
   */
  async createCourierProvider(data: {
    name: string;
    displayName?: string;
    description?: string;
    logo?: string;
    sandboxBaseUrl?: string;
    productionBaseUrl: string;
    authType: CourierAuthType;
    supportsCOD?: boolean;
    supportsTracking?: boolean;
    supportsBulkOrder?: boolean;
    supportsWebhook?: boolean;
    priority?: number;
    isPreferred?: boolean;
    statusMappings?: any;
  }) {
    // Generate slug from name
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    
    // Generate unique ID from name
    const id = data.name.toLowerCase().replace(/\s+/g, '_');

    // Default status mappings if not provided
    const defaultStatusMappings = {
      PENDING: ['Pending', 'Created', 'Accepted'],
      PICKED_UP: ['Picked Up', 'Collected'],
      IN_TRANSIT: ['In Transit', 'On the way'],
      OUT_FOR_DELIVERY: ['Out for Delivery'],
      DELIVERED: ['Delivered', 'Completed'],
      RETURNED: ['Returned', 'Return'],
      CANCELLED: ['Cancelled', 'Canceled'],
      ON_HOLD: ['On Hold', 'Held'],
    };

    return await prisma.courierProviders.create({
      data: {
        id,
        name: data.name,
        slug,
        displayName: data.displayName || data.name,
        description: data.description,
        logo: data.logo,
        sandboxBaseUrl: data.sandboxBaseUrl,
        productionBaseUrl: data.productionBaseUrl,
        authType: data.authType,
        supportsCOD: data.supportsCOD ?? true,
        supportsTracking: data.supportsTracking ?? true,
        supportsBulkOrder: data.supportsBulkOrder ?? false,
        supportsWebhook: data.supportsWebhook ?? false,
        priority: data.priority ?? 100,
        isPreferred: data.isPreferred ?? false,
        isActive: true,
        statusMappings: data.statusMappings || defaultStatusMappings,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      include: {
        courier_credentials: true,
      },
    });
  }

  /**
   * Update courier provider
   */
  async updateCourierProvider(
    providerId: string,
    data: Partial<{
      name: string;
      displayName: string;
      description: string;
      logo: string;
      sandboxBaseUrl: string;
      productionBaseUrl: string;
      authType: CourierAuthType;
      supportsCOD: boolean;
      supportsTracking: boolean;
      supportsBulkOrder: boolean;
      supportsWebhook: boolean;
      priority: number;
      isPreferred: boolean;
      isActive: boolean;
      statusMappings: any;
    }>
  ) {
    return await prisma.courierProviders.update({
      where: { id: providerId },
      data: {
        ...data,
        updatedAt: new Date(),
      },
      include: {
        courier_credentials: true,
      },
    });
  }

  /**
   * Delete courier provider
   */
  async deleteCourierProvider(providerId: string) {
    // Check if provider has active orders
    const activeOrders = await prisma.courierOrder.count({
      where: {
        courierProviderId: providerId,
        status: {
          notIn: ['DELIVERED', 'RETURNED', 'CANCELLED'],
        },
      },
    });

    if (activeOrders > 0) {
      throw new Error(
        `Cannot delete provider with ${activeOrders} active orders. Please complete or cancel them first.`
      );
    }

    return await prisma.courierProviders.delete({
      where: { id: providerId },
    });
  }

  /**
   * Toggle provider active status
   */
  async toggleProviderStatus(providerId: string) {
    const provider = await prisma.courierProviders.findUnique({
      where: { id: providerId },
      select: { isActive: true },
    });

    if (!provider) {
      throw new Error('Provider not found');
    }

    return await prisma.courierProviders.update({
      where: { id: providerId },
      data: {
        isActive: !provider.isActive,
        updatedAt: new Date(),
      },
    });
  }

  // ==================== CREDENTIALS MANAGEMENT ====================

  /**
   * Get all credentials with filters
   */
  async getAllCredentials(filters?: {
    courierProviderId?: string;
    environment?: Environment;
    isActive?: boolean;
    vendorId?: string | null;
  }) {
    const where: any = {};

    if (filters?.courierProviderId) {
      where.courierProviderId = filters.courierProviderId;
    }

    if (filters?.environment) {
      where.environment = filters.environment;
    }

    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    if (filters?.vendorId !== undefined) {
      where.vendorId = filters.vendorId;
    }

    return await prisma.courierCredential.findMany({
      where,
      include: {
        courier_providers: true,
        vendors: {
          select: {
            id: true,
            // businessName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get credential by ID
   */
  async getCredentialById(credentialId: string) {
    return await prisma.courierCredential.findUnique({
      where: { id: credentialId },
      include: {
        courier_providers: true,
        vendors: {
          select: {
            id: true,
            // businessName: true,
            email: true,
          },
        },
      },
    });
  }

  /**
   * Create platform courier credentials
   */
  async createPlatformCourierCredentials(data: {
    courierProviderId: string;
    environment: Environment;
    clientId?: string;
    clientSecret?: string;
    username?: string;
    password?: string;
    apiKey?: string;
    bearerToken?: string;
    storeId?: string;
    merchantId?: string;
    vendorId?: string | null;
  }) {
    // Check if credentials already exist
    const existing = await prisma.courierCredential.findFirst({
      where: {
        courierProviderId: data.courierProviderId,
        environment: data.environment,
        vendorId: data.vendorId || null,
      },
    });

    if (existing) {
      throw new Error(
        `Credentials for ${data.environment} environment already exist for this provider${
          data.vendorId ? ' and vendor' : ''
        }`
      );
    }

    return await prisma.courierCredential.create({
      data: {
        courierProviderId: data.courierProviderId,
        vendorId: data.vendorId || null,
        environment: data.environment,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        username: data.username,
        password: data.password,
        apiKey: data.apiKey,
        bearerToken: data.bearerToken,
        storeId: data.storeId,
        merchantId: data.merchantId,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      include: {
        courier_providers: true,
      },
    });
  }

  /**
   * Update platform courier credentials
   */
  async updatePlatformCourierCredentials(
    credentialId: string,
    data: Partial<{
      clientId: string;
      clientSecret: string;
      accessToken: string;
      refreshToken: string;
      tokenExpiresAt: Date;
      apiKey: string;
      bearerToken: string;
      username: string;
      password: string;
      storeId: string;
      merchantId: string;
      isActive: boolean;
    }>
  ) {
    return await prisma.courierCredential.update({
      where: { id: credentialId },
      data: {
        ...data,
        updatedAt: new Date(),
      },
      include: {
        courier_providers: true,
      },
    });
  }

  /**
   * Delete platform courier credentials
   */
  async deletePlatformCourierCredentials(credentialId: string) {
    // Check if there are active orders using these credentials
    const credential = await prisma.courierCredential.findUnique({
      where: { id: credentialId },
    });

    if (!credential) {
      throw new Error('Credentials not found');
    }

    const activeOrders = await prisma.courierOrder.count({
      where: {
        courierProviderId: credential.courierProviderId,
        vendorId: credential.vendorId || undefined,
        status: {
          notIn: ['DELIVERED', 'RETURNED', 'CANCELLED'],
        },
      },
    });

    if (activeOrders > 0) {
      throw new Error(
        `Cannot delete credentials with ${activeOrders} active orders. Please complete them first.`
      );
    }

    return await prisma.courierCredential.delete({
      where: { id: credentialId },
    });
  }

  /**
   * Toggle credential active status
   */
  async toggleCredentialStatus(credentialId: string) {
    const credential = await prisma.courierCredential.findUnique({
      where: { id: credentialId },
      select: { isActive: true },
    });

    if (!credential) {
      throw new Error('Credentials not found');
    }

    return await prisma.courierCredential.update({
      where: { id: credentialId },
      data: {
        isActive: !credential.isActive,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Get PLATFORM courier credentials (not vendor-specific)
   */
  async getPlatformCourierCredentials(
    courierProviderId: string,
    environment: Environment = 'PRODUCTION'
  ) {
    return await prisma.courierCredential.findFirst({
      where: {
        courierProviderId,
        vendorId: null,
        environment,
        isActive: true,
      },
      include: {
        courier_providers: true,
      },
    });
  }

  // ==================== SERVICEABLE AREAS MANAGEMENT ====================

  /**
   * Get serviceable areas with filters
   */
  async getServiceableAreas(filters?: {
    courierProviderId?: string;
    locationId?: string;
    homeDeliveryAvailable?: boolean;
    pickupAvailable?: boolean;
    isActive?: boolean;
    search?: string;
  }) {
    const where: any = {};

    if (filters?.courierProviderId) {
      where.courierProviderId = filters.courierProviderId;
    }

    if (filters?.locationId) {
      where.locationId = filters.locationId;
    }

    if (filters?.homeDeliveryAvailable !== undefined) {
      where.homeDeliveryAvailable = filters.homeDeliveryAvailable;
    }

    if (filters?.pickupAvailable !== undefined) {
      where.pickupAvailable = filters.pickupAvailable;
    }

    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    if (filters?.search) {
      where.OR = [
        { courierAreaName: { contains: filters.search, mode: 'insensitive' } },
        { courierCityName: { contains: filters.search, mode: 'insensitive' } },
        { courierZoneName: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    return await prisma.courierServicableAreas.findMany({
      where,
      include: {
        courier_providers: {
          select: {
            id: true,
            name: true,
            displayName: true,
          },
        },
        locations: {
          select: {
            id: true,
            name: true,
            name_local: true,
            level: true,
          },
        },
      },
      orderBy: { lastSyncedAt: 'desc' },
    });
  }

  /**
   * Sync serviceable areas (Platform admin function)
   */
  async syncServiceableAreas(
    courierProviderId: string,
    areas: Array<{
      locationId: string;
      courierCityId?: string;
      courierZoneId?: string;
      courierAreaId: string;
      courierCityName?: string;
      courierZoneName?: string;
      courierAreaName: string;
      homeDeliveryAvailable?: boolean;
      pickupAvailable?: boolean;
      rawData?: any;
    }>
  ) {
    const operations = areas.map((area) =>
      prisma.courierServicableAreas.upsert({
        where: {
          courierProviderId_courierAreaId: {
            courierProviderId,
            courierAreaId: area.courierAreaId,
          },
        },
        create: {
          courierProviderId,
          locationId: area.locationId,
          courierCityId: area.courierCityId,
          courierZoneId: area.courierZoneId,
          courierAreaId: area.courierAreaId,
          courierCityName: area.courierCityName,
          courierZoneName: area.courierZoneName,
          courierAreaName: area.courierAreaName,
          homeDeliveryAvailable: area.homeDeliveryAvailable ?? true,
          pickupAvailable: area.pickupAvailable ?? false,
          rawData: area.rawData,
          isActive: true,
          lastSyncedAt: new Date(),
        },
        update: {
          locationId: area.locationId,
          courierCityId: area.courierCityId,
          courierZoneId: area.courierZoneId,
          courierCityName: area.courierCityName,
          courierZoneName: area.courierZoneName,
          courierAreaName: area.courierAreaName,
          homeDeliveryAvailable: area.homeDeliveryAvailable ?? true,
          pickupAvailable: area.pickupAvailable ?? false,
          rawData: area.rawData,
          isActive: true,
          lastSyncedAt: new Date(),
        },
      })
    );

    return await prisma.$transaction(operations);
  }

  /**
   * Delete serviceable area
   */
  async deleteServiceableArea(areaId: string) {
    return await prisma.courierServicableAreas.delete({
      where: { id: areaId },
    });
  }

  /**
   * Get courier serviceable area mapping
   */
  private async getCourierServiceableArea(courierProviderId: string, locationId: string) {
    return await prisma.courierServicableAreas.findFirst({
      where: {
        courierProviderId,
        locationId,
        homeDeliveryAvailable: true,
        isActive: true,
      },
    });
  }

  // ==================== SMART COURIER SELECTION ====================

  /**
   * Select best courier based on criteria
   */
  async selectBestCourier(
    criteria: CourierSelectionCriteria
  ): Promise<{ courierProviderId: string; courierName: string; pricing: CourierPricing }> {
    const { vendorWarehouseLocationId, customerDeliveryLocationId, orderWeight, codAmount } =
      criteria;

    // Get all active courier providers
    const courierProviders = await prisma.courierProviders.findMany({
      where: { isActive: true },
      include: {
        courier_credentials: {
          where: {
            vendorId: null,
            isActive: true,
          },
        },
      },
      orderBy: [
        { isPreferred: 'desc' },
        { priority: 'asc' },
      ],
    });

    const pricingResults: CourierPricing[] = [];

    // Get pricing from each courier
    for (const provider of courierProviders) {
      try {
        let pricing: CourierPricing | null = null;

        if (provider.name === 'Pathao') {
          pricing = await this.getPathaoPricing(
            provider.id,
            vendorWarehouseLocationId,
            customerDeliveryLocationId,
            orderWeight,
            codAmount
          );
        } else if (provider.name === 'RedX') {
          pricing = await this.getRedXPricing(
            provider.id,
            vendorWarehouseLocationId,
            customerDeliveryLocationId,
            orderWeight,
            codAmount
          );
        }

        if (pricing) {
          pricingResults.push(pricing);
        }
      } catch (error) {
        console.error(`Failed to get pricing from ${provider.name}:`, error);
      }
    }

    if (pricingResults.length === 0) {
      throw new Error('No courier available for this delivery route');
    }

    // Select courier with lowest total charge
    const bestCourier = pricingResults.reduce((prev, current) =>
      current.totalCharge < prev.totalCharge ? current : prev
    );

    return {
      courierProviderId: bestCourier.courierProviderId,
      courierName: bestCourier.courierName,
      pricing: bestCourier,
    };
  }

  /**
   * Get Pathao pricing
   */
  private async getPathaoPricing(
    courierProviderId: string,
    pickupLocationId: string,
    deliveryLocationId: string,
    weight: number,
    codAmount: number
  ): Promise<CourierPricing> {
    const pickupArea = await this.getCourierServiceableArea(courierProviderId, pickupLocationId);
    const deliveryArea = await this.getCourierServiceableArea(
      courierProviderId,
      deliveryLocationId
    );

    if (!pickupArea || !deliveryArea) {
      throw new Error('Location not serviceable by Pathao');
    }

    const credentials = await this.getPlatformCourierCredentials(courierProviderId);
    if (!credentials || !credentials.storeId) {
      throw new Error('Pathao store not configured');
    }

    const priceData = {
      store_id: parseInt(credentials.storeId),
      item_type: 2,
      delivery_type: 48,
      item_weight: weight,
      recipient_city: parseInt(deliveryArea.courierCityId!),
      recipient_zone: parseInt(deliveryArea.courierZoneId!),
    };

    const priceResponse = await this.pathaoCalculatePrice(courierProviderId, priceData);

    return {
      courierProviderId,
      courierName: 'Pathao',
      deliveryCharge: priceResponse.data.delivery_fee || 0,
      codCharge: priceResponse.data.cod_fee || 0,
      totalCharge: (priceResponse.data.delivery_fee || 0) + (priceResponse.data.cod_fee || 0),
      estimatedDeliveryDays: 3,
    };
  }

  /**
   * Get RedX pricing
   */
  private async getRedXPricing(
    courierProviderId: string,
    pickupLocationId: string,
    deliveryLocationId: string,
    weight: number,
    codAmount: number
  ): Promise<CourierPricing> {
    const pickupArea = await this.getCourierServiceableArea(courierProviderId, pickupLocationId);
    const deliveryArea = await this.getCourierServiceableArea(
      courierProviderId,
      deliveryLocationId
    );

    if (!pickupArea || !deliveryArea) {
      throw new Error('Location not serviceable by RedX');
    }

    const chargeData = {
      delivery_area_id: parseInt(deliveryArea.courierAreaId),
      pickup_area_id: parseInt(pickupArea.courierAreaId),
      cash_collection_amount: codAmount,
      weight,
    };

    const chargeResponse = await this.redxCalculateCharge(courierProviderId, chargeData);

    return {
      courierProviderId,
      courierName: 'RedX',
      deliveryCharge: chargeResponse.delivery_charge || 0,
      codCharge: chargeResponse.cod_charge || 0,
      totalCharge: chargeResponse.total_charge || 0,
      estimatedDeliveryDays: 2,
    };
  }

  // ==================== PATHAO INTEGRATION ====================

  /**
   * Issue access token for Pathao
   */
  async pathaoIssueToken(
    courierProviderId: string,
    environment: Environment = 'PRODUCTION'
  ): Promise<PathaoTokenResponse> {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);

    if (!credentials) {
      throw new Error('Platform courier credentials not found');
    }

    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.post<PathaoTokenResponse>(
        `${baseUrl}/aladdin/api/v1/issue-token`,
        {
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: 'password',
          username: credentials.username,
          password: credentials.password,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + response.data.expires_in);

      await this.updatePlatformCourierCredentials(credentials.id, {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        tokenExpiresAt: expiresAt,
      });

      return response.data;
    } catch (error: any) {
      throw new Error(`Pathao token issue failed: ${error.message}`);
    }
  }

  /**
   * Refresh Pathao access token
   */
  async pathaoRefreshToken(
    courierProviderId: string,
    environment: Environment = 'PRODUCTION'
  ): Promise<PathaoTokenResponse> {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);

    if (!credentials || !credentials.refreshToken) {
      throw new Error('Platform courier credentials or refresh token not found');
    }

    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.post<PathaoTokenResponse>(
        `${baseUrl}/aladdin/api/v1/issue-token`,
        {
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + response.data.expires_in);

      await this.updatePlatformCourierCredentials(credentials.id, {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        tokenExpiresAt: expiresAt,
      });

      return response.data;
    } catch (error: any) {
      throw new Error(`Pathao token refresh failed: ${error.message}`);
    }
  }

  /**
   * Get valid access token (refresh if expired)
   */
  async getValidPathaoToken(
    courierProviderId: string,
    environment: Environment = 'PRODUCTION'
  ): Promise<string> {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);

    if (!credentials) {
      throw new Error('Platform courier credentials not found');
    }

    const now = new Date();
    const expiryBuffer = new Date(now.getTime() + 5 * 60000);

    if (
      !credentials.accessToken ||
      !credentials.tokenExpiresAt ||
      credentials.tokenExpiresAt <= expiryBuffer
    ) {
      const tokenResponse = credentials.refreshToken
        ? await this.pathaoRefreshToken(courierProviderId, environment)
        : await this.pathaoIssueToken(courierProviderId, environment);
      return tokenResponse.access_token;
    }

    return credentials.accessToken;
  }

  /**
   * Get Pathao cities
   */
  async pathaoGetCities(
    courierProviderId: string,
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const accessToken = await this.getValidPathaoToken(courierProviderId, environment);
    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.get(`${baseUrl}/aladdin/api/v1/city-list`, {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.data;
    } catch (error: any) {
      throw new Error(`Pathao get cities failed: ${error.message}`);
    }
  }

  /**
   * Get Pathao zones
   */
  async pathaoGetZones(
    courierProviderId: string,
    cityId: number,
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const accessToken = await this.getValidPathaoToken(courierProviderId, environment);
    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.get(
        `${baseUrl}/aladdin/api/v1/cities/${cityId}/zone-list`,
        {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`Pathao get zones failed: ${error.message}`);
    }
  }

  /**
   * Get Pathao areas
   */
  async pathaoGetAreas(
    courierProviderId: string,
    zoneId: number,
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const accessToken = await this.getValidPathaoToken(courierProviderId, environment);
    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.get(
        `${baseUrl}/aladdin/api/v1/zones/${zoneId}/area-list`,
        {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`Pathao get areas failed: ${error.message}`);
    }
  }

  /**
   * Get Pathao stores
   */
  async pathaoGetStores(
    courierProviderId: string,
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const accessToken = await this.getValidPathaoToken(courierProviderId, environment);
    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.get(`${baseUrl}/aladdin/api/v1/stores`, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.data;
    } catch (error: any) {
      throw new Error(`Pathao get stores failed: ${error.message}`);
    }
  }

  /**
   * Create Pathao store
   */
  async pathaoCreateStore(
    courierProviderId: string,
    storeData: {
      name: string;
      contact_name: string;
      contact_number: string;
      secondary_contact?: string;
      address: string;
      city_id: number;
      zone_id: number;
      area_id: number;
    },
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const accessToken = await this.getValidPathaoToken(courierProviderId, environment);
    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.post(
        `${baseUrl}/aladdin/api/v1/stores`,
        storeData,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`Pathao store creation failed: ${error.message}`);
    }
  }

  /**
   * Calculate Pathao price
   */
  async pathaoCalculatePrice(
    courierProviderId: string,
    priceData: {
      store_id: number;
      item_type: number;
      delivery_type: number;
      item_weight: number;
      recipient_city: number;
      recipient_zone: number;
    },
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const accessToken = await this.getValidPathaoToken(courierProviderId, environment);
    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.post(
        `${baseUrl}/aladdin/api/v1/merchant/price-plan`,
        priceData,
        {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`Pathao price calculation failed: ${error.message}`);
    }
  }

  /**
   * Get Pathao order info
   */
  async pathaoGetOrderInfo(
    courierProviderId: string,
    consignmentId: string,
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const accessToken = await this.getValidPathaoToken(courierProviderId, environment);
    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.get(
        `${baseUrl}/aladdin/api/v1/orders/${consignmentId}/info`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`Pathao get order info failed: ${error.message}`);
    }
  }

  // ==================== REDX INTEGRATION ====================

  /**
   * Get RedX areas
   */
 async redxGetAreas(
  courierProviderId: string,
  filters?: {
    post_code?: number;
    district_name?: string;
  },
  environment: Environment = 'PRODUCTION'
) {
  const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
  if (!credentials) throw new Error('Platform courier credentials not found');

  const baseUrl =
    environment === 'SANDBOX'
      ? credentials.courier_providers.sandboxBaseUrl
      : credentials.courier_providers.productionBaseUrl;

  // First, try to get ALL areas without filters
  let url = `${baseUrl}/v1.0.0-beta/areas`;

  console.log('RedX API Request (all areas):', {
    url,
    token: credentials.bearerToken?.substring(0, 20) + '...',
  });

  try {
   const response = await this.axiosInstance.get(url, {
      headers: {
        'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`, 
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    console.log('RedX API Response:', {
      status: response.status,
      totalAreas: response.data?.areas?.length || 0,
      sampleArea: response.data?.areas?.[0],
    });

    // Filter on the backend if filters were provided
    let areas = response.data?.areas || [];
    
    if (filters?.post_code) {
      areas = areas.filter((area: any) => area.post_code === filters.post_code);
    }
    
    if (filters?.district_name) {
      areas = areas.filter((area: any) => 
        area.district_name?.toLowerCase().includes(filters.district_name!.toLowerCase()) ||
        area.name?.toLowerCase().includes(filters.district_name!.toLowerCase())
      );
    }

    return {
      ...response.data,
      areas,
      filtered: !!(filters?.post_code || filters?.district_name),
    };
  } catch (error: any) {
    console.error('RedX API Error Details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      headers: error.response?.headers,
      requestUrl: url,
      requestHeaders: {
        'API-ACCESS-TOKEN': credentials.bearerToken?.substring(0, 20) + '...',
      },
    });

    if (error.response?.status === 404) {
      throw new Error(
        `RedX API endpoint not found. Please verify the API documentation. URL: ${url}`
      );
    }
    
    if (error.response?.status === 401 || error.response?.status === 403) {
      throw new Error(
        `RedX authentication failed. Token might be invalid or expired.`
      );
    }

    throw new Error(
      `RedX get areas failed: ${error.message}`
    );
  }
}
  /**
   * Get RedX pickup stores
   */
  async redxGetPickupStores(
    courierProviderId: string,
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.get(`${baseUrl}/v1.0.0-beta/pickup/stores`, {
        headers: {
          'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
        },
      });

      return response.data;
    } catch (error: any) {
      throw new Error(`RedX get pickup stores failed: ${error.message}`);
    }
  }

  /**
   * Create RedX pickup store
   */
  async redxCreatePickupStore(
    courierProviderId: string,
    storeData: {
      name: string;
      phone: string;
      address: string;
      area_id: number;
    },
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.post(
        `${baseUrl}/v1.0.0-beta/pickup/store`,
        storeData,
        {
          headers: {
            'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`RedX create pickup store failed: ${error.message}`);
    }
  }

  /**
   * Calculate RedX parcel charge
   */
  async redxCalculateCharge(
    courierProviderId: string,
    chargeData: {
      delivery_area_id: number;
      pickup_area_id: number;
      cash_collection_amount: number;
      weight: number;
    },
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    const params = new URLSearchParams({
      delivery_area_id: chargeData.delivery_area_id.toString(),
      pickup_area_id: chargeData.pickup_area_id.toString(),
      cash_collection_amount: chargeData.cash_collection_amount.toString(),
      weight: chargeData.weight.toString(),
    });

    try {
      const response = await this.axiosInstance.get(
        `${baseUrl}/v1.0.0-beta/charge/charge_calculator?${params.toString()}`,
        {
          headers: {
            'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
          },
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`RedX charge calculation failed: ${error.message}`);
    }
  }

  /**
   * Track RedX parcel
   */
  async redxTrackParcel(
    courierProviderId: string,
    trackingId: string,
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');

    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.get(
        `${baseUrl}/v1.0.0-beta/parcel/track/${trackingId}`,
        {
          headers: {
            'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
          },
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`RedX track parcel failed: ${error.message}`);
    }
  }

  // ==================== ORDER MANAGEMENT ====================

  /**
   * Create courier order for vendor
   */
  async createCourierOrderForVendor(
    orderId: number,
    vendorId: string,
    orderDetails: OrderDetails
  ) {
    try {
      // Step 1: Select the best courier based on pricing and availability
      const selectedCourier = await this.selectBestCourier({
        vendorWarehouseLocationId: orderDetails.vendorWarehouseLocationId,
        customerDeliveryLocationId: orderDetails.recipientLocationId,
        orderWeight: orderDetails.itemWeight,
        codAmount: orderDetails.codAmount,
        deliveryType: orderDetails.deliveryType,
      });

      console.log(`Selected courier: ${selectedCourier.courierName} for order ${orderId}`);

      // Step 2: Get serviceable area mappings for both locations
      const pickupArea = await prisma.courierServicableAreas.findFirst({
        where: {
          courierProviderId: selectedCourier.courierProviderId,
          locationId: orderDetails.vendorWarehouseLocationId,
          homeDeliveryAvailable: true,
          isActive: true,
        },
      });

      const deliveryArea = await prisma.courierServicableAreas.findFirst({
        where: {
          courierProviderId: selectedCourier.courierProviderId,
          locationId: orderDetails.recipientLocationId,
          homeDeliveryAvailable: true,
          isActive: true,
        },
      });

      if (!pickupArea || !deliveryArea) {
        throw new Error('Service area mapping not found for selected courier');
      }

      // Step 3: Create order in courier provider's system
      let courierResponse: any;
      let courierTrackingId: string;
      let courierOrderId: string;

      if (selectedCourier.courierName === 'Pathao') {
        courierResponse = await this.createPathaoOrder(
          selectedCourier.courierProviderId,
          {
            ...orderDetails,
            pickupArea,
            deliveryArea,
          }
        );
        courierTrackingId = courierResponse.data.consignment_id;
        courierOrderId = courierResponse.data.merchant_order_id || `ORDER-${orderId}`;
      } else if (selectedCourier.courierName === 'RedX') {
        courierResponse = await this.createRedXOrder(
          selectedCourier.courierProviderId,
          {
            ...orderDetails,
            pickupArea,
            deliveryArea,
          }
        );
        courierTrackingId = courierResponse.tracking_id;
        courierOrderId = courierResponse.tracking_id;
      } else {
        throw new Error(`Unsupported courier provider: ${selectedCourier.courierName}`);
      }

      // Step 4: Save courier order in database
      const courierOrder = await prisma.courierOrder.create({
        data: {
          orderId: orderId,
          vendorId: vendorId,
          courierProviderId: selectedCourier.courierProviderId,
          courierOrderId: courierOrderId,
          courierTrackingId: courierTrackingId,
          
          // Recipient details
          recipientName: orderDetails.recipientName,
          recipientPhone: orderDetails.recipientPhone,
          recipientSecondaryPhone: orderDetails.recipientSecondaryPhone,
          recipientAddress: orderDetails.recipientAddress,
          recipientLocationId: orderDetails.recipientLocationId,
          
          // Pickup details
          vendorWarehouseLocationId: orderDetails.vendorWarehouseLocationId,
          pickupAreaId: pickupArea.id,
          deliveryAreaId: deliveryArea.id,
          
          // Package details
          itemDescription: orderDetails.itemDescription,
          itemQuantity: orderDetails.itemQuantity,
          itemWeight: orderDetails.itemWeight,
          itemValue: orderDetails.itemValue,
          
          // Pricing
          codAmount: orderDetails.codAmount,
          deliveryCharge: selectedCourier.pricing.deliveryCharge,
          codCharge: selectedCourier.pricing.codCharge,
          totalCharge: selectedCourier.pricing.totalCharge,
          
          // Delivery details
          deliveryType: orderDetails.deliveryType,
          estimatedDeliveryDays: selectedCourier.pricing.estimatedDeliveryDays,
          specialInstructions: orderDetails.specialInstructions,
          
          // Status
          status: 'PENDING',
          courierStatus: 'Order Created',
          lastStatusUpdate: new Date(),
          
          // Raw response from courier
          rawCourierResponse: courierResponse,
          
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Step 5: Create initial tracking history entry
      await prisma.courierTrackingHistory.create({
        data: {
          courierOrderId: courierOrder.id,
          status: 'PENDING',
          courierStatus: 'Order Created Successfully',
          messageEn: 'Your order has been created and is pending pickup',
          messageBn: 'আপনার অর্ডার তৈরি হয়েছে এবং পিকআপের অপেক্ষায় রয়েছে',
          timestamp: new Date(),
        },
      });

      console.log(`Courier order created successfully: ${courierTrackingId}`);

      return {
        success: true,
        courierOrder: {
          id: courierOrder.id,
          trackingId: courierTrackingId,
          orderId: courierOrderId,
          courierName: selectedCourier.courierName,
          status: courierOrder.status,
          deliveryCharge: courierOrder.deliveryCharge,
          codCharge: courierOrder.codCharge,
          totalCharge: courierOrder.totalCharge,
          estimatedDeliveryDays: courierOrder.estimatedDeliveryDays,
        },
        pricing: selectedCourier.pricing,
      };
    } catch (error: any) {
      console.error('Failed to create courier order:', error);
      
      // Log the error for debugging
      await prisma.courierOrder.create({
        data: {
          orderId: orderId,
          vendorId: vendorId,
          courierProviderId: 'manual', // Use manual as fallback
          status: 'FAILED',
          courierStatus: 'Order creation failed',
          rawCourierResponse: { error: error.message },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      throw new Error(`Failed to create courier order: ${error.message}`);
    }
  }

  /**
   * Create order in Pathao system
   */
  private async createPathaoOrder(
    courierProviderId: string,
    orderData: {
      recipientName: string;
      recipientPhone: string;
      recipientSecondaryPhone?: string;
      recipientAddress: string;
      itemDescription: string;
      itemQuantity: number;
      itemWeight: number;
      codAmount: number;
      deliveryType: 'NORMAL' | 'EXPRESS';
      specialInstructions?: string;
      pickupArea: any;
      deliveryArea: any;
    },
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials || !credentials.storeId) {
      throw new Error('Pathao store not configured');
    }

    const accessToken = await this.getValidPathaoToken(courierProviderId, environment);
    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    const pathaoOrderData = {
      store_id: parseInt(credentials.storeId),
      merchant_order_id: `ORDER-${Date.now()}`, // Generate unique merchant order ID
      recipient_name: orderData.recipientName,
      recipient_phone: orderData.recipientPhone,
      recipient_secondary_phone: orderData.recipientSecondaryPhone,
      recipient_address: orderData.recipientAddress,
      recipient_city: parseInt(orderData.deliveryArea.courierCityId!),
      recipient_zone: parseInt(orderData.deliveryArea.courierZoneId!),
      recipient_area: parseInt(orderData.deliveryArea.courierAreaId!),
      delivery_type: orderData.deliveryType === 'EXPRESS' ? 12 : 48, // 12 for express, 48 for normal
      item_type: 2, // 2 for parcel, 1 for document
      special_instruction: orderData.specialInstructions || '',
      item_quantity: orderData.itemQuantity,
      item_weight: orderData.itemWeight,
      item_description: orderData.itemDescription,
      amount_to_collect: orderData.codAmount,
    };

    try {
      const response = await this.axiosInstance.post(
        `${baseUrl}/aladdin/api/v1/orders`,
        pathaoOrderData,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`Pathao order creation failed: ${error.message}`);
    }
  }

  /**
   * Create order in RedX system
   */
  private async createRedXOrder(
    courierProviderId: string,
    orderData: {
      recipientName: string;
      recipientPhone: string;
      recipientAddress: string;
      itemDescription: string;
      itemQuantity: number;
      itemWeight: number;
      codAmount: number;
      itemValue?: number;
      specialInstructions?: string;
      pickupArea: any;
      deliveryArea: any;
    },
    environment: Environment = 'PRODUCTION'
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) {
      throw new Error('RedX credentials not configured');
    }

    // Get pickup store ID (you need to have created a pickup store beforehand)
    const pickupStores = await this.redxGetPickupStores(courierProviderId, environment);
    const pickupStore = pickupStores.pickup_stores?.[0]; // Use first available store

    if (!pickupStore) {
      throw new Error('No pickup store configured for RedX');
    }

    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    const redxOrderData = {
      customer_name: orderData.recipientName,
      customer_phone: orderData.recipientPhone,
      delivery_area: orderData.deliveryArea.courierAreaName,
      delivery_area_id: parseInt(orderData.deliveryArea.courierAreaId),
      customer_address: orderData.recipientAddress,
      merchant_invoice_id: `INV-${Date.now()}`,
      cash_collection_amount: orderData.codAmount.toString(),
      parcel_weight: orderData.itemWeight.toString(),
      instruction: orderData.specialInstructions || '',
      value: (orderData.itemValue || orderData.codAmount).toString(),
      pickup_store_id: pickupStore.id,
      parcel_details_json: [
        {
          name: orderData.itemDescription,
          category: 'General',
          value: orderData.itemValue || orderData.codAmount,
        },
      ],
    };

    try {
      const response = await this.axiosInstance.post(`${baseUrl}/v1.0.0-beta/parcel`, redxOrderData, {
        headers: {
          'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
          'Content-Type': 'application/json',
        },
      });

      return response.data;
    } catch (error: any) {
      throw new Error(`RedX order creation failed: ${error.message}`);
    }
  }

  /**
   * Vendor marks order as ready for pickup
   * This method is called when the vendor has prepared the package and it's ready to be picked up by the courier
   */
  async vendorMarkReadyForPickup(vendorId: string, orderId: number) {
    // Step 1: Find the courier order
    const courierOrder = await prisma.courierOrder.findFirst({
      where: { 
        orderId, 
        vendorId 
      },
      include: {
        courier_providers: true,
      },
    });

    if (!courierOrder) {
      throw new Error('Courier order not found');
    }

    // Step 2: Validate current status - can only mark as ready if currently pending
    if (courierOrder.status !== 'PENDING') {
      throw new Error(
        `Cannot mark order as ready. Current status: ${courierOrder.status}. Only PENDING orders can be marked as ready.`
      );
    }

    // Step 3: Update courier order status
    const updatedOrder = await prisma.courierOrder.update({
      where: { id: courierOrder.id },
      data: {
        status: 'READY_FOR_PICKUP',
        courierStatus: 'Package ready for pickup',
        lastStatusUpdate: new Date(),
        updatedAt: new Date(),
      },
    });

    // Step 4: Create tracking history entry
    await prisma.courierTrackingHistory.create({
      data: {
        courierOrderId: courierOrder.id,
        status: 'READY_FOR_PICKUP',
        courierStatus: 'Vendor marked package as ready for pickup',
        messageEn: 'Package is ready for courier pickup',
        messageBn: 'প্যাকেজ কুরিয়ার পিকআপের জন্য প্রস্তুত',
        timestamp: new Date(),
      },
    });

    // Step 5: Optionally notify the courier provider (if they have webhook/notification API)
    // This would be courier-specific implementation
    try {
      if (courierOrder.courier_providers.name === 'Pathao') {
        // Pathao doesn't require explicit ready-for-pickup notification
        console.log('Pathao order marked ready, waiting for scheduled pickup');
      } else if (courierOrder.courier_providers.name === 'RedX') {
        // RedX also doesn't require explicit notification
        console.log('RedX order marked ready, waiting for scheduled pickup');
      }
    } catch (error) {
      // Log error but don't fail the operation
      console.error('Failed to notify courier provider:', error);
    }

    console.log(`Order ${orderId} marked as ready for pickup by vendor ${vendorId}`);

    return {
      success: true,
      order: {
        id: updatedOrder.id,
        trackingId: updatedOrder.courierTrackingId,
        status: updatedOrder.status,
        courierStatus: updatedOrder.courierStatus,
        lastStatusUpdate: updatedOrder.lastStatusUpdate,
      },
    };
  }

  /**
   * Get courier order by tracking ID
   */
  async getCourierOrderByTrackingId(trackingId: string) {
    return await prisma.courierOrder.findFirst({
      where: { courierTrackingId: trackingId },
      include: {
        vendorOrders: true,
        courier_providers: true,
        vendors: true,
        courier_tracking_history: {
          orderBy: { timestamp: 'desc' },
        },
      },
    });
  }

  /**
   * Get courier orders by order ID
   */
  async getCourierOrdersByOrderId(orderId: number) {
    return await prisma.courierOrder.findMany({
      where: { orderId },
      include: {
        courier_providers: true,
        vendors: true,
        courier_tracking_history: {
          orderBy: { timestamp: 'desc' },
        },
      },
    });
  }


  

  /**
   * Generate shipping label
   */
   async generateShippingLabel(orderId: number) {
    const courierOrder = await prisma.courierOrder.findFirst({
      where: { orderId },
      include: {
        vendorOrders: true,
        courier_providers: true,
      },
    });

    if (!courierOrder) {
      throw new Error('Courier order not found');
    }

    return {
      trackingId: courierOrder.courierTrackingId,
      orderId: courierOrder.courierOrderId,
      courierName: courierOrder.courier_providers.name,
      courierLogo: courierOrder.courier_providers.logo,
      recipientName: courierOrder.recipientName,
      recipientPhone: courierOrder.recipientPhone,
      recipientAddress: courierOrder.recipientAddress,
      codAmount: courierOrder.codAmount,
      weight: courierOrder.itemWeight,
      itemDescription: courierOrder.itemDescription,
      barcode: courierOrder.courierTrackingId,
      createdAt: courierOrder.createdAt,
    };
  }


  // ==================== WEBHOOK HANDLERS ====================

  /**
   * Handle Pathao webhook
   */
  async handlePathaoWebhook(webhookData: any) {
    // Webhook handling logic
    console.log('Pathao webhook received:', webhookData);
  }

  /**
   * Handle RedX webhook
   */
  async handleRedXWebhook(webhookData: any) {
    // Webhook handling logic
    console.log('RedX webhook received:', webhookData);
  }
}

export default new CourierService();