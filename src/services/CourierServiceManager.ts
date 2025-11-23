import axios from "axios";
import { PrismaClient } from "@prisma/client";
import Redis from "redis";
import redisClient from "../config/redis.ts";

const prisma = new PrismaClient();




// Initialize Redis connection
(async () => {
  try {
    await redisClient.connect();
  } catch (error) {
    console.error("Failed to connect to Redis:", error);
  }
})();

// Enhanced Types
interface PackageData {
  item_weight: number;
  height?: number;
  width?: number;
  length?: number;
  destination: string;
  codAmount?: number;
  recipient_city?:number,
  recipient_zone?:number,
  delivery_type?:number,
  item_type?: string;
}

interface OrderData {
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  customerAddress?: string;
  deliveryArea: string;
  deliveryAreaId: number;
  cashCollectionAmount: number;
  parcelWeight: number;
  merchantInvoiceId: string;
  instruction?: string;
  itemDescription?: string;
  pickupStoreId?: number;
}

interface TrackingResult {
  status: string;
  updates: Array<{
    message_en: string;
    message_bn: string;
    time: string;
  }>;
}

interface BalanceInfo {
  currentBalance: number;
  currency?: string;
}

// ✅ City type
interface City {
  city_id: number;
  city_name: string;
}

// ✅ Zone type
interface Zone {
  zone_id: number;
  zone_name: string;
}

// ✅ Area type
interface Area {
  area_id: number;
  area_name: string;
  home_delivery_available: boolean;
  pickup_available: boolean;
}

interface Store {
  id: number;
  name: string;
  address: string;
  area_name: string;
  area_id: number;
  phone: string;
  created_at?: string;
}

interface PriceCalculation {
  deliveryCharge: number;
  codCharge: number;
  finalPrice?: number;
}

interface RateLimitConfig {
  maxRequests: number;
  timeWindow: number;
  retryAttempts: number;
  retryDelay: number;
}

// Cache service for Redis operations
class CacheService {
  private readonly defaultTTL = 5 * 60; // 5 minutes in seconds

  async get<T>(key: string): Promise<T | null> {
    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }
      
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error("Redis get error:", error);
      return null;
    }
  }

  async set(key: string, data: any, ttl: number = this.defaultTTL): Promise<void> {
    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }
      
      await redisClient.setEx(key, ttl, JSON.stringify(data));
    } catch (error) {
      console.error("Redis set error:", error);
    }
  }

  async del(key: string): Promise<void> {
    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }
      
      await redisClient.del(key);
    } catch (error) {
      console.error("Redis delete error:", error);
    }
  }

  async getOrSet<T>(
    key: string, 
    fetchFunction: () => Promise<T>, 
    ttl: number = this.defaultTTL
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    
    const freshData = await fetchFunction();
    await this.set(key, freshData, ttl);
    return freshData;
  }

  async clearPattern(pattern: string): Promise<void> {
    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }
      
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (error) {
      console.error("Redis clear pattern error:", error);
    }
  }
}

export const cacheService = new CacheService();

// Base Courier Service Abstract Class with enhanced rate limiting
abstract class BaseCourierService {
  protected baseUrl: string;
  protected config: any;
  protected token: string | null = null;
  private lastRequestTime: number = 0;
  private requestQueue: Promise<any> = Promise.resolve();
  private requestCount: number = 0;
  private windowStart: number = Date.now();

  constructor(baseUrl: string, config: any) {
    this.baseUrl = baseUrl;
    this.config = config;
  }

  abstract authenticate(): Promise<void>;
  abstract getCities(): Promise<City[]>;
  abstract getAreas(filters?: { postCode?: number; districtName?: string }): Promise<Area[]>;
  abstract getZones(cityId?: number): Promise<Zone[]>;
  abstract calculateCharge(packageData: PackageData): Promise<PriceCalculation>;
  abstract createOrder(orderData: OrderData): Promise<{ trackingId: string; consignmentId?: string }>;
  abstract trackOrder(trackingId: string): Promise<TrackingResult>;
  abstract getBalance(): Promise<BalanceInfo>;
  abstract getStores(): Promise<Store[]>;

  protected getRateLimitConfig(): RateLimitConfig {
    return {
      maxRequests: 30, // Increased for batch operations
      timeWindow: 60000, // 1 minute
      retryAttempts: 3,
      retryDelay: 1000,
    };
  }

  protected async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected async enforceRateLimit(): Promise<void> {
    const rateLimit = this.getRateLimitConfig();
    const now = Date.now();
    
    // Reset counter if window has passed
    if (now - this.windowStart > rateLimit.timeWindow) {
      this.requestCount = 0;
      this.windowStart = now;
    }
    
    // Check if we've exceeded the rate limit
    if (this.requestCount >= rateLimit.maxRequests) {
      const waitTime = rateLimit.timeWindow - (now - this.windowStart);
      console.warn(`Rate limit exceeded. Waiting ${waitTime}ms`);
      await this.delay(waitTime);
      this.requestCount = 0;
      this.windowStart = Date.now();
    }
    
    // Ensure minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minDelay = rateLimit.timeWindow / rateLimit.maxRequests;
    
    if (timeSinceLastRequest < minDelay) {
      await this.delay(minDelay - timeSinceLastRequest);
    }
  }

