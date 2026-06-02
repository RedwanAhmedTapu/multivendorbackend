import { PrismaClient, type EntityType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type {
  StockListQuery,
  StockAdjustDTO,
  StockDamageDTO,
  StockTransferDTO,
  StockSellDamageDTO,
} from '../types/erp.types.ts';
import { deriveStockStatus } from '../types/erp.types.ts';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function requireCOA(
  tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
  entityType: EntityType,
  entityId: string | undefined,
  nameFragment: string,
): Promise<string> {
  const acct = await tx.chartOfAccount.findFirst({
    where: {
      entityType,
      entityId: entityId ?? null,
      name: { contains: nameFragment },
      isActive: true,
    },
    select: { id: true },
  });
  if (!acct) {
    throw new Error(
      `Required COA account not found: "${nameFragment}". ` +
      `Please create it in Chart of Accounts.`,
    );
  }
  return acct.id;
}

async function nextVoucherNumber(
  tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
  prefix: string,
  entityType: EntityType,
  entityId: string | undefined,
): Promise<string> {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const pfx = `${prefix}${yy}${mm}`;
  const last = await tx.voucher.findFirst({
    where: {
      voucherNumber: { startsWith: pfx },
      entityType,
      entityId: entityId ?? null,
    },
    orderBy: { voucherNumber: 'desc' },
    select: { voucherNumber: true },
  });
  const seq = last ? parseInt(last.voucherNumber.slice(-4), 10) + 1 : 1;
  return `${pfx}${String(seq).padStart(4, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STOCK INVENTORY LIST
// ─────────────────────────────────────────────────────────────────────────────
export async function listStockInventory(query: StockListQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 10;
  const skip = (page - 1) * limit;

  // Build variant-level where clause
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

  const variants = await prisma.productVariant.findMany({
    where: variantWhere,
    include: {
      product: {
        select: {
          id: true,
          name: true,
          categoryId: true,
          category: { select: { id: true, name: true } },
          images: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true } },
        },
      },
      warehouseStock: {
        include: {
          warehouse: { select: { id: true, name: true } },
        },
        ...(query.warehouseId ? { where: { warehouseId: query.warehouseId } } : {}),
      },
    },
    skip,
    take: limit,
  });

  const total = await prisma.productVariant.count({ where: variantWhere });

  // Shape each variant into the inventory row format
  let rows = variants.map((v) => {
    const status = deriveStockStatus(
      v.stock,
      v.damagedQty,
      v.reservedQty,
      v.reorderLevel ?? 10,
    );

    const warehouseBreakdown = v.warehouseStock.map((ws) => ({
      warehouseId: ws.warehouseId,
      warehouseName: ws.warehouse.name ?? ws.warehouseId,
      quantity: ws.quantity,
      reservedQty: ws.reservedQty,
      damagedQty: ws.damagedQty,
    }));

    return {
      variantId: v.id,
      sku: v.sku,
      productId: v.productId,
      productName: v.product.name,
      variantName: v.name,
      category: v.product.category?.name ?? null,
      image: v.product.images[0]?.url ?? null,
      avgCost: v.avgCost ?? 0,
      price: v.price,
      reorderLevel: v.reorderLevel ?? 10,
      totalStock: v.stock,
      damagedQty: v.damagedQty,
      reservedQty: v.reservedQty,
      availableStock: Math.max(0, v.stock - v.damagedQty - v.reservedQty),
      status,
      warehouseBreakdown,
    };
  });

  // Post-filter by status (cannot do this in Prisma easily — derived field)
  if (query.status) {
    rows = rows.filter((r) => r.status === query.status);
  }

  return {
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE STATS
// ─────────────────────────────────────────────────────────────────────────────
export async function getStockStats() {
  const variants = await prisma.productVariant.findMany({
    select: {
      stock: true,
      damagedQty: true,
      reservedQty: true,
      avgCost: true,
      reorderLevel: true,
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
    totalStock += v.stock;
    totalValue += v.stock * (v.avgCost ?? 0);
    totalDamaged += v.damagedQty;
    totalReserved += v.reservedQty;
    const avail = Math.max(0, v.stock - v.damagedQty - v.reservedQty);
    totalAvailable += avail;
    const st = deriveStockStatus(v.stock, v.damagedQty, v.reservedQty, v.reorderLevel ?? 10);
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
// STOCK ADJUSTMENT  (manual count correction — deducts stock)
// ─────────────────────────────────────────────────────────────────────────────
export async function stockAdjust(dto: StockAdjustDTO, createdBy?: string) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: dto.variantId },
    select: { id: true, sku: true, stock: true, avgCost: true },
  });
  if (!variant) throw new Error(`Variant ${dto.variantId} not found`);

  const ws = await prisma.warehouseStock.findUnique({
    where: { variantId_warehouseId: { variantId: dto.variantId, warehouseId: dto.warehouseId } },
  });
  if (!ws) throw new Error('No stock found in this warehouse for the selected variant');
  if (ws.quantity < dto.quantity) {
    throw new Error(
      `Cannot deduct ${dto.quantity} units — only ${ws.quantity} available in this warehouse`,
    );
  }

  const amt = parseFloat((dto.quantity * (variant.avgCost ?? 0)).toFixed(4));
  const voucherDate = new Date();

  const voucher = await prisma.$transaction(async (tx) => {
    await tx.warehouseStock.update({
      where: { variantId_warehouseId: { variantId: dto.variantId, warehouseId: dto.warehouseId } },
      data: { quantity: { decrement: dto.quantity } },
    });
    await tx.productVariant.update({
      where: { id: dto.variantId },
      data: { stock: { decrement: dto.quantity } },
    });

    await tx.stockMovement.create({
      data: {
        variantId: dto.variantId,
        fromWarehouseId: dto.warehouseId,
        movementType: 'ADJUSTMENT',
        quantity: dto.quantity,
        reason: dto.reason,
        notes: dto.notes,
        createdBy,
      },
    });

    const adjCoaId = await requireCOA(tx, dto.entityType, dto.entityId, '5030');
    const invCoaId = await requireCOA(tx, dto.entityType, dto.entityId, '5010');
    const vNum = await nextVoucherNumber(tx, 'ADJ', dto.entityType, dto.entityId);

    const v = await tx.voucher.create({
      data: {
        voucherNumber: vNum,
        voucherType: 'JOURNAL',
        entityType: dto.entityType,
        entityId: dto.entityId ?? null,
        voucherDate,
        narration: `Stock adjustment — SKU ${variant.sku} qty -${dto.quantity}${dto.reason ? ` (${dto.reason})` : ''}`,
        totalDebit: new Decimal(amt),
        totalCredit: new Decimal(amt),
        status: 'POSTED',
        isAuto: true,
        eventType: 'STOCK_ADJUSTMENT',
        postingDate: voucherDate,
        postedBy: createdBy ?? 'system',
        createdBy: createdBy ?? 'system',
      },
    });

    await tx.ledgerEntry.createMany({
      data: [
        {
          voucherId: v.id,
          accountId: adjCoaId,
          debitAmount: new Decimal(amt),
          creditAmount: new Decimal(0),
          entityType: dto.entityType,
          entityId: dto.entityId ?? null,
          description: `Adjustment expense — SKU ${variant.sku}`,
          entryDate: voucherDate,
        },
        {
          voucherId: v.id,
          accountId: invCoaId,
          debitAmount: new Decimal(0),
          creditAmount: new Decimal(amt),
          entityType: dto.entityType,
          entityId: dto.entityId ?? null,
          description: `Inventory reduction — SKU ${variant.sku}`,
          entryDate: voucherDate,
        },
      ],
    });

    // Link StockMovement → Voucher
    await tx.stockMovement.updateMany({
      where: { variantId: dto.variantId, movementType: 'ADJUSTMENT', voucherId: null },
      data: { voucherId: v.id },
    });

    return v;
  });

  return { voucherNumber: voucher.voucherNumber, amount: amt };
}

// ─────────────────────────────────────────────────────────────────────────────
// MARK DAMAGED
// ─────────────────────────────────────────────────────────────────────────────
export async function stockDamage(dto: StockDamageDTO, createdBy?: string) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: dto.variantId },
    select: { id: true, sku: true, stock: true, avgCost: true },
  });
  if (!variant) throw new Error(`Variant ${dto.variantId} not found`);

  const ws = await prisma.warehouseStock.findUnique({
    where: { variantId_warehouseId: { variantId: dto.variantId, warehouseId: dto.warehouseId } },
  });
  if (!ws) throw new Error('No stock found in this warehouse');
  const availableToMark = ws.quantity - ws.damagedQty;
  if (dto.quantity > availableToMark) {
    throw new Error(`Cannot mark ${dto.quantity} as damaged — only ${availableToMark} undamaged units available`);
  }

  const amt = parseFloat((dto.quantity * (variant.avgCost ?? 0)).toFixed(4));
  const voucherDate = new Date();

  const voucher = await prisma.$transaction(async (tx) => {
    // Move qty from good stock to damagedQty (total stock decreases, damagedQty increases)
    await tx.warehouseStock.update({
      where: { variantId_warehouseId: { variantId: dto.variantId, warehouseId: dto.warehouseId } },
      data: {
        quantity: { decrement: dto.quantity },
        damagedQty: { increment: dto.quantity },
      },
    });
    await tx.productVariant.update({
      where: { id: dto.variantId },
      data: {
        stock: { decrement: dto.quantity },
        damagedQty: { increment: dto.quantity },
      },
    });

    await tx.stockMovement.create({
      data: {
        variantId: dto.variantId,
        fromWarehouseId: dto.warehouseId,
        movementType: 'DAMAGE',
        quantity: dto.quantity,
        reason: dto.reason,
        notes: dto.notes,
        createdBy,
      },
    });

    const dmgCoaId = await requireCOA(tx, dto.entityType, dto.entityId, '5020');
    const invCoaId = await requireCOA(tx, dto.entityType, dto.entityId, '5010');
    const vNum = await nextVoucherNumber(tx, 'DMG', dto.entityType, dto.entityId);

    const v = await tx.voucher.create({
      data: {
        voucherNumber: vNum,
        voucherType: 'JOURNAL',
        entityType: dto.entityType,
        entityId: dto.entityId ?? null,
        voucherDate,
        narration: `Damage recorded — SKU ${variant.sku} qty ${dto.quantity}${dto.reason ? ` (${dto.reason})` : ''}`,
        totalDebit: new Decimal(amt),
        totalCredit: new Decimal(amt),
        status: 'POSTED',
        isAuto: true,
        eventType: 'DAMAGE_RECORDED',
        postingDate: voucherDate,
        postedBy: createdBy ?? 'system',
        createdBy: createdBy ?? 'system',
      },
    });

    await tx.ledgerEntry.createMany({
      data: [
        {
          voucherId: v.id,
          accountId: dmgCoaId,
          debitAmount: new Decimal(amt),
          creditAmount: new Decimal(0),
          entityType: dto.entityType,
          entityId: dto.entityId ?? null,
          description: `Damage expense — SKU ${variant.sku}`,
          entryDate: voucherDate,
        },
        {
          voucherId: v.id,
          accountId: invCoaId,
          debitAmount: new Decimal(0),
          creditAmount: new Decimal(amt),
          entityType: dto.entityType,
          entityId: dto.entityId ?? null,
          description: `Remove from inventory — SKU ${variant.sku}`,
          entryDate: voucherDate,
        },
      ],
    });

    return v;
  });

  return { voucherNumber: voucher.voucherNumber, amount: amt };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFER  (move between warehouses, total stock unchanged)
// ─────────────────────────────────────────────────────────────────────────────
export async function stockTransfer(dto: StockTransferDTO, createdBy?: string) {
  if (dto.fromWarehouseId === dto.toWarehouseId) {
    throw new Error('Source and destination warehouse must be different');
  }

  const variant = await prisma.productVariant.findUnique({
    where: { id: dto.variantId },
    select: { id: true, sku: true, avgCost: true },
  });
  if (!variant) throw new Error(`Variant ${dto.variantId} not found`);

  const fromWS = await prisma.warehouseStock.findUnique({
    where: { variantId_warehouseId: { variantId: dto.variantId, warehouseId: dto.fromWarehouseId } },
  });
  if (!fromWS || fromWS.quantity < dto.quantity) {
    throw new Error(
      `Insufficient stock in source warehouse — available: ${fromWS?.quantity ?? 0}, requested: ${dto.quantity}`,
    );
  }

  const amt = parseFloat((dto.quantity * (variant.avgCost ?? 0)).toFixed(4));
  const voucherDate = new Date();

  const voucher = await prisma.$transaction(async (tx) => {
    // Deduct from source
    await tx.warehouseStock.update({
      where: { variantId_warehouseId: { variantId: dto.variantId, warehouseId: dto.fromWarehouseId } },
      data: { quantity: { decrement: dto.quantity } },
    });

    // Add to destination (upsert in case no row yet)
    await tx.warehouseStock.upsert({
      where: { variantId_warehouseId: { variantId: dto.variantId, warehouseId: dto.toWarehouseId } },
      update: { quantity: { increment: dto.quantity } },
      create: {
        variantId: dto.variantId,
        warehouseId: dto.toWarehouseId,
        quantity: dto.quantity,
        reservedQty: 0,
        damagedQty: 0,
      },
    });
    // NOTE: ProductVariant.stock total stays the same — only warehouse distribution changes

    await tx.stockMovement.create({
      data: {
        variantId: dto.variantId,
        fromWarehouseId: dto.fromWarehouseId,
        toWarehouseId: dto.toWarehouseId,
        movementType: 'TRANSFER',
        quantity: dto.quantity,
        reason: dto.reason,
        notes: dto.notes,
        createdBy,
      },
    });

    const transferCoaId = await requireCOA(tx, dto.entityType, dto.entityId, '1061');
    const bankCoaId = await requireCOA(tx, dto.entityType, dto.entityId, 'Bank');
    const vNum = await nextVoucherNumber(tx, 'TRN', dto.entityType, dto.entityId);

    const v = await tx.voucher.create({
      data: {
        voucherNumber: vNum,
        voucherType: 'JOURNAL',
        entityType: dto.entityType,
        entityId: dto.entityId ?? null,
        voucherDate,
        narration: `Stock transfer — SKU ${variant.sku} qty ${dto.quantity}`,
        totalDebit: new Decimal(amt),
        totalCredit: new Decimal(amt),
        status: 'POSTED',
        isAuto: true,
        eventType: 'STOCK_TRANSFER',
        postingDate: voucherDate,
        postedBy: createdBy ?? 'system',
        createdBy: createdBy ?? 'system',
      },
    });

    await tx.ledgerEntry.createMany({
      data: [
        {
          voucherId: v.id,
          accountId: transferCoaId,
          debitAmount: new Decimal(amt),
          creditAmount: new Decimal(0),
          entityType: dto.entityType,
          entityId: dto.entityId ?? null,
          description: `Transfer expense — SKU ${variant.sku}`,
          entryDate: voucherDate,
        },
        {
          voucherId: v.id,
          accountId: bankCoaId,
          debitAmount: new Decimal(0),
          creditAmount: new Decimal(amt),
          entityType: dto.entityType,
          entityId: dto.entityId ?? null,
          description: `Payment for stock transfer`,
          entryDate: voucherDate,
        },
      ],
    });

    return v;
  });

  return { voucherNumber: voucher.voucherNumber, amount: amt };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELL DAMAGED STOCK
// ─────────────────────────────────────────────────────────────────────────────
export async function sellDamageStock(dto: StockSellDamageDTO, createdBy?: string) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: dto.variantId },
    select: { id: true, sku: true, avgCost: true },
  });
  if (!variant) throw new Error(`Variant ${dto.variantId} not found`);

  const ws = await prisma.warehouseStock.findUnique({
    where: { variantId_warehouseId: { variantId: dto.variantId, warehouseId: dto.warehouseId } },
  });
  if (!ws) throw new Error('No stock record for this variant + warehouse');
  if (ws.damagedQty < dto.quantity) {
    throw new Error(
      `Cannot sell ${dto.quantity} damaged units — only ${ws.damagedQty} damaged available`,
    );
  }

  const voucherDate = new Date();

  const voucher = await prisma.$transaction(async (tx) => {
    // Remove damaged qty from warehouse stock
    await tx.warehouseStock.update({
      where: { variantId_warehouseId: { variantId: dto.variantId, warehouseId: dto.warehouseId } },
      data: { damagedQty: { decrement: dto.quantity } },
    });
    await tx.productVariant.update({
      where: { id: dto.variantId },
      data: { damagedQty: { decrement: dto.quantity } },
    });

    await tx.stockMovement.create({
      data: {
        variantId: dto.variantId,
        fromWarehouseId: dto.warehouseId,
        movementType: 'SELL_DAMAGE',
        quantity: dto.quantity,
        saleAmount: dto.saleAmount,
        coaAccountId: dto.receiptCoaAccountId,
        notes: dto.notes,
        createdBy,
      },
    });

    const incomeCoaId = await requireCOA(tx, dto.entityType, dto.entityId, '1034');
    const vNum = await nextVoucherNumber(tx, 'SLD', dto.entityType, dto.entityId);

    const v = await tx.voucher.create({
      data: {
        voucherNumber: vNum,
        voucherType: 'JOURNAL',
        entityType: dto.entityType,
        entityId: dto.entityId ?? null,
        voucherDate,
        narration: `Damaged stock sold — SKU ${variant.sku} qty ${dto.quantity}`,
        totalDebit: new Decimal(dto.saleAmount),
        totalCredit: new Decimal(dto.saleAmount),
        status: 'POSTED',
        isAuto: true,
        eventType: 'DAMAGE_STOCK_SOLD',
        postingDate: voucherDate,
        postedBy: createdBy ?? 'system',
        createdBy: createdBy ?? 'system',
      },
    });

    await tx.ledgerEntry.createMany({
      data: [
        {
          voucherId: v.id,
          accountId: dto.receiptCoaAccountId,
          debitAmount: new Decimal(dto.saleAmount),
          creditAmount: new Decimal(0),
          entityType: dto.entityType,
          entityId: dto.entityId ?? null,
          description: `Receipt from damaged stock sale — SKU ${variant.sku}`,
          entryDate: voucherDate,
        },
        {
          voucherId: v.id,
          accountId: incomeCoaId,
          debitAmount: new Decimal(0),
          creditAmount: new Decimal(dto.saleAmount),
          entityType: dto.entityType,
          entityId: dto.entityId ?? null,
          description: `Damage stock sale income — SKU ${variant.sku}`,
          entryDate: voucherDate,
        },
      ],
    });

    return v;
  });

  return { voucherNumber: voucher.voucherNumber, saleAmount: dto.saleAmount };
}

// ─────────────────────────────────────────────────────────────────────────────
// VARIANT STOCK DETAIL (per warehouse breakdown for one variant)
// ─────────────────────────────────────────────────────────────────────────────
export async function getVariantStockDetail(variantId: string) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: {
      product: { select: { id: true, name: true } },
      warehouseStock: {
        include: { warehouse: { select: { id: true, name: true, code: true } } },
      },
    },
  });
  if (!variant) throw new Error('Variant not found');

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
      totalStock: variant.stock,
      damagedQty: variant.damagedQty,
      reservedQty: variant.reservedQty,
      availableStock: Math.max(0, variant.stock - variant.damagedQty - variant.reservedQty),
      avgCost: variant.avgCost,
      reorderLevel: variant.reorderLevel,
    },
    warehouseBreakdown: variant.warehouseStock.map((ws) => ({
      warehouseId: ws.warehouseId,
      warehouseName: ws.warehouse.name ?? ws.warehouseId,
      quantity: ws.quantity,
      reservedQty: ws.reservedQty,
      damagedQty: ws.damagedQty,
      available: Math.max(0, ws.quantity - ws.reservedQty - ws.damagedQty),
    })),
    recentMovements: movements,
  };
}