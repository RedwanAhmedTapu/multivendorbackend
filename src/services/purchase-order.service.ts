import { type EntityType, Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prismaDirect as prisma } from "../config/prisma.ts";
import type {
  CreatePurchaseOrderDTO,
  PayPurchaseDueDTO,
  PurchaseOrderListQuery,
  ReceivePurchaseOrderDTO,
  ShortClosePurchaseOrderDTO,
  CancelPurchaseOrderDTO,
  ReturnPurchaseOrderDTO,
  RefundPurchaseOrderCreditDTO,
} from "../types/purchase.types.ts";
import { calcWeightedAvg } from "../types/purchase.types.ts";
import { AccountingService } from "./accounting.services.ts";
import { applyStockDelta, runStockMutation } from "../modules/shared/stock-mutations.ts";
import {
  assertWarehouseUsable,
  isPlatformAdmin,
  type WarehouseActor,
} from "../modules/shared/warehouse-guard.ts";

const accountingService = new AccountingService();

// ─────────────────────────────────────────────────────────────────────────────
// NOTE ON SCOPE — builds on the earlier create/receive/pay refactor. Adds the
// full lifecycle: short-close (A1/A2), cancel (B1/B2), return (C1), refund
// (D1), plus damaged-at-receiving (C2). All new mutating flows follow the
// same two-phase pattern as createPurchaseOrder: inventory/DB changes commit
// first in a Prisma transaction, accounting voucher posting happens after
// and its failure is surfaced as an actionable error rather than rolled back.
//
// ── DECISION: NO creditBalance FIELD ────────────────────────────────────────
// Earlier drafts stored an "OVERPAID" payment status and a running
// PurchaseOrder.creditBalance field that got incremented on short-close/
// cancel/return and decremented on refund. That's been removed on purpose:
//   - PurchaseOrderPaymentStatus only has UNPAID/PARTIALLY_PAID/PAID in the
//     schema — "OVERPAID" was never a valid enum value.
//   - A stored balance is just a cache of (paidAmount - totalAmount - prior
//     refunds) that can drift out of sync. We compute it fresh every time
//     instead (see `getRefundableAmount` below), so there is nothing to
//     keep consistent and nothing extra to add to the schema for it.
// When paidAmount ends up exceeding totalAmount after a short-close/cancel/
// return, dueAmount is simply clamped to 0 and paymentStatus becomes PAID.
// The excess is not tracked as a field — it's derived on demand by
// refundPurchaseOrderCredit() (and can be surfaced read-only anywhere else
// via the same helper) directly from PurchaseRefund records that already
// exist in the schema.
//
// SCHEMA ADDITIONS THIS FILE STILL NEEDS (confirm with the team / migrate):
//   1. PurchaseOrderItem.cancelledQuantity Int @default(0)
//   2. PurchaseOrder.cancelledAt DateTime?, cancelledBy String?, cancelReason String?
//   3. PurchaseOrder.shortClosedAt DateTime?, shortClosedBy String?, shortCloseReason String?
//   4. PurchaseReturn.createdBy String?  (NOT `returnedBy` — that field name
//      does not exist on the model; use createdBy to match the rest of the
//      codebase's convention)
//   5. EventType enum: PURCHASE_SHORT_CLOSE / PURCHASE_CANCELLED /
//      PURCHASE_RETURN / PURCHASE_REFUND
//   NOTE: creditBalance is intentionally NOT in this list — it should not be
//   added to PurchaseOrder or Supplier.
//   6. Returns (C1) are valued at the PO's original per-unit cost, not the
//      variant's current avgCost — this avoids skewing avgCost with a naive
//      reversal.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export async function getNextPurchaseNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `PUR-${year}-`;
  const last = await prisma.purchaseOrder.findFirst({
    where: { purchaseNo: { startsWith: prefix } },
    orderBy: { purchaseNo: "desc" },
    select: { purchaseNo: true },
  });
  let seq = 1;
  if (last) {
    const parts = last.purchaseNo.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

export async function getNextReceiveNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `RCV-${year}-`;
  const last = await prisma.purchaseReceive.findFirst({
    where: { receiveNo: { startsWith: prefix } },
    orderBy: { receiveNo: "desc" },
    select: { receiveNo: true },
  });
  let seq = 1;
  if (last) {
    const parts = last.receiveNo.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

async function getNextReturnNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `RET-${year}-`;
  const last = await prisma.purchaseReturn.findFirst({
    where: { returnNo: { startsWith: prefix } },
    orderBy: { returnNo: "desc" },
    select: { returnNo: true },
  });
  let seq = 1;
  if (last) {
    const parts = last.returnNo.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

/**
 * Resolves a vendor-selected VendorPaymentAccount to its linked COA id.
 * Falls back to the vendor's default account of any type if no specific
 * account is given (e.g. legacy callers, or "pay from default" flows).
 * Throws if the account doesn't belong to this vendor, is inactive, or
 * has never been linked to a ledger account.
 */
async function resolveVendorPaymentAccountCoa(
  vendorId: string,
  vendorPaymentAccountId: string | undefined,
  fieldLabel = "Payment account",
): Promise<{ coaId: string; accountId: string }> {
  let account;

  if (vendorPaymentAccountId) {
    account = await prisma.vendorPaymentAccount.findFirst({
      where: { id: vendorPaymentAccountId, vendorId, isActive: true },
      select: { id: true, chartOfAccountId: true, type: true, label: true },
    });
    if (!account) {
      throw new Error(
        `${fieldLabel} "${vendorPaymentAccountId}" not found, inactive, or does not belong to this vendor.`,
      );
    }
  } else {
    account = await prisma.vendorPaymentAccount.findFirst({
      where: { vendorId, isDefault: true, isActive: true },
      select: { id: true, chartOfAccountId: true, type: true, label: true },
    });
    if (!account) {
      throw new Error(
        `${fieldLabel} was not specified and this vendor has no default payment account set.`,
      );
    }
  }

  if (!account.chartOfAccountId) {
    throw new Error(
      `${fieldLabel} "${account.label ?? account.id}" (${account.type}) has no linked ledger account — contact support.`,
    );
  }

  return { coaId: account.chartOfAccountId, accountId: account.id };
}

async function validateItemStockLocation(
  warehouseId: string,
  rackId?: string | null,
  rowNumber?: number | null,
  shelfNumber?: number | null,
): Promise<void> {
  if (!rackId) {
    if (rowNumber || shelfNumber) {
      throw new Error("rowNumber/shelfNumber require a rackId");
    }
    return;
  }
  const rack = await prisma.warehouseRack.findUnique({ where: { id: rackId } });
  if (!rack || rack.warehouseId !== warehouseId || !rack.isActive) {
    throw new Error(
      "Rack is invalid, inactive, or does not belong to this warehouse",
    );
  }
  if (rowNumber != null && (rowNumber < 1 || rowNumber > rack.totalRows)) {
    throw new Error(
      `rowNumber must be between 1 and ${rack.totalRows} for rack "${rack.code}"`,
    );
  }
  if (
    shelfNumber != null &&
    (shelfNumber < 1 || shelfNumber > rack.totalShelves)
  ) {
    throw new Error(
      `shelfNumber must be between 1 and ${rack.totalShelves} for rack "${rack.code}"`,
    );
  }
}

function effectiveUnitCost(unitCost: number, discountPercent?: number): number {
  const disc = Math.min(100, Math.max(0, discountPercent ?? 0));
  return unitCost * (1 - disc / 100);
}

/**
 * Recomputes dueAmount/paymentStatus from paidAmount vs. a (possibly
 * just-reduced) totalAmount. Shared by short-close, cancel, and return —
 * all three can shrink totalAmount below what's already been paid.
 *
 * dueAmount is clamped at 0 (never negative) and paymentStatus only ever
 * takes a value that actually exists in PurchaseOrderPaymentStatus
 * (UNPAID / PARTIALLY_PAID / PAID). If paidAmount now exceeds totalAmount,
 * that excess is NOT stored anywhere here — it's picked up later, on
 * demand, by getRefundableAmount()/refundPurchaseOrderCredit().
 */
function resolvePaymentStateAfterTotalChange(
  paidAmount: number,
  newTotalAmount: number,
) {
  const rawDue = parseFloat((newTotalAmount - paidAmount).toFixed(4));
  const dueAmount = rawDue <= 0.0001 ? 0 : rawDue;
  const paymentStatus =
    dueAmount <= 0
      ? ("PAID" as const)
      : paidAmount > 0
        ? ("PARTIALLY_PAID" as const)
        : ("UNPAID" as const);
  return { dueAmount, paymentStatus };
}

/**
 * How much of this PO's paidAmount is currently sitting above its
 * totalAmount and hasn't been refunded yet. Computed fresh every call from
 * paidAmount, totalAmount, and the sum of existing PurchaseRefund rows —
 * there is no stored balance field to keep in sync.
 */
async function getRefundableAmount(
  poId: string,
  paidAmount: number,
  totalAmount: number,
): Promise<number> {
  const overpaid = Math.max(
    0,
    parseFloat((paidAmount - totalAmount).toFixed(4)),
  );
  if (overpaid <= 0) return 0;

  const alreadyRefunded = await prisma.purchaseRefund.aggregate({
    where: { purchaseOrderId: poId },
    _sum: { amount: true },
  });
  const refundable = parseFloat(
    (overpaid - Number(alreadyRefunded._sum.amount ?? 0)).toFixed(4),
  );
  return refundable <= 0.0001 ? 0 : refundable;
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE PURCHASE ORDER (unchanged from the previous refactor)
// ─────────────────────────────────────────────────────────────────────────────
export async function createPurchaseOrder(
  dto: CreatePurchaseOrderDTO,
  createdBy?: string,
) {
  if (!dto.items.length)
    throw new Error("Purchase order must have at least one item");

  if (dto.entityType !== "VENDOR" || !dto.entityId) {
    throw new Error(
      "Purchase orders currently require entityType=VENDOR with a vendorId " +
        "(AccountingService.createPurchaseVoucher/createPurchasePaymentVoucher are VENDOR-scoped).",
    );
  }

  for (const item of dto.items) {
    if (item.quantity <= 0)
      throw new Error(`Item ${item.sku}: quantity must be > 0`);
    if (item.unitCost <= 0)
      throw new Error(`Item ${item.sku}: unit cost must be > 0`);
    if (
      item.discountPercent != null &&
      (item.discountPercent < 0 || item.discountPercent > 100)
    )
      throw new Error(
        `Item ${item.sku}: discountPercent must be between 0 and 100`,
      );
    if (item.mrpPrice != null && item.sellPrice > item.mrpPrice) {
      throw new Error(
        `Item ${item.sku}: sellPrice (${item.sellPrice}) cannot exceed mrpPrice (${item.mrpPrice})`,
      );
    }
  }

  const purchaseNo = await getNextPurchaseNumber();
  const vatRate = dto.vatRate ?? 0;
  const subtotal = dto.items.reduce(
    (s, i) => s + i.quantity * effectiveUnitCost(i.unitCost, i.discountPercent),
    0,
  );
  const vatAmount = parseFloat((subtotal * vatRate).toFixed(4));
  const totalAmount = parseFloat((subtotal + vatAmount).toFixed(4));
  const paidAmount = Math.min(dto.paidAmount ?? 0, totalAmount);
  const dueAmount = parseFloat((totalAmount - paidAmount).toFixed(4));
  const purchaseDate = new Date(dto.purchaseDate);
  const paymentStatus =
    dueAmount <= 0 ? "PAID" : paidAmount > 0 ? "PARTIALLY_PAID" : "UNPAID";

  const supplier = await prisma.supplier.findUnique({
    where: { id: dto.supplierId },
    select: { id: true, name: true },
  });
  if (!supplier) throw new Error(`Supplier ${dto.supplierId} not found`);

  if (dto.warehouseId) {
    // The destination warehouse must belong to the PO's vendor and be active.
    await assertWarehouseUsable(dto.warehouseId, dto.entityId, prisma, "purchase orders");
  }

  let bankCoaId: string | null = null;
  let resolvedPaymentAccountId: string | null = null;
  if (paidAmount > 0) {
    const resolved = await resolveVendorPaymentAccountCoa(
      dto.entityId,
      dto.vendorPaymentAccountId,
    );
    bankCoaId = resolved.coaId;
    resolvedPaymentAccountId = resolved.accountId;
  }

 const po = await prisma.$transaction(async (tx) => {
  const created = await tx.purchaseOrder.create({
    data: {
      purchaseNo,
      supplierId: dto.supplierId,
      warehouseId: dto.warehouseId ?? null,
      supplierInvoiceNo: dto.supplierInvoiceNo,
      purchaseDate,
      receivingStatus: "CONFIRMED",
      paymentStatus,
      subtotal,
      vatAmount,
      totalAmount,
      paidAmount,
      dueAmount,
      notes: dto.notes,
    },
  });

  // ── আগে: প্রতি item-এ আলাদা findUnique (৫০ round-trip) ──
  // ── এখন: একবারে সব variant fetch (১ round-trip) ──
  const variantIds = dto.items.map((i) => i.variantId);
  const variants = await tx.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: {
      id: true,
      avgCost: true,
      warehouseStock: { select: { quantity: true } },
    },
  });
  const variantMap = new Map(variants.map((v) => [v.id, v]));

  // Missing variant থাকলে batch-create করার আগেই ধরে ফেলুন
  for (const item of dto.items) {
    if (!variantMap.has(item.variantId)) {
      throw new Error(`Variant ${item.variantId} (SKU: ${item.sku}) not found`);
    }
  }

  // ── আগে: প্রতি item-এ আলাদা create (৫০ round-trip) ──
  // ── এখন: একবারে সব insert (১ round-trip) ──
  await tx.purchaseOrderItem.createMany({
    data: dto.items.map((item) => {
      const variant = variantMap.get(item.variantId)!;
      const currentStock = variant.warehouseStock.reduce((sum, ws) => sum + ws.quantity, 0);
      const costAfterDiscount = effectiveUnitCost(item.unitCost, item.discountPercent);
      const estimatedNewAvgCost = calcWeightedAvg({
        prevStock: currentStock,
        prevAvgCost: Number(variant.avgCost) || 0,
        incomingQty: item.quantity,
        incomingCost: costAfterDiscount,
      });

      return {
        purchaseOrderId: created.id,
        variantId: item.variantId,
        productName: item.productName,
        variantName: item.variantName,
        sku: item.sku,
        quantity: item.quantity,
        unitCost: item.unitCost,
        mrpPrice: item.mrpPrice ?? null,
        total: item.quantity * costAfterDiscount,
        newAvgCost: parseFloat(estimatedNewAvgCost.toFixed(4)),
        sellPrice: item.sellPrice,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
      };
    }),
  });

  return created;
}, {
  maxWait: 10000,
  timeout: 30000,   // safety বাফার — এখন লাগবেই না প্রায়, কিন্তু ভবিষ্যতে আরও বড় PO-র জন্য রাখা ভালো
});

  let purchaseVoucher: any;
  let paymentVoucher: any = null;
  let purchasePayment: any = null;

  try {
    purchaseVoucher = await accountingService.createPurchaseVoucher({
      purchaseOrderId: po.id,
      purchaseNo,
      supplierId: dto.supplierId,
      supplierName: supplier.name,
      inventoryAmount: new Decimal(subtotal),
      vatAmount: new Decimal(vatAmount),
      totalAmount: new Decimal(totalAmount),
      warehouseId: dto.warehouseId ?? "",
      vendorId: dto.entityId,
      createdBy: createdBy as string,
    });

    if (paidAmount > 0) {
      purchasePayment = await prisma.purchasePayment.create({
        data: {
          purchaseOrderId: po.id,
          amount: paidAmount,
          method: dto.paymentMethod ?? "Bank Transfer",
          coaAccountId: bankCoaId!,
          vendorPaymentAccountId: resolvedPaymentAccountId,
          reference: dto.paymentReference,
        },
      });

      paymentVoucher = await accountingService.createPurchasePaymentVoucher({
        purchaseOrderId: po.id,
        purchaseNo,
        supplierId: dto.supplierId,
        supplierName: supplier.name,
        amount: new Decimal(paidAmount),
        bankCoaId: bankCoaId!,
        paymentMethod: dto.paymentMethod ?? "Bank Transfer",
        reference: dto.paymentReference,
        vendorId: dto.entityId,
        purchasePaymentId: purchasePayment.id,
        createdBy: createdBy as string,
      });
    }
  } catch (err) {
    throw new Error(
      `Purchase order ${purchaseNo} (id: ${po.id}) was created successfully, ` +
        `but accounting voucher posting failed: ${(err as Error).message}. ` +
        `Inventory-side data is intact; manual reconciliation or a voucher retry is required.`,
    );
  }

  const full = await prisma.purchaseOrder.findUnique({
    where: { id: po.id },
    include: {
      supplier: { select: { id: true, name: true, phone: true, email: true } },
      warehouse: { select: { id: true, name: true } },
      items: true,
      payments: true,
    },
  });

  return {
    ...full,
    vouchers: [purchaseVoucher, ...(paymentVoucher ? [paymentVoucher] : [])],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RECEIVE PURCHASE ORDER
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// RECEIVE PURCHASE ORDER — batch-optimized
// ─────────────────────────────────────────────────────────────────────────────
export async function receivePurchaseOrder(
  poId: string,
  dto: ReceivePurchaseOrderDTO,
  createdBy?: string,
  actor?: WarehouseActor,
) {
  if (!dto.items?.length)
    throw new Error("Receive must include at least one item");

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { items: true },
  });
  if (!po) throw new Error("Purchase order not found");
  if (po.receivingStatus === "CANCELLED")
    throw new Error("Cannot receive against a CANCELLED purchase order");
  if (po.receivingStatus === "FULLY_RECEIVED")
    throw new Error("Purchase order is already fully received");
  if (po.receivingStatus === "SHORT_CLOSED")
    throw new Error(
      "Purchase order is short-closed — remaining quantity was permanently written off",
    );

  const itemsById = new Map(po.items.map((i) => [i.id, i]));
  const plannedReceived = new Map<string, number>();

  // Ownership: the PO's goods belong to the vendor that owns the variants;
  // they can only be received into that vendor's own ACTIVE warehouse, and a
  // vendor-scoped actor can only receive its own vendor's PO.
  const variantVendorRows = await prisma.productVariant.findMany({
    where: { id: { in: po.items.map((i) => i.variantId) } },
    select: { id: true, product: { select: { vendorId: true } } },
  });
  const vendorByVariant = new Map(variantVendorRows.map((v) => [v.id, v.product.vendorId]));
  if (actor && !isPlatformAdmin(actor)) {
    if (!actor.vendorId || po.items.some((i) => vendorByVariant.get(i.variantId) !== actor.vendorId)) {
      throw new Error("Purchase order not found");
    }
  }

  for (const line of dto.items) {
    const poItem = itemsById.get(line.purchaseOrderItemId);
    if (!poItem)
      throw new Error(
        `Item ${line.purchaseOrderItemId} does not belong to this purchase order`,
      );
    if (line.quantity <= 0)
      throw new Error(`Receive quantity for ${poItem.sku} must be > 0`);
    const damagedQty = line.damagedQuantity ?? 0;
    if (damagedQty < 0 || damagedQty > line.quantity)
      throw new Error(
        `damagedQuantity for ${poItem.sku} must be between 0 and quantity`,
      );

    const alreadyPlanned = plannedReceived.get(poItem.id) ?? 0;
    const remaining =
      poItem.quantity -
      poItem.receivedQuantity -
      (poItem as any).cancelledQuantity -
      alreadyPlanned;
    if (line.quantity > remaining) {
      throw new Error(
        `Cannot receive ${line.quantity} of ${poItem.sku} — only ${remaining} remaining ` +
          `(ordered ${poItem.quantity}, received ${poItem.receivedQuantity}, ` +
          `written off ${(poItem as any).cancelledQuantity ?? 0})`,
      );
    }
    plannedReceived.set(poItem.id, alreadyPlanned + line.quantity);
    await assertWarehouseUsable(
      line.warehouseId,
      vendorByVariant.get(poItem.variantId),
      prisma,
      "receiving",
    );
    await validateItemStockLocation(
      line.warehouseId,
      line.rackId,
      line.rowNumber,
      line.shelfNumber,
    );
  }

  const receiveNo = await getNextReceiveNumber();

  const result = await runStockMutation(prisma, async (tx) => {
    const receive = await tx.purchaseReceive.create({
      data: {
        purchaseOrderId: poId,
        receiveNo,
        receivedBy: dto.receivedBy ?? createdBy,
        notes: dto.notes,
      },
    });

    // ── আগে: প্রতি line-এ আলাদা tx.productVariant.findUnique (N round-trip) ──
    // ── এখন: একবারে সব variant fetch (১ round-trip) ──
    const variantIds = [...new Set(dto.items.map((l) => itemsById.get(l.purchaseOrderItemId)!.variantId))];
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        avgCost: true,
        priceManuallyOverridden: true,
        warehouseStock: { select: { quantity: true } },
      },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    for (const line of dto.items) {
      const poItem = itemsById.get(line.purchaseOrderItemId)!;
      if (!variantMap.has(poItem.variantId)) {
        throw new Error(`Variant for ${poItem.sku} not found`);
      }
    }

    // ── আগে: প্রতি line-এ আলাদা tx.purchaseReceiveItem.create (N round-trip) ──
    // ── এখন: একবারে সব insert (১ round-trip) ──
    await tx.purchaseReceiveItem.createMany({
      data: dto.items.map((line) => ({
        purchaseReceiveId: receive.id,
        purchaseOrderItemId: line.purchaseOrderItemId,
        quantity: line.quantity,
        warehouseId: line.warehouseId,
        rackId: line.rackId ?? null,
        rowNumber: line.rowNumber ?? null,
        shelfNumber: line.shelfNumber ?? null,
      })),
    });

    // ── stock delta / avgCost / price update এখনো per-line, কারণ:
    //    - applyStockDelta প্রতিটা (variantId, warehouseId, rackId, row, shelf)
    //      কম্বিনেশনের জন্য আলাদা upsert করে (compound-unique row), এবং একই
    //      variant একাধিক আলাদা warehouse/rack-এ যেতে পারে একই receive-এ।
    //    - avgCost রানিং calculation — প্রতিটা লাইন প্রসেস হওয়ার পর পরবর্তী
    //      লাইনের calculation-এ প্রভাব ফেলতে পারে (একই variant একাধিক লাইনে
    //      থাকলে), তাই সিকোয়েন্সিয়াল থাকা দরকার সঠিকতার জন্যই, শুধু speed-এর
    //      জন্য batch করলে ভুল avgCost বেরিয়ে আসতে পারে।
    //    - তবে findUnique আর সরানো হয়েছে (উপরেই batch-fetch করা হয়ে গেছে),
    //      তাই প্রতি লাইনে এখন ১টা query কম (আগে ছিল ~৪টা, এখন ~৩টা)।
    const stockMovementRows: any[] = [];
    // avgCost lুপে mutate হবে বলে local copy রাখছি যাতে একই variant পরপর
    // লাইনে সঠিক running average পায়
    const runningAvgCost = new Map(variants.map((v) => [v.id, v.avgCost?.toNumber() ?? 0]));
    const runningStock = new Map(
      variants.map((v) => [
        v.id,
        v.warehouseStock.reduce((sum, ws) => sum + ws.quantity, 0),
      ]),
    );

    for (const line of dto.items) {
      const poItem = itemsById.get(line.purchaseOrderItemId)!;
      const variant = variantMap.get(poItem.variantId)!;
      const damagedQty = line.damagedQuantity ?? 0;
      const goodQty = line.quantity - damagedQty;
      const effectiveUnit = Number(poItem.total) / poItem.quantity;

      const currentTotalStock = runningStock.get(poItem.variantId)!;
      const currentAvgCost = runningAvgCost.get(poItem.variantId)!;

      const newAvgCost =
        goodQty > 0
          ? calcWeightedAvg({
              prevStock: currentTotalStock,
              prevAvgCost: currentAvgCost,
              incomingQty: goodQty,
              incomingCost: effectiveUnit,
            })
          : currentAvgCost;

      // পরবর্তী লাইনের জন্য (একই variant থাকলে) running values আপডেট
      runningAvgCost.set(poItem.variantId, newAvgCost);
      runningStock.set(poItem.variantId, currentTotalStock + goodQty);

      await applyStockDelta(tx, {
        variantId: poItem.variantId,
        warehouseId: line.warehouseId,
        rackId: line.rackId,
        rowNumber: line.rowNumber,
        shelfNumber: line.shelfNumber,
        quantityDelta: goodQty,
        damagedDelta: damagedQty,
        reason: `Purchase receive (PO ${po.purchaseNo})`,
      });

      const mrp = Number(poItem.mrpPrice) || 0;
      const sp = Number(poItem.sellPrice) || 0;
      const discountPercentCalc =
        mrp > 0 && sp > 0 && sp < mrp
          ? parseFloat((((mrp - sp) / mrp) * 100).toFixed(2))
          : 0;

      await tx.productVariant.update({
        where: { id: poItem.variantId },
        data: {
          avgCost: parseFloat(newAvgCost.toFixed(4)),
          discount: discountPercentCalc,
          ...(!variant.priceManuallyOverridden &&
            Number(poItem.mrpPrice) > 0 && {
              price: poItem.mrpPrice,
              discount: discountPercentCalc,
            }),
          ...(!variant.priceManuallyOverridden &&
            Number(poItem.sellPrice) > 0 && {
              specialPrice: poItem.sellPrice,
            }),
        },
      });

      // stockMovement.create কল না করে batch array-তে জমা করছি
      stockMovementRows.push({
        variantId: poItem.variantId,
        toWarehouseId: line.warehouseId,
        rackId: line.rackId ?? null,
        movementType: damagedQty === line.quantity ? "DAMAGE" : "PURCHASE_RECEIVE",
        quantity: line.quantity,
        reason:
          damagedQty > 0
            ? `Purchase Receive (${damagedQty} damaged of ${line.quantity}): ${receiveNo} (PO ${po.purchaseNo})`
            : `Purchase Receive: ${receiveNo} (PO ${po.purchaseNo})`,
        notes: dto.notes,
        referenceId: receive.id,
        createdBy,
      });

      // ── receivedQuantity increment এখনো per-line updateOne (safe,
      //    সরাসরি increment atomic operator, কোনো read নেই)
      await tx.purchaseOrderItem.update({
        where: { id: poItem.id },
        data: { receivedQuantity: { increment: line.quantity } },
      });
    }

    // ── আগে: প্রতি line-এ আলাদা tx.stockMovement.create (N round-trip) ──
    // ── এখন: একবারে সব insert (১ round-trip) ──
    await tx.stockMovement.createMany({ data: stockMovementRows });

    const freshItems = await tx.purchaseOrderItem.findMany({
      where: { purchaseOrderId: poId },
      select: {
        quantity: true,
        receivedQuantity: true,
        cancelledQuantity: true,
      } as any,
    });
    const fullyResolved = freshItems.every(
      (i: any) => i.receivedQuantity + i.cancelledQuantity >= i.quantity,
    );
    const anyReceived = freshItems.some((i) => i.receivedQuantity > 0);
    const receivingStatus = fullyResolved
      ? "FULLY_RECEIVED"
      : anyReceived
        ? "PARTIALLY_RECEIVED"
        : po.receivingStatus;

    await tx.purchaseOrder.update({
      where: { id: poId },
      data: { receivingStatus },
    });
    return { receive, receivingStatus };
  });

  const full = await prisma.purchaseReceive.findUnique({
    where: { id: result.receive.id },
    include: {
      items: {
        include: {
          warehouse: { select: { id: true, name: true, code: true } },
          rack: { select: { id: true, code: true, label: true } },
          purchaseOrderItem: {
            select: { id: true, sku: true, productName: true },
          },
        },
      },
    },
  });

  return { ...full, receivingStatus: result.receivingStatus };
}

// ─────────────────────────────────────────────────────────────────────────────
// SHORT-CLOSE (Group A1/A2)
// Permanently writes off the requested remaining-quantity on each item.
// Recomputes subtotal/vatAmount/totalAmount downward proportionally, posts a
// reversal voucher for the delta, and resolves payment status. If the PO was
// already paid past the new (lower) total, dueAmount clamps to 0 and the
// excess simply becomes refundable — see getRefundableAmount(); nothing is
// stored on the PO for it.
// ─────────────────────────────────────────────────────────────────────────────
export async function shortClosePurchaseOrder(
  poId: string,
  dto: ShortClosePurchaseOrderDTO,
  createdBy?: string,
) {
  if (!dto.items?.length)
    throw new Error("Short-close must include at least one item");
  if (!dto.reason?.trim()) throw new Error("Short-close reason is required");
  if (dto.entityType !== "VENDOR" || !dto.entityId)
    throw new Error(
      "Short-close currently requires entityType=VENDOR with a vendorId",
    );

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { items: true, supplier: true },
  });
  if (!po) throw new Error("Purchase order not found");
  if (
    po.receivingStatus === "CANCELLED" ||
    po.receivingStatus === "SHORT_CLOSED"
  )
    throw new Error(`Purchase order is already ${po.receivingStatus}`);
  if (po.receivingStatus === "FULLY_RECEIVED")
    throw new Error(
      "Nothing outstanding to short-close — purchase order is fully received",
    );

  const itemsById = new Map(po.items.map((i) => [i.id, i]));
  let inventoryReversal = 0;

  for (const line of dto.items) {
    const poItem = itemsById.get(line.purchaseOrderItemId);
    if (!poItem)
      throw new Error(
        `Item ${line.purchaseOrderItemId} does not belong to this purchase order`,
      );
    const remaining =
      poItem.quantity -
      poItem.receivedQuantity -
      (poItem as any).cancelledQuantity;
    if (line.cancelQuantity <= 0 || line.cancelQuantity > remaining) {
      throw new Error(
        `Cannot short-close ${line.cancelQuantity} of ${poItem.sku} — only ${remaining} outstanding`,
      );
    }
    const unitCost = Number(poItem.total) / poItem.quantity;
    inventoryReversal += unitCost * line.cancelQuantity;
  }
  inventoryReversal = parseFloat(inventoryReversal.toFixed(4));

  const vatRate =
    Number(po.subtotal) > 0 ? Number(po.vatAmount) / Number(po.subtotal) : 0;
  const vatReversal = parseFloat((inventoryReversal * vatRate).toFixed(4));
  const totalReversal = parseFloat(
    (inventoryReversal + vatReversal).toFixed(4),
  );

  const newSubtotal = parseFloat(
    (Number(po.subtotal) - inventoryReversal).toFixed(4),
  );
  const newVatAmount = parseFloat(
    (Number(po.vatAmount) - vatReversal).toFixed(4),
  );
  const newTotalAmount = parseFloat((newSubtotal + newVatAmount).toFixed(4));

  const { dueAmount, paymentStatus } = resolvePaymentStateAfterTotalChange(
    Number(po.paidAmount),
    newTotalAmount,
  );

  const updatedPO = await prisma.$transaction(async (tx) => {
    for (const line of dto.items) {
      await tx.purchaseOrderItem.update({
        where: { id: line.purchaseOrderItemId },
        data: { cancelledQuantity: { increment: line.cancelQuantity } } as any,
      });
    }

    return tx.purchaseOrder.update({
      where: { id: poId },
      data: {
        subtotal: newSubtotal,
        vatAmount: newVatAmount,
        totalAmount: newTotalAmount,
        dueAmount,
        paymentStatus,
        receivingStatus: "SHORT_CLOSED",
        shortClosedAt: new Date(),
        shortClosedBy: createdBy ?? null,
        shortCloseReason: dto.reason,
      } as any,
    });
  });

  let voucher: any = null;
  try {
    voucher = await accountingService.createPurchaseShortCloseVoucher({
      purchaseOrderId: po.id,
      purchaseNo: po.purchaseNo,
      supplierId: po.supplierId,
      supplierName: po.supplier.name,
      inventoryReversalAmount: new Decimal(inventoryReversal),
      vatReversalAmount: new Decimal(vatReversal),
      totalReversalAmount: new Decimal(totalReversal),
      vendorId: dto.entityId,
      reason: dto.reason,
      createdBy: createdBy as string,
    });
  } catch (err) {
    throw new Error(
      `Purchase order ${po.purchaseNo} was short-closed successfully, but the reversal voucher ` +
        `failed to post: ${(err as Error).message}. Inventory/PO state is updated; manual ` +
        `reconciliation or a voucher retry is required.`,
    );
  }

  const refundable = await getRefundableAmount(
    poId,
    Number(po.paidAmount),
    newTotalAmount,
  );

  return { ...updatedPO, refundableAmount: refundable, voucher };
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL PURCHASE ORDER (Group B1/B2)
// Cancels everything still outstanding on the PO. If nothing has been
// received yet, this is a full reversal of the original purchase voucher and
// receivingStatus goes straight to CANCELLED. If something has already been
// received, the received portion is left alone (it's physically in stock —
// use returnPurchaseOrderItems() separately if it needs to go back).
// ─────────────────────────────────────────────────────────────────────────────
export async function cancelPurchaseOrder(
  poId: string,
  dto: CancelPurchaseOrderDTO,
  createdBy?: string,
) {
  if (!dto.reason?.trim()) throw new Error("Cancellation reason is required");
  if (dto.entityType !== "VENDOR" || !dto.entityId)
    throw new Error(
      "Cancellation currently requires entityType=VENDOR with a vendorId",
    );

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { items: true, supplier: true },
  });
  if (!po) throw new Error("Purchase order not found");
  if (
    po.receivingStatus === "CANCELLED" ||
    po.receivingStatus === "SHORT_CLOSED"
  )
    throw new Error(`Purchase order is already ${po.receivingStatus}`);
  if (po.receivingStatus === "FULLY_RECEIVED")
    throw new Error(
      "Cannot cancel a fully received purchase order — use returnPurchaseOrderItems() instead",
    );

  let inventoryReversal = 0;
  for (const poItem of po.items) {
    const remaining =
      poItem.quantity -
      poItem.receivedQuantity -
      (poItem as any).cancelledQuantity;
    if (remaining <= 0) continue;
    const unitCost = Number(poItem.total) / poItem.quantity;
    inventoryReversal += unitCost * remaining;
  }
  inventoryReversal = parseFloat(inventoryReversal.toFixed(4));

  const vatRate =
    Number(po.subtotal) > 0 ? Number(po.vatAmount) / Number(po.subtotal) : 0;
  const vatReversal = parseFloat((inventoryReversal * vatRate).toFixed(4));
  const totalReversal = parseFloat(
    (inventoryReversal + vatReversal).toFixed(4),
  );

  const newSubtotal = parseFloat(
    (Number(po.subtotal) - inventoryReversal).toFixed(4),
  );
  const newVatAmount = parseFloat(
    (Number(po.vatAmount) - vatReversal).toFixed(4),
  );
  const newTotalAmount = parseFloat((newSubtotal + newVatAmount).toFixed(4));

  const { dueAmount, paymentStatus } = resolvePaymentStateAfterTotalChange(
    Number(po.paidAmount),
    newTotalAmount,
  );

  const updatedPO = await prisma.$transaction(async (tx) => {
    for (const poItem of po.items) {
      const remaining =
        poItem.quantity -
        poItem.receivedQuantity -
        (poItem as any).cancelledQuantity;
      if (remaining <= 0) continue;
      await tx.purchaseOrderItem.update({
        where: { id: poItem.id },
        data: { cancelledQuantity: { increment: remaining } } as any,
      });
    }

    return tx.purchaseOrder.update({
      where: { id: poId },
      data: {
        subtotal: newSubtotal,
        vatAmount: newVatAmount,
        totalAmount: newTotalAmount,
        dueAmount,
        paymentStatus,
        receivingStatus: "CANCELLED",
        cancelledAt: new Date(),
        cancelledBy: createdBy ?? null,
        cancelReason: dto.reason,
      } as any,
    });
  });

  let voucher: any = null;
  try {
    voucher = await accountingService.createPurchaseCancelVoucher({
      purchaseOrderId: po.id,
      purchaseNo: po.purchaseNo,
      supplierId: po.supplierId,
      supplierName: po.supplier.name,
      inventoryReversalAmount: new Decimal(inventoryReversal),
      vatReversalAmount: new Decimal(vatReversal),
      totalReversalAmount: new Decimal(totalReversal),
      vendorId: dto.entityId,
      reason: dto.reason,
      createdBy: createdBy as string,
    });
  } catch (err) {
    throw new Error(
      `Purchase order ${po.purchaseNo} was cancelled successfully, but the reversal voucher ` +
        `failed to post: ${(err as Error).message}. Manual reconciliation or a voucher retry is required.`,
    );
  }

  const refundable = await getRefundableAmount(
    poId,
    Number(po.paidAmount),
    newTotalAmount,
  );

  return { ...updatedPO, refundableAmount: refundable, voucher };
}