 protected async makeRequest<T = any>(endpoint: string, options: any = {}): Promise<T> {
  const rateLimit = this.getRateLimitConfig();
  
  return this.requestQueue = this.requestQueue.then(async () => {
    await this.enforceRateLimit();

    for (let attempt = 1; attempt <= rateLimit.retryAttempts; attempt++) {
      try {
        // Ensure we have a valid token
        if (!this.token) {
          console.log('🔄 No token found, authenticating...');
          await this.authenticate();
        }

        const config = {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'CourierService/1.0',
            ...options.headers,
          },
          ...options,
          url: `${this.baseUrl}${endpoint}`,
          timeout: 30000,
          validateStatus: (status: number) => status < 500,
        };

        console.log(`🔄 API Request (attempt ${attempt}): ${config.method || 'GET'} ${config.url}`);
        
        const response = await axios(config);
        this.requestCount++;
        this.lastRequestTime = Date.now();
        
        console.log(`✅ API Response Status: ${response.status}`);
        
        // Check for API-specific error responses
        if (response.data?.errors || response.data?.error) {
          const errorMsg = response.data.errors || response.data.error;
          console.error('❌ API returned error:', errorMsg);
          throw new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
        }
        
        return response.data;

      } catch (error: any) {
        console.error(`❌ API Request failed (attempt ${attempt}/${rateLimit.retryAttempts}):`, {
          endpoint,
          method: options.method || 'GET',
          status: error.response?.status,
          statusText: error.response?.statusText,
          responseData: error.response?.data,
          errorMessage: error.message,
          errorCode: error.code,
        });

        // Handle specific error cases
        if (error.response?.status === 401) {
          console.log('🔑 Token expired, clearing cache and re-authenticating...');
          this.token = null;
          await cacheService.del(this.getCacheKey('authToken'));
          continue;
        }
        
        if (error.response?.status === 429) {
          const waitTime = Math.pow(2, attempt) * rateLimit.retryDelay;
          console.warn(`⏳ Rate limited. Waiting ${waitTime}ms before retry`);
          await this.delay(waitTime);
          continue;
        }
        
        if (error.code === 'ECONNABORTED') {
          console.warn(`⏰ Request timeout, retrying...`);
          await this.delay(rateLimit.retryDelay * attempt);
          continue;
        }
        
        if (error.response?.status >= 400 && error.response?.status < 500) {
          // Client error - don't retry for 4xx errors (except 429)
          throw new Error(`Client error ${error.response.status}: ${error.response.data?.message || error.response.statusText}`);
        }
        
        if (attempt === rateLimit.retryAttempts) {
          throw new Error(`All retry attempts failed: ${error.message}`);
        }
        
        await this.delay(rateLimit.retryDelay * attempt);
      }
    }
    
    throw new Error('All retry attempts failed');
  });
}

private handleApiError(error: any, endpoint: string): Error {
  let errorMessage = 'Unknown error occurred';
  
  // Extract meaningful error message
  if (typeof error === 'string') {
    errorMessage = error;
  } else if (error?.message) {
    errorMessage = error.message;
  } else if (error?.response?.data) {
    // Try to extract from response data
    const responseData = error.response.data;
    if (typeof responseData === 'string') {
      errorMessage = responseData;
    } else if (responseData.message) {
      errorMessage = responseData.message;
    } else if (responseData.error) {
      errorMessage = responseData.error;
    } else if (responseData.errors) {
      errorMessage = JSON.stringify(responseData.errors);
    } else {
      errorMessage = JSON.stringify(responseData);
    }
  } else if (error?.response?.statusText) {
    errorMessage = error.response.statusText;
  } else if (error?.code) {
    errorMessage = `Network error: ${error.code}`;
  }

  console.error('🔍 Detailed Error Analysis:', {
    endpoint,
    errorType: error?.constructor?.name,
    errorKeys: error ? Object.keys(error) : [],
    responseKeys: error?.response ? Object.keys(error.response) : [],
    responseDataKeys: error?.response?.data ? Object.keys(error.response.data) : []
  });

  return new Error(`API Error: ${errorMessage} - Endpoint: ${endpoint}`);
}

  // Cache key generator
  protected getCacheKey(method: string, params: any = {}): string {
    const providerName = this.constructor.name.replace('Service', '').toLowerCase();
    return `courier:${providerName}:${method}:${JSON.stringify(params)}`;
  }
}

// RedX Service Implementation
// RedX Service - Complete Implementation with Correct Authentication
class RedXService extends BaseCourierService {
  
  /**
   * RedX Authentication
   * RedX uses Bearer token authentication via API-ACCESS-TOKEN header
   */
  async authenticate(): Promise {
    // Validate token exists
    if (!this.config.token && !this.config.apiKey) {
      throw new Error('RedX requires a token in configuration');
    }
    
    // RedX uses a JWT token directly - no separate authentication endpoint needed
    this.token = this.config.token || this.config.apiKey;
    console.log('🔑 RedX authentication configured with Bearer token');
  }

