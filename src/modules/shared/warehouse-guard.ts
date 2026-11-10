// Shared warehouse ownership / lifecycle guards.
//
// Vendor isolation: a non-ADMIN actor (VENDOR, or an EMPLOYEE tied to a
// vendor) may only touch warehouses whose vendorId equals its own vendorId.
// Out-of-scope warehouses are reported as "not found" (no cross-vendor
// existence leak). ADMIN keeps legitimate cross-vendor administration, but
// every flow still verifies the warehouse belongs to the vendor it is used for.
//
// Lifecycle: VendorWarehouse.isActive = false → no NEW operational use
// (stock coming in, allocation, POS, courier pickup linking). History stays.
import pkg from '@prisma/client';
const { PrismaClient } = pkg;
import { AppError } from '../../middlewares/error.middleware.ts';

const prisma = new PrismaClient();

export type WarehouseActor = {
  role?: string | null;
  vendorId?: string | null;
};

type Db = any; // PrismaClient or a transaction client

/** Actor from the authenticated request (auth.middleware sets req.user). */
export function actorFromRequest(req: any): WarehouseActor {
  const u = req?.user;
  return { role: u?.role ?? null, vendorId: u?.vendorId ?? null };
}

export function isPlatformAdmin(actor: WarehouseActor | undefined): boolean {
  return actor?.role === 'ADMIN';
}

/** A non-admin actor must carry a vendorId and may only act for that vendor. */
export function assertVendorAccess(vendorId: string, actor: WarehouseActor | undefined): void {
  if (isPlatformAdmin(actor)) return;
  if (!actor?.vendorId) throw new AppError('Vendor context required', 403);
  if (actor.vendorId !== vendorId) throw new AppError('Not allowed to access another vendor\'s warehouses', 403);
}

const WAREHOUSE_GUARD_SELECT = { id: true, vendorId: true, isActive: true, locationId: true, type: true } as const;

/** Loads a warehouse the actor is allowed to access, or throws 404. */
export async function assertWarehouseAccess(
  warehouseId: string,
  actor: WarehouseActor | undefined,
  db: Db = prisma,
) {
  if (!warehouseId) throw new AppError('Warehouse not found', 404);
  const warehouse = await db.vendorWarehouse.findUnique({ where: { id: warehouseId }, select: WAREHOUSE_GUARD_SELECT });
  if (!warehouse) throw new AppError('Warehouse not found', 404);
  if (!isPlatformAdmin(actor)) {
    if (!actor?.vendorId) throw new AppError('Vendor context required', 403);
    if (warehouse.vendorId !== actor.vendorId) throw new AppError('Warehouse not found', 404);
  }
  return warehouse;
}

/**
 * A warehouse that is about to RECEIVE new operational use (stock in,
 * allocation target, POS return, courier pickup link): must exist, be active,
 * and — when given — belong to `expectedVendorId`.
 */
export async function assertWarehouseUsable(
  warehouseId: string,
  expectedVendorId: string | null | undefined,
  db: Db = prisma,
  purpose = 'this operation',
) {
  const warehouse = await db.vendorWarehouse.findUnique({ where: { id: warehouseId }, select: WAREHOUSE_GUARD_SELECT });
  if (!warehouse) throw new AppError(`Warehouse ${warehouseId} not found`, 404);
  if (expectedVendorId && warehouse.vendorId !== expectedVendorId) {
    throw new AppError(`Warehouse ${warehouseId} does not belong to this vendor`, 403);
  }
  if (!warehouse.isActive) {
    throw new AppError(`Warehouse ${warehouseId} is deactivated and cannot be used for ${purpose}`, 409);
  }
  return warehouse;
}
