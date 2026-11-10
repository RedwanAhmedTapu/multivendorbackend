// src/services/warehouse.service.ts
import { PrismaClient } from '@prisma/client';
import type { WarehouseType, StockMovementType, Prisma } from '@prisma/client';
import { AppError } from '../middlewares/error.middleware.ts';
import { runStockMutation } from '../modules/shared/stock-mutations.ts';
import {
  assertVendorAccess,
  assertWarehouseAccess,
  type WarehouseActor,
} from '../modules/shared/warehouse-guard.ts';

const prisma = new PrismaClient();

/** Fields that can never be changed through an update. */
const IMMUTABLE_WAREHOUSE_FIELDS = ['id', 'vendorId', 'isActive', 'deactivatedAt', 'createdAt', 'updatedAt'] as const;

const FIELD_LOCK_OPERATIONAL =
  'This field cannot be changed because this warehouse is already being used in operations.';
const FIELD_LOCK_COURIER_PICKUP =
  'This field cannot be changed while an active or pending courier pickup store is mapped to this warehouse.';

/** Courier shipments that are not finished yet (goods may still leave or return). */
const PENDING_COURIER_STATUSES = [
  'PENDING_PICKUP',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'PICKUP_FAILED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'PARTIAL_DELIVERED',
  'FAILED_DELIVERY',
  'RETURNING',
  'ON_HOLD',
] as any[];

/** Purchase orders that can still receive goods. */
const OPEN_PURCHASE_STATUSES = ['DRAFT', 'CONFIRMED', 'PARTIALLY_RECEIVED'] as any[];

interface CreateWarehouseInput {
  vendorId: string;
  locationId: string;
  code?: string;
  name?: string;
  address?: string;
  email?: string;
  phone?: string;
  isDefault?: boolean;
  type?: WarehouseType;
}

interface UpdateWarehouseInput {
  locationId?: string;
  code?: string;
  name?: string;
  address?: string;
  email?: string;
  phone?: string;
  isDefault?: boolean;
  type?: WarehouseType;
}

interface CreateHolidayInput {
  warehouseId: string;
  start: Date;
  end: Date;
  isOpen?: boolean;
}

interface UpdateHolidayInput {
  start?: Date;
  end?: Date;
  isOpen?: boolean;
}

// ─── Rack interfaces ─────────────────────────────────────────────
// A rack no longer *is* a row/shelf — it declares how many rows/shelves
// it has. Actual placement lives on WarehouseStock (rackId + rowNumber + shelfNumber).

export interface CreateRackInput {
  warehouseId: string;
  code: string;
  label?: string;
  totalRows?: number;      // default 1
  totalShelves?: number;   // default 1
  isActive?: boolean;
}

export interface UpdateRackInput {
  code?: string;
  label?: string;
  totalRows?: number;
  totalShelves?: number;
  isActive?: boolean;
}

export interface RackFilter {
  warehouseId?: string;
  isActive?: boolean;
}

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

// ─── Stock interfaces ────────────────────────────────────────────
// "Location" = the bin a stock row lives in. rackId/rowNumber/shelfNumber
// can all be omitted/null — that's how a vendor with no rack layout works.

export interface ReceivePurchaseOrderInput {
  purchaseOrderId: string;
  warehouseId: string;
  vendorId: string;
  items: Array<{
    purchaseOrderItemId: string;
    variantId: string;
    receivedQty: number;
    unitCost: number;
    newAvgCost: number;
    sellPrice?: number;
    rackId?: string;
    rowNumber?: number;
    shelfNumber?: number;
  }>;
  createdBy?: string;
}

export interface StockAdjustmentInput {
  variantId: string;
  warehouseId: string;
  vendorId: string;
  quantity: number;
  movementType: Extract<StockMovementType, 'ADJUSTMENT' | 'DAMAGE' | 'RETURN'>;
  rackId?: string;
  rowNumber?: number;
  shelfNumber?: number;
  reason?: string;
  notes?: string;
  createdBy?: string;
}

export interface StockTransferInput {
  variantId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  vendorId: string;
  quantity: number;
  // source bin (also used by sellDamagedStock, which only ever reads from* fields)
  fromRackId?: string;
  fromRowNumber?: number;
  fromShelfNumber?: number;
  // destination bin (transfer only)
  toRackId?: string;
  toRowNumber?: number;
  toShelfNumber?: number;
  reason?: string;
  notes?: string;
  saleAmount?: number;
  coaAccountId?: string;
  createdBy?: string;
}

export interface WarehouseStockFilter {
  warehouseId?: string;
  /** Vendor scope: only stock in this vendor's warehouses. */
  vendorId?: string;
  variantId?: string;
  rackId?: string;
  rowNumber?: number;
  shelfNumber?: number;
  lowStockOnly?: boolean;
  outOfStockOnly?: boolean;
  page?: number;
  limit?: number;
}

export class WarehouseService {

  // ─────────────────────────────────────────────────────────────────
  // INTERNAL HELPERS — bin location validation & compound-key builder
  // ─────────────────────────────────────────────────────────────────

  /**
   * Validates a (rackId, rowNumber, shelfNumber) combination against a warehouse:
   * - No rackId → rowNumber/shelfNumber must also be absent (can't place in a "row" of nothing).
   * - rackId present → must belong to this warehouse and be active.
   * - rowNumber/shelfNumber, if given, must be within the rack's configured capacity.
   * Returns the rack row when one was validated, otherwise undefined.
   */
  private async validateStockLocation(
    warehouseId: string,
    rackId?: string | null,
    rowNumber?: number | null,
    shelfNumber?: number | null,
  ) {
    if (!rackId) {
      if (rowNumber || shelfNumber) {
        const error = new Error('rowNumber/shelfNumber require a rackId');
        (error as any).statusCode = 400;
        throw error;
      }
      return undefined;
    }

    const rack = await prisma.warehouseRack.findUnique({ where: { id: rackId } });
    if (!rack || rack.warehouseId !== warehouseId || !rack.isActive) {
      const error = new Error('Rack is invalid, inactive, or does not belong to this warehouse');
      (error as any).statusCode = 400;
      throw error;
    }

    if (rowNumber !== undefined && rowNumber !== null) {
      if (rowNumber < 1 || rowNumber > rack.totalRows) {
        const error = new Error(
          `rowNumber must be between 1 and ${rack.totalRows} for rack "${rack.code}"`,
        );
        (error as any).statusCode = 400;
        throw error;
      }
    }

    if (shelfNumber !== undefined && shelfNumber !== null) {
      if (shelfNumber < 1 || shelfNumber > rack.totalShelves) {
        const error = new Error(
          `shelfNumber must be between 1 and ${rack.totalShelves} for rack "${rack.code}"`,
        );
        (error as any).statusCode = 400;
        throw error;
      }
    }

    return rack;
  }

