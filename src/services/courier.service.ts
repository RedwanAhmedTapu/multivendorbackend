import pkg from '@prisma/client';
const { PrismaClient, Prisma, CourierAuthType, Environment } = pkg;

import type { Prisma as PrismaTypes } from '@prisma/client';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { randomUUID } from 'crypto';
import warehouseCourierPickupService, { isWarehousePickupProvider } from './warehouse-courier-pickup.service.ts';
import { prismaDirect } from '../config/prisma.ts';
import { describeCourierError, redactSecrets } from '../lib/courier/redact.ts';

const prisma = new PrismaClient();

/** This module's own Prisma client — exported only so tests can stub its delegates. */
export const courierServiceDb = prisma;

// ==================== LIVE COURIER QUOTE SAFETY SWITCH ====================
/**
 * COURIER_LIVE_QUOTES gates every live Pathao/RedX price-API call (checkout,
 * the admin quote endpoint and booking's courier selection) and every refresh
 * of their 24h price cache. Defaults: ON when NODE_ENV=production, OFF
 * otherwise — so a local or staging checkout never calls the production
 * courier APIs. Override with on/off (also true/false, 1/0); any other value
 * keeps the default. Database-backed pricing (Steadfast rules, stored rates)
 * is unaffected.
 */
export function courierLiveQuotesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.COURIER_LIVE_QUOTES?.trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return env.NODE_ENV === 'production';
}

/** Thrown instead of calling a Pathao/RedX price API while live quotes are disabled. */
export class LiveCourierQuotesDisabledError extends Error {
  readonly code = 'LIVE_COURIER_QUOTES_DISABLED';
  constructor(courierName: string) {
    super(`${courierName} live price quotes are disabled (COURIER_LIVE_QUOTES is off)`);
    this.name = 'LiveCourierQuotesDisabledError';
  }
}

/**
 * The courier_pricing_rules rows checkout may apply: active, inside their
 * validity window (validFrom ≤ now < validTo, open-ended when validTo is null),
 * matching the weight band, standard ("NORMAL") delivery and platform-wide
 * (vendorId null — vendor-specific pricing is not supported yet). Shared by
 * getSteadfastPricing and getLowestStoredDeliveryCharge.
 */
export function applicablePricingRuleWhere(now: Date, weight: number) {
  return {
    AND: [
      { isActive: true, deliveryType: 'NORMAL', vendorId: null, minWeight: { lte: weight }, validFrom: { lte: now } },
      { OR: [{ maxWeight: null }, { maxWeight: { gte: weight } }] },
      { OR: [{ validTo: null }, { validTo: { gt: now } }] },
    ],
  };
}

/**
 * A valid commercial courier delivery charge must be a finite positive number.
 * Missing, NaN, null, non-number, zero, and negative values are rejected to
 * prevent third-party API mismatches from silently quoting zero delivery.
 */
export function isValidCourierDeliveryCharge(charge: unknown): charge is number {
  return typeof charge === 'number' && Number.isFinite(charge) && charge > 0;
}

// ==================== PRICING-RULE WRITE VALIDATION ====================
// Shared by createPricingRule and updatePricingRule. Every rule below exists
// because the read path cannot tell a typo from an intentional value.

/**
 * The only itemType the courier pricing and price-cache paths use today (see
 * the 'PARCEL' literals in the cache lookups). Extend this list when a
 * provider starts supporting another item type.
 */
const COURIER_ITEM_TYPES = ['PARCEL'] as const;

/**
 * Normalise itemType the way createPricingRule always has (trim + upper-case,
 * defaulting to PARCEL), but reject a value the pricing path would never
 * match instead of storing it verbatim.
 */
export function normalizeCourierItemType(input: string | null | undefined): string {
  const itemType = String(input ?? 'PARCEL').trim().toUpperCase();
  if (!(COURIER_ITEM_TYPES as readonly string[]).includes(itemType)) {
    throw new Error(
      `Unsupported itemType '${input}'. Supported: ${COURIER_ITEM_TYPES.join(', ')}.`
    );
  }
  return itemType;
}

/**
 * COD charge types getSteadfastPricing understands:
 *   PERCENT -> codChargeValue is a percentage of the COD amount
 *   FLAT    -> codChargeValue is an absolute amount
 * The pricing path reads every other token as a flat amount, so a typo such as
 * 'PERSENT' would quietly charge a flat (usually 0) fee instead of a
 * percentage - that is why this is an allow-list rather than a free string.
 */
const COURIER_COD_CHARGE_TYPES = ['PERCENT', 'FLAT'] as const;

export interface CourierCodCharge {
  codChargeType: string | null;
  codChargeValue: number | null;
}

/**
 * Validate a COD charge pair. The value's bounds depend on the type: a PERCENT
 * charge above 100 would exceed the COD amount it is applied to. A value with
 * no type is refused rather than silently read as an absolute amount.
 */
export function normalizeCourierCodCharge(
  typeInput: string | null | undefined,
  valueInput: number | null | undefined
): CourierCodCharge {
  const rawType = typeInput === undefined || typeInput === null ? '' : String(typeInput).trim();
  const hasValue = valueInput !== undefined && valueInput !== null;

  if (rawType === '') {
    if (hasValue) {
      throw new Error(
        `codChargeValue requires codChargeType (supported: ${COURIER_COD_CHARGE_TYPES.join(', ')}).`
      );
    }
    return { codChargeType: null, codChargeValue: null };
  }

  const codChargeType = rawType.toUpperCase();
  if (!(COURIER_COD_CHARGE_TYPES as readonly string[]).includes(codChargeType)) {
    throw new Error(
      `Unsupported codChargeType '${typeInput}'. Supported: ${COURIER_COD_CHARGE_TYPES.join(', ')}.`
    );
  }

  if (!hasValue) {
    return { codChargeType, codChargeValue: null };
  }

  const codChargeValue = Number(valueInput);
  if (!Number.isFinite(codChargeValue) || codChargeValue < 0) {
    throw new Error('codChargeValue must be a finite non-negative number.');
  }
  if (codChargeType === 'PERCENT' && codChargeValue > 100) {
    throw new Error(
      `codChargeValue (${codChargeValue}) must not exceed 100 when codChargeType is 'PERCENT'.`
    );
  }

  return { codChargeType, codChargeValue };
}


// ==================== PHASE 0: BOOKING-INTENT STATES ====================
// A CourierOrder is a BOOKED shipment only when courierTrackingId IS NOT NULL
// (it is set solely by the guarded confirm below and never cleared). Until
// then the row is a booking intent whose courierStatus records its state:
//   BOOKING_PENDING        created, not yet claimed — nothing sent to a provider
//   claim marker           claimed by exactly one request — provider call in flight
//   BOOKING_UNKNOWN        request sent, outcome unknown        ┐ blocked until
//   BOOKING_CONFIRM_FAILED provider accepted, confirm write failed ┘ manual reconciliation
// Legacy "Booking in progress" rows (written before Phase 0, possibly already
// sent to a provider) match none of the claimable states and stay blocked.
export const BOOKING_PENDING = 'Booking pending';
export const BOOKING_UNKNOWN = 'Booking outcome unknown — reconciliation required';
export const BOOKING_CONFIRM_FAILED = 'Booking confirmation failed — reconciliation required';
const bookingClaimMarker = (token: string) => `Booking submitting [claim:${token}]`;

/**
 * Outcome attached to every error thrown by createCourierOrderForVendor
 * (`error.courierBookingOutcome`). Only REJECTED means the intent was cancelled
 * and its booking slot freed; every other outcome leaves it blocked.
 *   NOT_CLAIMED          refused before any write (not claimable / not this vendor's)
 *   REJECTED             nothing was created at the provider (local/pre-request
 *                        failure or a confirmed validation rejection — see
 *                        classifyProviderBookingError); intent cancelled
 *   UNKNOWN              outcome ambiguous — the shipment may exist
 *   CONFIRM_FAILED       provider accepted, but the response had no tracking id
 *                        or recording the booking failed
 *   STALE                the claim no longer held when the outcome was recorded
 *   OUTCOME_NOT_RECORDED the outcome write itself failed (row keeps its claim)
 */
export type CourierBookingOutcome =
  | 'NOT_CLAIMED'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'CONFIRM_FAILED'
  | 'STALE'
  | 'OUTCOME_NOT_RECORDED';

/** Response text tying a rejection to a duplicate or to the merchant reference —
 *  never proof that no shipment exists for this booking. */
const AMBIGUOUS_REFERENCE_SIGNAL =
  /duplicate|already|unique|been taken|invoice|merchant[\s_-]?(order|invoice|ref)/i;

/**
 * Classifies a FAILED provider booking request (Phase 0 follow-up, H1).
 * A received HTTP response does not, by itself, prove that no shipment was
 * created, so the only REJECTED outcome is a confirmed business-validation
 * failure: HTTP 400/422 whose JSON body carries structured field errors
 * (`errors` object/array) and says nothing about duplicates or the merchant
 * reference. Everything else is UNKNOWN (slot kept, reconciliation required):
 *   - no response at all: timeout, connection reset, DNS, request aborted
 *   - 401/403/404/408/409/429, any 5xx, gateway/proxy errors
 *   - non-JSON / unparseable bodies (e.g. a proxy's HTML error page)
 *   - duplicate-invoice / merchant-reference responses: a shipment with this
 *     reference may already exist at the provider
 */
export function classifyProviderBookingError(error: any): 'REJECTED' | 'UNKNOWN' {
  const status = error?.response?.status;
  if (status !== 400 && status !== 422) return 'UNKNOWN';
  const data = error.response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'UNKNOWN';
  const fieldErrors = data.errors;
  const hasFieldErrors =
    !!fieldErrors && typeof fieldErrors === 'object' && Object.keys(fieldErrors).length > 0;
  if (!hasFieldErrors) return 'UNKNOWN';
  let body: string;
  try {
    body = JSON.stringify(data);
  } catch {
    return 'UNKNOWN';
  }
  if (AMBIGUOUS_REFERENCE_SIGNAL.test(body)) return 'UNKNOWN';
  return 'REJECTED';
}

/** A provider tracking/consignment id as a string, or null when missing, empty or
 *  whitespace-only. A valid id is returned unchanged (webhooks match it exactly). */
function providerShipmentId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

function bookingError(outcome: CourierBookingOutcome, message: string): Error {
  const e: any = new Error(message);
  e.courierBookingOutcome = outcome;
  return e;
}

/** Writes used by cancelCourierOrder — the module client or a caller's transaction client. */
type CourierCancelDb = Pick<PrismaTypes.TransactionClient, 'courierOrder' | 'courierTrackingHistory'>;

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
  /** The pickup warehouse (VendorWarehouse.id). Required for Pathao/RedX —
   *  their pickup is a warehouse-specific provider store; without it those
   *  providers are not eligible (no fallback to a platform-level store). */
  warehouseId?: string;
}

interface CourierPricing {
  courierProviderId: string;
  courierName: string;
  deliveryCharge: number;
  codCharge: number;
  totalCharge: number;
  estimatedDeliveryDays: number;
  /** WarehouseCourierPickup.id the quote was priced for (Pathao/RedX only). */
  pickupMappingId?: string;
  /** Provider store id the quote was priced for (Pathao/RedX only). */
  pickupStoreId?: string;
}

/** A warehouse's ACTIVE courier pickup mapping, resolved against the platform
 *  credential used for quote and booking. */
interface ResolvedWarehousePickup {
  credentialId: string;
  mapping: {
    id: string;
    warehouseId: string;
    vendorId: string;
    courierCredentialId: string;
    providerStoreId: string;
    providerAreaId: string | null;
  };
}

/** Pickup leg of a quote: the warehouse row and its location. */
export interface QuotePickup {
  warehouseId: string;
  locationId: string;
}