// ─────────────────────────────────────────────────────────────────────────────
// RETURN RECEIVED ITEMS (Group C1)
// Sends already-received stock back to the supplier. Decrements
// WarehouseStock, logs a PURCHASE_RETURN StockMovement, and posts a voucher
// that reduces the payable at the ORIGINAL PO unit cost (not current
// avgCost). Does NOT touch receivedQuantity/quantity on the
// PurchaseOrderItem, but DOES reduce totalAmount/dueAmount the same way
// short-close does, since the supplier is no longer owed for the returned
// goods.
// ─────────────────────────────────────────────────────────────────────────────
export async function returnPurchaseOrderItems(
  poId: string,
  dto: ReturnPurchaseOrderDTO,
  createdBy?: string,
) {
  if (!dto.items?.length)
    throw new Error("Return must include at least one item");
  if (!dto.reason?.trim()) throw new Error("Return reason is required");
  if (dto.entityType !== "VENDOR" || !dto.entityId)
    throw new Error(
      "Returns currently require entityType=VENDOR with a vendorId",
    );

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { items: true, supplier: true },
  });
  if (!po) throw new Error("Purchase order not found");

  const itemsById = new Map(po.items.map((i) => [i.id, i]));

  // How much of each item has already been returned before, so we don't
  // let someone return more than was ever received. Scalar FK filter —
  // no relation join, so there's no "quantity is ambiguous" risk.
  const priorReturns = await prisma.purchaseReturnItem.groupBy({
    by: ["purchaseOrderItemId"],
    where: {
      purchaseOrderItemId: { in: po.items.map((i) => i.id) },
    },
    _sum: { quantity: true },
  });
  const priorReturnedByItem = new Map(
    priorReturns.map((r) => [r.purchaseOrderItemId, r._sum.quantity ?? 0]),
  );

  let returnAmount = 0;
  const lineDetails: { poItem: (typeof po.items)[number]; unitCost: number }[] =
    [];

  for (const line of dto.items) {
    const poItem = itemsById.get(line.purchaseOrderItemId);
    if (!poItem)
      throw new Error(
        `Item ${line.purchaseOrderItemId} does not belong to this purchase order`,
      );
    if (line.quantity <= 0)
      throw new Error(`Return quantity for ${poItem.sku} must be > 0`);

    const alreadyReturned = priorReturnedByItem.get(poItem.id) ?? 0;
    const returnable = poItem.receivedQuantity - alreadyReturned;
    if (line.quantity > returnable) {
      throw new Error(
        `Cannot return ${line.quantity} of ${poItem.sku} — only ${returnable} returnable ` +
          `(received ${poItem.receivedQuantity}, already returned ${alreadyReturned})`,
      );
    }

    const unitCost = Number(poItem.total) / poItem.quantity;
    returnAmount += unitCost * line.quantity;
    lineDetails.push({ poItem, unitCost });
  }
  returnAmount = parseFloat(returnAmount.toFixed(4));

  const newTotalAmount = parseFloat(
    (Number(po.totalAmount) - returnAmount).toFixed(4),
  );
  const { dueAmount, paymentStatus } = resolvePaymentStateAfterTotalChange(
    Number(po.paidAmount),
    newTotalAmount,
  );

  const returnNo = await getNextReturnNumber();

  const { purchaseReturn, updatedPO } = await runStockMutation(
    prisma,
    async (tx) => {
      const pr = await tx.purchaseReturn.create({
        data: {
          purchaseOrderId: poId,
          returnNo,
          reason: dto.reason,
          returnAmount,
          createdBy: dto.returnedBy ?? createdBy,
        } as any,
      });

      for (const line of dto.items) {
        const detail = lineDetails.find(
          (d) => d.poItem.id === line.purchaseOrderItemId,
        )!;

        await tx.purchaseReturnItem.create({
          data: {
            purchaseReturnId: pr.id,
            purchaseOrderItemId: line.purchaseOrderItemId,
            quantity: line.quantity,
            unitCost: detail.unitCost,
            warehouseId: line.warehouseId,
            rackId: line.rackId ?? null,
          },
        });

        await applyStockDelta(tx, {
          variantId: detail.poItem.variantId,
          warehouseId: line.warehouseId,
          rackId: line.rackId,
          rowNumber: line.rowNumber,
          shelfNumber: line.shelfNumber,
          quantityDelta: -line.quantity,
          reason: `Purchase return (${returnNo})`,
        });

        await tx.stockMovement.create({
          data: {
            variantId: detail.poItem.variantId,
            fromWarehouseId: line.warehouseId,
            rackId: line.rackId ?? null,
            movementType: "PURCHASE_RETURN",
            quantity: line.quantity,
            reason: `Purchase Return: ${returnNo} (PO ${po.purchaseNo}) | ${dto.reason}`,
            referenceId: pr.id,
            createdBy,
          },
        });
      }

      const updated = await tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          totalAmount: newTotalAmount,
          dueAmount,
          paymentStatus,
        },
      });

      return { purchaseReturn: pr, updatedPO: updated };
    },
  );

  let voucher: any = null;
  try {
    voucher = await accountingService.createPurchaseReturnVoucher({
      purchaseOrderId: po.id,
      purchaseNo: po.purchaseNo,
      supplierId: po.supplierId,
      supplierName: po.supplier.name,
      returnAmount: new Decimal(returnAmount),
      vendorId: dto.entityId,
      purchaseReturnId: purchaseReturn.id,
      reason: dto.reason,
      createdBy: createdBy as string,
    });
  } catch (err) {
    throw new Error(
      `Return ${returnNo} against PO ${po.purchaseNo} was recorded and stock was adjusted, ` +
        `but the voucher failed to post: ${(err as Error).message}. Manual reconciliation or a ` +
        `voucher retry is required.`,
    );
  }

  const refundable = await getRefundableAmount(
    poId,
    Number(po.paidAmount),
    newTotalAmount,
  );

  return {
    ...purchaseReturn,
    purchaseOrder: updatedPO,
    refundableAmount: refundable,
    voucher,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REFUND (Group D1)
// Cashes out (partially or fully) whatever is currently refundable on a PO —
// computed fresh from paidAmount/totalAmount/prior refunds, not read from a
// stored balance field.
// ─────────────────────────────────────────────────────────────────────────────
export async function refundPurchaseOrderCredit(
  poId: string,
  dto: RefundPurchaseOrderCreditDTO,
  createdBy?: string,
) {
  if (!dto.amount || dto.amount <= 0)
    throw new Error("Refund amount must be > 0");
  if (dto.entityType !== "VENDOR" || !dto.entityId)
    throw new Error(
      "Refunds currently require entityType=VENDOR with a vendorId",
    );

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { supplier: true },
  });
  if (!po) throw new Error("Purchase order not found");

  const refundable = await getRefundableAmount(
    poId,
    Number(po.paidAmount),
    Number(po.totalAmount),
  );
  if (dto.amount > refundable) {
    throw new Error(
      `Refund amount ${dto.amount} exceeds refundable balance ${refundable.toFixed(2)}`,
    );
  }

  const { coaId: bankCoaId, accountId: resolvedPaymentAccountId } =
    await resolveVendorPaymentAccountCoa(
      dto.entityId,
      dto.vendorPaymentAccountId,
      "Refund account",
    );
  const refund = await prisma.purchaseRefund.create({
    data: {
      purchaseOrderId: poId,
      amount: dto.amount,
      method: dto.method,
      coaAccountId: bankCoaId,
      vendorPaymentAccountId: resolvedPaymentAccountId,
      reference: dto.reference,
    },
  });

  let voucher: any = null;
  try {
    voucher = await accountingService.createPurchaseRefundVoucher({
      purchaseOrderId: po.id,
      purchaseNo: po.purchaseNo,
      supplierId: po.supplierId,
      supplierName: po.supplier.name,
      amount: new Decimal(dto.amount),
      bankCoaId,
      vendorId: dto.entityId,
      purchaseRefundId: refund.id,
      reference: dto.reference,
      createdBy: createdBy as string,
    });
  } catch (err) {
    throw new Error(
      `Refund of ${dto.amount} against PO ${po.purchaseNo} was recorded, but the voucher failed to ` +
        `post: ${(err as Error).message}. Refund id: ${refund.id}. Manual reconciliation or a voucher ` +
        `retry is required.`,
    );
  }

  const remainingRefundable = parseFloat((refundable - dto.amount).toFixed(4));

  return { ...refund, purchaseOrder: po, remainingRefundable, voucher };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAY PURCHASE DUE (unchanged logic; console.log removed — Group E3)
