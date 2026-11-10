import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type {
  StockListQuery,
  StockAdjustDTO,
  StockDamageDTO,
  StockTransferDTO,
  StockSellDamageDTO,
  WarehouseLocationInput,
} from '../types/stock-inventory.types.ts';
import { deriveStockStatus, aggregateWarehouseStock } from '../types/stock-inventory.types.ts';
import { AccountingService } from './accounting.services.ts';
import { applyStockDelta, runStockMutation } from "../modules/shared/stock-mutations.ts";
import { assertWarehouseUsable } from "../modules/shared/warehouse-guard.ts";
const prisma = new PrismaClient();
const accountingService = new AccountingService();

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA NOTES
//   model WarehouseStock {
//     id          String   @id @default(cuid())
//     variantId   String
//     warehouseId String
//     rackId      String?
//     rowNumber   Int?
//     shelfNumber Int?
//     quantity    Int      @default(0)
//     reservedQty Int      @default(0)
//     damagedQty  Int      @default(0)
//     createdAt   DateTime @default(now())
//     updatedAt   DateTime @updatedAt
//     rack        WarehouseRack? @relation(fields: [rackId], references: [id])
//     @@unique([variantId, warehouseId, rackId, rowNumber, shelfNumber])
//   }
//
//   model StockMovement {
//     id              String   @id @default(cuid())
//     variantId       String
//     fromWarehouseId String?
//     toWarehouseId   String?
//     rackId          String?
//     toRackId        String?
//     movementType    StockMovementType
//     quantity        Int
//     reason          String?
//     notes           String?
//     saleAmount      Float?
//     coaAccountId    String?
//     voucherId       String?
//     referenceId     String?
//     createdBy       String?
//     createdAt       DateTime  @default(now())
//   }
//
// NOTE: avgCost and price are `Decimal` columns (Prisma Decimal / decimal.js
// instances), NOT plain numbers or Floats. They serialize to JSON as
// STRINGS via their .toJSON() method, not numbers — any response field
// typed as `number` on the frontend must go through `.toNumber()` here
// before being returned.
// ─────────────────────────────────────────────────────────────────────────────

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
type WarehouseStockRow = Awaited<ReturnType<TxClient['warehouseStock']['findMany']>>[number];
type StockField = 'quantity' | 'damagedQty';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — shelf-aware stock resolution
// ─────────────────────────────────────────────────────────────────────────────

function normalizeLocation(loc?: WarehouseLocationInput) {
  return {
    rackId: loc?.rackId ?? null,
    rowNumber: loc?.rowNumber ?? null,
    shelfNumber: loc?.shelfNumber ?? null,
  };
}

function hasExactLocation(loc?: WarehouseLocationInput): boolean {
  return !!loc && (loc.rackId !== undefined || loc.rowNumber !== undefined || loc.shelfNumber !== undefined);
}

/** Safely converts a Prisma Decimal (or plain number/null) to a JS number. */
function toNum(v: Decimal | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  return v.toNumber();
}

async function resolveOrderedRows(
  tx: TxClient,
  variantId: string,
  warehouseId: string,
): Promise<WarehouseStockRow[]> {
  const rows = await tx.warehouseStock.findMany({
    where: { variantId, warehouseId },
    orderBy: [{ rackId: 'asc' }, { rowNumber: 'asc' }, { shelfNumber: 'asc' }],
  });
  const looseIdx = rows.findIndex((r) => r.rackId === null && r.rowNumber === null && r.shelfNumber === null);
  if (looseIdx > 0) {
    const [loose] = rows.splice(looseIdx, 1);
    rows.unshift(loose);
  }
  return rows;
}

interface LocationSlice {
  rowId: string;
  rackId: string | null;
  rowNumber: number | null;
  shelfNumber: number | null;
  amount: number;
}

