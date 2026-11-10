// modules/shared/stock-mutations.ts
import { Prisma } from "@prisma/client";

export type StockDeltaParams = {
  variantId: string;
  warehouseId: string;
  rackId?: string | null;
  rowNumber?: number | null;
  shelfNumber?: number | null;
  quantityDelta?: number;
  damagedDelta?: number;
  reservedDelta?: number;
  reason?: string;
};

export async function applyStockDelta(tx: Prisma.TransactionClient, params: StockDeltaParams) {
  const {
    variantId, warehouseId,
    rackId = null, rowNumber = null, shelfNumber = null,
    quantityDelta = 0, damagedDelta = 0, reservedDelta = 0,
    reason = "stock mutation",
  } = params;

  const existing = await tx.warehouseStock.findFirst({
    where: { variantId, warehouseId, rackId, rowNumber, shelfNumber },
  });

  if (existing) {
    if (existing.quantity + quantityDelta < 0)
      throw new Error(`${reason}: insufficient sellable stock (have ${existing.quantity}, need ${-quantityDelta}).`);
    if (existing.damagedQty + damagedDelta < 0)
      throw new Error(`${reason}: damagedQty would go negative.`);
    if (existing.reservedQty + reservedDelta < 0)
      throw new Error(`${reason}: reservedQty would go negative.`);

    // reserve বাড়ানোর সময় available check — overselling ঠেকায়
    if (reservedDelta > 0) {
      const available = existing.quantity - existing.reservedQty - existing.damagedQty;
      if (available < reservedDelta)
        throw new Error(`${reason}: cannot reserve ${reservedDelta}, only ${available} available.`);
    }

    await tx.warehouseStock.update({
      where: { id: existing.id },
      data: {
        quantity: { increment: quantityDelta },
        damagedQty: { increment: damagedDelta },
        reservedQty: { increment: reservedDelta },
      },
    });
  } else {
    if (quantityDelta < 0 || damagedDelta < 0 || reservedDelta < 0)
      throw new Error(`${reason}: no stock row exists at this location to deduct from.`);
    await tx.warehouseStock.create({
      data: {
        variantId, warehouseId, rackId, rowNumber, shelfNumber,
        quantity: quantityDelta, damagedQty: damagedDelta, reservedQty: reservedDelta,
      },
    });
  }

  await tx.productVariant.update({
    where: { id: variantId },
    data: {
      stock: { increment: quantityDelta },
      damagedQty: { increment: damagedDelta },
      reservedQty: { increment: reservedDelta },
    },
  });
}

/**
 * A serialization conflict (SQLSTATE 40001): P2034 from model queries, P2010
 * from raw ones. Only the database's own error code is trusted — never the
 * message text — so no other raw-query failure is ever retried.
 */
export function isSerializationConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === "P2034") return true;
  const meta = err.meta as { code?: unknown } | undefined;
  return err.code === "P2010" && meta?.code === "40001";
}

export async function runStockMutation<T>(
  prisma: any,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const MAX_RETRIES = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10000,
        timeout: 30000,   // 15000 থেকে বাড়ানো — item-heavy purchase receive-এর জন্য বাফার
      });
    } catch (err) {
      lastError = err;
      if (isSerializationConflict(err) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 100 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Stock mutation failed after retries");
}