// ------------------------------------------------------------------
// NOTE ON SCHEMA ALIGNMENT
// The current `CourierOrder` model does NOT have: recipientSecondaryPhone,
// pickupAreaId, deliveryAreaId, itemValue, estimatedDeliveryDays,
// rawCourierResponse, updatedAt, or a direct "vendorWarehouseLocationId"
// column. It DOES have a required `deliveryLocationId` (FK to locations),
// an optional `warehouseId` (FK to VendorWarehouse — NOT a location id),
// an optional `vendorOrderId` (FK to VendorOrder, needed for the
// VendorOrder.courierOrders[] relation to find this row), and the field
// is called `specialInstruction` (singular), not `specialInstructions`.
//
// This interface keeps its original public shape (so existing callers in
// vendor.order.service.ts don't need to change their param names) — the
// mapping to the real column names happens inside createCourierOrderForVendor().
// ------------------------------------------------------------------
interface OrderDetails {
  recipientName: string;
  recipientPhone: string;
  recipientSecondaryPhone?: string; // accepted but NOT persisted — no matching column
  recipientAddress: string;
  recipientLocationId: string; // -> stored as CourierOrder.deliveryLocationId
  vendorWarehouseLocationId: string; // used only for area/pricing lookups, not persisted directly
  itemDescription: string;
  itemQuantity: number;
  itemWeight: number;
  codAmount: number;
  deliveryType: 'NORMAL' | 'EXPRESS';
  specialInstructions?: string; // -> stored as CourierOrder.specialInstruction
  itemValue?: number; // accepted but NOT persisted — no matching column
  vendorOrderId?: string; // -> stored as CourierOrder.vendorOrderId (needed for VendorOrder.courierOrders[])
  warehouseId?: string; // -> stored as CourierOrder.warehouseId (the actual pickup warehouse row, not its location)
  /** 1C-13: pre-persisted booking-intent CourierOrder row id (claimed before
   *  the provider call; confirmed in place with the provider response). */
  intentId: string;
  /** 1C-13: deterministic per-logical-shipment provider reference
   *  ("<vendorOrderId>-<warehouseId>") — sent as the provider's merchant id. */
  merchantReference: string;
  /** 1C-13: courier selected by the caller before the booking-intent claim
   *  (a pure quote); when present, selection is skipped. */
  preselectedCourier?: {
    courierProviderId: string;
    courierName: string;
    pricing: CourierPricing;
  };
}

/** Map the app-level delivery type to the schema's DeliveryType enum (no 'NORMAL' value exists — it's 'STANDARD'). */
function toSchemaDeliveryType(t: 'NORMAL' | 'EXPRESS'): 'STANDARD' | 'EXPRESS' {
  return t === 'EXPRESS' ? 'EXPRESS' : 'STANDARD';
}

// ==================== PROVIDER WEIGHT BOUNDARY ====================
// FinixMart's internal weight is ALWAYS kilograms (modules/shared/package-weight.ts;
// CourierOrder.itemWeight). These helpers adapt it ONLY for the outgoing provider
// request — they never change the internal/stored value.

/** RedX charge calculator `weight` and parcel `parcel_weight` are in GRAMS
 *  (see RedXChargeRequest / RedXParcelRequest in types/courier.types.ts). */
export function kgToRedxGrams(weightKg: number): number {
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new Error(`Invalid parcel weight for RedX: ${weightKg} kg`);
  }
  return Math.round(weightKg * 1000);
}

/** Pathao `item_weight` contract: KG, minimum 0.5, maximum 10
 *  (applies to price-plan and order creation). */
export const PATHAO_MIN_ITEM_WEIGHT_KG = 0.5;
export const PATHAO_MAX_ITEM_WEIGHT_KG = 10;

/** Outgoing Pathao `item_weight`. Below the minimum, the provider minimum
 *  (0.5 kg) is sent — the parcel is still billed in Pathao's lowest weight
 *  band; the internal weight is untouched. Above 10 kg Pathao is NOT called:
 *  the parcel's real weight is never altered and no split policy is assumed. */
export function toPathaoItemWeightKg(weightKg: number): number {
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new Error(`Invalid parcel weight for Pathao: ${weightKg} kg`);
  }
  if (weightKg > PATHAO_MAX_ITEM_WEIGHT_KG) {
    throw new Error(
      `Pathao does not accept this parcel: weight ${weightKg} kg exceeds Pathao's maximum of ${PATHAO_MAX_ITEM_WEIGHT_KG} kg`,
    );
  }
  return Math.max(PATHAO_MIN_ITEM_WEIGHT_KG, weightKg);
}

/** Deterministic choice when several provider areas map to the same internal
 *  location: oldest mapping row first (stable cuid order; `id` is unique, so
 *  the order is total and does not change on re-sync). */
const SERVICEABLE_AREA_ORDER = [{ id: 'asc' as const }];

/** Quote pickups de-duplicated by WAREHOUSE (not location): two warehouses at
 *  the same location can have different provider pickup stores. */