// ─────────────────────────────────────────────────────────────────────────────
export async function payPurchaseDue(
  poId: string,
  dto: PayPurchaseDueDTO,
  createdBy?: string,
) {
  if (!dto.amount || dto.amount <= 0)
    throw new Error("Payment amount must be > 0");
  if (!dto.vendorPaymentAccountId)
    throw new Error("Payment account is required");
  if (dto.entityType !== "VENDOR" || !dto.entityId) {
    throw new Error(
      "Payments currently require entityType=VENDOR with a vendorId " +
        "(AccountingService.createPurchasePaymentVoucher is VENDOR-scoped).",
    );
  }

  const initialPO = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { supplier: true },
  });
  if (!initialPO) throw new Error("Purchase order not found");

  const initialDue = Number(initialPO.dueAmount);
  if (initialDue <= 0) {
    const refundable = await getRefundableAmount(
      poId,
      Number(initialPO.paidAmount),
      Number(initialPO.totalAmount),
    );
    throw new Error(
      refundable > 0
        ? `No outstanding due on this purchase order — it currently has ${refundable.toFixed(2)} owed ` +
            `back from the supplier. Use refundPurchaseOrderCredit() instead of taking another payment.`
        : "No outstanding due on this purchase order",
    );
  }
  if (dto.amount > initialDue) {
    throw new Error(
      `Amount ${dto.amount} exceeds outstanding due ${initialDue.toFixed(2)}`,
    );
  }

  const paymentAmount = Number(dto.amount);
  if (!dto.vendorPaymentAccountId)
    throw new Error("Payment account is required");
  const { coaId: resolvedPaymentCoaId, accountId: resolvedPaymentAccountId } =
    await resolveVendorPaymentAccountCoa(
      dto.entityId,
      dto.vendorPaymentAccountId,
    );
  const MAX_RETRIES = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { po, purchasePayment } = await prisma.$transaction(
        async (tx) => {
          const updatedPOResult = await tx.purchaseOrder.updateMany({
            where: { id: poId, dueAmount: { gte: paymentAmount } },
            data: {
              paidAmount: { increment: paymentAmount },
              dueAmount: { decrement: paymentAmount },
            },
          });

          if (updatedPOResult.count !== 1) {
            throw new Error(
              "Payment could not be completed. The outstanding due may have changed. Please refresh and try again.",
            );
          }

          const freshPO = await tx.purchaseOrder.findUnique({
            where: { id: poId },
          });
          if (!freshPO) throw new Error("Purchase order not found");

          const newDue = Number(freshPO.dueAmount);
          const normalizedDue =
            newDue <= 0.0001 ? 0 : Number(newDue.toFixed(4));
          const newPaymentStatus =
            normalizedDue <= 0 ? "PAID" : "PARTIALLY_PAID";

          await tx.purchaseOrder.update({
            where: { id: poId },
            data: { dueAmount: normalizedDue, paymentStatus: newPaymentStatus },
          });

          const purchasePayment = await tx.purchasePayment.create({
            data: {
              purchaseOrderId: poId,
              amount: paymentAmount,
              method: dto.method,
              coaAccountId: resolvedPaymentCoaId,
              vendorPaymentAccountId: resolvedPaymentAccountId,
              reference: dto.reference,
            },
          });

          return {
            po: {
              ...freshPO,
              dueAmount: normalizedDue,
              paymentStatus: newPaymentStatus,
            },
            purchasePayment,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5000,
          timeout: 15000,
        },
      );

      let voucher: any;
      try {
        voucher = await accountingService.createPurchasePaymentVoucher({
          purchaseOrderId: po.id,
          purchaseNo: po.purchaseNo,
          supplierId: initialPO.supplierId,
          supplierName: initialPO.supplier.name,
          amount: new Decimal(paymentAmount),
          bankCoaId: resolvedPaymentCoaId,
          paymentMethod: dto.method,
          reference: dto.reference,
          vendorId: dto.entityId,
          purchasePaymentId: purchasePayment.id,
          createdBy: createdBy as string,
        });
      } catch (err) {
        throw new Error(
          `Payment of ${paymentAmount} against PO ${po.purchaseNo} (id: ${po.id}) was recorded, ` +
            `but voucher posting failed: ${(err as Error).message}. ` +
            `Payment id: ${purchasePayment.id}. Manual reconciliation or a voucher retry is required.`,
        );
      }

      return {
        purchaseOrderId: poId,
        purchaseNo: po.purchaseNo,
        amountPaid: paymentAmount,
        newDue: Number(po.dueAmount),
        newPaymentStatus: po.paymentStatus,
        voucherNumber: voucher.voucherNumber,
      };
    } catch (error) {
      lastError = error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < MAX_RETRIES
      ) {
        console.warn(
          `Purchase payment transaction conflict. Retrying... attempt ${attempt + 1}/${MAX_RETRIES}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to process purchase payment");
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────────
export async function listPurchaseOrders(query: PurchaseOrderListQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (query.supplierId) where.supplierId = query.supplierId;
  if (query.warehouseId) {
    where.OR = [
      { warehouseId: query.warehouseId },
      {
        receives: {
          some: { items: { some: { warehouseId: query.warehouseId } } },
        },
      },
    ];
  }
  if (query.receivingStatus) where.receivingStatus = query.receivingStatus;
  if (query.paymentStatus) where.paymentStatus = query.paymentStatus;
  if (query.startDate || query.endDate) {
    const dateFilter: Record<string, Date> = {};
    if (query.startDate) dateFilter.gte = new Date(query.startDate);
    if (query.endDate) dateFilter.lte = new Date(query.endDate);
    where.purchaseDate = dateFilter;
  }

  const [orders, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        warehouse: { select: { id: true, name: true } },
        items: {
          select: {
            id: true,
            productName: true,
            variantName: true,
            quantity: true,
            receivedQuantity: true,
            total: true,
          },
        },
        payments: {
          select: { id: true, amount: true, method: true, paidAt: true },
        },
      },
      orderBy: { purchaseDate: "desc" },
      skip,
      take: limit,
    }),
    prisma.purchaseOrder.count({ where }),
  ]);

  const agg = await prisma.purchaseOrder.aggregate({
    where,
    _sum: { totalAmount: true, paidAmount: true, dueAmount: true },
    _count: { id: true },
  });

  return {
    data: orders,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    stats: {
      count: agg._count.id,
      totalValue: agg._sum.totalAmount ?? 0,
      totalPaid: agg._sum.paidAmount ?? 0,
      totalDue: agg._sum.dueAmount ?? 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ONE (full detail with vouchers + receiving/return history)
// ─────────────────────────────────────────────────────────────────────────────
export async function getPurchaseOrderById(id: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      supplier: { include: { coaAccount: true } },
      warehouse: true,
      items: {
        include: {
          variant: { select: { id: true, sku: true, avgCost: true } },
        },
      },

      payments: {
        include: {
          vendorPaymentAccount: {
            select: {
              id: true,
              type: true,
              label: true,
              accountNumber: true,
              mobileProvider: true,
              walletNumber: true,
            },
          },
        },
      },

      // ✅ receives structure — matches ReceivePurchaseOrderItemInput / frontend's rItem.* usage
      receives: {
        include: {
          items: {
            include: {
              purchaseOrderItem: {
                select: {
                  id: true,
                  sku: true,
                  productName: true,
                  variantName: true,
                },
              },
              warehouse: { select: { id: true, name: true, code: true } },
              rack: { select: { id: true, code: true, label: true } },
            },
          },
        },
        orderBy: { receivedAt: "asc" },
      },
    } as any,
  });

  if (!po) throw new Error("Purchase order not found");

  // ✅ voucher lookup — receive/return/refund/short-close/cancel সবগুলো referenceType কভার করছে
  const vouchers = await prisma.voucher.findMany({
    where: {
      OR: [
        { referenceType: "purchase_order", referenceId: po.id },
        {
          referenceType: "purchase_payment",
          referenceId: { in: (po.payments ?? []).map((p: any) => p.id) },
        },
        {
          referenceType: "purchase_receive",
          referenceId: {
            in: ((po as any).receives ?? []).map((r: any) => r.id),
          },
        },
      ],
    },
    include: { ledgerEntries: { include: { account: true } } },
    orderBy: { voucherDate: "asc" },
  });

  const refundableAmount = await getRefundableAmount(
    po.id,
    Number(po.paidAmount),
    Number(po.totalAmount),
  );

  return { ...po, vouchers, refundableAmount };
}
