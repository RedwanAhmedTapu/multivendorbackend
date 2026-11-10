import pkg from '@prisma/client';
const { PrismaClient } = pkg;

const prisma = new PrismaClient();

// ==================== WAREHOUSE COURIER PICKUP MAPPING ====================
// Source of truth for WHERE a courier picks up a warehouse's shipment:
//   VendorWarehouse + CourierCredential (merchant account + environment)
//     → provider store (Pathao store_id / RedX pickup_store id)
//
// Quote (courier.service getPathaoPricing / getRedXPricing) and booking
// (createPathaoOrder / createRedXOrder) both resolve the pickup through
// findActivePickup(), so they always use the SAME store. There is no fallback
// to CourierCredential.storeId and no "first store" selection: a warehouse
// without an ACTIVE mapping is simply not eligible for that provider.
//
// Integrity (DB, migration 20261008010000_warehouse_courier_pickup):
//   - (warehouseId, vendorId) FK → vendor_warehouses(id, vendorId)
//   - (courierCredentialId, courierProviderId) FK → courier_credentials(id, courierProviderId)
//   - ≤ 1 ACTIVE row per (warehouseId, courierCredentialId)
//   - ≤ 1 ACTIVE/PENDING_APPROVAL row per (courierCredentialId, providerStoreId)
// Enforced here: actor vendor scope, credential active + scope
// (platform credential or the warehouse vendor's own), provider support,
// store-id immutability (a replacement is a new row; the old one goes INACTIVE).
//
// This module intentionally does NOT import courier.service (courier.service
// imports it); provider verification happens in the controller.

/** Providers whose pickup is a provider-side store bound to a warehouse. */
export const WAREHOUSE_PICKUP_PROVIDERS = ['Pathao', 'RedX'] as const;
export type WarehousePickupProviderName = (typeof WAREHOUSE_PICKUP_PROVIDERS)[number];

export function isWarehousePickupProvider(name: string | null | undefined): name is WarehousePickupProviderName {
  return !!name && (WAREHOUSE_PICKUP_PROVIDERS as readonly string[]).includes(name);
}

export type PickupActor = {
  userId?: string | null;
  role?: string | null;
  /** Set for vendor-scoped actors — restricts every operation to that vendor's warehouses. */
  vendorId?: string | null;
};