// ── consumeField  ──
async function consumeField(
  tx: TxClient, variantId: string, warehouseId: string, quantity: number,
  field: StockField, location?: WarehouseLocationInput,
): Promise<LocationSlice[]> {
  const label = field === 'quantity' ? 'stock' : 'damaged stock';
  const slices: LocationSlice[] = [];
  const isDamaged = field === 'damagedQty';

  if (hasExactLocation(location)) {
    const loc = normalizeLocation(location);
    const row = await tx.warehouseStock.findFirst({
      where: { variantId, warehouseId, rackId: loc.rackId, rowNumber: loc.rowNumber, shelfNumber: loc.shelfNumber },
    });
    const available = row?.[field] ?? 0;
    if (!row || available < quantity) {
      throw new Error(`Insufficient ${label} at the specified shelf — available: ${available}, requested: ${quantity}`);
    }
    await applyStockDelta(tx, {
      variantId, warehouseId, rackId: loc.rackId, rowNumber: loc.rowNumber, shelfNumber: loc.shelfNumber,
      quantityDelta: isDamaged ? 0 : -quantity,
      damagedDelta: isDamaged ? -quantity : 0,
      reason: `Consume ${label}`,
    });
    slices.push({ rowId: row.id, rackId: row.rackId, rowNumber: row.rowNumber, shelfNumber: row.shelfNumber, amount: quantity });
    return slices;
  }

  const rows = await resolveOrderedRows(tx, variantId, warehouseId);
  const totalAvailable = rows.reduce((s, r) => s + r[field], 0);
  if (totalAvailable < quantity) {
    throw new Error(`Insufficient ${label} in this warehouse — available: ${totalAvailable}, requested: ${quantity}`);
  }

  let remaining = quantity;
  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, row[field]);
    if (take <= 0) continue;
    await applyStockDelta(tx, {
      variantId, warehouseId, rackId: row.rackId, rowNumber: row.rowNumber, shelfNumber: row.shelfNumber,
      quantityDelta: isDamaged ? 0 : -take,
      damagedDelta: isDamaged ? -take : 0,
      reason: `Consume ${label}`,
    });
    slices.push({ rowId: row.id, rackId: row.rackId, rowNumber: row.rowNumber, shelfNumber: row.shelfNumber, amount: take });
    remaining -= take;
  }
  return slices;
}

// ── moveGoodToDamaged ──
async function moveGoodToDamaged(
  tx: TxClient, variantId: string, warehouseId: string, quantity: number, location?: WarehouseLocationInput,
): Promise<LocationSlice[]> {
  const slices: LocationSlice[] = [];

  if (hasExactLocation(location)) {
    const loc = normalizeLocation(location);
    const row = await tx.warehouseStock.findFirst({
      where: { variantId, warehouseId, rackId: loc.rackId, rowNumber: loc.rowNumber, shelfNumber: loc.shelfNumber },
    });
    const undamaged = (row?.quantity ?? 0) - (row?.damagedQty ?? 0);
    if (!row || undamaged < quantity) {
      throw new Error(`Cannot mark ${quantity} as damaged — only ${Math.max(0, undamaged)} undamaged units available`);
    }
    await applyStockDelta(tx, {
      variantId, warehouseId, rackId: loc.rackId, rowNumber: loc.rowNumber, shelfNumber: loc.shelfNumber,
      quantityDelta: -quantity, damagedDelta: quantity, reason: "Mark damaged",
    });
    slices.push({ rowId: row.id, rackId: row.rackId, rowNumber: row.rowNumber, shelfNumber: row.shelfNumber, amount: quantity });
    return slices;
  }

  const rows = await resolveOrderedRows(tx, variantId, warehouseId);
  const totalUndamaged = rows.reduce((s, r) => s + (r.quantity - r.damagedQty), 0);
  if (totalUndamaged < quantity) {
    throw new Error(`Cannot mark ${quantity} as damaged — only ${totalUndamaged} undamaged units available`);
  }

  let remaining = quantity;
  for (const row of rows) {
    if (remaining <= 0) break;
    const undamaged = row.quantity - row.damagedQty;
    const take = Math.min(remaining, undamaged);
    if (take <= 0) continue;
    await applyStockDelta(tx, {
      variantId, warehouseId, rackId: row.rackId, rowNumber: row.rowNumber, shelfNumber: row.shelfNumber,
      quantityDelta: -take, damagedDelta: take, reason: "Mark damaged",
    });
    slices.push({ rowId: row.id, rackId: row.rackId, rowNumber: row.rowNumber, shelfNumber: row.shelfNumber, amount: take });
    remaining -= take;
  }
  return slices;
}