  /**
   * Override makeRequest to use RedX-specific Bearer token authentication
   */
  protected async makeRequest(endpoint: string, options: any = {}): Promise {
    const rateLimit = this.getRateLimitConfig();
    
    return this.requestQueue = this.requestQueue.then(async () => {
      await this.enforceRateLimit();

      for (let attempt = 1; attempt <= rateLimit.retryAttempts; attempt++) {
        try {
          // Ensure authentication is configured
          if (!this.token) {
            console.log('🔄 No authentication found, configuring...');
            await this.authenticate();
          }

          // RedX uses 'API-ACCESS-TOKEN: Bearer {token}' header
          const config = {
            headers: {
              'API-ACCESS-TOKEN': `Bearer ${this.token}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              ...options.headers,
            },
            ...options,
            url: `${this.baseUrl}${endpoint}`,
            timeout: 30000,
            validateStatus: (status: number) => status < 500,
          };

          console.log(`🔄 RedX API Request (attempt ${attempt}): ${config.method || 'GET'} ${config.url}`);

          const response = await axios(config);
          this.requestCount++;
          this.lastRequestTime = Date.now();

          console.log(`✅ RedX API Response Status: ${response.status}`);

          // Check for error responses
          if (response.status === 401) {
            throw new Error('RedX Authentication Failed: Invalid or expired token');
          }

          if (response.status === 403) {
            throw new Error('RedX Authorization Failed: Access forbidden');
          }

          if (response.data?.errors || response.data?.error) {
            const errorMsg = response.data.errors || response.data.error;
            console.error('❌ RedX API returned error:', errorMsg);
            throw new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
          }

          return response.data;

        } catch (error: any) {
          console.error(`❌ RedX API Request failed (attempt ${attempt}/${rateLimit.retryAttempts}):`, {
            endpoint,
            method: options.method || 'GET',
            status: error.response?.status,
            statusText: error.response?.statusText,
            responseData: error.response?.data,
            errorMessage: error.message,
            errorCode: error.code,
          });

          // Handle authentication errors - don't retry
          if (error.response?.status === 401) {
            throw new Error(`RedX Authentication Failed: Please verify your token is correct. Use sandbox token for testing or production token for live environment.`);
          }

          if (error.response?.status === 403) {
            throw new Error(`RedX Authorization Failed: Token does not have permission to access this resource`);
          }

          // Handle rate limiting
          if (error.response?.status === 429) {
            const waitTime = Math.pow(2, attempt) * rateLimit.retryDelay;
            console.warn(`⏳ RedX rate limited. Waiting ${waitTime}ms before retry`);
            await this.delay(waitTime);
            continue;
          }

          // Handle timeout
          if (error.code === 'ECONNABORTED') {
            console.warn(`⏰ RedX request timeout, retrying...`);
            await this.delay(rateLimit.retryDelay * attempt);
            continue;
          }

          // Handle client errors - don't retry
          if (error.response?.status >= 400 && error.response?.status < 500) {
            throw new Error(`RedX Client Error ${error.response.status}: ${error.response.data?.message || error.response.statusText}`);
          }

          // Last attempt failed
          if (attempt === rateLimit.retryAttempts) {
            throw new Error(`RedX API: All retry attempts failed - ${error.message}`);
          }

          // Wait before retry
          await this.delay(rateLimit.retryDelay * attempt);
        }
      }

      throw new Error('RedX API: All retry attempts failed');
    });
  }

  /**
   * Get all cities/areas from RedX
   * RedX API returns areas which we map to cities for unified interface
   */
  async getCities(): Promise {
    const cacheKey = this.getCacheKey('getCities');
    return cacheService.getOrSet(cacheKey, async () => {
      console.log('🌐 Fetching all areas from RedX...');
      
      const response = await this.makeRequest<{ areas: RedxArea[] }>('/areas', {
        method: 'GET'
      });

      if (!response.areas || !Array.isArray(response.areas)) {
        console.warn('⚠️ RedX returned no areas');
        return [];
      }

      // Transform RedX areas to City-like structure
      const cities = response.areas.map(area => ({
        city_id: area.id,
        city_name: area.name,
        post_code: area.post_code,
        division_name: area.division_name,
        zone_id: area.zone_id
      }));

      console.log(`✅ Successfully fetched ${cities.length} areas from RedX`);
      return cities;
    }, 24 * 60 * 60); // Cache 24 hours
  }

  /**
   * Get zones by filters (postal code or district name)
   * RedX uses areas endpoint with query parameters
   */
  async getZones(filters?: { postCode?: number; districtName?: string }): Promise {
    if (!filters?.postCode && !filters?.districtName) {
      throw new Error("postCode or districtName is required for RedX getZones");
    }

    const cacheKey = this.getCacheKey('getZones', filters);
    console.log(`🔍 Fetching RedX zones with filters:`, filters);

    return cacheService.getOrSet(cacheKey, async () => {
      try {
        const params: any = {};
        
        if (filters.postCode) {
          params.post_code = filters.postCode;
        }
        
        if (filters.districtName) {
          params.district_name = filters.districtName;
        }

        console.log(`🌐 Making API call to /areas with params:`, params);

        const response = await this.makeRequest<{ areas: RedxArea[] }>('/areas', {
          method: 'GET',
          params
        });

        if (!response.areas || !Array.isArray(response.areas)) {
          console.warn('⚠️ RedX returned no zones');
          return [];
        }

        // Transform RedX areas to Zone-like structure
        const zones = response.areas.map(area => ({
          zone_id: area.id,
          zone_name: area.name,
          post_code: area.post_code,
          division_name: area.division_name,
          city_id: area.zone_id
        }));

        console.log(`✅ Successfully fetched ${zones.length} zones from RedX`);
        return zones;
      } catch (error: any) {
        console.error(`❌ Failed to fetch zones from RedX:`, error.message);
        throw error;
      }
    }, 2 * 60 * 60); // Cache 2 hours
  }

  /**
   * Get areas by filters
   * For RedX, this uses the same areas endpoint
   */
  async getAreas(filters?: { zoneId?: number; postCode?: number; districtName?: string }): Promise {
    // Handle zoneId filtering
    if (filters?.zoneId) {
      console.log('⚠️ RedX does not support zoneId filtering directly. Using general area lookup.');
    }

    // If no specific filters, return all areas
    if (!filters?.postCode && !filters?.districtName) {
      return this.getCities() as Promise;
    }

    const cacheKey = this.getCacheKey('getAreas', filters);
    console.log(`🔍 Fetching RedX areas with filters:`, filters);

    return cacheService.getOrSet(cacheKey, async () => {
      try {
        const params: any = {};
        
        if (filters.postCode) {
          params.post_code = filters.postCode;
        }
        
        if (filters.districtName) {
          params.district_name = filters.districtName;
        }

        console.log(`🌐 Making API call to /areas with params:`, params);

        const response = await this.makeRequest<{ areas: RedxArea[] }>('/areas', {
          method: 'GET',
          params
        });

        if (!response.areas || !Array.isArray(response.areas)) {
          console.warn('⚠️ RedX returned no areas');
          return [];
        }

        // Transform to unified Area structure
        const areas = response.areas.map(area => ({
          area_id: area.id,
          area_name: area.name,
          post_code: area.post_code,
          division_name: area.division_name,
          zone_id: area.zone_id,
          home_delivery_available: true,
          pickup_available: true
        }));

        console.log(`✅ Successfully fetched ${areas.length} areas from RedX`);
        return areas;
      } catch (error: any) {
        console.error(`❌ Failed to fetch areas from RedX:`, error.message);
        throw error;
      }
    }, 2 * 60 * 60); // Cache 2 hours
  }

  /**
   * Calculate delivery charge for a package
   */
  async calculateCharge(packageData: PackageData): Promise {
    const cacheKey = this.getCacheKey('calculateCharge', packageData);
    
    return cacheService.getOrSet(cacheKey, async () => {
      console.log("📦 Calculating RedX charge with package data:", packageData);

      try {
        // Validate required fields for RedX
        if (!packageData.delivery_area_id || !packageData.pickup_area_id) {
          throw new Error('delivery_area_id and pickup_area_id are required for RedX');
        }

        const params = {
          delivery_area_id: packageData.delivery_area_id,
          pickup_area_id: packageData.pickup_area_id,
          cash_collection_amount: packageData.cash_collection_amount || 0,
          weight: packageData.item_weight * 1000, // Convert KG to grams
        };

        console.log("📨 RedX Charge Calculation Request:", JSON.stringify(params, null, 2));

        const response = await this.makeRequest<{
          deliveryCharge: number;
          codCharge: number;
        }>('/charge/charge_calculator', {
          method: 'GET',
          params,
        });

        console.log("✅ RedX Charge Response:", JSON.stringify(response, null, 2));

        const deliveryCharge = response.deliveryCharge || 0;
        const codCharge = response.codCharge || 0;
        const finalPrice = deliveryCharge + codCharge;

        return {
          deliveryCharge,
          codCharge,
          finalPrice,
        };
      } catch (error: any) {
        console.error('❌ RedX calculateCharge error:', error);
        if (error.response) {
          console.error('Response data:', error.response.data);
          console.error('Response status:', error.response.status);
        }
        throw new Error(`RedX price calculation failed: ${error.message}`);
      }
    }, 30 * 60); // Cache 30 minutes
  }

  /**
   * Create a parcel/order in RedX
   */
  async createOrder(orderData: OrderData): Promise<{ trackingId: string; consignmentId?: string }> {
    console.log('📦 Creating RedX order with data:', orderData);

    try {
      // Prepare order payload according to RedX API specs
      const payload: any = {
        customer_name: orderData.recipientName,
        customer_phone: orderData.recipientPhone,
        delivery_area: orderData.deliveryArea,
        delivery_area_id: orderData.deliveryAreaId,
        customer_address: orderData.recipientAddress,
        merchant_invoice_id: orderData.merchantInvoiceId,
        cash_collection_amount: String(orderData.cashCollectionAmount),
        parcel_weight: String(orderData.parcelWeight), // in grams, as string
        value: "0",
        is_closed_box: "1",
      };

      // Add optional fields
      if (orderData.instruction) {
        payload.instruction = orderData.instruction;
      }

      if (orderData.pickupStoreId) {
        payload.pickup_store_id = orderData.pickupStoreId;
      }

      // Add parcel details if item description exists
      if (orderData.itemDescription) {
        payload.parcel_details_json = [
          {
            name: orderData.itemDescription,
            category: "General",
            value: orderData.cashCollectionAmount || 0,
          }
        ];
      }

      console.log('📨 RedX Order Payload:', JSON.stringify(payload, null, 2));

      const response = await this.makeRequest<{ tracking_id: string }>('/parcel', {
        method: 'POST',
        data: payload,
      });

      console.log('✅ RedX order created successfully:', response.tracking_id);

      // Clear relevant caches
      await cacheService.clearPattern(`courier:redx:getBalance:*`);
      await cacheService.clearPattern(`courier:redx:trackOrder:*`);

      return {
        trackingId: response.tracking_id,
        consignmentId: response.tracking_id // RedX uses tracking_id as consignment_id
      };
    } catch (error: any) {
      console.error('❌ RedX order creation failed:', error);
      throw new Error(`RedX order creation failed: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Track a parcel by tracking ID
   */
  async trackOrder(trackingId: string): Promise {
    const cacheKey = this.getCacheKey('trackOrder', { trackingId });
    
    return cacheService.getOrSet(cacheKey, async () => {
      console.log(`🔍 Tracking RedX order: ${trackingId}`);

      try {
        const response = await this.makeRequest<{
          tracking: Array<{
            message_en: string;
            message_bn: string;
            time: string;
          }>;
        }>(`/parcel/track/${trackingId}`, {
          method: 'GET'
        });

        const updates = response.tracking || [];
        const status = updates.length > 0 ? updates[updates.length - 1].message_en : 'unknown';

        console.log(`✅ RedX tracking result: ${status} with ${updates.length} updates`);

        return {
          status,
          updates,
        };
      } catch (error: any) {
        console.error(`❌ RedX tracking failed for ${trackingId}:`, error.message);
        throw error;
      }
    }, 2 * 60); // Cache tracking for 2 minutes
  }

  /**
   * Get parcel details by tracking ID
   */
  async getParcelDetails(trackingId: string): Promise<any> {
    const cacheKey = this.getCacheKey('getParcelDetails', { trackingId });
    
    return cacheService.getOrSet(cacheKey, async () => {
      console.log(`📦 Fetching RedX parcel details: ${trackingId}`);

      try {
        const response = await this.makeRequest<{ parcel: any }>(`/parcel/info/${trackingId}`, {
          method: 'GET'
        });

        console.log(`✅ RedX parcel details fetched for: ${trackingId}`);
        return response.parcel;
      } catch (error: any) {
        console.error(`❌ RedX parcel details fetch failed for ${trackingId}:`, error.message);
        throw error;
      }
    }, 5 * 60); // Cache for 5 minutes
  }

  /**
   * Update parcel (e.g., cancel)
   */
  async updateParcel(trackingId: string, updateDetails: {
    property_name: string;
    new_value: string;
    reason?: string;
  }): Promise<boolean> {
    console.log(`🔄 Updating RedX parcel: ${trackingId}`, updateDetails);

    try {
      const response = await this.makeRequest<{ success: boolean; message: string }>('/parcels', {
        method: 'PATCH',
        data: {
          entity_type: "parcel-tracking-id",
          entity_id: trackingId,
          update_details: updateDetails
        },
      });

      console.log(`✅ RedX parcel updated: ${response.message}`);

      // Clear relevant caches
      await cacheService.clearPattern(`courier:redx:trackOrder:*`);
      await cacheService.clearPattern(`courier:redx:getParcelDetails:*`);

      return response.success;
    } catch (error: any) {
      console.error(`❌ RedX parcel update failed for ${trackingId}:`, error.message);
      throw error;
    }
  }

  /**
   * Cancel a parcel
   */
  async cancelOrder(trackingId: string, reason: string = 'Cancelled by merchant'): Promise<boolean> {
    return this.updateParcel(trackingId, {
      property_name: 'status',
      new_value: 'cancelled',
      reason: reason
    });
  }

  /**
   * Get account balance
   * Note: RedX may not have a balance API endpoint in all plans
   */
  async getBalance(): Promise {
    const cacheKey = this.getCacheKey('getBalance');
    
    return cacheService.getOrSet(cacheKey, async () => {
      console.log('💳 Fetching RedX balance...');
      
      try {
        // RedX might not have a public balance API endpoint
        // Check your RedX API documentation for the correct endpoint
        const response = await this.makeRequest<{ balance: number }>('/account/balance', {
          method: 'GET'
        });

        return {
          currentBalance: response.balance || 0,
          currency: 'BDT'
        };
      } catch (error: any) {
        console.warn('⚠️ RedX balance API not available or failed:', error.message);
        // Return 0 balance if API is not available
        return {
          currentBalance: 0,
          currency: 'BDT'
        };
      }
    }, 10 * 60); // Cache balance for 10 minutes
  }

  /**
   * Get all pickup stores
   */
  async getStores(): Promise {
    const cacheKey = this.getCacheKey('getStores');
    
    return cacheService.getOrSet(cacheKey, async () => {
      console.log('🏪 Fetching RedX pickup stores...');

      try {
        const response = await this.makeRequest<{ pickup_stores: RedxStore[] }>('/pickup/stores', {
          method: 'GET'
        });

        if (!response.pickup_stores || !Array.isArray(response.pickup_stores)) {
          console.warn('⚠️ RedX returned no pickup stores');
          return [];
        }

        const stores = response.pickup_stores.map(store => ({
          id: store.id,
          name: store.name,
          address: store.address,
          area_name: store.area_name,
          area_id: store.area_id,
          phone: store.phone,
          created_at: store.created_at
        }));

        console.log(`✅ Successfully fetched ${stores.length} pickup stores from RedX`);
        return stores;
      } catch (error: any) {
        console.error('❌ Failed to fetch RedX stores:', error.message);
        return []; // Return empty array for graceful degradation
      }
    }, 60 * 60); // Cache stores for 1 hour
  }

  /**
   * Get details of a specific pickup store
   */
  async getPickupStoreDetails(storeId: number): Promise<RedxStore | null> {
    const cacheKey = this.getCacheKey('getPickupStoreDetails', { storeId });
    
    return cacheService.getOrSet(cacheKey, async () => {
      console.log(`🏪 Fetching RedX pickup store details for ID: ${storeId}`);

      try {
        const response = await this.makeRequest<{ pickup_store: RedxStore }>(
          `/pickup/store/info/${storeId}`,
          { method: 'GET' }
        );

        console.log(`✅ Successfully fetched store details for ID: ${storeId}`);
        return response.pickup_store;
      } catch (error: any) {
        console.error(`❌ Failed to fetch store details for ID ${storeId}:`, error.message);
        return null;
      }
    }, 60 * 60); // Cache for 1 hour
  }

  /**
   * Create a new pickup store
   */
  async createPickupStore(storeData: {
    name: string;
    address: string;
    area_id: number;
    phone: string;
  }): Promise<RedxStore> {
    console.log('🏪 Creating new RedX pickup store:', storeData);

    try {
      const response = await this.makeRequest<RedxStore>('/pickup/store', {
        method: 'POST',
        data: storeData,
      });

      console.log('✅ RedX pickup store created successfully:', response);

      // Clear stores cache
      await cacheService.clearPattern(`courier:redx:getStores:*`);

      return response;
    } catch (error: any) {
      console.error('❌ RedX store creation failed:', error);
      throw new Error(`RedX store creation failed: ${error.response?.data?.message || error.message}`);
    }
  }
}

// Type definitions for RedX responses
interface RedxArea {
  id: number;
  name: string;
  post_code: number;
  division_name: string;
  zone_id: number;
}

interface RedxStore {
  id: number;
  name: string;
  address: string;
  area_name: string;
  area_id: number;
  phone: string;
  created_at: string;
}

// Type definitions for Redx responses
interface RedxArea {
  id: number;
  name: string;
  post_code: number;
  division_name: string;
  zone_id: number;
}

interface RedxStore {
  id: number;
  name: string;
  address: string;
  area_name: string;
  area_id: number;
  phone: string;
  created_at: string;
}
// Pathao Service Implementation
class PathaoService extends BaseCourierService {
  private citiesCache: { city_id: number; city_name: string }[] | null = null;

 async authenticate(): Promise<void> {
  const cacheKey = this.getCacheKey('authToken');
  const cachedToken = await cacheService.get<string>(cacheKey);
  
  if (cachedToken) {
    console.log('🔑 Using cached token');
    this.token = cachedToken;
    return;
  }

  try {
    console.log('🔑 Requesting new authentication token...');
    
    const response = await axios.post<{ 
      access_token: string; 
      expires_in: number;
      token_type: string;
    }>(
      `${this.baseUrl}/aladdin/api/v1/issue-token`,
      {
        client_id: this.config.client_id,
        client_secret: this.config.client_secret,
        username: this.config.username,
        password: this.config.password,
        grant_type: "password",
      },
      {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
    
    if (!response.data.access_token) {
      throw new Error('No access token received in response');
    }
    
    this.token = response.data.access_token;
    console.log('✅ Successfully authenticated');
    
    // Cache token with 1 hour expiry
    await cacheService.set(cacheKey, this.token, 60 * 60);
    
  } catch (error: any) {
    console.error('❌ Pathao authentication failed:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw new Error(`Pathao authentication failed: ${error.response?.data?.message || error.message}`);
  }
}

 async getCities(): Promise<City[]> {
  const cacheKey = this.getCacheKey("getCities");

  return cacheService.getOrSet(cacheKey, async () => {
    const response = await this.makeRequest<{
      data: { data: City[] };
    }>("/aladdin/api/v1/city-list", { method: "GET" });

    return response.data?.data || [];
  }, 24 * 60 * 60); // cache 24h
}

async getZones(cityId: number): Promise<Zone[]> {
  const cacheKey = this.getCacheKey("getZones", { cityId });

  return cacheService.getOrSet(cacheKey, async () => {
    const response = await this.makeRequest<{
      data: { data: Zone[] };
    }>(`/aladdin/api/v1/cities/${cityId}/zone-list`, { method: "GET" });

    return response.data?.data || [];
  }, 2 * 60 * 60); // cache 2h
}

async getAreas(filters?: { zoneId?: number; postCode?: number; districtName?: string }): Promise<Area[]> {
  if (!filters?.zoneId) throw new Error("zoneId is required for PathaoService");
  
  const cacheKey = this.getCacheKey("getAreas", { zoneId: filters.zoneId });

  return cacheService.getOrSet(cacheKey, async () => {
    const response = await this.makeRequest<{ data: { data: Area[] } }>(
      `/aladdin/api/v1/zones/${filters.zoneId}/area-list`,
      { method: "GET" }
    );
    return response.data?.data || [];
  }, 2 * 60 * 60);
}


  async calculateCharge(packageData: PackageData): Promise<PriceCalculation> {
    const cacheKey = this.getCacheKey('calculateCharge', packageData);
    console.log("📦 Package Data:", packageData);
    
    return cacheService.getOrSet(cacheKey, async () => {
      try {
        // Validate required fields
        if (!packageData.recipient_city || !packageData.recipient_zone) {
          throw new Error('recipient_city and recipient_zone are required');
        }

        const payload = {
          store_id: Number(this.config.store_id),
          item_type: Number(packageData.item_type) || 2,
          delivery_type: Number(packageData.delivery_type) || 48,
          item_weight: Math.max(0.5, Number(packageData.item_weight)),
          recipient_city: Number(packageData.recipient_city),
          recipient_zone: Number(packageData.recipient_zone),
        };

        console.log("📨 Request Payload:", JSON.stringify(payload, null, 2));

        // Make the API request
        const response = await this.makeRequest<any>('/aladdin/api/v1/merchant/price-plan', {
          method: 'POST',
          data: payload,
        });

        console.log("✅ API Response:", JSON.stringify(response, null, 2));

        // Handle different response structures
        if (response.code !== 200) {
          throw new Error(response.message || `API Error: ${response.code}`);
        }

        // Extract data based on actual response structure
        let priceData;
        if (response.data) {
          // Structure: { code: 200, message: "Success", data: { price: 100, ... } }
          priceData = response.data;
        } else if (response.price !== undefined) {
          // Structure: { price: 100, ... }
          priceData = response;
        } else {
          throw new Error('Invalid response structure from Pathao API');
        }

        // Calculate final price
        const deliveryCharge = priceData.price || 0;
        const codCharge = (priceData.cod_percentage || 0) * deliveryCharge;
        const finalPrice = priceData.final_price || deliveryCharge + codCharge;

        return {
          deliveryCharge,
          codCharge,
          finalPrice,
        };

      } catch (error: any) {
        console.error('❌ Pathao calculateCharge error:', error);
        
        // Enhanced error logging
        if (error.response) {
          console.error('Response data:', error.response.data);
          console.error('Response status:', error.response.status);
          console.error('Response headers:', error.response.headers);
        }
        
        throw new Error(`Pathao price calculation failed: ${error.message}`);
      }
    }, 30 * 60);
  }

  async createOrder(orderData: OrderData): Promise<{ trackingId: string; consignmentId?: string }> {
    const response = await this.makeRequest<{ 
      data: { 
        merchant_order_id: string; 
        consignment_id: string;
        order_status: string;
        delivery_fee: number;
      } 
    }>('/aladdin/api/v1/orders', {
      method: 'POST',
      data: {
        store_id: this.config.storeId,
        merchant_order_id: orderData.merchantInvoiceId,
        recipient_name: orderData.recipientName,
        recipient_phone: orderData.recipientPhone,
        recipient_address: orderData.recipientAddress,
        delivery_type: 48,
        item_type: 2,
        item_quantity: 1,
        item_weight: orderData.parcelWeight / 1000, // Convert to KG
        amount_to_collect: orderData.cashCollectionAmount,
        item_description: orderData.itemDescription,
      },
    });
    
    // Clear relevant caches
    await cacheService.clearPattern(`courier:pathao:getBalance:*`);
    await cacheService.clearPattern(`courier:pathao:trackOrder:*`);
    
    return { 
      trackingId: response.data.merchant_order_id, 
      consignmentId: response.data.consignment_id 
    };
  }

  async trackOrder(trackingId: string): Promise<TrackingResult> {
    const cacheKey = this.getCacheKey('trackOrder', { trackingId });
    
    return cacheService.getOrSet(cacheKey, async () => {
      const response = await this.makeRequest<{ 
        data: { 
          order_status: string; 
          updated_at: string;
          status_details?: Array<{ status: string; date_time: string }>;
        } 
      }>(`/aladdin/api/v1/orders/${trackingId}/info`, { method: 'GET' });
      
      const updates = response.data.status_details?.map(detail => ({
        message_en: detail.status,
        message_bn: '', 
        time: detail.date_time,
      })) || [{
        message_en: response.data.order_status,
        message_bn: '',
        time: response.data.updated_at,
      }];
      
      return {
        status: response.data.order_status,
        updates,
      };
    }, 2 * 60); // Cache tracking for 2 minutes (frequent updates)
  }

  async getBalance(): Promise<BalanceInfo> {
    const cacheKey = this.getCacheKey('getBalance');
    
    return cacheService.getOrSet(cacheKey, async () => {
      // Pathao balance API might not be available in all plans
      return { currentBalance: 0 };
    }, 10 * 60); // Cache balance for 10 minutes
  }

  async getStores(): Promise<Store[]> {
    const cacheKey = this.getCacheKey('getStores');
    
    return cacheService.getOrSet(cacheKey, async () => {
      const response = await this.makeRequest<{ data: { data: Store[] } }>('/aladdin/api/v1/stores', { method: 'GET' });
      return response.data?.data || [];
    }, 60 * 60); // Cache stores for 1 hour
  }
}



// Main Courier Service Manager with enhanced caching
export class CourierServiceManager {
  private serviceInstances: Map<string, BaseCourierService> = new Map();

  async getService(providerName: string): Promise<BaseCourierService> {
    const normalizedProvider = providerName.toLowerCase();
    
    if (this.serviceInstances.has(normalizedProvider)) {
      return this.serviceInstances.get(normalizedProvider)!;
    }

    const provider = await prisma.shippingProvider.findFirst({
      where: { 
        name: { equals: normalizedProvider, mode: 'insensitive' },
        isActive: true 
      },
    });

    if (!provider) {
      throw new Error(`Active provider not found: ${providerName}`);
    }

    let service: BaseCourierService;

    switch (normalizedProvider) {
      case 'redx':
        service = new RedXService(provider.baseUrl, provider.config);
        break;
      case 'pathao':
        service = new PathaoService(provider.baseUrl, provider.config);
        break;
      
      default:
        throw new Error(`Unsupported provider: ${providerName}`);
    }

    await service.authenticate();
    this.serviceInstances.set(normalizedProvider, service);
    return service;
  }

  // High-level methods with caching
  async calculateDeliveryCost(providerName: string, packageData: PackageData): Promise<PriceCalculation> {
    const service = await this.getService(providerName);
    return service.calculateCharge(packageData);
  }

  async createShippingOrder(providerName: string, orderData: OrderData): Promise<{ trackingId: string; consignmentId?: string }> {
    const service = await this.getService(providerName);
    return service.createOrder(orderData);
  }

  async trackShippingOrder(providerName: string, trackingId: string): Promise<TrackingResult> {
    const service = await this.getService(providerName);
    return service.trackOrder(trackingId);
  }

  async getAvailableAreas(providerName: string, filters?: { postCode?: number; districtName?: string }): Promise<Area[]> {
    const service = await this.getService(providerName);
    return service.getAreas(filters);
  }

  async getProviderBalance(providerName: string): Promise<BalanceInfo> {
    const service = await this.getService(providerName);
    return service.getBalance();
  }

  async getPickupStores(providerName: string): Promise<Store[]> {
    const service = await this.getService(providerName);
    return service.getStores();
  }

  // Batch operations with improved error handling
  async batchTrackOrders(providerName: string, trackingIds: string[]): Promise<Array<{
    trackingId: string;
    status: 'success' | 'error';
    data: TrackingResult | null;
    error?: string;
  }>> {
    const service = await this.getService(providerName);
    const results = [];
    
    // Process in batches to avoid overwhelming the API
    const batchSize = 5;
    for (let i = 0; i < trackingIds.length; i += batchSize) {
      const batch = trackingIds.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(id => service.trackOrder(id))
      );
      
      results.push(...batchResults.map((result, index) => ({
        trackingId: batch[index],
        status: result.status === 'fulfilled' ? 'success' : 'error',
        data: result.status === 'fulfilled' ? result.value : null,
        error: result.status === 'rejected' ? result.reason.message : undefined,
      })));
      
      // Delay between batches
      if (i + batchSize < trackingIds.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return results;
  }

  async getActiveProviders(): Promise<string[]> {
    const cacheKey = 'courier:activeProviders';
    
    return cacheService.getOrSet(cacheKey, async () => {
      const providers = await prisma.shippingProvider.findMany({
        where: { isActive: true },
        select: { name: true }
      });
      return providers.map(p => p.name);
    }, 5 * 60); // Cache for 5 minutes
  }

  async comparePrices(packageData: PackageData): Promise<{provider: string; price: PriceCalculation; error?: string}[]> {
    const providers = await this.getActiveProviders();
    const priceComparisons = [];
    
    for (const provider of providers) {
      try {
        const price = await this.calculateDeliveryCost(provider, packageData);
        priceComparisons.push({ provider, price });
      } catch (error: any) {
        console.error(`Failed to get price for ${provider}:`, error);
        priceComparisons.push({ 
          provider, 
          price: { deliveryCharge: 0, codCharge: 0 },
          error: error.message 
        });
      }
    }
    
    return priceComparisons.sort((a, b) => a.price.deliveryCharge - b.price.deliveryCharge);
  }

  // Clear cache for specific provider or all providers
  async clearCache(providerName?: string, pattern?: string): Promise<void> {
    if (providerName) {
      const cachePattern = pattern || `courier:${providerName.toLowerCase()}:*`;
      await cacheService.clearPattern(cachePattern);
    } else {
      await cacheService.clearPattern('courier:*');
    }
  }
}

// Singleton instance
export const courierService = new CourierServiceManager();

// Utility functions
export const CourierUtils = {
  formatPhoneNumber(phone: string): string {
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.startsWith('88') ? cleaned.slice(2) : cleaned;
  },

  validateOrderData(orderData: OrderData): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!orderData.recipientName || orderData.recipientName.length < 2) {
      errors.push('Recipient name is required and must be at least 2 characters');
    }
    
    const phone = this.formatPhoneNumber(orderData.recipientPhone);
    if (!phone || !/^01[3-9]\d{8}$/.test(phone)) {
      errors.push('Valid Bangladeshi phone number is required (11 digits starting with 01)');
    }
    
    if (!orderData.recipientAddress || orderData.recipientAddress.length < 10) {
      errors.push('Recipient address is required and must be at least 10 characters');
    }
    
    if (orderData.cashCollectionAmount < 0) {
      errors.push('Cash collection amount cannot be negative');
    }
    
    if (orderData.parcelWeight <= 0) {
      errors.push('Parcel weight must be greater than 0');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  },

  parseTrackingStatus(status: string): { status: string; description: string; color: string } {
    const statusMap: { [key: string]: { description: string; color: string } } = {
      'pending': { description: 'Order is pending', color: 'orange' },
      'in_review': { description: 'Order is under review', color: 'blue' },
      'ready-for-delivery': { description: 'Ready for delivery', color: 'green' },
      'delivery-in-progress': { description: 'Out for delivery', color: 'purple' },
      'delivered': { description: 'Successfully delivered', color: 'green' },
      'cancelled': { description: 'Order cancelled', color: 'red' },
      'hold': { description: 'On hold', color: 'yellow' },
    };
    
    const mappedStatus = statusMap[status.toLowerCase()] || { description: 'Unknown status', color: 'gray' };
    return { status, ...mappedStatus };
  }
};

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await redisClient.quit();
  process.exit(0);
});