export class PickupMappingError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * How a store reaches a link request:
 *  - EXISTING_STORE: an already-existing store of the SHARED platform courier
 *    account is claimed for a warehouse. There is no provider-side ownership
 *    metadata, so only an ADMIN may do this (a vendor-scoped employee could
 *    otherwise claim another vendor's unclaimed / deactivated store).
 *  - CREATED_FOR_WAREHOUSE: the store was created by this backend in the same
 *    request, for this warehouse (its location came from the warehouse), so the
 *    association is proven; any actor allowed to create the store may link it.
 */
export type LinkOrigin = 'EXISTING_STORE' | 'CREATED_FOR_WAREHOUSE';

function assertMayLink(origin: LinkOrigin, actor: PickupActor | undefined) {
  if (origin === 'EXISTING_STORE' && actor?.role !== 'ADMIN') {
    throw new PickupMappingError(
      403,
      'ADMIN_REQUIRED',
      'Only an ADMIN can link an existing shared-account courier store to a warehouse',
    );
  }
}

export type LinkPickupInput = {
  warehouseId: string;
  courierCredentialId: string;
  providerStoreId: string;
  providerStoreName?: string | null;
  providerCityId?: string | null;
  providerZoneId?: string | null;
  providerAreaId?: string | null;
  rawData?: unknown;
  /** Set when the store id was just confirmed against the provider account. */
  verifiedAt?: Date | null;
};

const PUBLIC_SELECT = {
  id: true,
  warehouseId: true,
  vendorId: true,
  courierCredentialId: true,
  courierProviderId: true,
  providerStoreId: true,
  providerStoreName: true,
  providerCityId: true,
  providerZoneId: true,
  providerAreaId: true,
  status: true,
  rawData: true,
  lastVerifiedAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function isActorScoped(actor: PickupActor | undefined): actor is PickupActor & { vendorId: string } {
  return !!actor?.vendorId && actor.role !== 'ADMIN';
}

type Tx = any; // Prisma.TransactionClient (kept loose: the client is loaded via default import)

export class WarehouseCourierPickupService {
  // ---------- internal checks ----------

  private async loadWarehouseInScope(db: Tx, warehouseId: string, actor?: PickupActor) {
    const warehouse = await db.vendorWarehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true, vendorId: true, locationId: true, name: true, isActive: true },
    });
    // Out-of-scope warehouses are reported as not found (no cross-vendor existence leak).
    if (!warehouse || (isActorScoped(actor) && warehouse.vendorId !== actor.vendorId)) {
      throw new PickupMappingError(404, 'WAREHOUSE_NOT_FOUND', `Warehouse ${warehouseId} not found`);
    }
    return warehouse;
  }

  /** A deactivated warehouse can't get new courier pickup stores (deactivating an existing mapping stays allowed). */
  private assertWarehouseActive(warehouse: { id: string; isActive: boolean }) {
    if (!warehouse.isActive) {
      throw new PickupMappingError(409, 'WAREHOUSE_INACTIVE', `Warehouse ${warehouse.id} is deactivated`);
    }
  }

  private async loadCredentialForWarehouse(
    db: Tx,
    courierCredentialId: string,
    warehouse: { vendorId: string },
  ) {
    const credential = await db.courierCredential.findUnique({
      where: { id: courierCredentialId },
      select: {
        id: true,
        courierProviderId: true,
        vendorId: true,
        environment: true,
        isActive: true,
        courier_providers: { select: { id: true, name: true } },
      },
    });
    if (!credential) {
      throw new PickupMappingError(404, 'CREDENTIAL_NOT_FOUND', `Courier credential ${courierCredentialId} not found`);
    }
    if (!credential.isActive) {
      throw new PickupMappingError(422, 'CREDENTIAL_INACTIVE', 'Courier credential is inactive');
    }
    // Vendor isolation: a platform credential (vendorId NULL) may serve any
    // vendor's warehouse; a vendor credential only that vendor's warehouses.
    if (credential.vendorId !== null && credential.vendorId !== warehouse.vendorId) {
      throw new PickupMappingError(403, 'CREDENTIAL_SCOPE', 'Courier credential belongs to a different vendor');
    }
    const providerName = credential.courier_providers?.name;
    if (providerName === 'Steadfast') {
      throw new PickupMappingError(
        422,
        'PROVIDER_ACCOUNT_LEVEL_PICKUP',
        'Steadfast pickup is configured on the Steadfast account; it has no warehouse store mapping',
      );
    }
    if (!isWarehousePickupProvider(providerName)) {
      throw new PickupMappingError(422, 'PROVIDER_NOT_SUPPORTED', `Warehouse pickup mapping is not supported for ${providerName ?? 'this provider'}`);
    }
    return { ...credential, providerName };
  }

  private validateProviderFields(providerName: WarehousePickupProviderName, input: { providerStoreId: string | null; providerAreaId: string | null }) {
    if (!input.providerStoreId || !/^\d+$/.test(input.providerStoreId)) {
      throw new PickupMappingError(400, 'INVALID_STORE_ID', `${providerName} store id must be a numeric provider store id`);
    }
    // RedX quotes need the store's pickup_area_id — quote and booking must refer
    // to the same pickup store, so the area comes from the store, not the location.
    if (providerName === 'RedX' && (!input.providerAreaId || !/^\d+$/.test(input.providerAreaId))) {
      throw new PickupMappingError(400, 'INVALID_AREA_ID', 'RedX pickup store mapping requires the store\'s numeric area_id');
    }
  }

  private mapUniqueViolation(err: any): never {
    if (err?.code === 'P2002') {
      throw new PickupMappingError(
        409,
        'MAPPING_CONFLICT',
        'This provider store is already mapped to another warehouse, or the warehouse already has an active store for this courier account',
      );
    }
    throw err;
  }

  // ---------- commands ----------

  /**
   * Scope/credential checks for a future link, without a store id — run
   * BEFORE creating a store at the provider so a store is never created for
   * a warehouse/credential that could not be mapped.
   */
  async precheckLink(
    warehouseId: string,
    courierCredentialId: string,
    actor?: PickupActor,
    origin: LinkOrigin = 'EXISTING_STORE',
  ) {
    assertMayLink(origin, actor);
    const warehouse = await this.loadWarehouseInScope(prisma, warehouseId, actor);
    this.assertWarehouseActive(warehouse);
    const credential = await this.loadCredentialForWarehouse(prisma, courierCredentialId, warehouse);
    return { warehouse, providerName: credential.providerName };
  }

  /**
   * Link a provider store to a warehouse. Always creates a PENDING_APPROVAL
   * row (activation is a separate, re-verified step). Idempotent: linking the
   * same store to the same warehouse again returns the existing open mapping.
   */
  async linkStore(input: LinkPickupInput, actor?: PickupActor, origin: LinkOrigin = 'EXISTING_STORE') {
    assertMayLink(origin, actor);
    const providerStoreId = str(input.providerStoreId);
    const providerAreaId = str(input.providerAreaId);
    try {
      return await prisma.$transaction(async (tx: Tx) => {
        const warehouse = await this.loadWarehouseInScope(tx, input.warehouseId, actor);
        this.assertWarehouseActive(warehouse);
        const credential = await this.loadCredentialForWarehouse(tx, input.courierCredentialId, warehouse);
        this.validateProviderFields(credential.providerName, { providerStoreId, providerAreaId });

        const existingOpen = await tx.warehouseCourierPickup.findFirst({
          where: {
            courierCredentialId: credential.id,
            providerStoreId,
            status: { in: ['ACTIVE', 'PENDING_APPROVAL'] },
          },
          select: PUBLIC_SELECT,
        });
        if (existingOpen) {
          if (existingOpen.warehouseId === warehouse.id) return { mapping: existingOpen, created: false };
          throw new PickupMappingError(409, 'STORE_ALREADY_MAPPED', 'This provider store is already mapped to another warehouse');
        }

        const mapping = await tx.warehouseCourierPickup.create({
          data: {
            warehouseId: warehouse.id,
            vendorId: warehouse.vendorId,
            courierCredentialId: credential.id,
            courierProviderId: credential.courierProviderId,
            providerStoreId,
            providerStoreName: str(input.providerStoreName),
            providerCityId: str(input.providerCityId),
            providerZoneId: str(input.providerZoneId),
            providerAreaId,
            status: 'PENDING_APPROVAL',
            rawData: (input.rawData ?? undefined) as any,
            lastVerifiedAt: input.verifiedAt ?? null,
            createdById: actor?.userId ?? null,
          },
          select: PUBLIC_SELECT,
        });
        return { mapping, created: true };
      });
    } catch (err) {
      if (err instanceof PickupMappingError) throw err;
      this.mapUniqueViolation(err);
    }
  }

  /**
   * Activate a mapping (PENDING_APPROVAL or INACTIVE → ACTIVE). Any other
   * ACTIVE mapping of the same warehouse + credential is moved to INACTIVE in
   * the same transaction (store replacement). Idempotent for ACTIVE rows.
   * The caller must have re-verified the store with the provider first.
   */
  async activate(mappingId: string, actor?: PickupActor, verification?: { rawData?: unknown; verifiedAt?: Date }) {
    try {
      return await prisma.$transaction(async (tx: Tx) => {
        // Serialize concurrent status changes of this mapping.
        await tx.$queryRaw`SELECT "id" FROM "warehouse_courier_pickups" WHERE "id" = ${mappingId} FOR UPDATE`;
        const current = await tx.warehouseCourierPickup.findUnique({ where: { id: mappingId }, select: PUBLIC_SELECT });
        if (!current) throw new PickupMappingError(404, 'MAPPING_NOT_FOUND', `Pickup mapping ${mappingId} not found`);
        const warehouse = await this.loadWarehouseInScope(tx, current.warehouseId, actor);
        this.assertWarehouseActive(warehouse);
        const credential = await this.loadCredentialForWarehouse(tx, current.courierCredentialId, warehouse);
        this.validateProviderFields(credential.providerName, current);

        const verifiedData = {
          ...(verification?.verifiedAt ? { lastVerifiedAt: verification.verifiedAt } : {}),
          ...(verification?.rawData !== undefined ? { rawData: verification.rawData as any } : {}),
        };

        if (current.status === 'ACTIVE') {
          const mapping = Object.keys(verifiedData).length
            ? await tx.warehouseCourierPickup.update({ where: { id: current.id }, data: verifiedData, select: PUBLIC_SELECT })
            : current;
          return { mapping, replacedIds: [] as string[] };
        }

        const others = await tx.warehouseCourierPickup.findMany({
          where: {
            warehouseId: current.warehouseId,
            courierCredentialId: current.courierCredentialId,
            status: 'ACTIVE',
            id: { not: current.id },
          },
          select: { id: true },
        });
        if (others.length) {
          await tx.warehouseCourierPickup.updateMany({
            where: { id: { in: others.map((o: { id: string }) => o.id) }, status: 'ACTIVE' },
            data: { status: 'INACTIVE' },
          });
        }
        const mapping = await tx.warehouseCourierPickup.update({
          where: { id: current.id },
          data: { status: 'ACTIVE', ...verifiedData },
          select: PUBLIC_SELECT,
        });
        return { mapping, replacedIds: others.map((o: { id: string }) => o.id) };
      });
    } catch (err) {
      if (err instanceof PickupMappingError) throw err;
      this.mapUniqueViolation(err);
    }
  }

  /** Deactivate a mapping (→ INACTIVE). Idempotent. Never touches existing shipments. */
  async deactivate(mappingId: string, actor?: PickupActor) {
    return prisma.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT "id" FROM "warehouse_courier_pickups" WHERE "id" = ${mappingId} FOR UPDATE`;
      const current = await tx.warehouseCourierPickup.findUnique({ where: { id: mappingId }, select: PUBLIC_SELECT });
      if (!current) throw new PickupMappingError(404, 'MAPPING_NOT_FOUND', `Pickup mapping ${mappingId} not found`);
      await this.loadWarehouseInScope(tx, current.warehouseId, actor);
      if (current.status === 'INACTIVE') return { mapping: current };
      const mapping = await tx.warehouseCourierPickup.update({
        where: { id: current.id },
        data: { status: 'INACTIVE' },
        select: PUBLIC_SELECT,
      });
      return { mapping };
    });
  }

  // ---------- queries ----------

  /**
   * The ACTIVE pickup mapping for a warehouse on one courier credential, or
   * null. Used by quote AND booking. The partial unique index guarantees at
   * most one row, so no ordering/"first" choice is involved.
   */
  async findActivePickup(warehouseId: string, courierCredentialId: string) {
    return prisma.warehouseCourierPickup.findFirst({
      where: { warehouseId, courierCredentialId, status: 'ACTIVE' },
      select: PUBLIC_SELECT,
    });
  }

  async getById(mappingId: string, actor?: PickupActor) {
    const mapping = await prisma.warehouseCourierPickup.findUnique({ where: { id: mappingId }, select: PUBLIC_SELECT });
    if (!mapping || (isActorScoped(actor) && mapping.vendorId !== actor.vendorId)) {
      throw new PickupMappingError(404, 'MAPPING_NOT_FOUND', `Pickup mapping ${mappingId} not found`);
    }
    return mapping;
  }

  async list(
    filters: { warehouseId?: string; vendorId?: string; courierProviderId?: string; courierCredentialId?: string; status?: string },
    actor?: PickupActor,
  ) {
    const status = filters.status && ['ACTIVE', 'INACTIVE', 'PENDING_APPROVAL'].includes(filters.status) ? filters.status : undefined;
    return prisma.warehouseCourierPickup.findMany({
      where: {
        ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
        ...(filters.courierProviderId ? { courierProviderId: filters.courierProviderId } : {}),
        ...(filters.courierCredentialId ? { courierCredentialId: filters.courierCredentialId } : {}),
        ...(status ? { status: status as any } : {}),
        // a vendor-scoped actor only ever sees its own vendor's mappings
        ...(isActorScoped(actor)
          ? { vendorId: actor.vendorId }
          : filters.vendorId
            ? { vendorId: filters.vendorId }
            : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      select: PUBLIC_SELECT,
    });
  }
}

export default new WarehouseCourierPickupService();