  /** Builds the WarehouseStock compound-unique `where` for the new 5-part key. */
  private stockUniqueWhere(
    variantId: string,
    warehouseId: string,
    rackId?: string | null,
    rowNumber?: number | null,
    shelfNumber?: number | null,
  ) {
    return {
      variantId_warehouseId_rackId_rowNumber_shelfNumber: {
        variantId,
        warehouseId,
        rackId: rackId ?? null,
        rowNumber: rowNumber ?? null,
        shelfNumber: shelfNumber ?? null,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // BULK CREATE / UPDATE
  // ─────────────────────────────────────────────────────────────────

  async createOrUpdateBulkWarehouses(vendorId: string, data: BulkWarehouseInput, actor?: WarehouseActor) {
    assertVendorAccess(vendorId, actor);
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
    if (!vendor) throw new AppError('Vendor not found', 404);

    // Same create/update rules (scope, allow-list, field locks) as the
    // single-warehouse endpoints. With several warehouses of a type, the
    // vendor's default (then oldest) active one is the one updated.
    const findPrimary = (type: WarehouseType) =>
      prisma.vendorWarehouse.findFirst({
        where: { vendorId, type, isActive: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
    const upsertPrimary = async (type: WarehouseType, payload: any, isDefault: boolean) => {
      const existing = await findPrimary(type);
      return existing
        ? this.updateWarehouse(existing.id, { ...payload, isDefault }, actor)
        : this.createWarehouse({ ...payload, vendorId, type, isDefault }, actor);
    };
    const pick = (w: any) => ({
      locationId: w.locationId,
      address: w.address,
      code: w.code,
      name: w.name,
      email: w.email,
      phone: w.phone,
    });

    const result: any = {};

    if (data.pickupWarehouse) {
      result.pickupWarehouse = await upsertPrimary('PICKUP', pick(data.pickupWarehouse), true);
    }

    if (data.returnWarehouse && !data.returnWarehouse.sameAsPickup) {
      result.returnWarehouse = await upsertPrimary('RETURN', pick(data.returnWarehouse), false);
    } else if (data.returnWarehouse?.sameAsPickup) {
      result.returnWarehouse = await upsertPrimary('RETURN', pick(data.pickupWarehouse!), false);
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────
  // WAREHOUSE CRUD
  //
  // Vendor isolation: every operation is scoped by the authenticated actor
  // (warehouse-guard.ts). Updates use an explicit allow-list — the request
  // body is never passed to Prisma, and vendorId/id can never be changed.
  //
  // Lifecycle: ACTIVE → (derived) OPERATIONAL → INACTIVE (isActive = false).
  // "Operational" is computed from existing references (getWarehouseUsage);
  // it is never stored.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Derived usage of a warehouse: whether it is operational, which fields are
   * locked, and whether it can be deactivated or hard-deleted.
   * Read-only; safe to call inside a transaction (pass `db`).
   */
  async getWarehouseUsage(id: string, db: any = prisma) {
    const warehouse = await db.vendorWarehouse.findUnique({
      where: { id },
      select: { id: true, vendorId: true, isActive: true, deactivatedAt: true },
    });
    if (!warehouse) throw new AppError('Warehouse not found', 404);

    const [
      stock,
      purchaseReceiveItems,
      allocations,
      pendingAllocationRows,
      stockMovements,
      courierOrders,
      pendingCourierOrders,
      posSaleItems,
      purchaseOrders,
      openPurchaseOrders,
      openCourierPickups,
      courierPickups,
    ] = await Promise.all([
      db.warehouseStock.aggregate({
        where: { warehouseId: id },
        _sum: { quantity: true, reservedQty: true, damagedQty: true },
      }),
      db.purchaseReceiveItem.count({ where: { warehouseId: id } }),
      db.orderItemAllocation.count({ where: { warehouseId: id } }),
      // allocation rows still waiting to ship (released/cancelled rows are
      // shrunk to their shipped quantity, so quantity > shippedQty = pending)
      db.$queryRaw`SELECT count(*)::int AS "n" FROM "order_item_allocations" WHERE "warehouseId" = ${id} AND "quantity" > "shippedQty"`,
      db.stockMovement.count({ where: { OR: [{ fromWarehouseId: id }, { toWarehouseId: id }] } }),
      db.courierOrder.count({ where: { warehouseId: id } }),
      db.courierOrder.count({ where: { warehouseId: id, status: { in: PENDING_COURIER_STATUSES } } }),
      db.posSaleItem.count({ where: { warehouseId: id } }),
      db.purchaseOrder.count({ where: { warehouseId: id } }),
      db.purchaseOrder.count({ where: { warehouseId: id, receivingStatus: { in: OPEN_PURCHASE_STATUSES } } }),
      db.warehouseCourierPickup.count({ where: { warehouseId: id, status: { in: ['ACTIVE', 'PENDING_APPROVAL'] } } }),
      db.warehouseCourierPickup.count({ where: { warehouseId: id } }),
    ]);

    const onHand = stock._sum.quantity ?? 0;
    const reserved = stock._sum.reservedQty ?? 0;
    const damaged = stock._sum.damagedQty ?? 0;
    const pendingAllocations = Number(pendingAllocationRows?.[0]?.n ?? 0);

    const counts = {
      stockOnHand: onHand,
      stockReserved: reserved,
      stockDamaged: damaged,
      purchaseReceiveItems,
      allocations,
      pendingAllocations,
      stockMovements,
      courierOrders,
      pendingCourierOrders,
      posSaleItems,
      purchaseOrders,
      openPurchaseOrders,
      openCourierPickups,
      courierPickups,
    };

    // Operational = the warehouse has been used for real stock/order activity.
    const operational =
      onHand > 0 ||
      reserved > 0 ||
      damaged > 0 ||
      purchaseReceiveItems > 0 ||
      allocations > 0 ||
      stockMovements > 0 ||
      courierOrders > 0 ||
      posSaleItems > 0;

    const locks = {
      locationId: operational ? FIELD_LOCK_OPERATIONAL : null,
      type: operational ? FIELD_LOCK_OPERATIONAL : null,
      address: openCourierPickups > 0 ? FIELD_LOCK_COURIER_PICKUP : null,
    };

    const deactivationBlockers: string[] = [];
    if (onHand > 0 || reserved > 0 || damaged > 0) {
      deactivationBlockers.push(
        `Warehouse still holds stock (on hand ${onHand}, reserved ${reserved}, damaged ${damaged}). Transfer or clear it first.`,
      );
    }
    if (pendingAllocations > 0) {
      deactivationBlockers.push(`${pendingAllocations} order allocation(s) from this warehouse are not shipped yet.`);
    }
    if (pendingCourierOrders > 0) {
      deactivationBlockers.push(`${pendingCourierOrders} courier shipment(s) from this warehouse are still in progress.`);
    }
    if (openPurchaseOrders > 0) {
      deactivationBlockers.push(`${openPurchaseOrders} open purchase order(s) are still due to be received into this warehouse.`);
    }

    const hardDeleteBlockers: string[] = [];
    if (operational) hardDeleteBlockers.push('Warehouse has been used in operations — deactivate it instead.');
    if (purchaseOrders > 0) hardDeleteBlockers.push('Purchase orders reference this warehouse — deactivate it instead.');
    if (courierPickups > 0) hardDeleteBlockers.push('Courier pickup mappings reference this warehouse — deactivate it instead.');

    return {
      warehouseId: id,
      isActive: warehouse.isActive,
      deactivatedAt: warehouse.deactivatedAt,
      operational,
      counts,
      locks,
      canDeactivate: warehouse.isActive && deactivationBlockers.length === 0,
      deactivationBlockers,
      canHardDelete: hardDeleteBlockers.length === 0,
      hardDeleteBlockers,
    };
  }

  /** Allow-listed, normalized create/update payload. Never includes vendorId/id. */
  private pickWarehouseFields(body: any) {
    const out: {
      locationId?: string;
      code?: string | null;
      name?: string | null;
      address?: string | null;
      email?: string | null;
      phone?: string | null;
      type?: WarehouseType;
      isDefault?: boolean;
    } = {};
    if (!body || typeof body !== 'object') return out;
    const optionalText = (v: unknown) => {
      if (v === null) return null;
      if (typeof v !== 'string') throw new AppError('Warehouse text fields must be strings', 400);
      const t = v.trim();
      return t.length ? t : null;
    };
    if (body.locationId !== undefined) {
      if (typeof body.locationId !== 'string' || !body.locationId.trim()) throw new AppError('locationId is required', 400);
      out.locationId = body.locationId.trim();
    }
    for (const k of ['code', 'name', 'address', 'email', 'phone'] as const) {
      if (body[k] !== undefined) out[k] = optionalText(body[k]);
    }
    if (body.type !== undefined) {
      if (body.type !== 'PICKUP' && body.type !== 'RETURN') throw new AppError('type must be PICKUP or RETURN', 400);
      out.type = body.type;
    }
    if (body.isDefault !== undefined) out.isDefault = body.isDefault === true;
    return out;
  }

  async createWarehouse(data: CreateWarehouseInput, actor?: WarehouseActor) {
    assertVendorAccess(data.vendorId, actor);
    const fields = this.pickWarehouseFields(data);
    if (!fields.locationId) throw new AppError('locationId is required', 400);
    const type = fields.type ?? 'PICKUP';

    const vendor = await prisma.vendor.findUnique({ where: { id: data.vendorId }, select: { id: true } });
    if (!vendor) throw new AppError('Vendor not found', 404);

    const location = await prisma.locations.findUnique({ where: { id: fields.locationId }, select: { id: true } });
    if (!location) throw new AppError('Location not found', 404);

    if (fields.code) {
      const existing = await prisma.vendorWarehouse.findFirst({
        where: { vendorId: data.vendorId, code: fields.code, type },
        select: { id: true },
      });
      if (existing) throw new AppError('Warehouse with this code and type already exists', 409);
    }

    try {
      return await prisma.$transaction(async (tx) => {
        if (fields.isDefault) {
          await tx.vendorWarehouse.updateMany({
            where: { vendorId: data.vendorId, type, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.vendorWarehouse.create({
          data: {
            vendorId: data.vendorId,
            locationId: fields.locationId!,
            code: fields.code ?? null,
            name: fields.name ?? null,
            address: fields.address ?? null,
            email: fields.email ?? null,
            phone: fields.phone ?? null,
            isDefault: fields.isDefault ?? false,
            type,
          },
          include: { vendor: true, location: true },
        });
      });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new AppError('Warehouse with this code and type already exists', 409);
      throw err;
    }
  }

  async getWarehousesByVendor(
    vendorId: string,
    filters: { type?: WarehouseType; isDefault?: boolean; locationId?: string; isActive?: boolean } = {},
    actor?: WarehouseActor,
  ) {
    assertVendorAccess(vendorId, actor);
    const where: Prisma.VendorWarehouseWhereInput = { vendorId };
    if (filters.type) where.type = filters.type;
    if (filters.isDefault !== undefined) where.isDefault = filters.isDefault;
    if (filters.locationId) where.locationId = filters.locationId;
    if (filters.isActive !== undefined) where.isActive = filters.isActive;

    return prisma.vendorWarehouse.findMany({
      where,
      include: {
        vendor: true,
        location: true,
        holidays: {
          where: { end: { gte: new Date() } },
          orderBy: { start: 'asc' },
        },
        racks: {
          where: { isActive: true },
          orderBy: { code: 'asc' },
        },
        warehouseStock: {
          include: {
            variant: {
              include: {
                product: { select: { id: true, name: true } },
              },
            },
            rack: { select: { id: true, code: true, label: true, totalRows: true, totalShelves: true } },
          },
        },
      },
      orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async getWarehouseById(id: string, includeHolidays = false, actor?: WarehouseActor) {
    await assertWarehouseAccess(id, actor);
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id },
      include: {
        vendor: true,
        location: true,
        holidays: includeHolidays ? { orderBy: { start: 'asc' } } : false,
        racks: {
          orderBy: { code: 'asc' },
        },
        warehouseStock: {
          include: {
            variant: {
              include: {
                product: { select: { id: true, name: true, slug: true } },
              },
            },
            rack: {
              select: { id: true, code: true, label: true, totalRows: true, totalShelves: true },
            },
          },
          // rowNumber/shelfNumber come back automatically as scalar fields on WarehouseStock
          orderBy: { updatedAt: 'desc' },
        },
      },
    });

    if (!warehouse) throw new AppError('Warehouse not found', 404);
    return warehouse;
  }

  /** Usage / lock state for the edit UI (scoped). */
  async getWarehouseUsageForActor(id: string, actor?: WarehouseActor) {
    await assertWarehouseAccess(id, actor);
    return this.getWarehouseUsage(id);
  }

  async updateWarehouse(id: string, body: any, actor?: WarehouseActor) {
    for (const forbidden of IMMUTABLE_WAREHOUSE_FIELDS) {
      if (body && Object.prototype.hasOwnProperty.call(body, forbidden)) {
        throw new AppError(`${forbidden} cannot be changed`, 400);
      }
    }
    await assertWarehouseAccess(id, actor);
    const fields = this.pickWarehouseFields(body);

    if (fields.locationId) {
      const location = await prisma.locations.findUnique({ where: { id: fields.locationId }, select: { id: true } });
      if (!location) throw new AppError('Location not found', 404);
    }

    try {
      // Serializable (runStockMutation): a concurrent first receive/allocation
      // and a location/type change cannot both commit on a stale usage read.
      return await runStockMutation(prisma, async (tx: any) => {
        const existing = await tx.vendorWarehouse.findUnique({ where: { id } });
        if (!existing) throw new AppError('Warehouse not found', 404);

        const changes: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (k === 'isDefault') continue;
          if ((existing as any)[k] !== v) changes[k] = v;
        }

        const lockCandidates = ['locationId', 'type', 'address'].filter((k) => k in changes);
        if (lockCandidates.length) {
          const usage = await this.getWarehouseUsage(id, tx);
          for (const k of lockCandidates) {
            const reason = (usage.locks as any)[k];
            if (reason) throw new AppError(`${k}: ${reason}`, 409);
          }
        }

        const nextType = (changes.type as WarehouseType | undefined) ?? existing.type;
        const nextCode = 'code' in changes ? (changes.code as string | null) : existing.code;
        if (nextCode && ('code' in changes || 'type' in changes)) {
          const duplicate = await tx.vendorWarehouse.findFirst({
            where: { vendorId: existing.vendorId, code: nextCode, type: nextType, id: { not: id } },
            select: { id: true },
          });
          if (duplicate) throw new AppError('Warehouse with this code and type already exists', 409);
        }

        if (fields.isDefault === true) {
          if (!existing.isActive) throw new AppError('A deactivated warehouse cannot be the default', 409);
          await tx.vendorWarehouse.updateMany({
            where: { vendorId: existing.vendorId, type: nextType, isDefault: true, id: { not: id } },
            data: { isDefault: false },
          });
          changes.isDefault = true;
        } else if (fields.isDefault === false) {
          changes.isDefault = false;
        }

        return tx.vendorWarehouse.update({
          where: { id },
          data: changes,
          include: { vendor: true, location: true },
        });
      });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new AppError('Warehouse with this code and type already exists', 409);
      throw err;
    }
  }

  /**
   * Deactivate: only when no stock (on hand / reserved / damaged) and no
   * pending operational references remain. History is never touched.
   */
  async deactivateWarehouse(id: string, actor?: WarehouseActor) {
    await assertWarehouseAccess(id, actor);
    return runStockMutation(prisma, async (tx: any) => {
      const usage = await this.getWarehouseUsage(id, tx);
      if (!usage.isActive) {
        return tx.vendorWarehouse.findUnique({ where: { id }, include: { vendor: true, location: true } });
      }
      if (usage.deactivationBlockers.length) {
        throw new AppError(`Warehouse cannot be deactivated: ${usage.deactivationBlockers.join(' ')}`, 409);
      }
      return tx.vendorWarehouse.update({
        where: { id },
        data: { isActive: false, deactivatedAt: new Date(), isDefault: false },
        include: { vendor: true, location: true },
      });
    });
  }

  async reactivateWarehouse(id: string, actor?: WarehouseActor) {
    await assertWarehouseAccess(id, actor);
    return prisma.vendorWarehouse.update({
      where: { id },
      data: { isActive: true, deactivatedAt: null },
      include: { vendor: true, location: true },
    });
  }

  /** Hard delete — only for a warehouse that was never operational and has no history. */
  async deleteWarehouse(id: string, actor?: WarehouseActor) {
    await assertWarehouseAccess(id, actor);
    await runStockMutation(prisma, async (tx: any) => {
      const usage = await this.getWarehouseUsage(id, tx);
      if (!usage.canHardDelete) {
        throw new AppError(`Warehouse cannot be deleted: ${usage.hardDeleteBlockers.join(' ')}`, 409);
      }
      await tx.vendorWarehouse.delete({ where: { id } });
    });
    return { success: true };
  }

  async setDefaultWarehouse(id: string, actor?: WarehouseActor) {
    await assertWarehouseAccess(id, actor);
    return prisma.$transaction(async (tx) => {
      const warehouse = await tx.vendorWarehouse.findUnique({ where: { id } });
      if (!warehouse) throw new AppError('Warehouse not found', 404);
      if (!warehouse.isActive) throw new AppError('A deactivated warehouse cannot be the default', 409);

      await tx.vendorWarehouse.updateMany({
        where: { vendorId: warehouse.vendorId, type: warehouse.type, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });

      return tx.vendorWarehouse.update({
        where: { id },
        data: { isDefault: true },
        include: { vendor: true, location: true },
      });
    });
  }

  /** Warehouse id of a rack (for ownership checks); 404 when missing. */
  async getRackWarehouseId(rackId: string): Promise<string> {
    const rack = await prisma.warehouseRack.findUnique({ where: { id: rackId }, select: { warehouseId: true } });
    if (!rack) throw new AppError('Rack not found', 404);
    return rack.warehouseId;
  }

  /** Warehouse id of a holiday (for ownership checks); 404 when missing. */
  async getHolidayWarehouseId(holidayId: string): Promise<string> {
    const holiday = await prisma.warehouseHoliday.findUnique({ where: { id: holidayId }, select: { warehouseId: true } });
    if (!holiday) throw new AppError('Holiday not found', 404);
    return holiday.warehouseId;
  }

  // ─────────────────────────────────────────────────────────────────
  // RACK CRUD — a rack declares its row/shelf capacity; placement of
  // actual stock into a specific row/shelf happens on WarehouseStock.
  // ─────────────────────────────────────────────────────────────────

  async createRack(data: CreateRackInput) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id: data.warehouseId },
    });
    if (!warehouse) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const duplicate = await prisma.warehouseRack.findUnique({
      where: { warehouseId_code: { warehouseId: data.warehouseId, code: data.code } },
    });
    if (duplicate) {
      const error = new Error(`Rack with code "${data.code}" already exists in this warehouse`);
      (error as any).statusCode = 409;
      throw error;
    }

    if (data.totalRows !== undefined && data.totalRows < 1) {
      const error = new Error('totalRows must be at least 1');
      (error as any).statusCode = 400;
      throw error;
    }
    if (data.totalShelves !== undefined && data.totalShelves < 1) {
      const error = new Error('totalShelves must be at least 1');
      (error as any).statusCode = 400;
      throw error;
    }

    return prisma.warehouseRack.create({
      data: {
        warehouseId: data.warehouseId,
        code: data.code,
        label: data.label,
        totalRows: data.totalRows ?? 1,
        totalShelves: data.totalShelves ?? 1,
        isActive: data.isActive ?? true,
      },
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
      },
    });
  }

  async getRacksByWarehouse(warehouseId: string, filters: RackFilter = {}) {
    const where: Prisma.WarehouseRackWhereInput = { warehouseId };
    if (filters.isActive !== undefined) where.isActive = filters.isActive;

    return prisma.warehouseRack.findMany({
      where,
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
        stockItems: {
          include: {
            variant: {
              include: {
                product: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: { code: 'asc' },
    });
  }

  async getRackById(id: string) {
    const rack = await prisma.warehouseRack.findUnique({
      where: { id },
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
        stockItems: {
          include: {
            variant: {
              include: {
                product: { select: { id: true, name: true, slug: true } },
              },
            },
          },
        },
      },
    });

    if (!rack) {
      const error = new Error('Rack not found');
      (error as any).statusCode = 404;
      throw error;
    }

    return rack;
  }

  async updateRack(id: string, data: UpdateRackInput) {
    const existing = await prisma.warehouseRack.findUnique({ where: { id } });
    if (!existing) {
      const error = new Error('Rack not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (data.code && data.code !== existing.code) {
      const duplicate = await prisma.warehouseRack.findUnique({
        where: {
          warehouseId_code: { warehouseId: existing.warehouseId, code: data.code },
        },
      });
      if (duplicate) {
        const error = new Error(
          `Rack with code "${data.code}" already exists in this warehouse`
        );
        (error as any).statusCode = 409;
        throw error;
      }
    }

    // Guard against shrinking capacity below row/shelf numbers already in use.
    if (data.totalRows !== undefined && data.totalRows < existing.totalRows) {
      const maxRow = await prisma.warehouseStock.aggregate({
        where: { rackId: id, rowNumber: { not: null } },
        _max: { rowNumber: true },
      });
      if (maxRow._max.rowNumber && maxRow._max.rowNumber > data.totalRows) {
        const error = new Error(
          `Cannot reduce totalRows below ${maxRow._max.rowNumber} — stock is already placed there`
        );
        (error as any).statusCode = 409;
        throw error;
      }
    }
    if (data.totalShelves !== undefined && data.totalShelves < existing.totalShelves) {
      const maxShelf = await prisma.warehouseStock.aggregate({
        where: { rackId: id, shelfNumber: { not: null } },
        _max: { shelfNumber: true },
      });
      if (maxShelf._max.shelfNumber && maxShelf._max.shelfNumber > data.totalShelves) {
        const error = new Error(
          `Cannot reduce totalShelves below ${maxShelf._max.shelfNumber} — stock is already placed there`
        );
        (error as any).statusCode = 409;
        throw error;
      }
    }

    return prisma.warehouseRack.update({
      where: { id },
      data,
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
      },
    });
  }

  async deleteRack(id: string) {
    const rack = await prisma.warehouseRack.findUnique({
      where: { id },
      include: { stockItems: true },
    });
    if (!rack) {
      const error = new Error('Rack not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const hasStock = rack.stockItems.some(s => s.quantity > 0);
    if (hasStock) {
      const error = new Error(
        'Cannot delete rack with existing stock. Move or adjust stock first.'
      );
      (error as any).statusCode = 409;
      throw error;
    }

    await prisma.warehouseRack.delete({ where: { id } });
    return { success: true };
  }

  async toggleRackActive(id: string) {
    const rack = await prisma.warehouseRack.findUnique({ where: { id } });
    if (!rack) {
      const error = new Error('Rack not found');
      (error as any).statusCode = 404;
      throw error;
    }

    return prisma.warehouseRack.update({
      where: { id },
      data: { isActive: !rack.isActive },
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // HOLIDAY CRUD (unchanged)
  // ─────────────────────────────────────────────────────────────────

  async createHoliday(data: CreateHolidayInput) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id: data.warehouseId },
    });
    if (!warehouse) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (data.start >= data.end) {
      const error = new Error('End date must be after start date');
      (error as any).statusCode = 400;
      throw error;
    }

    const overlapping = await prisma.warehouseHoliday.findFirst({
      where: {
        warehouseId: data.warehouseId,
        OR: [
          { AND: [{ start: { lte: data.start } }, { end: { gte: data.start } }] },
          { AND: [{ start: { lte: data.end } }, { end: { gte: data.end } }] },
          { AND: [{ start: { gte: data.start } }, { end: { lte: data.end } }] },
        ],
      },
    });
    if (overlapping) {
      const error = new Error('Holiday period overlaps with existing holiday');
      (error as any).statusCode = 409;
      throw error;
    }

    return prisma.warehouseHoliday.create({
      data: {
        warehouseId: data.warehouseId,
        start: data.start,
        end: data.end,
        isOpen: data.isOpen ?? true,
      },
      include: { warehouse: true },
    });
  }

  async getHolidaysByWarehouse(
    warehouseId: string,
    filters: { startDate?: Date; endDate?: Date; isOpen?: boolean } = {}
  ) {
    const where: Prisma.WarehouseHolidayWhereInput = { warehouseId };

    if (filters.startDate || filters.endDate) {
      where.AND = [];
      if (filters.startDate) (where.AND as any[]).push({ end: { gte: filters.startDate } });
      if (filters.endDate) (where.AND as any[]).push({ start: { lte: filters.endDate } });
    }

    if (filters.isOpen !== undefined) where.isOpen = filters.isOpen;

    return prisma.warehouseHoliday.findMany({
      where,
      include: { warehouse: true },
      orderBy: { start: 'asc' },
    });
  }

  async updateHoliday(id: string, data: UpdateHolidayInput) {
    const existing = await prisma.warehouseHoliday.findUnique({ where: { id } });
    if (!existing) {
      const error = new Error('Holiday not found');
      (error as any).statusCode = 404;
      throw error;
    }

    const start = data.start || existing.start;
    const end = data.end || existing.end;

    if (start >= end) {
      const error = new Error('End date must be after start date');
      (error as any).statusCode = 400;
      throw error;
    }

    if (data.start || data.end) {
      const overlapping = await prisma.warehouseHoliday.findFirst({
        where: {
          warehouseId: existing.warehouseId,
          id: { not: id },
          OR: [
            { AND: [{ start: { lte: start } }, { end: { gte: start } }] },
            { AND: [{ start: { lte: end } }, { end: { gte: end } }] },
            { AND: [{ start: { gte: start } }, { end: { lte: end } }] },
          ],
        },
      });
      if (overlapping) {
        const error = new Error('Holiday period overlaps with existing holiday');
        (error as any).statusCode = 409;
        throw error;
      }
    }

    return prisma.warehouseHoliday.update({
      where: { id },
      data,
      include: { warehouse: true },
    });
  }

  async deleteHoliday(id: string) {
    const holiday = await prisma.warehouseHoliday.findUnique({ where: { id } });
    if (!holiday) {
      const error = new Error('Holiday not found');
      (error as any).statusCode = 404;
      throw error;
    }

    await prisma.warehouseHoliday.delete({ where: { id } });
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────
  // STOCK — RECEIVE PURCHASE ORDER
  // ─────────────────────────────────────────────────────────────────

  async receivePurchaseOrder(input: ReceivePurchaseOrderInput) {
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id: input.warehouseId },
    });
    if (!warehouse) {
      const error = new Error('Warehouse not found');
      (error as any).statusCode = 404;
      throw error;
    }
    if (!warehouse.isActive) {
      throw new AppError('Warehouse is deactivated and cannot receive stock', 409);
    }

    const purchaseOrder = await prisma.purchaseOrder.findUnique({
      where: { id: input.purchaseOrderId },
      include: { items: true },
    });
    if (!purchaseOrder) {
      const error = new Error('Purchase order not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (purchaseOrder.warehouseId !== input.warehouseId) {
      const error = new Error(
        'Warehouse mismatch: this purchase order belongs to a different warehouse'
      );
      (error as any).statusCode = 400;
      throw error;
    }

    // Validate every item's target bin (rack + row + shelf) up front, before touching data.
    for (const item of input.items) {
      await this.validateStockLocation(
        input.warehouseId,
        item.rackId,
        item.rowNumber,
        item.shelfNumber,
      );
    }

    const movements: any[] = [];

    await prisma.$transaction(async (tx) => {
      for (const item of input.items) {
        if (item.receivedQty <= 0) continue;

        // 1. Upsert WarehouseStock at the exact bin (rack/row/shelf may all be null)
        await tx.warehouseStock.upsert({
          where: this.stockUniqueWhere(
            item.variantId,
            input.warehouseId,
            item.rackId,
            item.rowNumber,
            item.shelfNumber,
          ),
          update: {
            quantity: { increment: item.receivedQty },
          },
          create: {
            variantId: item.variantId,
            warehouseId: input.warehouseId,
            rackId: item.rackId ?? null,
            rowNumber: item.rowNumber ?? null,
            shelfNumber: item.shelfNumber ?? null,
            quantity: item.receivedQty,
            reservedQty: 0,
            damagedQty: 0,
          },
        });

        // 2. Update ProductVariant totals and costs
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: {
            stock: { increment: item.receivedQty },
            avgCost: item.newAvgCost,
            ...(item.sellPrice ? { price: item.sellPrice } : {}),
          },
        });

        // 3. Record StockMovement
        const movement = await tx.stockMovement.create({
          data: {
            variantId: item.variantId,
            toWarehouseId: input.warehouseId,
            movementType: 'PURCHASE_RECEIVE',
            quantity: item.receivedQty,
            reason: `Purchase order ${purchaseOrder.purchaseNo}`,
            referenceId: item.purchaseOrderItemId,
            createdBy: input.createdBy || 'system',
          },
        });

        movements.push(movement);
      }

      // 4. Update PO status
      const totalOrdered = purchaseOrder.items.reduce((s, i) => s + i.quantity, 0);
      const totalReceived = input.items.reduce((s, i) => s + i.receivedQty, 0);
      const newStatus =
        totalReceived >= totalOrdered ? 'RECEIVED' : purchaseOrder.status;

      await tx.purchaseOrder.update({
        where: { id: input.purchaseOrderId },
        data: { status: newStatus },
      });
    });

    return {
      purchaseOrderId: input.purchaseOrderId,
      warehouseId: input.warehouseId,
      movements,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // STOCK — ADJUSTMENT / DAMAGE / RETURN
  // ─────────────────────────────────────────────────────────────────

  async adjustStock(input: StockAdjustmentInput) {
    const target = await prisma.vendorWarehouse.findUnique({
      where: { id: input.warehouseId },
      select: { isActive: true },
    });
    if (!target) throw new AppError('Warehouse not found', 404);
    if (!target.isActive) throw new AppError('Warehouse is deactivated and its stock cannot be adjusted', 409);

    await this.validateStockLocation(
      input.warehouseId,
      input.rackId,
      input.rowNumber,
      input.shelfNumber,
    );

    const stockWhere = this.stockUniqueWhere(
      input.variantId,
      input.warehouseId,
      input.rackId,
      input.rowNumber,
      input.shelfNumber,
    );

    const warehouseStock = await prisma.warehouseStock.findUnique({ where: stockWhere });

    const isDeduction =
      input.movementType === 'ADJUSTMENT' || input.movementType === 'DAMAGE';

    if (isDeduction) {
      if (!warehouseStock || warehouseStock.quantity < input.quantity) {
        const error = new Error(
          `Insufficient stock. Available: ${warehouseStock?.quantity ?? 0}, requested: ${input.quantity}`
        );
        (error as any).statusCode = 400;
        throw error;
      }
    }

    let movement: any;

    await prisma.$transaction(async (tx) => {
      if (input.movementType === 'DAMAGE') {
        await tx.warehouseStock.update({
          where: stockWhere,
          data: {
            quantity: { decrement: input.quantity },
            damagedQty: { increment: input.quantity },
          },
        });
        await tx.productVariant.update({
          where: { id: input.variantId },
          data: {
            stock: { decrement: input.quantity },
            damagedQty: { increment: input.quantity },
          },
        });

      } else if (input.movementType === 'ADJUSTMENT') {
        await tx.warehouseStock.update({
          where: stockWhere,
          data: { quantity: { decrement: input.quantity } },
        });
        await tx.productVariant.update({
          where: { id: input.variantId },
          data: { stock: { decrement: input.quantity } },
        });

      } else if (input.movementType === 'RETURN') {
        // RETURN may create a brand-new bin record (e.g. first-time restock into that slot).
        await tx.warehouseStock.upsert({
          where: stockWhere,
          update: { quantity: { increment: input.quantity } },
          create: {
            variantId: input.variantId,
            warehouseId: input.warehouseId,
            rackId: input.rackId ?? null,
            rowNumber: input.rowNumber ?? null,
            shelfNumber: input.shelfNumber ?? null,
            quantity: input.quantity,
            reservedQty: 0,
            damagedQty: 0,
          },
        });
        await tx.productVariant.update({
          where: { id: input.variantId },
          data: { stock: { increment: input.quantity } },
        });
      }

      movement = await tx.stockMovement.create({
        data: {
          variantId: input.variantId,
          fromWarehouseId:
            input.movementType !== 'RETURN' ? input.warehouseId : undefined,
          toWarehouseId:
            input.movementType === 'RETURN' ? input.warehouseId : undefined,
          movementType: input.movementType,
          quantity: input.quantity,
          reason: input.reason,
          notes: input.notes,
          createdBy: input.createdBy || 'system',
        },
      });
    });

    return movement;
  }

  // ─────────────────────────────────────────────────────────────────
  // STOCK — WAREHOUSE TRANSFER
  // ─────────────────────────────────────────────────────────────────

  async transferStock(input: StockTransferInput) {
    if (input.fromWarehouseId === input.toWarehouseId) {
      const error = new Error('Source and destination warehouses must be different');
      (error as any).statusCode = 400;
      throw error;
    }
    // Both ends must belong to the same vendor; the destination must be active.
    const [fromWh, toWh] = await Promise.all([
      prisma.vendorWarehouse.findUnique({ where: { id: input.fromWarehouseId }, select: { vendorId: true } }),
      prisma.vendorWarehouse.findUnique({ where: { id: input.toWarehouseId }, select: { vendorId: true, isActive: true } }),
    ]);
    if (!fromWh || !toWh) throw new AppError('Warehouse not found', 404);
    if (fromWh.vendorId !== toWh.vendorId) {
      throw new AppError('Stock can only be transferred between warehouses of the same vendor', 403);
    }
    if (!toWh.isActive) throw new AppError('Destination warehouse is deactivated', 409);

    await this.validateStockLocation(
      input.fromWarehouseId,
      input.fromRackId,
      input.fromRowNumber,
      input.fromShelfNumber,
    );
    await this.validateStockLocation(
      input.toWarehouseId,
      input.toRackId,
      input.toRowNumber,
      input.toShelfNumber,
    );

    const fromWhere = this.stockUniqueWhere(
      input.variantId,
      input.fromWarehouseId,
      input.fromRackId,
      input.fromRowNumber,
      input.fromShelfNumber,
    );
    const toWhere = this.stockUniqueWhere(
      input.variantId,
      input.toWarehouseId,
      input.toRackId,
      input.toRowNumber,
      input.toShelfNumber,
    );

    const fromStock = await prisma.warehouseStock.findUnique({ where: fromWhere });

    if (!fromStock || fromStock.quantity < input.quantity) {
      const error = new Error(
        `Insufficient stock in source bin. Available: ${fromStock?.quantity ?? 0}`
      );
      (error as any).statusCode = 400;
      throw error;
    }

    let movement: any;

    await prisma.$transaction(async (tx) => {
      // Deduct from source bin
      await tx.warehouseStock.update({
        where: fromWhere,
        data: { quantity: { decrement: input.quantity } },
      });

      // Add to destination bin (upsert — destination bin may not exist yet)
      await tx.warehouseStock.upsert({
        where: toWhere,
        update: { quantity: { increment: input.quantity } },
        create: {
          variantId: input.variantId,
          warehouseId: input.toWarehouseId,
          rackId: input.toRackId ?? null,
          rowNumber: input.toRowNumber ?? null,
          shelfNumber: input.toShelfNumber ?? null,
          quantity: input.quantity,
          reservedQty: 0,
          damagedQty: 0,
        },
      });

      // Total variant stock unchanged — only warehouse/bin distribution changes
      movement = await tx.stockMovement.create({
        data: {
          variantId: input.variantId,
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
          movementType: 'TRANSFER',
          quantity: input.quantity,
          reason: input.reason,
          notes: input.notes,
          saleAmount: input.saleAmount,
          coaAccountId: input.coaAccountId,
          createdBy: input.createdBy || 'system',
        },
      });
    });

    return movement;
  }

  // ─────────────────────────────────────────────────────────────────
  // STOCK — SELL DAMAGED STOCK
  // ─────────────────────────────────────────────────────────────────

  async sellDamagedStock(input: StockTransferInput) {
    const fromWhere = this.stockUniqueWhere(
      input.variantId,
      input.fromWarehouseId,
      input.fromRackId,
      input.fromRowNumber,
      input.fromShelfNumber,
    );

    const warehouseStock = await prisma.warehouseStock.findUnique({ where: fromWhere });

    if (!warehouseStock || warehouseStock.damagedQty < input.quantity) {
      const error = new Error(
        `Insufficient damaged stock. Available damaged: ${warehouseStock?.damagedQty ?? 0}`
      );
      (error as any).statusCode = 400;
      throw error;
    }

    let movement: any;

    await prisma.$transaction(async (tx) => {
      await tx.warehouseStock.update({
        where: fromWhere,
        data: { damagedQty: { decrement: input.quantity } },
      });

      await tx.productVariant.update({
        where: { id: input.variantId },
        data: { damagedQty: { decrement: input.quantity } },
      });

      movement = await tx.stockMovement.create({
        data: {
          variantId: input.variantId,
          fromWarehouseId: input.fromWarehouseId,
          movementType: 'SELL_DAMAGE',
          quantity: input.quantity,
          reason: input.reason,
          notes: input.notes,
          saleAmount: input.saleAmount,
          coaAccountId: input.coaAccountId,
          createdBy: input.createdBy || 'system',
        },
      });
    });

    return movement;
  }

  // ─────────────────────────────────────────────────────────────────
  // STOCK — QUERY
  // ─────────────────────────────────────────────────────────────────

  async getWarehouseStock(filters: WarehouseStockFilter) {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.WarehouseStockWhereInput = {};
    if (filters.warehouseId) where.warehouseId = filters.warehouseId;
    if (filters.vendorId) where.warehouse = { vendorId: filters.vendorId };
    if (filters.variantId) where.variantId = filters.variantId;
    if (filters.rackId) where.rackId = filters.rackId;
    if (filters.rowNumber !== undefined) where.rowNumber = filters.rowNumber;
    if (filters.shelfNumber !== undefined) where.shelfNumber = filters.shelfNumber;
    if (filters.outOfStockOnly) where.quantity = 0;

    const [rows, total] = await Promise.all([
      prisma.warehouseStock.findMany({
        where,
        include: {
          warehouse: {
            select: { id: true, name: true, code: true, type: true, location: true },
          },
          rack: {
            select: { id: true, code: true, label: true, totalRows: true, totalShelves: true },
          },
          variant: {
            include: {
              product: { select: { id: true, name: true, slug: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.warehouseStock.count({ where }),
    ]);

    const filtered = filters.lowStockOnly
      ? rows.filter(r => r.quantity <= ((r.variant as any).reorderLevel ?? 10))
      : rows;

    return {
      data: filtered,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async getStockMovements(filters: {
    variantId?: string;
    warehouseId?: string;
    /** Vendor scope: only movements touching this vendor's warehouses. */
    vendorId?: string;
    movementType?: StockMovementType;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.StockMovementWhereInput = {};
    if (filters.variantId) where.variantId = filters.variantId;
    if (filters.movementType) where.movementType = filters.movementType;
    if (filters.warehouseId) {
      where.OR = [
        { fromWarehouseId: filters.warehouseId },
        { toWarehouseId: filters.warehouseId },
      ];
    }
    if (filters.vendorId) {
      where.AND = [
        { OR: [{ fromWarehouse: { vendorId: filters.vendorId } }, { toWarehouse: { vendorId: filters.vendorId } }] },
      ];
    }
    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = filters.startDate;
      if (filters.endDate) where.createdAt.lte = filters.endDate;
    }

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        include: {
          variant: {
            include: {
              product: { select: { id: true, name: true } },
            },
          },
          fromWarehouse: { select: { id: true, name: true, code: true } },
          toWarehouse: { select: { id: true, name: true, code: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.stockMovement.count({ where }),
    ]);

    return {
      data: movements,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }
}