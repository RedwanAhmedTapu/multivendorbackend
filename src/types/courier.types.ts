// courier.types.ts - Type definitions for courier services

import type { 
  CourierAuthType, 
  CourierOrderStatus, 
  Environment 
} from '@prisma/client';

// ==================== COMMON TYPES ====================

export interface CourierProvider {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  isActive: boolean;
  sandboxBaseUrl?: string;
  productionBaseUrl: string;
  authType: CourierAuthType;
  supportsCOD: boolean;
  supportsTracking: boolean;
  supportsBulkOrder: boolean;
  supportsWebhook: boolean;
  priority: number;
  isPreferred: boolean;
  statusMappings: any;
}

export interface CourierCredentials {
  id: string;
  courierProviderId: string;
  vendorId?: string;
  environment: Environment;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  apiKey?: string;
  bearerToken?: string;
  username?: string;
  password?: string;
  storeId?: string;
  merchantId?: string;
  isActive: boolean;
  lastVerifiedAt?: Date;
}

export interface CourierOrder {
  id: string;
  orderId: number;
  courierProviderId: string;
  vendorId: string;
  courierTrackingId?: string;
  courierOrderId?: string;
  consignmentId?: string;
  pickupStoreId?: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  deliveryLocationId: string;
  itemType: string;
  deliveryType: string;
  itemWeight: number;
  itemQuantity: number;
  itemDescription?: string;
  specialInstruction?: string;
  codAmount: number;
  deliveryCharge: number;
  codCharge: number;
  totalCharge: number;
  status: CourierOrderStatus;
  courierStatus?: string;
  lastStatusUpdate: Date;
}

export interface CourierTrackingHistory {
  id: string;
  courierOrderId: string;
  status: CourierOrderStatus;
  courierStatus: string;
  messageEn: string;
  messageBn?: string;
  location?: string;
  timestamp: Date;
  rawData?: any;
}

// ==================== PATHAO TYPES ====================

export interface PathaoTokenRequest {
  client_id: string;
  client_secret: string;
  grant_type: 'password' | 'refresh_token';
  username?: string;
  password?: string;
  refresh_token?: string;
}