function uniquePickups(pickups: QuotePickup[]): QuotePickup[] {
  const seen = new Map<string, QuotePickup>();
  for (const p of pickups) if (!seen.has(p.warehouseId)) seen.set(p.warehouseId, p);
  return [...seen.values()];
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
      PENDING_PICKUP: ['Pending', 'Created', 'Accepted'],
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
      // Deterministic: the DB allows at most ONE active platform credential per
      // provider + environment (partial unique index, migration
      // 20261008020000); the ordering keeps every caller (quote, booking,
      // token refresh) on the same row even if legacy duplicates pre-date it.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
  /**
   * @param purpose 'pickup' checks the courier can PICK UP from this
   *   location (pickupAvailable) — used for a vendor warehouse.
   *   'delivery' checks the courier can DELIVER to this location
   *   (homeDeliveryAvailable) — used for the customer's address.
   *   ⚠️ FIX: previously this always checked homeDeliveryAvailable
   *   regardless of which purpose it was called for, so a warehouse in
   *   an area where a courier delivers-but-doesn't-pickup would
   *   incorrectly pass the pickup check.
   */
  private async getCourierServiceableArea(
    courierProviderId: string,
    locationId: string,
    purpose: 'pickup' | 'delivery' = 'delivery',
  ) {
    return await prisma.courierServicableAreas.findFirst({
      where: {
        courierProviderId,
        locationId,
        ...(purpose === 'pickup' ? { pickupAvailable: true } : { homeDeliveryAvailable: true }),
        isActive: true,
      },
      orderBy: SERVICEABLE_AREA_ORDER, // G6: deterministic when a location has several provider areas
    });
  }

  /** Pickup-side provider area of an internal location (same deterministic
   *  choice as the quote path) — used to derive a new warehouse store's
   *  provider city/zone/area from the warehouse's location. */
  async getPickupServiceableArea(courierProviderId: string, locationId: string) {
    return this.getCourierServiceableArea(courierProviderId, locationId, 'pickup');
  }

  /**
   * Warehouse pickup resolution for Pathao/RedX — shared by quote and booking.
   * The pickup is the warehouse's ACTIVE WarehouseCourierPickup on the platform
   * credential (the same credential the price/booking API calls use). There is
   * NO fallback to CourierCredential.storeId and NO "first store" choice: a
   * warehouse without an active mapping makes the provider ineligible.
   * DB-only (no provider API call).
   */
  async resolveWarehousePickup(
    courierProviderId: string,
    courierName: string,
    warehouseId: string | null | undefined,
    environment: 'SANDBOX' | 'PRODUCTION' = 'PRODUCTION'
  ): Promise<ResolvedWarehousePickup> {
    if (!warehouseId) {
      throw new Error(`${courierName} requires a warehouse-specific pickup store; no pickup warehouse was given`);
    }
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials || credentials.vendorId !== null) {
      throw new Error(`${courierName} credentials not configured`);
    }
    const mapping = await warehouseCourierPickupService.findActivePickup(warehouseId, credentials.id);
    if (!mapping || !mapping.providerStoreId) {
      throw new Error(`${courierName} pickup store not configured for warehouse ${warehouseId}`);
    }
    if (courierName === 'RedX' && !mapping.providerAreaId) {
      throw new Error(`RedX pickup store mapping for warehouse ${warehouseId} has no area id`);
    }
    return {
      credentialId: credentials.id,
      mapping: {
        id: mapping.id,
        warehouseId: mapping.warehouseId,
        vendorId: mapping.vendorId,
        courierCredentialId: mapping.courierCredentialId,
        providerStoreId: mapping.providerStoreId,
        providerAreaId: mapping.providerAreaId,
      },
    };
  }

  // ==================== SMART COURIER SELECTION ====================

  /**
   * Select best courier based on criteria
   */
  async selectBestCourier(
    criteria: CourierSelectionCriteria
  ): Promise<{ courierProviderId: string; courierName: string; pricing: CourierPricing }> {
    const { vendorWarehouseLocationId, customerDeliveryLocationId, orderWeight, codAmount, warehouseId } =
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
            codAmount,
            warehouseId
          );
        } else if (provider.name === 'RedX') {
          pricing = await this.getRedXPricing(
            provider.id,
            vendorWarehouseLocationId,
            customerDeliveryLocationId,
            orderWeight,
            codAmount,
            warehouseId
          );
        } else if (provider.name === 'Steadfast') {
          pricing = await this.getSteadfastPricing(
            provider.id,
            vendorWarehouseLocationId,
            customerDeliveryLocationId,
            orderWeight,
            codAmount
          );
        }

        const isApiProvider = isWarehousePickupProvider(provider.name);
        const isValidDeliveryCharge = isApiProvider
          ? isValidCourierDeliveryCharge(pricing?.deliveryCharge)
          : typeof pricing?.deliveryCharge === 'number' && Number.isFinite(pricing.deliveryCharge) && pricing.deliveryCharge >= 0;

        if (
          pricing &&
          isValidDeliveryCharge &&
          typeof pricing.totalCharge === 'number' &&
          Number.isFinite(pricing.totalCharge) &&
          pricing.totalCharge >= pricing.deliveryCharge
        ) {
          pricingResults.push(pricing);
        } else if (pricing) {
          console.warn(`[selectBestCourier] Rejected invalid quote from ${provider.name}:`, pricing);
        }
      } catch (error) {
        console.error(`Failed to get pricing from ${provider.name}:`, describeCourierError(error));
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
   * Lowest stored delivery charge for checkout pricing (1C-16 B11).
   *
   * Same rate source, matching and charge formula as getSteadfastPricing —
   * CourierPricingRules, route-scoped (warehouse location -> delivery
   * location) first, then a nationwide rule (from/to null), priority asc,
   * active + valid, weight window — but evaluated across ALL active
   * providers and returning the LOWEST charge. DB-only by design: unlike
   * selectBestCourier this never calls provider quote APIs, so it is safe
   * to run inside the checkout Serializable transaction. When nothing
   * matches it throws the same error selectBestCourier throws.
   */
  async getLowestStoredDeliveryCharge(
    pickupWarehouses: QuotePickup[],
    deliveryLocationId: string,
    weight: number
  ): Promise<{ charge: number; courierProviderId: string; courierName: string }> {
    const now = new Date();
    const pickups = uniquePickups(pickupWarehouses);
    const providers = await prisma.courierProviders.findMany({
      where: { isActive: true },
      orderBy: [{ isPreferred: 'desc' }, { priority: 'asc' }],
      select: { id: true, name: true },
    });

    // Active, valid now (validFrom/validTo), weight band, NORMAL delivery, platform-wide.
    const commonWhere = applicablePricingRuleWhere(now, weight);

    let best: { charge: number; courierProviderId: string; courierName: string } | null = null;
    for (const provider of providers) {
      for (const { warehouseId, locationId: pickupLocationId } of pickups) {
        // Pathao/RedX can only ship from a warehouse with an ACTIVE pickup store
        // mapping — a manual rate for a provider that cannot book this
        // warehouse would be a price for a shipment that cannot be created.
        if (isWarehousePickupProvider(provider.name)) {
          try {
            await this.resolveWarehousePickup(provider.id, provider.name, warehouseId);
          } catch (error) {
            console.warn(`[stored-rate] ${provider.name} skipped for warehouse ${warehouseId}:`, (error as Error).message);
            continue;
          }
        }
        const rule =
          (await prisma.courierPricingRules.findFirst({
            where: {
              ...commonWhere,
              courierProviderId: provider.id,
              fromLocationId: pickupLocationId,
              toLocationId: deliveryLocationId,
            },
            orderBy: { priority: 'asc' },
          })) ||
          // 1C-29: third fallback — "from anywhere → to specific destination"
          // (fromLocationId=null, toLocationId=delivery location). Business rules
          // legitimately use this pattern for delivery-to-specific-area pricing.
          (await prisma.courierPricingRules.findFirst({
            where: {
              ...commonWhere,
              courierProviderId: provider.id,
              fromLocationId: null,
              toLocationId: deliveryLocationId,
            },
            orderBy: { priority: 'asc' },
          })) ||
          (await prisma.courierPricingRules.findFirst({
            where: {
              ...commonWhere,
              courierProviderId: provider.id,
              fromLocationId: null,
              toLocationId: null,
            },
            orderBy: { priority: 'asc' },
          }));
        if (!rule) continue;
        const charge =
          rule.basePrice +
          rule.perKgCharge * Math.max(0, weight - 1) +
          (rule.fuelSurcharge || 0);
        // Stored rate rules may represent authorized free shipping (charge === 0), but must be finite and non-negative.
        if (typeof charge !== 'number' || !Number.isFinite(charge) || charge < 0) {
          console.warn(`[getLowestStoredDeliveryCharge] Ignored invalid stored charge from rule ${rule.id}:`, charge);
          continue;
        }
        if (!best || charge < best.charge) {
          best = { charge, courierProviderId: provider.id, courierName: provider.name };
        }
      }
    }

    if (!best) {
      throw new Error('No courier available for this delivery route');
    }
    return best;
  }

  // ==================== 1C-25: LIVE QUOTE + 24H CACHE ENGINE ====================
  //
  // Delivery pricing architecture (1C-25):
  //   1. LIVE QUOTE CACHE (CourierPriceCache — the model was designed for this:
  //      provider + route + WEIGHT + deliveryType + itemType in the unique key,
  //      calculatedAt/expiresAt for freshness, index on expiresAt).
  //      Fresh (< 24h) cached quotes are used as-is; no courier API is called.
  //   2. LIVE QUOTES for stale/missing entries — Pathao/RedX via their live
  //      pricing APIs, Steadfast via its CourierPricingRules source (Steadfast
  //      has no quote API; its admin-maintained rule IS its pricing).
  //   3. MANUAL FALLBACK — getLowestStoredDeliveryCharge (explicit business
  //      fallback, e.g. the 1C-24 TEST rule) ONLY when the live layer yields
  //      nothing. A live quote is never overridden by a manual rule.
  //
  // calculateVendorShippingCost (checkout) and the delivery-fees preview both
  // call getLowestDeliveryQuote so preview and checkout always agree.

  private static readonly QUOTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  /** Fresh (non-expired) cached quote for one provider on one route/weight,
   *  priced for ONE pickup configuration (`pickupRef` = WarehouseCourierPickup.id).
   *  Rows of another pickup store — or legacy location-only rows (NULL) — are
   *  never returned. */
  private async getFreshCachedQuote(
    courierProviderId: string,
    fromLocationId: string,
    toLocationId: string,
    weight: number,
    pickupRef: string
  ) {
    const row = await prisma.courierPriceCache.findFirst({
      where: {
        courierProviderId,
        vendorId: null,
        fromLocationId,
        toLocationId,
        weight,
        deliveryType: "NORMAL",
        itemType: "PARCEL",
        codAmount: 0,
        pickupRef,
        expiresAt: { gt: new Date() },
      },
      orderBy: { calculatedAt: "desc" },
    });
    if (!row || !isValidCourierDeliveryCharge(row.basePrice)) return null;
    return {
      courierProviderId: row.courierProviderId,
      courierName: row.courierProviderId,
      // Delivery-only, exactly like a live quote (getLowestLiveDeliveryCharge
      // uses quote.deliveryCharge). saveCachedQuote stores that amount as
      // basePrice; totalPrice also includes the provider's COD fee, which
      // checkout does not charge — returning it made a cached route cost more.
      charge: row.basePrice,
      cached: true as const,
    };
  }

  /** Persist one live quote into the 24h cache (concurrency-safe via the unique key).
   *  The row records the pickup configuration it was priced for (`pickupRef`);
   *  the unique key is location-based, so a co-located warehouse with another
   *  store overwrites the row (last write wins) and readers of the other store
   *  simply miss and re-quote live — a wrong store's price is never served. */
  private async saveCachedQuote(
    courierProviderId: string,
    fromLocationId: string,
    toLocationId: string,
    weight: number,
    quote: { deliveryCharge: number; codCharge: number; totalCharge: number },
    pickupRef: string
  ) {
    if (!isValidCourierDeliveryCharge(quote.deliveryCharge)) {
      return; // Never cache an invalid quote
    }
    const now = new Date();
    const key = {
      courierProviderId, vendorId: null, fromLocationId, toLocationId,
      weight, deliveryType: "NORMAL", itemType: "PARCEL", codAmount: 0,
    };
    const existing = await prisma.courierPriceCache.findFirst({ where: key, select: { id: true } });
    const data = {
      basePrice: quote.deliveryCharge,
      weightCharge: 0,
      codCharge: quote.codCharge ?? 0,
      additionalCharges: 0,
      discount: 0,
      totalPrice: quote.totalCharge,
      calculatedAt: now,
      expiresAt: new Date(now.getTime() + CourierService.QUOTE_CACHE_TTL_MS),
      pickupRef,
    };
    if (existing) {
      await prisma.courierPriceCache.update({ where: { id: existing.id }, data });
    } else {
      try {
        await prisma.courierPriceCache.create({ data: { ...key, ...data } });
      } catch (err: any) {
        // concurrent first-quote race — the winner's row is just as valid
        if (err?.code !== "P2002") throw err;
        const dup = await prisma.courierPriceCache.findFirst({ where: key, select: { id: true } });
        if (dup) await prisma.courierPriceCache.update({ where: { id: dup.id }, data });
      }
    }
  }

  /**
   * 1C-25 engine: lowest delivery charge across providers using live quotes
   * with a 24-hour cache. Cache-first per provider; stale/missing entries
   * refresh from the provider's live source (Pathao/RedX APIs, Steadfast
   * rules); providers that fail are skipped; the lowest valid quote wins.
   * Throws the established error only when NO provider yields a quote.
   *
   * Pickups are WAREHOUSES: Pathao/RedX are priced for the warehouse's ACTIVE
   * pickup store mapping (and cached per mapping); a warehouse without one is
   * not eligible for that provider. Steadfast stays account-level.
   */
  async getLowestLiveDeliveryCharge(
    pickupWarehouses: QuotePickup[],
    deliveryLocationId: string,
    weight: number
  ): Promise<{
    charge: number; courierProviderId: string; courierName: string;
    source: "CACHE" | "LIVE" | "MANUAL";
  }> {
    const pickups = uniquePickups(pickupWarehouses);
    const providers = await prisma.courierProviders.findMany({
      where: { isActive: true },
      orderBy: [{ isPreferred: "desc" }, { priority: "asc" }],
      select: { id: true, name: true },
    });

    let best: { charge: number; courierProviderId: string; courierName: string; source: "CACHE" | "LIVE" | "MANUAL" } | null = null;
    const liveQuotes = courierLiveQuotesEnabled();
    for (const provider of providers) {
      for (const { warehouseId, locationId: pickupLocationId } of pickups) {
        // Safety switch: with COURIER_LIVE_QUOTES off, Pathao/RedX take no part
        // here at all — no price-API call and no cache read, claim or refresh.
        // Database-backed pricing (Steadfast rules, then the stored-rate
        // fallback in getLowestDeliveryQuote) still applies.
        if (!liveQuotes && isWarehousePickupProvider(provider.name)) continue;
        // 0. Pathao/RedX: the warehouse's pickup store decides the price — no
        //    mapping, no quote (and no cache read).
        let pickup: ResolvedWarehousePickup | undefined;
        if (isWarehousePickupProvider(provider.name)) {
          try {
            pickup = await this.resolveWarehousePickup(provider.id, provider.name, warehouseId);
          } catch (error) {
            console.error(`Failed to get quote from ${provider.name}:`, (error as Error).message);
            continue;
          }
        }
        const pickupRef = pickup?.mapping.id;

        // 1. fresh cache → use as-is (no courier API call). Only API-backed
        //    providers are cached, always per pickup mapping.
        if (pickupRef) {
          const cached = await this.getFreshCachedQuote(provider.id, pickupLocationId, deliveryLocationId, weight, pickupRef);
          if (cached) {
            if (!best || cached.charge < best.charge) {
              best = { charge: cached.charge, courierProviderId: cached.courierProviderId, courierName: provider.name, source: "CACHE" };
            }
            continue;
          }

          // 2. stale/missing → claim the refresh (conditional on calculatedAt) so
          //    concurrent requests converge on one live refresh where practical.
          const staleRow = await prisma.courierPriceCache.findFirst({
            where: {
              courierProviderId: provider.id, vendorId: null,
              fromLocationId: pickupLocationId, toLocationId: deliveryLocationId,
              weight, deliveryType: "NORMAL", itemType: "PARCEL", codAmount: 0,
              pickupRef,
            },
            select: { id: true, calculatedAt: true },
          });
          let claimed = staleRow === null; // missing rows: every caller may attempt
          if (staleRow) {
            const claim = await prisma.courierPriceCache.updateMany({
              where: { id: staleRow.id, calculatedAt: staleRow.calculatedAt },
              data: { calculatedAt: new Date() },
            });
            claimed = claim.count > 0;
            if (!claimed) {
              // another request is refreshing — poll briefly for its result
              for (let poll = 0; poll < 4; poll++) {
                await new Promise((r) => setTimeout(r, 700));
                const fresh = await this.getFreshCachedQuote(provider.id, pickupLocationId, deliveryLocationId, weight, pickupRef);
                if (fresh) {
                  if (!best || fresh.charge < best.charge) {
                    best = { charge: fresh.charge, courierProviderId: fresh.courierProviderId, courierName: provider.name, source: "CACHE" };
                  }
                  claimed = true;
                  break;
                }
              }
              if (claimed && best) continue;
              claimed = false; // winner failed — attempt our own refresh
            }
          }
        }

        try {
          let quote: CourierPricing | null = null;
          if (provider.name === "Pathao") {
            quote = await this.getPathaoPricing(provider.id, pickupLocationId, deliveryLocationId, weight, 0, warehouseId, pickup);
          } else if (provider.name === "RedX") {
            quote = await this.getRedXPricing(provider.id, pickupLocationId, deliveryLocationId, weight, 0, warehouseId, pickup);
          } else if (provider.name === "Steadfast") {
            quote = await this.getSteadfastPricing(provider.id, pickupLocationId, deliveryLocationId, weight, 0);
          }
          if (quote) {
            const isApiProvider = isWarehousePickupProvider(provider.name);
            const isValidQuote = isApiProvider
              ? isValidCourierDeliveryCharge(quote.deliveryCharge)
              : typeof quote.deliveryCharge === 'number' && Number.isFinite(quote.deliveryCharge) && quote.deliveryCharge >= 0;

            if (!isValidQuote) {
              console.warn(`[getLowestLiveDeliveryCharge] Ignored invalid ${provider.name} quote:`, quote.deliveryCharge);
              continue;
            }

            // API-backed providers (Pathao/RedX) are cached per pickup mapping;
            // Steadfast is rules-sourced and always fresh from the database.
            if (pickupRef) {
              await this.saveCachedQuote(provider.id, pickupLocationId, deliveryLocationId, weight, quote, pickupRef);
            }
            const deliveryOnly = quote.deliveryCharge;
            if (!best || deliveryOnly < best.charge) {
              best = { charge: deliveryOnly, courierProviderId: provider.id, courierName: provider.name, source: "LIVE" };
            }
          }
        } catch (error) {
          // provider unavailable/unconfigured — skip it; if every provider fails
          // and no fresh cache exists, the caller gets the established error.
          console.error(`Failed to get quote from ${provider.name}:`, (error as Error).message);
        }
      }
    }

    if (!best) {
      throw new Error("No courier available for this delivery route");
    }
    return best;
  }

  /**
   * 1C-25 single entry point for preview AND checkout: live quotes with a
   * 24-hour cache first; if the live layer yields nothing, fall back to the
   * explicitly configured manual business pricing (1C-16 stored rates).
   * `pickupWarehouses` are the supplying warehouses (id + location).
   */
  async getLowestDeliveryQuote(
    pickupWarehouses: QuotePickup[],
    deliveryLocationId: string,
    weight: number
  ): Promise<{ charge: number; courierProviderId: string; courierName: string }> {
    try {
      return await this.getLowestLiveDeliveryCharge(pickupWarehouses, deliveryLocationId, weight);
    } catch (err: any) {
      if (/No courier available for this delivery route/.test(err?.message ?? "")) {
        // explicit manual business fallback (never overrides live quotes)
        return this.getLowestStoredDeliveryCharge(pickupWarehouses, deliveryLocationId, weight);
      }
      throw err;
    }
  }

  /**
   * Get Pathao pricing
   */
  private async getPathaoPricing(
    courierProviderId: string,
    pickupLocationId: string,
    deliveryLocationId: string,
    weight: number,
    codAmount: number,
    warehouseId?: string,
    resolvedPickup?: ResolvedWarehousePickup
  ): Promise<CourierPricing> {
    // Safety switch (COURIER_LIVE_QUOTES): never call the Pathao price API while disabled.
    if (!courierLiveQuotesEnabled()) throw new LiveCourierQuotesDisabledError('Pathao');
    const pickupArea = await this.getCourierServiceableArea(courierProviderId, pickupLocationId, 'pickup');
    const deliveryArea = await this.getCourierServiceableArea(
      courierProviderId,
      deliveryLocationId,
      'delivery'
    );

    if (!pickupArea || !deliveryArea) {
      throw new Error('Location not serviceable by Pathao');
    }

    // The warehouse's own Pathao store (WarehouseCourierPickup) — the same
    // store booking will use. No fallback to CourierCredential.storeId.
    const pickup = resolvedPickup ?? (await this.resolveWarehousePickup(courierProviderId, 'Pathao', warehouseId));

    const priceData = {
      store_id: parseInt(pickup.mapping.providerStoreId),
      item_type: 2,
      delivery_type: 48,
      item_weight: weight,
      recipient_city: parseInt(deliveryArea.courierCityId!),
      recipient_zone: parseInt(deliveryArea.courierZoneId!),
    };

    // Priced with the credential the store mapping was resolved for — never a
    // different account (the call refuses if the platform credential changed).
    const priceResponse = await this.pathaoCalculatePrice(courierProviderId, priceData, 'PRODUCTION', pickup.credentialId);

    const rawDeliveryFee = priceResponse?.data?.delivery_fee;
    if (!isValidCourierDeliveryCharge(rawDeliveryFee)) {
      throw new Error(`Invalid or missing delivery fee received from Pathao API: ${rawDeliveryFee}`);
    }
    const codCharge =
      typeof priceResponse?.data?.cod_fee === 'number' &&
      Number.isFinite(priceResponse.data.cod_fee) &&
      priceResponse.data.cod_fee >= 0
        ? priceResponse.data.cod_fee
        : 0;

    return {
      courierProviderId,
      courierName: 'Pathao',
      deliveryCharge: rawDeliveryFee,
      codCharge,
      totalCharge: rawDeliveryFee + codCharge,
      estimatedDeliveryDays: 3,
      pickupMappingId: pickup.mapping.id,
      pickupStoreId: pickup.mapping.providerStoreId,
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
    codAmount: number,
    warehouseId?: string,
    resolvedPickup?: ResolvedWarehousePickup
  ): Promise<CourierPricing> {
    // Safety switch (COURIER_LIVE_QUOTES): never call the RedX price API while disabled.
    if (!courierLiveQuotesEnabled()) throw new LiveCourierQuotesDisabledError('RedX');
    const pickupArea = await this.getCourierServiceableArea(courierProviderId, pickupLocationId, 'pickup');
    const deliveryArea = await this.getCourierServiceableArea(
      courierProviderId,
      deliveryLocationId,
      'delivery'
    );

    if (!pickupArea || !deliveryArea) {
      throw new Error('Location not serviceable by RedX');
    }

    // The warehouse's own RedX pickup store (WarehouseCourierPickup): quote with
    // THAT store's area so quote and booking (pickup_store_id) refer to the
    // same pickup — never pickup_stores[0].
    const pickup = resolvedPickup ?? (await this.resolveWarehousePickup(courierProviderId, 'RedX', warehouseId));

    const chargeData = {
      delivery_area_id: parseInt(deliveryArea.courierAreaId),
      pickup_area_id: parseInt(pickup.mapping.providerAreaId!),
      cash_collection_amount: codAmount,
      weight,
    };

    const chargeResponse = await this.redxCalculateCharge(courierProviderId, chargeData, 'PRODUCTION', pickup.credentialId);

    const rawDeliveryCharge = chargeResponse?.deliveryCharge;
    if (!isValidCourierDeliveryCharge(rawDeliveryCharge)) {
      throw new Error(`Invalid or missing delivery charge received from RedX API: ${rawDeliveryCharge}`);
    }
    const codCharge =
      typeof chargeResponse?.codCharge === 'number' &&
      Number.isFinite(chargeResponse.codCharge) &&
      chargeResponse.codCharge >= 0
        ? chargeResponse.codCharge
        : 0;

    return {
      courierProviderId,
      courierName: 'RedX',
      deliveryCharge: rawDeliveryCharge,
      codCharge,
      totalCharge: rawDeliveryCharge + codCharge,
      estimatedDeliveryDays: 2,
      pickupMappingId: pickup.mapping.id,
      pickupStoreId: pickup.mapping.providerStoreId,
    };
  }

  /**
   * Get Steadfast pricing.
   *
   * Unlike Pathao/RedX, Steadfast has no live price-quote API — pricing is
   * a flat rate you negotiate with them directly. Rather than
   * hardcoding a number, this reads from CourierPricingRules (already in
   * the schema, previously unused): an admin creates a rule row with
   * basePrice/perKgCharge/codChargeType/codChargeValue, optionally scoped
   * to a from/to location pair, or left location-less for a single
   * nationwide flat rate. This also means Steadfast is never excluded by
   * the pickup/delivery "serviceable area" check below — it has no
   * area-sync API either, so it's treated as serviceable everywhere a
   * pricing rule matches.
   */
  private async getSteadfastPricing(
    courierProviderId: string,
    pickupLocationId: string,
    deliveryLocationId: string,
    weight: number,
    codAmount: number
  ): Promise<CourierPricing> {
    const now = new Date();

    // Prefer a rule scoped to this exact pickup->delivery pair; fall back
    // to a nationwide rule (fromLocationId/toLocationId both null).
    // Active, valid now (validFrom/validTo), weight band, NORMAL delivery, platform-wide.
    const applicable = applicablePricingRuleWhere(now, weight);

    const rule =
      (await prisma.courierPricingRules.findFirst({
        where: {
          ...applicable,
          courierProviderId,
          fromLocationId: pickupLocationId,
          toLocationId: deliveryLocationId,
        },
        orderBy: { priority: 'asc' },
      })) ||
      (await prisma.courierPricingRules.findFirst({
        where: {
          ...applicable,
          courierProviderId,
          fromLocationId: null,
          toLocationId: null,
        },
        orderBy: { priority: 'asc' },
      }));

    if (!rule) {
      throw new Error(
        'No Steadfast pricing rule configured. Ask an admin to add one via CourierPricingRules (a location-less rule applies nationwide).'
      );
    }

    const deliveryCharge = rule.basePrice + rule.perKgCharge * Math.max(0, weight - 1) + (rule.fuelSurcharge || 0);
    if (typeof deliveryCharge !== 'number' || !Number.isFinite(deliveryCharge) || deliveryCharge < 0) {
      throw new Error(`Invalid Steadfast delivery charge calculated from rule ${rule.id}: ${deliveryCharge}`);
    }
    const codCharge =
      rule.codChargeType === 'PERCENT'
        ? (Number(rule.codChargeValue || 0) / 100) * codAmount
        : Number(rule.codChargeValue || 0);
    const safeCodCharge =
      typeof codCharge === 'number' && Number.isFinite(codCharge) && codCharge >= 0
        ? codCharge
        : 0;

    return {
      courierProviderId,
      courierName: 'Steadfast',
      deliveryCharge,
      codCharge: safeCodCharge,
      totalCharge: deliveryCharge + safeCodCharge,
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
      console.error('Pathao issue-token error body:', error.response?.data ?? error.message);
      throw new Error(
        `Pathao token issue failed: ${
          error.response?.data ? JSON.stringify(error.response.data) : error.message
        }`
      );
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
      console.error('Pathao refresh-token error body:', error.response?.data ?? error.message);
      throw new Error(
        `Pathao token refresh failed: ${
          error.response?.data ? JSON.stringify(error.response.data) : error.message
        }`
      );
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
    environment: Environment = 'PRODUCTION',
    /** When set, the price must be calculated on exactly this credential. */
    expectedCredentialId?: string
  ) {
    // G3: Pathao boundary — `priceData.item_weight` is internal kg; validated
    // (> 10 kg → Pathao is not called) and raised to Pathao's 0.5 kg minimum
    // for the outgoing request only.
    const outgoingPriceData = { ...priceData, item_weight: toPathaoItemWeightKg(priceData.item_weight) };

    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');
    if (expectedCredentialId && credentials.id !== expectedCredentialId) {
      throw new Error('Pathao platform credential changed during the quote — re-quote required');
    }

    const accessToken = await this.getValidPathaoToken(courierProviderId, environment);
    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    try {
      const response = await this.axiosInstance.post(
        `${baseUrl}/aladdin/api/v1/merchant/price-plan`,
        outgoingPriceData,
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
  //
  // IMPORTANT: RedX base URLs are expected to ALREADY include the version
  // segment, e.g.:
  //   sandboxBaseUrl    = https://sandbox.redx.com.bd/v1.0.0-beta
  //   productionBaseUrl = https://openapi.redx.com.bd/v1.0.0-beta
  //
  // Every method below appends only the resource path (no "/v1.0.0-beta/"
  // prefix) so the version lives in ONE place (the DB row) instead of being
  // duplicated in six different methods. If RedX ever changes their API
  // version, you only need to update the provider's baseUrl values.

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

    // Base URL already contains /v1.0.0-beta — do not prepend it again here.
    const url = `${baseUrl}/areas`;

    console.log('RedX API Request (all areas):', {
      url,
      token: credentials.bearerToken?.substring(0, 20) + '...',
    });

    try {
      const response = await this.axiosInstance.get(url, {
        headers: {
          'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
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
        areas = areas.filter(
          (area: any) =>
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
          `RedX authentication failed: ${
            error.response?.data?.message || 'Token might be invalid or expired.'
          }`
        );
      }

      throw new Error(`RedX get areas failed: ${error.message}`);
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

    const url = `${baseUrl}/pickup/stores`;

    try {
      const response = await this.axiosInstance.get(url, {
        headers: {
          'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
        },
      });

      return response.data;
    } catch (error: any) {
      console.error('RedX get pickup stores error:', {
        status: error.response?.status,
        data: error.response?.data,
        url,
      });
      throw new Error(
        `RedX get pickup stores failed: ${error.response?.data?.message || error.message}`
      );
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

    const url = `${baseUrl}/pickup/store`;

    try {
      const response = await this.axiosInstance.post(url, storeData, {
        headers: {
          'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
          'Content-Type': 'application/json',
        },
      });

      return response.data;
    } catch (error: any) {
      console.error('RedX create pickup store error:', {
        status: error.response?.status,
        data: error.response?.data,
        url,
      });
      throw new Error(
        `RedX create pickup store failed: ${error.response?.data?.message || error.message}`
      );
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
      /** Internal weight in KG — converted to RedX grams below (G2). */
      weight: number;
    },
    environment: Environment = 'PRODUCTION',
    /** When set, the charge must be calculated on exactly this credential. */
    expectedCredentialId?: string
  ) {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials) throw new Error('Platform courier credentials not found');
    if (expectedCredentialId && credentials.id !== expectedCredentialId) {
      throw new Error('RedX platform credential changed during the quote — re-quote required');
    }

    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    const params = new URLSearchParams({
      delivery_area_id: chargeData.delivery_area_id.toString(),
      pickup_area_id: chargeData.pickup_area_id.toString(),
      cash_collection_amount: chargeData.cash_collection_amount.toString(),
      // G2: RedX charge calculator expects GRAMS (internal kg × 1000).
      weight: kgToRedxGrams(chargeData.weight).toString(),
    });

    const url = `${baseUrl}/charge/charge_calculator?${params.toString()}`;

    try {
      const response = await this.axiosInstance.get(url, {
        headers: {
          'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
        },
      });

      return response.data;
    } catch (error: any) {
      console.error('RedX charge calculation error:', {
        status: error.response?.status,
        data: error.response?.data,
        url,
      });
      throw new Error(
        `RedX charge calculation failed: ${error.response?.data?.message || error.message}`
      );
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

    const url = `${baseUrl}/parcel/track/${trackingId}`;

    try {
      const response = await this.axiosInstance.get(url, {
        headers: {
          'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
        },
      });

      return response.data;
    } catch (error: any) {
      console.error('RedX track parcel error:', {
        status: error.response?.status,
        data: error.response?.data,
        url,
      });
      throw new Error(
        `RedX track parcel failed: ${error.response?.data?.message || error.message}`
      );
    }
  }

  // ==================== STEADFAST INTEGRATION ====================
  //
  // Base URL: https://portal.packzy.com/api/v1 (no separate sandbox — set
  // both sandboxBaseUrl and productionBaseUrl to this on the
  // CourierProviders row). Auth is a static Api-Key/Secret-Key pair sent
  // as headers on every request — reusing the existing CourierCredential
  // columns: `apiKey` holds the Api-Key, `clientSecret` holds the
  // Secret-Key (there's no dedicated secretKey column, and adding one
  // would mean a migration + touching every other provider's code path
  // for no benefit — clientSecret is otherwise unused by API_KEY auth).

  private async getSteadfastHeaders(courierProviderId: string, environment: Environment = 'PRODUCTION') {
    const credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
    if (!credentials || !credentials.apiKey || !credentials.clientSecret) {
      throw new Error('Steadfast credentials not configured (need apiKey + clientSecret in courier_credentials)');
    }
    return {
      baseUrl: credentials.courier_providers.productionBaseUrl, // Steadfast has no distinct sandbox
      headers: {
        'Api-Key': credentials.apiKey,
        'Secret-Key': credentials.clientSecret,
        'Content-Type': 'application/json',
      },
    };
  }

  /**
   * Create a single Steadfast order.
   * Docs: POST /create_order
   */
  async steadfastCreateOrder(
    courierProviderId: string,
    orderData: {
      invoice: string; // must be unique, alphanumeric incl. hyphens/underscores
      recipient_name: string;
      recipient_phone: string; // 11 digits
      recipient_address: string;
      cod_amount: number;
      note?: string;
      alternative_phone?: string;
      recipient_email?: string;
      item_description?: string;
      total_lot?: number;
      delivery_type?: 0 | 1; // 0 = home delivery, 1 = point/hub pickup
    },
    environment: Environment = 'PRODUCTION'
  ) {
    const { baseUrl, headers } = await this.getSteadfastHeaders(courierProviderId, environment);

    try {
      const response = await this.axiosInstance.post(`${baseUrl}/create_order`, orderData, { headers });
      if (response.data?.status !== 200) {
        throw new Error(response.data?.message || 'Steadfast order creation failed');
      }
      return response.data as { status: number; message: string; consignment: any };
    } catch (error: any) {
      console.error('Steadfast create order error:', error.response?.data || error.message);
      // Phase 0 follow-up (H1): only a confirmed validation rejection is
      // REJECTED. 5xx/408/429/gateway errors, a non-200 body status and a
      // duplicate-invoice response are UNKNOWN — the shipment may exist.
      const wrapped = new Error(`Steadfast order creation failed: ${error.response?.data?.message || error.message}`);
      (wrapped as any).courierBookingOutcome = classifyProviderBookingError(error);
      throw wrapped;
    }
  }

  /**
   * Create up to 500 Steadfast orders in one call.
   * Docs: POST /create_order/bulk-order
   */
  async steadfastBulkCreateOrder(
    courierProviderId: string,
    orders: Array<{
      invoice: string;
      recipient_name: string;
      recipient_address: string;
      recipient_phone: string;
      cod_amount: number;
      note?: string;
    }>,
    environment: Environment = 'PRODUCTION'
  ) {
    if (orders.length > 500) {
      throw new Error('Steadfast bulk order accepts a maximum of 500 items per call');
    }
    const { baseUrl, headers } = await this.getSteadfastHeaders(courierProviderId, environment);

    try {
      const response = await this.axiosInstance.post(
        `${baseUrl}/create_order/bulk-order`,
        { data: JSON.stringify(orders) },
        { headers }
      );
      return response.data; // array of { invoice, consignment_id, tracking_code, status: 'success'|'error', ... }
    } catch (error: any) {
      console.error('Steadfast bulk order error:', error.response?.data || error.message);
      throw new Error(`Steadfast bulk order failed: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Check delivery status by consignment id, invoice, or tracking code —
   * pass whichever one you have.
   * Docs: GET /status_by_cid/{id} | /status_by_invoice/{invoice} | /status_by_trackingcode/{code}
   */
  async steadfastCheckStatus(
    courierProviderId: string,
    lookup: { consignmentId?: string | number } | { invoice: string } | { trackingCode: string },
    environment: Environment = 'PRODUCTION'
  ) {
    const { baseUrl, headers } = await this.getSteadfastHeaders(courierProviderId, environment);

    const path =
      'consignmentId' in lookup
        ? `/status_by_cid/${lookup.consignmentId}`
        : 'invoice' in lookup
        ? `/status_by_invoice/${lookup.invoice}`
        : `/status_by_trackingcode/${lookup.trackingCode}`;

    try {
      const response = await this.axiosInstance.get(`${baseUrl}${path}`, { headers });
      return response.data as { status: number; delivery_status: string };
    } catch (error: any) {
      console.error('Steadfast status check error:', error.response?.data || error.message);
      throw new Error(`Steadfast status check failed: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Docs: GET /get_balance
   */
  async steadfastGetBalance(courierProviderId: string, environment: Environment = 'PRODUCTION') {
    const { baseUrl, headers } = await this.getSteadfastHeaders(courierProviderId, environment);
    try {
      const response = await this.axiosInstance.get(`${baseUrl}/get_balance`, { headers });
      return response.data as { status: number; current_balance: number };
    } catch (error: any) {
      throw new Error(`Steadfast get balance failed: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Docs: POST /create_return_request
   */
  async steadfastCreateReturnRequest(
    courierProviderId: string,
    data: { consignment_id?: string | number; invoice?: string; tracking_code?: string; reason?: string },
    environment: Environment = 'PRODUCTION'
  ) {
    const { baseUrl, headers } = await this.getSteadfastHeaders(courierProviderId, environment);
    try {
      const response = await this.axiosInstance.post(`${baseUrl}/create_return_request`, data, { headers });
      return response.data;
    } catch (error: any) {
      throw new Error(`Steadfast return request failed: ${error.response?.data?.message || error.message}`);
    }
  }

  // ==================== ORDER MANAGEMENT ====================

  /**
   * Book a courier shipment for an existing booking intent (Phase 0 flow).
   *
   * Every shipment field (recipient, address, COD, weight, quantity, warehouse,
   * merchant reference) is read from the intent ROW, never from the caller —
   * POST /orders/create passes only the intent id. A courier preselected by
   * markForDelivery (server side, same request) is honoured only when it is
   * the courier the intent was created for.
   *
   * Each state change is one guarded `updateMany`, so a stale response can
   * never overwrite a newer state:
   *   T2 claim    BOOKING_PENDING → claim marker   (0 rows → NOT_CLAIMED, no provider call)
   *   T3 confirm  claim marker → booked + history  (0 rows / P2002 → STALE, audited)
   *   T4 reject   claim marker → CANCELLED         (0 rows → STALE)
   *   T5 unknown  claim marker → BOOKING_UNKNOWN   (0 rows → STALE)
   * A provider success with no tracking id, or whose confirm write fails,
   * becomes CONFIRM_FAILED — never REJECTED: the shipment may exist, so the
   * booking slot stays occupied.
   * Every thrown error carries `courierBookingOutcome` (CourierBookingOutcome).
   *
   * NOTE: `orderId` is the platform Order's cuid string (Order.id in schema).
   */
  async createCourierOrderForVendor(
    orderId: string,
    vendorId: string,
    input: Partial<OrderDetails> & {
      /** The booking-intent CourierOrder row to book. */
      intentId: string;
      /** Server-side courier selection made for this intent (markForDelivery only). */
      preselectedCourier?: OrderDetails['preselectedCourier'];
    }
  ) {
    // Step 0: the intent must be this vendor's, for this order. No writes yet.
    const intent = await prisma.courierOrder.findFirst({
      where: { id: input.intentId, orderId, vendorId },
    });
    if (!intent) {
      throw bookingError('NOT_CLAIMED', `Booking intent ${input.intentId} is not a booking intent of vendor ${vendorId} for this order`);
    }
    if (!intent.warehouseId || !intent.merchantReference) {
      throw bookingError('NOT_CLAIMED', `Booking intent ${intent.id} has no warehouse or merchant reference and cannot be booked automatically`);
    }
    if (input.preselectedCourier && input.preselectedCourier.courierProviderId !== intent.courierProviderId) {
      throw bookingError('NOT_CLAIMED', `Booking intent ${intent.id} was created for a different courier than the one preselected`);
    }
    const warehouse = await prisma.vendorWarehouse.findFirst({
      where: { id: intent.warehouseId, vendorId },
      select: { id: true, locationId: true },
    });
    if (!warehouse) {
      throw bookingError('NOT_CLAIMED', `Warehouse ${intent.warehouseId} does not belong to vendor ${vendorId}`);
    }

    // T2: atomic claim. Exactly one request can move BOOKING_PENDING to its own
    // claim marker; claimed, unresolved, legacy, booked and cancelled rows are
    // refused without contacting a provider.
    const marker = bookingClaimMarker(randomUUID());
    const claim = await prisma.courierOrder.updateMany({
      where: {
        id: intent.id,
        orderId,
        vendorId,
        warehouseId: intent.warehouseId,
        status: 'PENDING_PICKUP',
        courierTrackingId: null,
        courierStatus: BOOKING_PENDING,
      },
      data: { courierStatus: marker, lastStatusUpdate: new Date() },
    });
    if (claim.count !== 1) {
      throw bookingError('NOT_CLAIMED', `Booking intent ${intent.id} is not claimable (already claimed, unresolved, booked or cancelled)`);
    }

    // The shipment exactly as persisted on the intent row.
    const shipment: OrderDetails = {
      recipientName: intent.recipientName,
      recipientPhone: intent.recipientPhone,
      recipientAddress: intent.recipientAddress,
      recipientLocationId: intent.deliveryLocationId,
      vendorWarehouseLocationId: warehouse.locationId,
      itemDescription: intent.itemDescription ?? '',
      itemQuantity: intent.itemQuantity,
      itemWeight: intent.itemWeight,
      codAmount: Number(intent.codAmount),
      deliveryType: intent.deliveryType === 'EXPRESS' ? 'EXPRESS' : 'NORMAL',
      specialInstructions: intent.specialInstruction ?? undefined,
      vendorOrderId: intent.vendorOrderId ?? undefined,
      warehouseId: intent.warehouseId,
      intentId: intent.id,
      merchantReference: intent.merchantReference,
    };

    // Steps 1–2b run after the claim. Any failure here is a definitive local
    // rejection: nothing has been sent to a provider.
    let selectedCourier: { courierProviderId: string; courierName: string; pricing: CourierPricing };
    let pickupArea: any = null;
    let deliveryArea: any = null;
    let warehousePickup: ResolvedWarehousePickup | undefined;
    try {
      // Step 1: selection is skipped when the server preselected the courier.
      selectedCourier =
        input.preselectedCourier ??
        (await this.selectBestCourier({
          vendorWarehouseLocationId: warehouse.locationId,
          customerDeliveryLocationId: shipment.recipientLocationId,
          orderWeight: shipment.itemWeight,
          codAmount: shipment.codAmount,
          deliveryType: shipment.deliveryType,
          warehouseId: warehouse.id,
        }));
      if (selectedCourier.courierProviderId !== intent.courierProviderId) {
        throw new Error(`Selected courier differs from the courier booking intent ${intent.id} was created for`);
      }

      console.log(`Selected courier: ${selectedCourier.courierName} for order ${orderId}`);

      // Step 2: serviceable area mappings for both locations. Steadfast has no
      // city/zone/area-sync API (see getSteadfastPricing), so it never has
      // courier_serviceable_areas rows — the check is skipped for it.
      if (selectedCourier.courierName !== 'Steadfast') {
        pickupArea = await prisma.courierServicableAreas.findFirst({
          where: {
            courierProviderId: selectedCourier.courierProviderId,
            locationId: warehouse.locationId,
            // PICKUP side of the route: the courier must pick up from here.
            pickupAvailable: true,
            isActive: true,
          },
          orderBy: SERVICEABLE_AREA_ORDER, // G6: same deterministic choice as the quote path
        });

        deliveryArea = await prisma.courierServicableAreas.findFirst({
          where: {
            courierProviderId: selectedCourier.courierProviderId,
            locationId: shipment.recipientLocationId,
            homeDeliveryAvailable: true,
            isActive: true,
          },
          orderBy: SERVICEABLE_AREA_ORDER, // G6: same deterministic choice as the quote path
        });

        if (!pickupArea || !deliveryArea) {
          throw new Error('Service area mapping not found for selected courier');
        }
      }

      // Step 2b: Pathao/RedX pickup = the warehouse's ACTIVE pickup store
      // mapping, the same one the quote was priced for.
      if (isWarehousePickupProvider(selectedCourier.courierName)) {
        warehousePickup = await this.resolveWarehousePickup(
          selectedCourier.courierProviderId,
          selectedCourier.courierName,
          warehouse.id,
        );
        // mapping.vendorId === warehouse.vendorId is a DB composite FK; the
        // warehouse was verified to belong to `vendorId` in Step 0.
        if (warehousePickup.mapping.vendorId !== vendorId) {
          throw new Error(`${selectedCourier.courierName} pickup mapping belongs to a different vendor`);
        }
        const quotedMappingId = selectedCourier.pricing?.pickupMappingId;
        if (quotedMappingId && quotedMappingId !== warehousePickup.mapping.id) {
          throw new Error(
            `${selectedCourier.courierName} pickup store for warehouse ${warehouse.id} changed since the quote — re-quote required`,
          );
        }
      }
    } catch (localError: any) {
      throw await this.settleClaimedIntent(intent.id, marker, 'REJECTED', localError?.message ?? 'Local booking validation failed');
    }

    // Step 3: create the order in the courier provider's system. Only the
    // provider call itself is inside this try — reading the identifiers out of
    // an ACCEPTED response happens below, so a malformed success response can
    // never be mistaken for a failed (let alone rejected) request.
    let courierResponse: any;
    try {
      if (selectedCourier.courierName === 'Pathao') {
        courierResponse = await this.createPathaoOrder(selectedCourier.courierProviderId, {
          ...shipment,
          pickupArea,
          deliveryArea,
          warehousePickup,
        });
      } else if (selectedCourier.courierName === 'RedX') {
        courierResponse = await this.createRedXOrder(selectedCourier.courierProviderId, {
          ...shipment,
          pickupArea,
          deliveryArea,
          warehousePickup,
        });
      } else if (selectedCourier.courierName === 'Steadfast') {
        courierResponse = await this.steadfastCreateOrder(selectedCourier.courierProviderId, {
          invoice: shipment.merchantReference, // 1C-13: deterministic per VendorOrder+warehouse
          recipient_name: shipment.recipientName,
          recipient_phone: shipment.recipientPhone,
          recipient_address: shipment.recipientAddress,
          cod_amount: shipment.codAmount,
          note: shipment.specialInstructions || shipment.itemDescription,
        });
      } else {
        throw new Error(`Unsupported courier provider: ${selectedCourier.courierName}`);
      }
    } catch (error: any) {
      // The provider call failed. The builders tag their outcome (pre-request
      // validation → REJECTED; the HTTP call → classifyProviderBookingError).
      // An untagged error is classified the same conservative way: only a
      // confirmed business-validation rejection releases the booking slot.
      console.error('Courier provider order creation failed:', {
        orderId,
        vendorId,
        provider: selectedCourier.courierName,
        error: describeCourierError(error),
      });
      const message = `Failed to create courier order with ${selectedCourier.courierName}: ${
        error.response?.data ? JSON.stringify(redactSecrets(error.response.data)) : error.message
      }`;
      const outcome: 'REJECTED' | 'UNKNOWN' =
        (error as any).courierBookingOutcome ?? classifyProviderBookingError(error);
      throw await this.settleClaimedIntent(intent.id, marker, outcome, message);
    }

    // The provider ACCEPTED the request. Its shipment identifiers are read
    // defensively: a nominally successful response without a usable tracking /
    // consignment id is NOT confirmed and NOT reported as success — the shipment
    // may exist at the provider, so it becomes CONFIRM_FAILED (never REJECTED)
    // and keeps its booking slot for reconciliation.
    let rawTrackingId: unknown;
    let rawExternalOrderId: unknown;
    if (selectedCourier.courierName === 'Pathao') {
      rawTrackingId = courierResponse?.data?.consignment_id;
      rawExternalOrderId = courierResponse?.data?.merchant_order_id || `ORDER-${orderId}`;
    } else if (selectedCourier.courierName === 'RedX') {
      rawTrackingId = courierResponse?.tracking_id;
      rawExternalOrderId = courierResponse?.tracking_id;
    } else {
      rawTrackingId = courierResponse?.consignment?.tracking_code;
      rawExternalOrderId = courierResponse?.consignment?.consignment_id;
    }
    const courierTrackingId = providerShipmentId(rawTrackingId);
    const courierExternalOrderId = providerShipmentId(rawExternalOrderId); // optional column: null when absent
    if (!courierTrackingId) {
      throw await this.recordConfirmFailed(intent.id, marker, {
        provider: selectedCourier.courierName,
        providerTrackingId: '(missing)',
        providerOrderId: courierExternalOrderId ?? '(missing)',
        merchantReference: intent.merchantReference,
        error: 'Provider response has no tracking/consignment id',
      });
    }

    // Step 4 (T3): the provider ACCEPTED the booking. Confirm the intent in
    // place, together with its first tracking-history row, in one transaction
    // and only while this request's claim still holds.
    const pricing = selectedCourier.pricing;
    let confirmation: 'CONFIRMED' | 'STALE';
    try {
      confirmation = await prismaDirect.$transaction(async (tx) => {
        const confirmed = await tx.courierOrder.updateMany({
          where: { id: intent.id, status: 'PENDING_PICKUP', courierTrackingId: null, courierStatus: marker },
          data: {
            courierProviderId: selectedCourier.courierProviderId,
            courierOrderId: courierExternalOrderId, // the courier's own order id (scalar column, not the relation)
            courierTrackingId,
            deliveryCharge: pricing.deliveryCharge,
            codCharge: pricing.codCharge,
            totalCharge: pricing.totalCharge,
            courierStatus: 'Order Created',
            lastStatusUpdate: new Date(),
            // Snapshot of the provider pickup store this shipment was booked with
            // (Pathao/RedX). Later mapping changes never rewrite existing shipments.
            ...(warehousePickup ? { pickupStoreId: warehousePickup.mapping.providerStoreId } : {}),
          },
        });
        if (confirmed.count !== 1) return 'STALE';
        await tx.courierTrackingHistory.create({
          data: {
            courierOrderId: intent.id,
            status: 'PENDING_PICKUP',
            courierStatus: 'Order Created Successfully',
            messageEn: 'Your order has been created and is pending pickup',
            messageBn: 'আপনার অর্ডার তৈরি হয়েছে এবং পিকআপের অপেক্ষায় রয়েছে',
            timestamp: new Date(),
            rawData: courierResponse, // raw provider response (Json? field on CourierTrackingHistory)
          },
        });
        return 'CONFIRMED';
      });
    } catch (confirmError: any) {
      if (confirmError?.code === 'P2002') {
        // Another row already holds this provider tracking id.
        confirmation = 'STALE';
      } else {
        // The shipment EXISTS at the provider but could not be recorded. Never
        // REJECTED — keep the slot occupied and leave it for reconciliation.
        throw await this.recordConfirmFailed(intent.id, marker, {
          provider: selectedCourier.courierName,
          providerTrackingId: courierTrackingId,
          providerOrderId: courierExternalOrderId ?? '(missing)',
          merchantReference: intent.merchantReference,
          error: describeCourierError(confirmError).message,
        });
      }
    }
    if (confirmation === 'STALE') {
      await this.auditBookingEvent('COURIER_STALE_CONFIRMATION', intent.id, {
        provider: selectedCourier.courierName,
        providerTrackingId: courierTrackingId,
        providerOrderId: courierExternalOrderId,
        merchantReference: intent.merchantReference,
      });
      throw bookingError(
        'STALE',
        `Courier ${selectedCourier.courierName} accepted shipment ${intent.merchantReference} (tracking ${courierTrackingId}), but booking intent ${intent.id} changed before it could be recorded — reconciliation required`,
      );
    }

    console.log(`Courier order created successfully: ${courierTrackingId}`);

    return {
      success: true,
      courierOrder: {
        id: intent.id,
        trackingId: courierTrackingId,
        orderId: courierExternalOrderId,
        courierName: selectedCourier.courierName,
        status: 'PENDING_PICKUP' as const,
        deliveryCharge: pricing.deliveryCharge,
        codCharge: pricing.codCharge,
        totalCharge: pricing.totalCharge,
      },
      pricing,
    };
  }

  /**
   * T4/T5: record a provider outcome on a CLAIMED intent — only while this
   * request's claim marker still holds. Returns the error to throw:
   *   REJECTED → status CANCELLED (slot freed; the only outcome that frees it)
   *   UNKNOWN  → BOOKING_UNKNOWN  (slot stays occupied until reconciliation)
   * 0 rows → STALE (audited); a failed write → OUTCOME_NOT_RECORDED (the row
   * keeps its claim marker, which stays blocked).
   */
  private async settleClaimedIntent(
    intentId: string,
    marker: string,
    outcome: 'REJECTED' | 'UNKNOWN',
    message: string,
  ): Promise<Error> {
    const data =
      outcome === 'REJECTED'
        ? { status: 'CANCELLED' as const, courierStatus: `Booking rejected: ${message}`.slice(0, 1000), cancelledAt: new Date(), lastStatusUpdate: new Date() }
        : { courierStatus: BOOKING_UNKNOWN, lastStatusUpdate: new Date() };
    try {
      const settled = await prisma.courierOrder.updateMany({
        where: { id: intentId, status: 'PENDING_PICKUP', courierTrackingId: null, courierStatus: marker },
        data,
      });
      if (settled.count === 1) return bookingError(outcome, message);
      await this.auditBookingEvent('COURIER_STALE_OUTCOME', intentId, { outcome });
      return bookingError('STALE', `Booking intent ${intentId} changed before its ${outcome} outcome could be recorded — reconciliation required. ${message}`);
    } catch (writeError) {
      console.error('[courier-booking] could not record booking outcome', {
        intentId,
        outcome,
        error: describeCourierError(writeError).message,
      });
      return bookingError('OUTCOME_NOT_RECORDED', `Booking intent ${intentId}: the ${outcome} outcome could not be recorded — reconciliation required. ${message}`);
    }
  }

  /**
   * The provider accepted the booking but the confirm write failed. Marks the
   * claimed intent BOOKING_CONFIRM_FAILED (guarded on the claim marker; if that
   * write fails too, the marker itself keeps the row blocked) and records the
   * provider identifiers for reconciliation. Always returns CONFIRM_FAILED.
   */
  private async recordConfirmFailed(
    intentId: string,
    marker: string,
    details: { provider: string; providerTrackingId: string; providerOrderId: string; merchantReference: string; error: string },
  ): Promise<Error> {
    console.error('[courier-booking] provider accepted the booking but it could not be recorded — reconciliation required', {
      intentId,
      ...details,
    });
    try {
      await prisma.courierOrder.updateMany({
        where: { id: intentId, status: 'PENDING_PICKUP', courierTrackingId: null, courierStatus: marker },
        data: { courierStatus: BOOKING_CONFIRM_FAILED, lastStatusUpdate: new Date() },
      });
    } catch (writeError) {
      console.error('[courier-booking] could not mark booking CONFIRM_FAILED', {
        intentId,
        error: describeCourierError(writeError).message,
      });
    }
    await this.auditBookingEvent('COURIER_CONFIRM_FAILED', intentId, details);
    return bookingError(
      'CONFIRM_FAILED',
      `Courier ${details.provider} accepted shipment ${details.merchantReference} (tracking ${details.providerTrackingId}), but it could not be recorded — reconciliation required`,
    );
  }

  /** Best-effort audit row for a booking event (never contains credentials). */
  private async auditBookingEvent(action: string, intentId: string, data: Record<string, unknown>) {
    try {
      await prisma.auditLog.create({
        data: { action, entity: 'CourierOrder', entityId: intentId, newData: data as any },
      });
    } catch (auditError) {
      console.error('[courier-booking] audit write failed', {
        action,
        intentId,
        error: describeCourierError(auditError).message,
      });
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
      /** 1C-13 deterministic shipment reference (arrives via ...orderDetails). */
      merchantReference?: string;
      /** The warehouse's ACTIVE Pathao store mapping (resolved by the caller). */
      warehousePickup?: ResolvedWarehousePickup;
    },
    environment: Environment = 'PRODUCTION'
  ) {
    // G1/G3: validate the outgoing payload inputs BEFORE any provider call.
    // These failures are definitive — nothing was sent — so they are marked
    // REJECTED (retry/reallocation safe), never UNKNOWN (reconciliation).
    let outgoingItemWeight: number;
    let storeId: number;
    let credentials: Awaited<ReturnType<CourierService['getPlatformCourierCredentials']>>;
    try {
      if (!orderData.merchantReference) {
        throw new Error('Pathao booking requires a merchantReference (1C-13 idempotency key)');
      }
      outgoingItemWeight = toPathaoItemWeightKg(orderData.itemWeight);
      // Pickup = the warehouse's own Pathao store; never CourierCredential.storeId.
      if (!orderData.warehousePickup) {
        throw new Error('Pathao booking requires the warehouse pickup store mapping');
      }
      storeId = parseInt(orderData.warehousePickup.mapping.providerStoreId);
      if (!Number.isFinite(storeId)) {
        throw new Error(`Invalid Pathao store id on pickup mapping ${orderData.warehousePickup.mapping.id}`);
      }
      credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
      if (!credentials) {
        throw new Error('Pathao credentials not configured');
      }
      // The store id only exists inside the merchant account it was mapped for.
      if (credentials.id !== orderData.warehousePickup.mapping.courierCredentialId) {
        throw new Error('Pathao pickup store mapping belongs to a different courier credential');
      }
    } catch (validationError: any) {
      (validationError as any).courierBookingOutcome = 'REJECTED';
      throw validationError;
    }

    const accessToken = await this.getValidPathaoToken(courierProviderId, environment);
    const baseUrl =
      environment === 'SANDBOX'
        ? credentials.courier_providers.sandboxBaseUrl
        : credentials.courier_providers.productionBaseUrl;

    const pathaoOrderData = {
      store_id: storeId, // the warehouse's mapped Pathao store (same as the quote)
      merchant_order_id: orderData.merchantReference, // 1C-13: deterministic per-logical-shipment reference (G1: was the undefined `orderDetails`)
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
      item_weight: outgoingItemWeight, // G3: Pathao boundary (kg, min 0.5; > 10 kg rejected above)
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
      // Phase 0 follow-up (H1): a received HTTP response is not proof that no
      // shipment exists. Only a confirmed validation rejection is REJECTED;
      // timeouts, resets, 5xx/408/429, gateway errors and duplicate
      // merchant_order_id responses are UNKNOWN (the shipment MAY exist).
      const wrapped = new Error(`Pathao order creation failed: ${error.message}`);
      (wrapped as any).courierBookingOutcome = classifyProviderBookingError(error);
      throw wrapped;
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
      /** 1C-13 deterministic shipment reference (arrives via ...orderDetails). */
      merchantReference?: string;
      /** The warehouse's ACTIVE RedX pickup store mapping (resolved by the caller). */
      warehousePickup?: ResolvedWarehousePickup;
    },
    environment: Environment = 'PRODUCTION'
  ) {
    // G1/G2: validate outgoing payload inputs BEFORE any provider call —
    // definitive local failures are REJECTED (nothing sent), never UNKNOWN.
    let parcelWeightGrams: number;
    let pickupStoreId: number;
    let credentials: Awaited<ReturnType<CourierService['getPlatformCourierCredentials']>>;
    try {
      if (!orderData.merchantReference) {
        throw new Error('RedX booking requires a merchantReference (1C-13 idempotency key)');
      }
      parcelWeightGrams = kgToRedxGrams(orderData.itemWeight);
      // Pickup = the warehouse's own RedX pickup store (the one the quote's
      // pickup_area_id came from) — never pickup_stores[0].
      if (!orderData.warehousePickup) {
        throw new Error('RedX booking requires the warehouse pickup store mapping');
      }
      pickupStoreId = parseInt(orderData.warehousePickup.mapping.providerStoreId);
      if (!Number.isFinite(pickupStoreId)) {
        throw new Error(`Invalid RedX pickup store id on pickup mapping ${orderData.warehousePickup.mapping.id}`);
      }
      credentials = await this.getPlatformCourierCredentials(courierProviderId, environment);
      if (!credentials) {
        throw new Error('RedX credentials not configured');
      }
      if (credentials.id !== orderData.warehousePickup.mapping.courierCredentialId) {
        throw new Error('RedX pickup store mapping belongs to a different courier credential');
      }
    } catch (validationError: any) {
      (validationError as any).courierBookingOutcome = 'REJECTED';
      throw validationError;
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
      merchant_invoice_id: orderData.merchantReference, // 1C-13: deterministic per-logical-shipment reference (G1: was the undefined `orderDetails`)
      cash_collection_amount: orderData.codAmount.toString(),
      parcel_weight: parcelWeightGrams.toString(), // G2: RedX expects GRAMS (internal kg × 1000)
      instruction: orderData.specialInstructions || '',
      value: (orderData.itemValue || orderData.codAmount).toString(),
      pickup_store_id: pickupStoreId, // the warehouse's mapped RedX pickup store (same as the quote)
      parcel_details_json: [
        {
          name: orderData.itemDescription,
          category: 'General',
          value: orderData.itemValue || orderData.codAmount,
        },
      ],
    };

    const url = `${baseUrl}/parcel`;

    try {
      const response = await this.axiosInstance.post(url, redxOrderData, {
        headers: {
          'API-ACCESS-TOKEN': `Bearer ${credentials.bearerToken}`,
          'Content-Type': 'application/json',
        },
      });

      return response.data;
    } catch (error: any) {
      console.error('RedX order creation error:', {
        status: error.response?.status,
        data: error.response?.data,
        url,
      });
      throw new Error(
        `RedX order creation failed: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Vendor marks order as ready for pickup
   * This method is called when the vendor has prepared the package and it's ready to be picked up by the courier
   *
   * NOTE: `orderId` is the platform Order's cuid string, not a number.
   */
  async vendorMarkReadyForPickup(vendorId: string, orderId: string) {
    // Step 1: Find the courier order
    const courierOrder = await prisma.courierOrder.findFirst({
      where: {
        orderId,
        vendorId,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        courier_providers: true,
      },
    });

    if (!courierOrder) {
      throw new Error('Courier order not found');
    }

    // Step 2: Validate current status - can only mark as ready if currently
    // pending pickup. (Schema's CourierOrderStatus has no plain 'PENDING'.)
    if (courierOrder.status !== 'PENDING_PICKUP') {
      throw new Error(
        `Cannot mark order as ready. Current status: ${courierOrder.status}. Only PENDING_PICKUP orders can be marked as ready.`
      );
    }

    // Steps 3–4 (Phase 0, T8): guarded update + tracking history in ONE
    // transaction. Only this vendor's BOOKED (tracking id set), still
    // PENDING_PICKUP, REGULAR shipment can move; a booking intent never can.
    // 0 rows → error and no history row.
    const updatedOrder = await prismaDirect.$transaction(async (tx) => {
      const moved = await tx.courierOrder.updateMany({
        where: {
          id: courierOrder.id,
          vendorId,
          status: 'PENDING_PICKUP',
          shipmentKind: 'REGULAR',
          courierTrackingId: { not: null },
        },
        data: {
          status: 'READY_FOR_PICKUP',
          courierStatus: 'Package ready for pickup',
          lastStatusUpdate: new Date(),
        },
      });
      if (moved.count !== 1) return null;
      await tx.courierTrackingHistory.create({
        data: {
          courierOrderId: courierOrder.id,
          status: 'READY_FOR_PICKUP',
          courierStatus: 'Vendor marked package as ready for pickup',
          messageEn: 'Package is ready for courier pickup',
          messageBn: 'প্যাকেজ কুরিয়ার পিকআপের জন্য প্রস্তুত',
          timestamp: new Date(),
        },
      });
      return tx.courierOrder.findUnique({ where: { id: courierOrder.id } });
    });
    if (!updatedOrder) {
      throw new Error(
        'Cannot mark order as ready: only a booked, pending-pickup REGULAR shipment of this vendor can be marked ready.'
      );
    }

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
      console.error('Failed to notify courier provider:', describeCourierError(error));
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
   * Cancel a courier order (used by admin.order.service.ts's cancelOrder()).
   * Only meaningful pre-pickup.
   *
   * Phase 0 (T6): `db` is the caller's transaction client, so the cancel
   * commits or rolls back (and is retried) together with the order
   * cancellation. The guarded update only cancels a BOOKED pre-pickup shipment
   * or an UNCLAIMED intent (BOOKING_PENDING — nothing sent to a provider);
   * claimed, unknown, confirm-failed, legacy and already-cancelled rows are
   * left untouched. A refusal is returned, never thrown: a thrown SQL error
   * would abort the caller's transaction.
   */
  async cancelCourierOrder(courierOrderId: string, db: CourierCancelDb = prisma): Promise<{ cancelled: boolean }> {
    const cancelled = await db.courierOrder.updateMany({
      where: {
        id: courierOrderId,
        status: { in: ['PENDING_PICKUP', 'READY_FOR_PICKUP'] },
        OR: [
          { courierTrackingId: { not: null } },
          { courierTrackingId: null, courierStatus: BOOKING_PENDING },
        ],
      },
      data: {
        status: 'CANCELLED',
        courierStatus: 'Cancelled by platform',
        lastStatusUpdate: new Date(),
        cancelledAt: new Date(),
      },
    });
    if (cancelled.count !== 1) return { cancelled: false };

    await db.courierTrackingHistory.create({
      data: {
        courierOrderId,
        status: 'CANCELLED',
        courierStatus: 'Cancelled by platform',
        messageEn: 'This shipment was cancelled before pickup.',
        timestamp: new Date(),
      },
    });

    return { cancelled: true };
  }

  /**
   * Get courier order by tracking ID
   */
  async getCourierOrderByTrackingId(trackingId: string) {
    return await prisma.courierOrder.findFirst({
      where: { courierTrackingId: trackingId },
      include: {
        vendorOrder: true, // relation is singular (CourierOrder -> at most one VendorOrder), was incorrectly "vendorOrders"
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
  async getCourierOrdersByOrderId(orderId: string) {
    return await prisma.courierOrder.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
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
  async generateShippingLabel(orderId: string, vendorId: string) {
    const courierOrder = await prisma.courierOrder.findFirst({
      where: { orderId, vendorId }, // Phase 0: a vendor only ever sees its own label
      orderBy: { createdAt: 'desc' },
      include: {
        vendorOrder: true, // singular relation, was incorrectly "vendorOrders"
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

  // ==================== COURIER PRICING RULES (ADMIN) ====================

  /**
   * List courier pricing rules with filters, sorting, and pagination.
   */
  async listPricingRules(filters: {
    courierProviderId?: string;
    isActive?: boolean;
    deliveryType?: string;
    fromLocationId?: string;
    toLocationId?: string;
    page?: number;
    limit?: number;
  } = {}) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(filters.limit) || 20));
    const skip = (page - 1) * limit;

    const where: any = {
      vendorId: null, // Only platform-wide rules are managed
    };

    if (filters.courierProviderId) {
      where.courierProviderId = filters.courierProviderId;
    }
    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive;
    }
    if (filters.deliveryType) {
      where.deliveryType = filters.deliveryType.trim().toUpperCase();
    }
    if (filters.fromLocationId !== undefined) {
      where.fromLocationId = filters.fromLocationId || null;
    }
    if (filters.toLocationId !== undefined) {
      where.toLocationId = filters.toLocationId || null;
    }

    const [rules, total] = await Promise.all([
      prisma.courierPricingRules.findMany({
        where,
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
        include: {
          courier_providers: {
            select: { id: true, name: true, slug: true, displayName: true, isActive: true },
          },
          locations_courier_pricing_rules_fromLocationIdTolocations: {
            select: { id: true, name: true, level: true },
          },
          locations_courier_pricing_rules_toLocationIdTolocations: {
            select: { id: true, name: true, level: true },
          },
        },
      }),
      prisma.courierPricingRules.count({ where }),
    ]);

    return {
      rules,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Create a platform-wide courier pricing rule with full validation.
   */
  async createPricingRule(data: {
    courierProviderId: string;
    vendorId?: string | null;
    deliveryType?: string;
    deliveryTypeCode?: string | null;
    itemType?: string;
    itemTypeCode?: string | null;
    fromLocationId?: string | null;
    toLocationId?: string | null;
    minWeight?: number;
    maxWeight?: number | null;
    basePrice: number;
    perKgCharge?: number;
    codChargeType?: string | null;
    codChargeValue?: number | null;
    fuelSurcharge?: number;
    validFrom?: Date | string;
    validTo?: Date | string | null;
    isActive?: boolean;
    priority?: number;
  }) {
    if (data.vendorId !== undefined && data.vendorId !== null) {
      throw new Error('Vendor-scoped pricing rules are not supported yet. Rules must be platform-wide (vendorId must be null).');
    }

    if (!data.courierProviderId) {
      throw new Error('courierProviderId is required.');
    }
    const provider = await prisma.courierProviders.findUnique({
      where: { id: data.courierProviderId },
      select: { id: true, name: true },
    });
    if (!provider) {
      throw new Error(`Courier provider ${data.courierProviderId} not found.`);
    }

    const deliveryType = (data.deliveryType || 'NORMAL').trim().toUpperCase();
    if (deliveryType !== 'NORMAL') {
      throw new Error(`Unsupported deliveryType '${data.deliveryType}'. Only 'NORMAL' delivery is supported.`);
    }

    const itemType = normalizeCourierItemType(data.itemType);

    if (data.fromLocationId) {
      const fromLoc = await prisma.locations.findUnique({
        where: { id: data.fromLocationId },
        select: { id: true },
      });
      if (!fromLoc) {
        throw new Error(`From location ${data.fromLocationId} not found.`);
      }
    }

    if (data.toLocationId) {
      const toLoc = await prisma.locations.findUnique({
        where: { id: data.toLocationId },
        select: { id: true },
      });
      if (!toLoc) {
        throw new Error(`To location ${data.toLocationId} not found.`);
      }
    }

    const basePrice = Number(data.basePrice);
    if (!Number.isFinite(basePrice) || basePrice < 0) {
      throw new Error('basePrice must be a finite non-negative number.');
    }

    const perKgCharge = Number(data.perKgCharge ?? 0);
    if (!Number.isFinite(perKgCharge) || perKgCharge < 0) {
      throw new Error('perKgCharge must be a finite non-negative number.');
    }

    const fuelSurcharge = Number(data.fuelSurcharge ?? 0);
    if (!Number.isFinite(fuelSurcharge) || fuelSurcharge < 0) {
      throw new Error('fuelSurcharge must be a finite non-negative number.');
    }

    const minWeight = Number(data.minWeight ?? 0);
    if (!Number.isFinite(minWeight) || minWeight < 0) {
      throw new Error('minWeight must be a finite non-negative number.');
    }

    let maxWeight: number | null = null;
    if (data.maxWeight !== undefined && data.maxWeight !== null) {
      maxWeight = Number(data.maxWeight);
      if (!Number.isFinite(maxWeight) || maxWeight <= 0) {
        throw new Error('maxWeight must be a finite positive number.');
      }
      if (maxWeight <= minWeight) {
        throw new Error(`maxWeight (${maxWeight}) must be greater than minWeight (${minWeight}).`);
      }
    }

    const validFrom = data.validFrom ? new Date(data.validFrom) : new Date();
    if (isNaN(validFrom.getTime())) {
      throw new Error('validFrom is not a valid date.');
    }

    let validTo: Date | null = null;
    if (data.validTo !== undefined && data.validTo !== null) {
      validTo = new Date(data.validTo);
      if (isNaN(validTo.getTime())) {
        throw new Error('validTo is not a valid date.');
      }
      if (validTo <= validFrom) {
        throw new Error('validTo must be strictly after validFrom.');
      }
    }

    const { codChargeType, codChargeValue } = normalizeCourierCodCharge(
      data.codChargeType,
      data.codChargeValue
    );

    const priority = Number.isInteger(data.priority) ? Number(data.priority) : 100;
    const isActive = data.isActive !== undefined ? Boolean(data.isActive) : true;

    return prisma.courierPricingRules.create({
      data: {
        courierProviderId: provider.id,
        vendorId: null,
        deliveryType,
        deliveryTypeCode: data.deliveryTypeCode ?? null,
        itemType,
        itemTypeCode: data.itemTypeCode ?? null,
        fromLocationId: data.fromLocationId ?? null,
        toLocationId: data.toLocationId ?? null,
        minWeight,
        maxWeight,
        basePrice,
        perKgCharge,
        codChargeType,
        codChargeValue,
        fuelSurcharge,
        validFrom,
        validTo,
        isActive,
        priority,
        updatedAt: new Date(),
      },
      include: {
        courier_providers: {
          select: { id: true, name: true, slug: true, displayName: true, isActive: true },
        },
        locations_courier_pricing_rules_fromLocationIdTolocations: {
          select: { id: true, name: true, level: true },
        },
        locations_courier_pricing_rules_toLocationIdTolocations: {
          select: { id: true, name: true, level: true },
        },
      },
    });
  }

  /**
   * Update an existing courier pricing rule.
   */
  async updatePricingRule(
    id: string,
    data: {
      vendorId?: string | null;
      deliveryType?: string;
      deliveryTypeCode?: string | null;
      itemType?: string;
      itemTypeCode?: string | null;
      fromLocationId?: string | null;
      toLocationId?: string | null;
      minWeight?: number;
      maxWeight?: number | null;
      basePrice?: number;
      perKgCharge?: number;
      codChargeType?: string | null;
      codChargeValue?: number | null;
      fuelSurcharge?: number;
      validFrom?: Date | string;
      validTo?: Date | string | null;
      isActive?: boolean;
      priority?: number;
    }
  ) {
    const existing = await prisma.courierPricingRules.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new Error(`Courier pricing rule ${id} not found.`);
    }

    if (data.vendorId !== undefined && data.vendorId !== null) {
      throw new Error('Vendor-scoped pricing rules are not supported yet. Rules must be platform-wide (vendorId must be null).');
    }

    const updates: any = {
      updatedAt: new Date(),
    };

    if (data.deliveryType !== undefined) {
      const deliveryType = data.deliveryType.trim().toUpperCase();
      if (deliveryType !== 'NORMAL') {
        throw new Error(`Unsupported deliveryType '${data.deliveryType}'. Only 'NORMAL' delivery is supported.`);
      }
      updates.deliveryType = deliveryType;
    }

    if (data.fromLocationId !== undefined) {
      if (data.fromLocationId) {
        const fromLoc = await prisma.locations.findUnique({
          where: { id: data.fromLocationId },
          select: { id: true },
        });
        if (!fromLoc) throw new Error(`From location ${data.fromLocationId} not found.`);
        updates.fromLocationId = data.fromLocationId;
      } else {
        updates.fromLocationId = null;
      }
    }

    if (data.toLocationId !== undefined) {
      if (data.toLocationId) {
        const toLoc = await prisma.locations.findUnique({
          where: { id: data.toLocationId },
          select: { id: true },
        });
        if (!toLoc) throw new Error(`To location ${data.toLocationId} not found.`);
        updates.toLocationId = data.toLocationId;
      } else {
        updates.toLocationId = null;
      }
    }

    if (data.basePrice !== undefined) {
      const basePrice = Number(data.basePrice);
      if (!Number.isFinite(basePrice) || basePrice < 0) {
        throw new Error('basePrice must be a finite non-negative number.');
      }
      updates.basePrice = basePrice;
    }

    if (data.perKgCharge !== undefined) {
      const perKgCharge = Number(data.perKgCharge);
      if (!Number.isFinite(perKgCharge) || perKgCharge < 0) {
        throw new Error('perKgCharge must be a finite non-negative number.');
      }
      updates.perKgCharge = perKgCharge;
    }

    if (data.fuelSurcharge !== undefined) {
      const fuelSurcharge = Number(data.fuelSurcharge);
      if (!Number.isFinite(fuelSurcharge) || fuelSurcharge < 0) {
        throw new Error('fuelSurcharge must be a finite non-negative number.');
      }
      updates.fuelSurcharge = fuelSurcharge;
    }

    const effectiveMinWeight = data.minWeight !== undefined ? Number(data.minWeight) : existing.minWeight;
    if (!Number.isFinite(effectiveMinWeight) || effectiveMinWeight < 0) {
      throw new Error('minWeight must be a finite non-negative number.');
    }
    if (data.minWeight !== undefined) updates.minWeight = effectiveMinWeight;

    let effectiveMaxWeight = data.maxWeight !== undefined ? data.maxWeight : existing.maxWeight;
    if (effectiveMaxWeight !== null && effectiveMaxWeight !== undefined) {
      const maxW = Number(effectiveMaxWeight);
      if (!Number.isFinite(maxW) || maxW <= 0) {
        throw new Error('maxWeight must be a finite positive number.');
      }
      if (maxW <= effectiveMinWeight) {
        throw new Error(`maxWeight (${maxW}) must be greater than minWeight (${effectiveMinWeight}).`);
      }
      if (data.maxWeight !== undefined) updates.maxWeight = maxW;
    } else if (data.maxWeight === null) {
      updates.maxWeight = null;
    }

    const effectiveValidFrom = new Date(data.validFrom ?? existing.validFrom);
    if (isNaN(effectiveValidFrom.getTime())) {
      throw new Error('validFrom is not a valid date.');
    }
    if (data.validFrom !== undefined) updates.validFrom = effectiveValidFrom;

    if (data.validTo !== undefined) {
      if (data.validTo === null) {
        updates.validTo = null;
      } else {
        const vTo = new Date(data.validTo);
        if (isNaN(vTo.getTime())) {
          throw new Error('validTo is not a valid date.');
        }
        if (vTo <= effectiveValidFrom) {
          throw new Error('validTo must be strictly after validFrom.');
        }
        updates.validTo = vTo;
      }
    }

    if (data.isActive !== undefined) updates.isActive = Boolean(data.isActive);
    if (data.priority !== undefined) {
      // Was Number(data.priority), which wrote NaN straight into an Int column
      // and surfaced as a raw ORM error instead of a clean 400.
      const priority = Number(data.priority);
      if (!Number.isFinite(priority) || !Number.isInteger(priority)) {
        throw new Error('priority must be a finite integer.');
      }
      updates.priority = priority;
    }
    if (data.deliveryTypeCode !== undefined) updates.deliveryTypeCode = data.deliveryTypeCode;
    if (data.itemType !== undefined) {
      updates.itemType = normalizeCourierItemType(data.itemType);
    }
    if (data.itemTypeCode !== undefined) updates.itemTypeCode = data.itemTypeCode;
    if (data.codChargeType !== undefined || data.codChargeValue !== undefined) {
      // The value's bounds depend on the type, so validate the pair together,
      // falling back to the stored type when only a new value was sent.
      const typeInput =
        data.codChargeType !== undefined ? data.codChargeType : existing.codChargeType;
      let valueInput =
        data.codChargeValue !== undefined ? data.codChargeValue : existing.codChargeValue;
      if (
        data.codChargeValue === undefined &&
        (typeInput === null || typeInput === undefined || String(typeInput).trim() === '')
      ) {
        // Clearing the type makes any stored value meaningless; drop it rather
        // than reject the request over data the caller never sent.
        valueInput = null;
      }
      const normalizedCod = normalizeCourierCodCharge(typeInput, valueInput);
      updates.codChargeType = normalizedCod.codChargeType;
      updates.codChargeValue = normalizedCod.codChargeValue;
    }

    return prisma.courierPricingRules.update({
      where: { id },
      data: updates,
      include: {
        courier_providers: {
          select: { id: true, name: true, slug: true, displayName: true, isActive: true },
        },
        locations_courier_pricing_rules_fromLocationIdTolocations: {
          select: { id: true, name: true, level: true },
        },
        locations_courier_pricing_rules_toLocationIdTolocations: {
          select: { id: true, name: true, level: true },
        },
      },
    });
  }

  /**
   * Toggle a courier pricing rule's active status (safe deactivation).
   */
  async togglePricingRuleStatus(id: string) {
    const existing = await prisma.courierPricingRules.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Courier pricing rule ${id} not found.`);
    }
    return prisma.courierPricingRules.update({
      where: { id },
      data: {
        isActive: !existing.isActive,
        updatedAt: new Date(),
      },
      include: {
        courier_providers: {
          select: { id: true, name: true, slug: true, displayName: true, isActive: true },
        },
      },
    });
  }

  /**
   * Safe deactivation / deletion of a pricing rule.
   */
  async deletePricingRule(id: string) {
    const existing = await prisma.courierPricingRules.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Courier pricing rule ${id} not found.`);
    }
    // Hard delete rule
    await prisma.courierPricingRules.delete({ where: { id } });
    return { id, deleted: true };
  }
}

export default new CourierService();