// ── addStock  ──
async function addStock(
  tx: TxClient, variantId: string, warehouseId: string, quantity: number, location?: WarehouseLocationInput,
): Promise<LocationSlice> {
  const loc = normalizeLocation(location);
  await applyStockDelta(tx, {
    variantId, warehouseId, rackId: loc.rackId, rowNumber: loc.rowNumber, shelfNumber: loc.shelfNumber,
    quantityDelta: quantity, reason: "Add stock (transfer destination)",
  });
  const row = await tx.warehouseStock.findFirstOrThrow({
    where: { variantId, warehouseId, rackId: loc.rackId, rowNumber: loc.rowNumber, shelfNumber: loc.shelfNumber },
  });
  return { rowId: row.id, rackId: row.rackId, rowNumber: row.rowNumber, shelfNumber: row.shelfNumber, amount: quantity };
}

function groupByWarehouse(
  rows: (WarehouseStockRow & { warehouse: { id: string; name: string | null; code?: string | null } } & { rack?: { id: string; code: string | null; label: string | null } | null })[],
) {
  const byWarehouse = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byWarehouse.get(r.warehouseId) ?? [];
    list.push(r);
    byWarehouse.set(r.warehouseId, list);
  }
  return [...byWarehouse.entries()].map(([warehouseId, list]) => {
    const totals = aggregateWarehouseStock(list);
    return {
      warehouseId,
      warehouseName: list[0].warehouse.name ?? warehouseId,
      warehouseCode: list[0].warehouse.code ?? null,
      ...totals,
      locations: list.map((r) => ({
        rackId: r.rackId,
        rackCode: r.rack?.code ?? null,
        rackLabel: r.rack?.label ?? null,
        rowNumber: r.rowNumber,
        shelfNumber: r.shelfNumber,
        quantity: r.quantity,
        reservedQty: r.reservedQty,
        damagedQty: r.damagedQty,
      })),
    };
  });
}

// The include shape shared by both pagination paths below.
const stockListInclude = {
  product: {
    select: {
      id: true,
      name: true,
      categoryId: true,
      category: { select: { id: true, name: true } },
      images: { take: 1, orderBy: { sortOrder: 'asc' as const }, select: { url: true } },
    },
  },
  warehouseStock: {
    include: {
      warehouse: { select: { id: true, name: true, code: true } },
      rack: { select: { id: true, code: true, label: true } },
    },
  },
} as const;

type StockListVariant = Awaited<ReturnType<typeof prisma.productVariant.findMany<{ include: typeof stockListInclude }>>>[number];

/**
 * Narrows a variant's warehouseStock rows down to only those matching the
 * warehouse/rack/row/shelf filters, for DISPLAY purposes (the
 * "Warehouses" column / warehouseBreakdown). Status/totals are always
 * computed from the variant's FULL (unfiltered) stock — filtering here
 * only changes what's shown in the breakdown, not the overall status.
 */