export interface PathaoTokenResponse {
  token_type: 'Bearer';
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

export interface PathaoStoreRequest {
  name: string;
  contact_name: string;
  contact_number: string;
  secondary_contact?: string;
  otp_number?: string;
  address: string;
  city_id: number;
  zone_id: number;
  area_id: number;
}

export interface PathaoStoreResponse {
  message: string;
  type: string;
  code: number;
  data: {
    store_name: string;
  };
}

export interface PathaoStore {
  store_id: number;
  store_name: string;
  store_address: string;
  is_active: number;
  city_id: number;
  zone_id: number;
  hub_id: number;
  is_default_store: boolean;
  is_default_return_store: boolean;
}

export interface PathaoOrderRequest {
  store_id: number;
  merchant_order_id?: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_secondary_phone?: string;
  recipient_address: string;
  recipient_city?: number;
  recipient_zone?: number;
  recipient_area?: number;
  delivery_type: 48 | 12; // 48 = Normal, 12 = On Demand
  item_type: 1 | 2; // 1 = Document, 2 = Parcel
  special_instruction?: string;
  item_quantity: number;
  item_weight: number; // Min 0.5, Max 10 kg
  item_description?: string;
  amount_to_collect: number; // COD amount, 0 for non-COD
}

export interface PathaoOrderResponse {
  message: string;
  type: string;
  code: number;
  data: {
    consignment_id: string;
    merchant_order_id?: string;
    order_status: string;
    delivery_fee: number;
  };
}

export interface PathaoBulkOrderRequest {
  orders: PathaoOrderRequest[];
}

export interface PathaoBulkOrderResponse {
  message: string;
  type: string;
  code: 202;
  data: boolean;
}

export interface PathaoOrderInfo {
  consignment_id: string;
  merchant_order_id?: string;
  order_status: string;
  order_status_slug: string;
  updated_at: string;
  invoice_id?: string;
}

export interface PathaoCity {
  city_id: number;
  city_name: string;
}

export interface PathaoZone {
  zone_id: number;
  zone_name: string;
}

export interface PathaoArea {
  area_id: number;
  area_name: string;
  home_delivery_available: boolean;
  pickup_available: boolean;
}

export interface PathaoPriceRequest {
  store_id: number;
  item_type: 1 | 2;
  delivery_type: 48 | 12;
  item_weight: number;
  recipient_city: number;
  recipient_zone: number;
}

export interface PathaoPriceResponse {
  message: string;
  type: string;
  code: number;
  data: {
    price: number;
    discount: number;
    promo_discount: number;
    plan_id: number;
    cod_enabled: number;
    cod_percentage: number;
    additional_charge: number;
    final_price: number;
  };
}

// ==================== REDX TYPES ====================

export interface RedXArea {
  id: number;
  name: string;
  post_code: number;
  division_name: string;
  zone_id: number;
}

export interface RedXAreasResponse {
  areas: RedXArea[];
}

export interface RedXParcelDetailsItem {
  name: string;
  category: string;
  value: number;
}

export interface RedXParcelRequest {
  customer_name: string;
  customer_phone: string;
  delivery_area: string;
  delivery_area_id: number;
  customer_address: string;
  cash_collection_amount: string;
  parcel_weight: number; // in grams
  merchant_invoice_id?: string;
  instruction?: string;
  type?: string; // For reverse shipments
  value: number;
  is_closed_box?: string;
  pickup_store_id?: number;
  parcel_details_json?: RedXParcelDetailsItem[];
}

export interface RedXParcelResponse {
  tracking_id: string;
}

export interface RedXTrackingUpdate {
  message_en: string;
  message_bn: string;
  time: string; // ISO 8601 datetime
}

export interface RedXTrackingResponse {
  tracking: RedXTrackingUpdate[];
}

export interface RedXPickupLocation {
  id: number;
  name: string;
  address: string;
  area_name: string;
  area_id: number;
}

export interface RedXParcelInfo {
  tracking_id: string;
  customer_address: string;
  delivery_area: string;
  delivery_area_id: number;
  charge: number;
  customer_name: string;
  customer_phone: string;
  cash_collection_amount: number;
  parcel_weight: number;
  merchant_invoice_id: string;
  status: string;
  instruction: string;
  created_at: string;
  delivery_type: string;
  value: string;
  pickup_location: RedXPickupLocation;
}

export interface RedXParcelInfoResponse {
  parcel: RedXParcelInfo;
}

export interface RedXUpdateParcelRequest {
  entity_type: 'parcel-tracking-id';
  entity_id: string; // tracking_id
  update_details: {
    property_name: 'status' | 'delivery_address' | string;
    new_value: string;
    reason?: string;
  };
}

export interface RedXUpdateParcelResponse {
  success: boolean;
  message: string;
}

export interface RedXPickupStoreRequest {
  name: string;
  phone: string;
  address: string;
  area_id: number;
}

export interface RedXPickupStore {
  id: number;
  name: string;
  address: string;
  area_name: string;
  area_id: number;
  phone: string;
  created_at?: string;
}

export interface RedXPickupStoreResponse {
  id: number;
  name: string;
  address: string;
  area_name: string;
  area_id: number;
  phone: string;
}

export interface RedXPickupStoresResponse {
  pickup_stores: RedXPickupStore[];
}

export interface RedXPickupStoreInfoResponse {
  pickup_store: RedXPickupStore;
}

export interface RedXChargeRequest {
  delivery_area_id: number;
  pickup_area_id: number;
  cash_collection_amount: number;
  weight: number; // in grams
}

export interface RedXChargeResponse {
  deliveryCharge: number;
  codCharge: number;
}

export interface RedXWebhookPayload {
  tracking_number: string;
  timestamp: string;
  status: 'ready-for-delivery' | 'delivery-in-progress' | 'delivered' | 
          'agent-hold' | 'agent-returning' | 'returned' | 'agent-area-change';
  message_en: string;
  message_bn: string;
  invoice_number: string;
}

// ==================== SERVICE RESPONSE TYPES ====================

export interface ServiceResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T = any> {
  data: T[];
  total: number;
  current_page: number;
  per_page: number;
  total_in_page: number;
  last_page: number;
  path: string;
  to: number;
  from: number;
  last_page_url: string;
  first_page_url: string;
}

// ==================== UTILITY TYPES ====================

export type CourierProviderSlug = 'pathao' | 'redx' | 'steadfast' | 'paperfly';

export interface CourierOrderCreateData {
  orderId: number;
  courierProviderId: string;
  vendorId: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  deliveryLocationId: string;
  itemWeight: number;
  itemQuantity: number;
  codAmount: number;
  specialInstruction?: string;
}

export interface ServiceableArea {
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
}