function pickRelevantRows(v: StockListVariant, query: StockListQuery) {
  const hasLocationFilter =
    !!query.warehouseId || !!query.rackId || query.rowNumber !== undefined || query.shelfNumber !== undefined;
  if (!hasLocationFilter) return v.warehouseStock;

  return v.warehouseStock.filter(
    (ws) =>
      (!query.warehouseId || ws.warehouseId === query.warehouseId) &&
      (!query.rackId || ws.rackId === query.rackId) &&
      (query.rowNumber === undefined || ws.rowNumber === query.rowNumber) &&
      (query.shelfNumber === undefined || ws.shelfNumber === query.shelfNumber),
  );
}

function buildRow(v: StockListVariant, query: StockListQuery) {
  const totals = aggregateWarehouseStock(v.warehouseStock);
  const status = deriveStockStatus(totals.quantity, totals.damagedQty, totals.reservedQty, v.reorderLevel ?? 10);

  return {
    variantId: v.id,
    sku: v.sku,
    productId: v.productId,
    productName: v.product.name,
    variantName: v.name,
    category: v.product.category?.name ?? null,
    image: v.product.images[0]?.url ?? null,
    avgCost: toNum(v.avgCost),
    price: toNum(v.price),
    reorderLevel: v.reorderLevel ?? 10,
    totalStock: totals.quantity,
    damagedQty: totals.damagedQty,
    reservedQty: totals.reservedQty,
    availableStock: totals.available,
    status,
    warehouseBreakdown: groupByWarehouse(pickRelevantRows(v, query)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STOCK INVENTORY LIST
// ─────────────────────────────────────────────────────────────────────────────
//
// FIX (pagination correctness): the previous version ran `skip`/`take` at
// the DB level FIRST, then filtered the resulting page by `status` and
// `warehouseId` in JS afterward. That meant:
//   - `pagination.total`/`pages` reflected the UNFILTERED variant count,
//     not the actually-matching count, so page numbers didn't line up
//     with what the user could scroll through.
//   - A given page could come back with fewer than `limit` rows (or even
//     zero), because the filter ran on an already-sliced 10-row window —
//     users had to click through several pages to find matching data.
//
// Fix strategy:
//   - warehouseId / rackId / rowNumber / shelfNumber are now applied as a
//     real Prisma `where` (via the WarehouseStock relation), so the DB
//     itself only counts/paginates over variants that actually have stock
//     at the requested location. This keeps the fast single-query path.
//   - `status` is a DERIVED value (computed from aggregated stock, not a
//     DB column) and can't go into a `where` clause. When a status filter
//     is given, we resolve it in two passes: first fetch every matching
//     variant with just enough data to compute status, filter and get the
//     TRUE total/order, then fetch full display data only for the
//     requested page's ids. This keeps pagination numerically correct at
//     the cost of one extra lightweight query — only when status filter
//     is actually used.
// ─────────────────────────────────────────────────────────────────────────────
export async function listStockInventory(query: StockListQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 10;

  const variantWhere: Record<string, unknown> = {};
  if (query.q) {
    variantWhere.OR = [
      { sku: { contains: query.q, mode: 'insensitive' } },
      { product: { name: { contains: query.q, mode: 'insensitive' } } },
    ];
  }
  if (query.categoryId) {
    variantWhere.product = { categoryId: query.categoryId };
  }
  // FIX: warehouse/rack/row/shelf filtering now happens at the DB level via
  // the WarehouseStock relation, instead of filtering the already-paginated
  // page afterward. A variant qualifies if it has AT LEAST ONE stock row
  // matching every given field.
  if (query.warehouseId || query.rackId || query.rowNumber !== undefined || query.shelfNumber !== undefined) {
    variantWhere.warehouseStock = {
      some: {
        ...(query.warehouseId && { warehouseId: query.warehouseId }),
        ...(query.rackId && { rackId: query.rackId }),
        ...(query.rowNumber !== undefined && { rowNumber: query.rowNumber }),
        ...(query.shelfNumber !== undefined && { shelfNumber: query.shelfNumber }),
      },
    };
  }

  // ── Path A: status filter given — two-pass resolution for correct pagination ──
  if (query.status) {
    const candidates = await prisma.productVariant.findMany({
      where: variantWhere,
      select: {
        id: true,
        reorderLevel: true,
        warehouseStock: { select: { quantity: true, reservedQty: true, damagedQty: true } },
      },
      orderBy: { id: 'asc' }, // stable order shared with the detail fetch below
    });

    const filteredIds = candidates
      .filter((v) => {
        const totals = aggregateWarehouseStock(v.warehouseStock);
        const status = deriveStockStatus(totals.quantity, totals.damagedQty, totals.reservedQty, v.reorderLevel ?? 10);
        return status === query.status;
      })
      .map((v) => v.id);

    const total = filteredIds.length;
    const pageIds = filteredIds.slice((page - 1) * limit, (page - 1) * limit + limit);

    if (pageIds.length === 0) {
      return { data: [], pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    }

    const variants = await prisma.productVariant.findMany({
      where: { id: { in: pageIds } },
      include: stockListInclude,
    });

    // `findMany({ where: { id: { in } } })` does not guarantee result order
    // matches `pageIds` — re-order explicitly so pagination stays stable.
    const byId = new Map(variants.map((v) => [v.id, v]));
    const orderedVariants = pageIds.map((id) => byId.get(id)).filter((v): v is StockListVariant => !!v);

    return {
      data: orderedVariants.map((v) => buildRow(v, query)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  // ── Path B: no status filter — single efficient DB-paginated query ──
  const skip = (page - 1) * limit;
  const [variants, total] = await Promise.all([
    prisma.productVariant.findMany({
      where: variantWhere,
      include: stockListInclude,
      skip,
      take: limit,
    }),
    prisma.productVariant.count({ where: variantWhere }),
  ]);

  return {
    data: variants.map((v) => buildRow(v, query)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE STATS
// ─────────────────────────────────────────────────────────────────────────────
export async function getStockStats() {
  const variants = await prisma.productVariant.findMany({
    select: {
      avgCost: true,
      reorderLevel: true,
      warehouseStock: { select: { quantity: true, reservedQty: true, damagedQty: true } },
    },
  });

  let totalStock = 0;
  let totalValue = 0;
  let totalDamaged = 0;
  let totalReserved = 0;
  let totalAvailable = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;
  let overstockCount = 0;

  for (const v of variants) {
    const totals = aggregateWarehouseStock(v.warehouseStock);
    const avgCost = toNum(v.avgCost);
    totalStock += totals.quantity;
    totalValue += totals.quantity * avgCost;

    totalDamaged += totals.damagedQty;
    totalReserved += totals.reservedQty;
    totalAvailable += totals.available;
    const st = deriveStockStatus(totals.quantity, totals.damagedQty, totals.reservedQty, v.reorderLevel ?? 10);
    if (st === 'low_stock') lowStockCount++;
    else if (st === 'out_stock') outOfStockCount++;
    else if (st === 'overstock') overstockCount++;
  }

  return {
    totalVariants: variants.length,
    totalStock,
    totalValue: parseFloat(totalValue.toFixed(2)),
    totalAvailable,
    totalDamaged,
    totalReserved,
    lowStockCount,
    outOfStockCount,
    overstockCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STOCK ADJUSTMENT
// ─────────────────────────────────────────────────────────────────────────────
export async function stockAdjust(dto: StockAdjustDTO, createdBy?: string) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: dto.variantId },
    select: {
      id: true,
      sku: true,
      name: true,
      avgCost: true,
      product: { select: { vendorId: true } },
    },
  });
  if (!variant) throw new Error(`Variant ${dto.variantId} not found`);
  if (!variant.product?.vendorId) throw new Error('Variant has no associated vendor');

  const movement = await runStockMutation(prisma, async (tx) => {
    const consumed = await consumeField(tx, dto.variantId, dto.warehouseId, dto.quantity, 'quantity', dto);
    const primaryRackId = consumed.find((c) => c.rackId)?.rackId ?? null;

    return tx.stockMovement.create({
      data: {
        variantId: dto.variantId,
        fromWarehouseId: dto.warehouseId,
        rackId: primaryRackId,
        movementType: 'ADJUSTMENT',
        quantity: dto.quantity,
        reason: dto.reason,
        notes: dto.notes,
        createdBy,
      },
    });
  });

  const voucher = await accountingService.createAutoVoucher('STOCK_ADJUSTMENT', {
    variantId: variant.id,
    variantName: variant.name || variant.sku,
    warehouseId: dto.warehouseId,
    quantity: dto.quantity,
    avgCost: new Decimal(variant.avgCost ?? 0),
    reason: dto.reason || 'Stock adjustment',
    vendorId: variant.product.vendorId,
    stockMovementId: movement.id,
  });

  return { movement, voucher };
}

// ─────────────────────────────────────────────────────────────────────────────
// MARK DAMAGED
// ─────────────────────────────────────────────────────────────────────────────
export async function stockDamage(dto: StockDamageDTO, createdBy?: string) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: dto.variantId },
    select: {
      id: true,
      sku: true,
      name: true,
      avgCost: true,
      product: { select: { vendorId: true } },
    },
  });
  if (!variant) throw new Error(`Variant ${dto.variantId} not found`);
  if (!variant.product?.vendorId) throw new Error('Variant has no associated vendor');

  const movement = await runStockMutation(prisma, async (tx) => {
    const moved = await moveGoodToDamaged(tx, dto.variantId, dto.warehouseId, dto.quantity, dto);
    const primaryRackId = moved.find((m) => m.rackId)?.rackId ?? null;

    return tx.stockMovement.create({
      data: {
        variantId: dto.variantId,
        fromWarehouseId: dto.warehouseId,
        rackId: primaryRackId,
        movementType: 'DAMAGE',
        quantity: dto.quantity,
        reason: dto.reason,
        notes: dto.notes,
        createdBy,
      },
    });
  });

  const voucher = await accountingService.createAutoVoucher('DAMAGE_RECORDED', {
    variantId: variant.id,
    variantName: variant.name || variant.sku,
    warehouseId: dto.warehouseId,
    quantity: dto.quantity,
    avgCost: new Decimal(variant.avgCost ?? 0),
    reason: dto.reason || 'Damage recorded',
    vendorId: variant.product.vendorId,
    stockMovementId: movement.id,
  });

  return { movement, voucher };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFER
// ─────────────────────────────────────────────────────────────────────────────
export async function stockTransfer(dto: StockTransferDTO, createdBy?: string) {
  if (dto.fromWarehouseId === dto.toWarehouseId) {
    throw new Error('Source and destination warehouse must be different');
  }
  // Destination must be active and belong to the same vendor as the source.
  const fromWarehouse = await prisma.vendorWarehouse.findUnique({
    where: { id: dto.fromWarehouseId },
    select: { vendorId: true },
  });
  if (!fromWarehouse) throw new Error('Source warehouse not found');
  await assertWarehouseUsable(dto.toWarehouseId, fromWarehouse.vendorId, prisma, 'stock transfers');

  const variant = await prisma.productVariant.findUnique({
    where: { id: dto.variantId },
    select: {
      id: true,
      sku: true,
      name: true,
      avgCost: true,
      product: { select: { vendorId: true } },
    },
  });
  if (!variant) throw new Error(`Variant ${dto.variantId} not found`);
  if (!variant.product?.vendorId) throw new Error('Variant has no associated vendor');

  const movement = await runStockMutation(prisma, async (tx) => {
    const consumed = await consumeField(tx, dto.variantId, dto.fromWarehouseId, dto.quantity, 'quantity', dto.from);
    const added = await addStock(tx, dto.variantId, dto.toWarehouseId, dto.quantity, dto.to);

    const sourceRackId = consumed.find((c) => c.rackId)?.rackId ?? null;
    const destRackId = added.rackId;

    return tx.stockMovement.create({
      data: {
        variantId: dto.variantId,
        fromWarehouseId: dto.fromWarehouseId,
        toWarehouseId: dto.toWarehouseId,
        rackId: sourceRackId,
        toRackId: destRackId,
        movementType: 'TRANSFER',
        quantity: dto.quantity,
        reason: dto.reason,
        notes: dto.notes,
        createdBy,
      },
    });
  });

  // AccountingService-এ logisticsCost > 0 না থাকলে voucher create করে না (pure stock movement)
  const voucher = await accountingService.createAutoVoucher('STOCK_TRANSFER', {
    variantId: variant.id,
    variantName: variant.name || variant.sku,
    fromWarehouseId: dto.fromWarehouseId,
    toWarehouseId: dto.toWarehouseId,
    quantity: dto.quantity,
    avgCost: new Decimal(variant.avgCost ?? 0),
    vendorId: variant.product.vendorId,
    stockMovementId: movement.id,
  });

  return { movement, voucher };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELL DAMAGED STOCK
// ─────────────────────────────────────────────────────────────────────────────
export async function sellDamageStock(dto: StockSellDamageDTO, createdBy?: string) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: dto.variantId },
    select: {
      id: true,
      sku: true,
      name: true,
      product: { select: { vendorId: true } },
    },
  });
  if (!variant) throw new Error(`Variant ${dto.variantId} not found`);
  if (!variant.product?.vendorId) throw new Error('Variant has no associated vendor');

  const movement = await runStockMutation(prisma, async (tx) => {
    const consumed = await consumeField(tx, dto.variantId, dto.warehouseId, dto.quantity, 'damagedQty', dto);
    const primaryRackId = consumed.find((c) => c.rackId)?.rackId ?? null;

    return tx.stockMovement.create({
      data: {
        variantId: dto.variantId,
        fromWarehouseId: dto.warehouseId,
        rackId: primaryRackId,
        movementType: 'SELL_DAMAGE',
        quantity: dto.quantity,
        saleAmount: dto.saleAmount,
        coaAccountId: dto.receiptCoaAccountId,
        notes: dto.notes,
        createdBy,
      },
    });
  });

  const voucher = await accountingService.createAutoVoucher('DAMAGE_STOCK_SOLD', {
    variantId: variant.id,
    variantName: variant.name || variant.sku,
    warehouseId: dto.warehouseId,
    quantity: dto.quantity,
    saleAmount: new Decimal(dto.saleAmount),
    bankCoaId: dto.receiptCoaAccountId,
    vendorId: variant.product.vendorId,
    stockMovementId: movement.id,
  });

  return { movement, voucher };
}

// ─────────────────────────────────────────────────────────────────────────────
// VARIANT STOCK DETAIL
// ─────────────────────────────────────────────────────────────────────────────
export async function getVariantStockDetail(variantId: string) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: {
      product: { select: { id: true, name: true } },
      warehouseStock: {
        include: {
          warehouse: { select: { id: true, name: true, code: true } },
          rack: { select: { id: true, code: true, label: true } },
        },
      },
    },
  });
  if (!variant) throw new Error('Variant not found');

  const totals = aggregateWarehouseStock(variant.warehouseStock);

  const movements = await prisma.stockMovement.findMany({
    where: { variantId },
    include: {
      fromWarehouse: { select: { id: true, name: true } },
      toWarehouse: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  return {
    variant: {
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      productName: variant.product.name,
      totalStock: totals.quantity,
      damagedQty: totals.damagedQty,
      reservedQty: totals.reservedQty,
      availableStock: totals.available,
      avgCost: toNum(variant.avgCost),
      reorderLevel: variant.reorderLevel,
    },
    warehouseBreakdown: groupByWarehouse(variant.warehouseStock),
    recentMovements: movements,
  };
}