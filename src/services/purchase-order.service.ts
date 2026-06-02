import { PrismaClient, type EntityType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import type {
  CreatePurchaseOrderDTO,
  PayPurchaseDueDTO,
  PurchaseOrderListQuery,
  VoucherEntryInput,
} from "../types/erp.types.ts";
import { calcWeightedAvg } from "../types/erp.types.ts";

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Generate next PO number: PUR-{YYYY}-{NNNN} */
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

// ─────────────────────────────────────────────────────────────────────────────
// COA DEFINITIONS
// Standard chart of accounts auto-created on first purchase for a vendor.
// Matches typical double-entry structure for a product-based business.
// ─────────────────────────────────────────────────────────────────────────────
const STANDARD_COA = [
  // ASSETS
  { code: "1000", name: "Cash in Hand",           accountClass: "ASSET",     accountType: "CURRENT_ASSET",   group: "Cash & Bank",   nature: "DEBIT"  },
  { code: "1010", name: "Bank Account",            accountClass: "ASSET",     accountType: "CURRENT_ASSET",   group: "Cash & Bank",   nature: "DEBIT"  },
  // ↓ codes 1020–1023 match COA_OPTIONS in PurchaseEntryForm.tsx
  { code: "1020", name: "Cash in Hand (Alt)",      accountClass: "ASSET",     accountType: "CURRENT_ASSET",   group: "Cash & Bank",   nature: "DEBIT"  },
  { code: "1021", name: "BRAC Bank - Current",     accountClass: "ASSET",     accountType: "CURRENT_ASSET",   group: "Cash & Bank",   nature: "DEBIT"  },
  { code: "1022", name: "Dutch Bangla Bank",        accountClass: "ASSET",     accountType: "CURRENT_ASSET",   group: "Cash & Bank",   nature: "DEBIT"  },
  { code: "1023", name: "Islami Bank",              accountClass: "ASSET",     accountType: "CURRENT_ASSET",   group: "Cash & Bank",   nature: "DEBIT"  },
  { code: "1100", name: "Accounts Receivable",    accountClass: "ASSET",     accountType: "CURRENT_ASSET",   group: "Receivables",   nature: "DEBIT"  },
  { code: "1200", name: "Inventory",              accountClass: "ASSET",     accountType: "CURRENT_ASSET",   group: "Inventory",     nature: "DEBIT"  },
  { code: "1210", name: "Stock in Trade",         accountClass: "ASSET",     accountType: "CURRENT_ASSET",   group: "Inventory",     nature: "DEBIT"  },

  // LIABILITIES
  { code: "2000", name: "Accounts Payable",       accountClass: "LIABILITY", accountType: "CURRENT_LIABILITY", group: "Payables",    nature: "CREDIT" },
  { code: "2100", name: "VAT Payable",            accountClass: "LIABILITY", accountType: "CURRENT_LIABILITY", group: "Tax",         nature: "CREDIT" },

  // EQUITY
  { code: "3000", name: "Owner Equity",           accountClass: "EQUITY",    accountType: "EQUITY",          group: "Equity",        nature: "CREDIT" },
  { code: "3100", name: "Retained Earnings",      accountClass: "EQUITY",    accountType: "EQUITY",          group: "Equity",        nature: "CREDIT" },

  // INCOME
  { code: "4000", name: "Sales Revenue",          accountClass: "INCOME",    accountType: "REVENUE",         group: "Revenue",       nature: "CREDIT" },
  { code: "4100", name: "Other Income",           accountClass: "INCOME",    accountType: "REVENUE",         group: "Revenue",       nature: "CREDIT" },

  // EXPENSES
  { code: "5000", name: "Cost of Goods Sold",     accountClass: "EXPENSE",   accountType: "COST_OF_GOODS",   group: "COGS",          nature: "DEBIT"  },
  { code: "5100", name: "Purchase Expense",       accountClass: "EXPENSE",   accountType: "COST_OF_GOODS",   group: "COGS",          nature: "DEBIT"  },
  // ↓ code 1410 — VAT Input Tax (ASSET side — input tax recoverable)
  { code: "1410", name: "VAT Input Tax",           accountClass: "ASSET",     accountType: "CURRENT_ASSET",   group: "Tax",           nature: "DEBIT"  },
  { code: "5200", name: "VAT Input",               accountClass: "EXPENSE",   accountType: "TAX",             group: "Tax",           nature: "DEBIT"  },
  { code: "6000", name: "Operating Expense",      accountClass: "EXPENSE",   accountType: "OPERATING",       group: "Operations",    nature: "DEBIT"  },
  { code: "6100", name: "Damage Expense",         accountClass: "EXPENSE",   accountType: "OPERATING",       group: "Operations",    nature: "DEBIT"  },
  { code: "6200", name: "Stock Adjustment",       accountClass: "EXPENSE",   accountType: "OPERATING",       group: "Operations",    nature: "DEBIT"  },
];

// ─────────────────────────────────────────────────────────────────────────────
// COA HELPERS — all use the MAIN prisma client, NOT a transaction client.
//
// WHY: PostgreSQL FK constraints check committed data. When you create a
// chartOfAccount row inside a $transaction and then immediately insert a
// ledgerEntry referencing it (also inside the same transaction), the FK check
// may fail because the COA row is not yet visible outside the transaction.
//
// Fix: resolve / create ALL COA accounts BEFORE the transaction opens.
// The transaction then only does inserts that reference already-committed rows.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure all standard COA accounts exist for this entity.
 * Uses prisma (not tx) so rows are committed immediately and visible to FK checks.
 */
async function ensureStandardCOA(
  entityType: EntityType,
  entityId: string | undefined,
): Promise<void> {
  for (const acct of STANDARD_COA) {
    // Try insert; if unique constraint fires it means the row already exists — skip.
    const existing = await prisma.chartOfAccount.findFirst({
      where: {
        code:       acct.code,
        entityType,
        entityId:   entityId ?? null,
      },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.chartOfAccount.create({
      data: {
        code:         acct.code,
        name:         acct.name,
        accountClass: acct.accountClass as any,
        accountType:  acct.accountType  as any,
        nature:       acct.nature       as any,
        entityType,
        entityId:     entityId ?? null,
        isSystem:     true,
        isActive:     true,
        canDelete:    false,
      },
    }).catch(() => { /* concurrent insert — row already exists, ignore */ });
  }
}

/**
 * Find a COA account by exact code for this entity.
 * Uses prisma (not tx) — always reads committed data.
 */
async function findCOAByCode(
  entityType: EntityType,
  entityId: string | undefined,
  code: string,
): Promise<string | null> {
  const acct = await prisma.chartOfAccount.findFirst({
    where: { code, entityType, entityId: entityId ?? null, isActive: true },
    select: { id: true },
  });
  return acct?.id ?? null;
}

/**
 * Get or create a COA account by code — OUTSIDE any transaction.
 * Guaranteed to return a committed row that FK checks will accept.
 */
async function getOrCreateCOAByCode(
  entityType: EntityType,
  entityId: string | undefined,
  code: string,
): Promise<string> {
  let id = await findCOAByCode(entityType, entityId, code);
  if (id) return id;

  // Seed all standard accounts then retry
  await ensureStandardCOA(entityType, entityId);

  id = await findCOAByCode(entityType, entityId, code);
  if (id) return id;

  throw new Error(
    `COA account code "${code}" not found for ${entityType}` +
    `${entityId ? ":" + entityId : ""} even after seeding. ` +
    `Check STANDARD_COA in purchaseService.ts.`,
  );
}

/**
 * Get or create a per-supplier AP account — OUTSIDE any transaction.
 */
async function getOrCreateSupplierCOA(
  supplierId: string,
  supplierName: string,
  entityType: EntityType,
  entityId: string | undefined,
): Promise<string> {
  // 1. Supplier's own linked AP account
  const supplier = await prisma.supplier.findUnique({
    where:  { id: supplierId },
    select: { coaAccount: { select: { id: true } } },
  });
  if (supplier?.coaAccount?.id) return supplier.coaAccount.id;

  // 2. Named AP account for this supplier
  const name = `AP — ${supplierName}`;
  const byName = await prisma.chartOfAccount.findFirst({
    where: { entityType, entityId: entityId ?? null, name, isActive: true },
    select: { id: true },
  });
  if (byName) return byName.id;

  // 3. Create it (committed immediately, visible to FK checks)
  // Use a simple sequential code within the LIABILITY prefix
  const prefix  = entityType === "VENDOR" ? "VND-LIB" : "ADM-LIB";
  const lastAcct = await prisma.chartOfAccount.findFirst({
    where:   { entityType, entityId: entityId ?? null, code: { startsWith: prefix } },
    orderBy: { createdAt: "desc" },
    select:  { code: true },
  });
  const seq  = lastAcct ? parseInt(lastAcct.code.split("-").pop()!, 10) + 1 : 1;
  const code = `${prefix}-${String(seq).padStart(4, "0")}`;

  const created = await prisma.chartOfAccount.create({
    data: {
      code,
      name,
      accountClass: "LIABILITY" as any,
      accountType:  "CURRENT_LIABILITY" as any,
      nature:       "CREDIT" as any,
      entityType,
      entityId:     entityId ?? null,
      isSystem:     false,
      isActive:     true,
      canDelete:    false,
      description:  `Accounts payable to supplier ${supplierName}`,
    },
  });

  // Link back to supplier (best-effort)
  await prisma.supplier.update({
    where: { id: supplierId },
    data:  { coaAccountId: created.id },
  }).catch(() => {});

  return created.id;
}

/** Generate voucher number: {PREFIX}{YY}{MM}{NNNN} */
async function nextVoucherNumber(
  tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  voucherType: string,
  entityType: EntityType,
  entityId: string | undefined,
): Promise<string> {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const pfx = `${voucherType.substring(0, 3).toUpperCase()}${yy}${mm}`;

  const last = await tx.voucher.findFirst({
    where: {
      voucherNumber: { startsWith: pfx },
      entityType,
      entityId: entityId ?? null,
    },
    orderBy: { voucherNumber: "desc" },
    select: { voucherNumber: true },
  });

  const seq = last ? parseInt(last.voucherNumber.slice(-4), 10) + 1 : 1;
  return `${pfx}${String(seq).padStart(4, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE PURCHASE ORDER
// All steps run in one $transaction — atomically:
//   1. PurchaseOrder + PurchaseOrderItems
//   2. WarehouseStock upsert per item
//   3. ProductVariant.avgCost + price + stock total
//   4. PURCHASE voucher (DR Inventory, DR VAT → CR AP)
//   5. PAYMENT voucher  (DR AP → CR Bank) — only if paidAmount > 0
//   6. PurchasePayment record linked to PO
// ─────────────────────────────────────────────────────────────────────────────
export async function createPurchaseOrder(
  dto: CreatePurchaseOrderDTO,
  createdBy?: string,
) {
  if (!dto.items.length)
    throw new Error("Purchase order must have at least one item");

  for (const item of dto.items) {
    if (item.quantity <= 0)
      throw new Error(`Item ${item.sku}: quantity must be > 0`);
    if (item.unitCost <= 0)
      throw new Error(`Item ${item.sku}: unit cost must be > 0`);
  }

  const purchaseNo   = await getNextPurchaseNumber();
  const vatRate      = dto.vatRate ?? 0;
  const subtotal     = dto.items.reduce((s, i) => s + i.quantity * i.unitCost, 0);
  const vatAmount    = parseFloat((subtotal * vatRate).toFixed(4));
  const totalAmount  = parseFloat((subtotal + vatAmount).toFixed(4));
  const paidAmount   = Math.min(dto.paidAmount ?? 0, totalAmount);
  const dueAmount    = parseFloat((totalAmount - paidAmount).toFixed(4));
  const purchaseDate = new Date(dto.purchaseDate);

  // ── PRE-TRANSACTION: Resolve / create all COA accounts ───────────────────
  // MUST happen before $transaction opens. PostgreSQL FK checks on
  // ledgerEntry.accountId require the referenced chartOfAccount row to exist
  // in committed storage — rows created inside the same transaction are NOT
  // visible to FK constraint checks in some Postgres/Prisma versions.

  const supplierForCOA = await prisma.supplier.findUnique({
    where:  { id: dto.supplierId },
    select: { id: true, name: true },
  });
  if (!supplierForCOA) throw new Error(`Supplier ${dto.supplierId} not found`);

  const warehouseCheck = await prisma.vendorWarehouse.findUnique({
    where:  { id: dto.warehouseId },
    select: { id: true },
  });
  if (!warehouseCheck) throw new Error(`Warehouse ${dto.warehouseId} not found`);

  // All four IDs are committed rows — safe for FK references inside the tx
  const supplierCoaId  = await getOrCreateSupplierCOA(
    dto.supplierId, supplierForCOA.name, dto.entityType, dto.entityId,
  );
  const inventoryCoaId = await getOrCreateCOAByCode(dto.entityType, dto.entityId, "1200");
  const vatCoaId       = vatAmount > 0
    ? await getOrCreateCOAByCode(dto.entityType, dto.entityId, dto.vatCoaAccountId ?? "1410")
    : null;

  let bankCoaId: string | null = null;
  if (paidAmount > 0) {
    const raw = dto.paymentCoaAccountId;
    if (raw && raw.length > 10 && raw.includes("-")) {
      // UUID — verify it exists, fall back to 1010 if not
      const exists = await prisma.chartOfAccount.findUnique({ where: { id: raw }, select: { id: true } });
      bankCoaId = exists?.id ?? await getOrCreateCOAByCode(dto.entityType, dto.entityId, "1010");
    } else {
      bankCoaId = await getOrCreateCOAByCode(dto.entityType, dto.entityId, raw ?? "1010");
    }
  }
  // ── END PRE-TRANSACTION ───────────────────────────────────────────────────

  const result = await prisma.$transaction(async (tx) => {

    // ── 1. Supplier name (re-fetch inside tx for consistency) ────────────────
    const supplier = await tx.supplier.findUnique({
      where:  { id: dto.supplierId },
      select: { id: true, name: true },
    });
    if (!supplier) throw new Error(`Supplier ${dto.supplierId} not found`);

    // ── 2. Warehouse (already validated above) ───────────────────────────────
    const warehouse = await tx.vendorWarehouse.findUnique({
      where:  { id: dto.warehouseId },
      select: { id: true, name: true },
    });
    if (!warehouse) throw new Error(`Warehouse ${dto.warehouseId} not found`);

    // ── 3. Create PurchaseOrder ──────────────────────────────────────────────
    const po = await tx.purchaseOrder.create({
      data: {
        purchaseNo,
        supplierId:        dto.supplierId,
        warehouseId:       dto.warehouseId,
        supplierInvoiceNo: dto.supplierInvoiceNo,
        purchaseDate,
        status:      dueAmount > 0 ? "PARTIALLY_PAID" : "CONFIRMED",
        subtotal,
        vatAmount,
        totalAmount,
        paidAmount,
        dueAmount,
        notes: dto.notes,
      },
    });

    // ── 4. Create PurchaseOrderItems + update stock ──────────────────────────
    const itemResults: Array<{
      variantId: string;
      newAvgCost: number;
      sku: string;
    }> = [];

    for (const item of dto.items) {
      const variant = await tx.productVariant.findUnique({
        where: { id: item.variantId },
        select: { id: true, stock: true, avgCost: true, price: true },
      });
      if (!variant)
        throw new Error(`Variant ${item.variantId} (SKU: ${item.sku}) not found`);

      const newAvgCost = calcWeightedAvg({
        prevStock:    variant.stock,
        prevAvgCost:  variant.avgCost ?? 0,
        incomingQty:  item.quantity,
        incomingCost: item.unitCost,
      });

      await tx.purchaseOrderItem.create({
        data: {
          purchaseOrderId: po.id,
          variantId:   item.variantId,
          productName: item.productName,
          variantName: item.variantName,
          sku:         item.sku,
          quantity:    item.quantity,
          unitCost:    item.unitCost,
          total:       item.quantity * item.unitCost,
          newAvgCost:  parseFloat(newAvgCost.toFixed(4)),
          sellPrice:   item.sellPrice,
          expiryDate:  item.expiryDate ? new Date(item.expiryDate) : null,
        },
      });

      await tx.warehouseStock.upsert({
        where: {
          variantId_warehouseId: {
            variantId:   item.variantId,
            warehouseId: dto.warehouseId,
          },
        },
        update: { quantity: { increment: item.quantity } },
        create: {
          variantId:   item.variantId,
          warehouseId: dto.warehouseId,
          quantity:    item.quantity,
          reservedQty: 0,
          damagedQty:  0,
        },
      });

      await tx.productVariant.update({
        where: { id: item.variantId },
        data: {
          stock:    { increment: item.quantity },
          avgCost:  parseFloat(newAvgCost.toFixed(4)),
          price:    item.sellPrice > 0 ? item.sellPrice : variant.price,
        },
      });

      await tx.stockMovement.create({
        data: {
          variantId:     item.variantId,
          toWarehouseId: dto.warehouseId,
          movementType:  "PURCHASE_RECEIVE",
          quantity:      item.quantity,
          reason:        `Purchase Order: ${purchaseNo}`,
          notes:         dto.notes,
          referenceId:   po.id,
          createdBy,
        },
      });

      itemResults.push({ variantId: item.variantId, newAvgCost, sku: item.sku });
    }

    // ── 5. PURCHASE VOUCHER ──────────────────────────────────────────────────
    // COA IDs (inventoryCoaId, vatCoaId, supplierCoaId) were resolved
    // pre-transaction and are committed — FK-safe.
    const pvNumber = await nextVoucherNumber(
      tx, "PURCHASE", dto.entityType, dto.entityId,
    );

    const purchaseEntries: VoucherEntryInput[] = [
      {
        accountId:     inventoryCoaId,
        debitAmount:   subtotal,
        description:   `Inventory purchase — ${purchaseNo}`,
        referenceType: "purchase_order",
        referenceId:   po.id,
      },
    ];

    if (vatAmount > 0 && vatCoaId) {
      purchaseEntries.push({
        accountId:     vatCoaId,
        debitAmount:   vatAmount,
        description:   `VAT input tax — ${purchaseNo}`,
        referenceType: "purchase_order",
        referenceId:   po.id,
      });
    }

    purchaseEntries.push({
      accountId:     supplierCoaId,
      creditAmount:  totalAmount,
      description:   `Payable to ${supplier.name} — ${purchaseNo}`,
      referenceType: "purchase_order",
      referenceId:   po.id,
    });

    const purchaseVoucher = await tx.voucher.create({
      data: {
        voucherNumber: pvNumber,
        voucherType:   "PURCHASE",
        entityType:    dto.entityType,
        entityId:      dto.entityId ?? null,
        voucherDate:   purchaseDate,
        narration:     `Purchase from ${supplier.name} | Ref: ${purchaseNo}`,
        totalDebit:    new Decimal(subtotal + vatAmount),
        totalCredit:   new Decimal(totalAmount),
        status:        "POSTED",
        isAuto:        true,
        eventType:     "PURCHASE_CREATED",
        referenceType: "purchase_order",
        referenceId:   po.id,
        postingDate:   new Date(),
        postedBy:      createdBy ?? "system",
        createdBy:     createdBy ?? "system",
      },
    });

    for (const entry of purchaseEntries) {
      // Verify the account exists in committed storage before inserting
      const acctExists = await prisma.chartOfAccount.findUnique({
        where: { id: entry.accountId },
        select: { id: true },
      });
      if (!acctExists) {
        throw new Error(
          `FATAL: accountId "${entry.accountId}" not found in chartOfAccount ` +
          `(description: "${entry.description}"). ` +
          `This means the COA row was not committed before the transaction opened. ` +
          `supplierCoaId=${supplierCoaId} inventoryCoaId=${inventoryCoaId} vatCoaId=${vatCoaId}`,
        );
      }
      await tx.ledgerEntry.create({
        data: {
          voucherId:     purchaseVoucher.id,
          accountId:     entry.accountId,
          debitAmount:   new Decimal(entry.debitAmount ?? 0),
          creditAmount:  new Decimal(entry.creditAmount ?? 0),
          entityType:    dto.entityType,
          entityId:      dto.entityId ?? null,
          description:   entry.description,
          referenceType: entry.referenceType,
          referenceId:   entry.referenceId,
          entryDate:     purchaseDate,
        },
      });
    }

    // ── 7. PAYMENT VOUCHER (only when paidAmount > 0) ────────────────────────
    let paymentVoucher = null;
    if (paidAmount > 0) {
      // bankCoaId resolved pre-transaction — already committed, FK-safe

      const payVNumber = await nextVoucherNumber(
        tx, "PAYMENT", dto.entityType, dto.entityId,
      );

      paymentVoucher = await tx.voucher.create({
        data: {
          voucherNumber: payVNumber,
          voucherType:   "PAYMENT",
          entityType:    dto.entityType,
          entityId:      dto.entityId ?? null,
          voucherDate:   purchaseDate,
          narration:     `Payment to ${supplier.name} | Ref: ${purchaseNo}`,
          totalDebit:    new Decimal(paidAmount),
          totalCredit:   new Decimal(paidAmount),
          status:        "POSTED",
          isAuto:        true,
          eventType:     "PURCHASE_PAYMENT",
          referenceType: "purchase_order",
          referenceId:   po.id,
          postingDate:   new Date(),
          postedBy:      createdBy ?? "system",
          createdBy:     createdBy ?? "system",
        },
      });

      await tx.ledgerEntry.create({
        data: {
          voucherId:     paymentVoucher.id,
          accountId:     supplierCoaId,
          debitAmount:   new Decimal(paidAmount),
          entityType:    dto.entityType,
          entityId:      dto.entityId ?? null,
          description:   `Reduce payable — ${purchaseNo}`,
          referenceType: "purchase_order",
          referenceId:   po.id,
          entryDate:     purchaseDate,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          voucherId:     paymentVoucher.id,
          accountId:     bankCoaId,
          creditAmount:  new Decimal(paidAmount),
          entityType:    dto.entityType,
          entityId:      dto.entityId ?? null,
          description:   `Cash/bank paid — ${purchaseNo}`,
          referenceType: "purchase_order",
          referenceId:   po.id,
          entryDate:     purchaseDate,
        },
      });

      await tx.purchasePayment.create({
        data: {
          purchaseOrderId: po.id,
          amount:          paidAmount,
          method:          dto.paymentMethod ?? "Bank Transfer",
          coaAccountId:    bankCoaId,
          reference:       dto.paymentReference,
          voucherId:       paymentVoucher.id,
        },
      });
    }

    return { purchaseOrder: po, purchaseVoucher, paymentVoucher, itemResults };
  });

  // Return full PO with relations
  const full = await prisma.purchaseOrder.findUnique({
    where: { id: result.purchaseOrder.id },
    include: {
      supplier: { select: { id: true, name: true, phone: true, email: true } },
      warehouse: { select: { id: true, name: true } },
      items:    true,
      payments: true,
    },
  });

  return {
    ...full,
    vouchers: [
      result.purchaseVoucher,
      ...(result.paymentVoucher ? [result.paymentVoucher] : []),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAY PURCHASE DUE
// ─────────────────────────────────────────────────────────────────────────────
export async function payPurchaseDue(
  poId: string,
  dto: PayPurchaseDueDTO,
  createdBy?: string,
) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      supplier: {
        include: { coaAccount: { select: { id: true, name: true } } },
      },
    },
  });
  if (!po)              throw new Error("Purchase order not found");
  if (po.dueAmount <= 0) throw new Error("No outstanding due on this purchase order");
  if (dto.amount <= 0)   throw new Error("Payment amount must be > 0");
  if (dto.amount > po.dueAmount) {
    throw new Error(
      `Amount $${dto.amount} exceeds outstanding due $${po.dueAmount.toFixed(2)}`,
    );
  }
  if (!po.supplier.coaAccount) throw new Error("Supplier AP account not found");

  const newPaid  = parseFloat((po.paidAmount + dto.amount).toFixed(4));
  const newDue   = parseFloat((po.dueAmount  - dto.amount).toFixed(4));
  const newStatus = newDue <= 0 ? "CONFIRMED" : "PARTIALLY_PAID";
  const payDate  = new Date();

  const result = await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: poId },
      data: { paidAmount: newPaid, dueAmount: newDue, status: newStatus },
    });

    const pvNumber = await nextVoucherNumber(
      tx, "PAYMENT", dto.entityType, dto.entityId,
    );

    const voucher = await tx.voucher.create({
      data: {
        voucherNumber: pvNumber,
        voucherType:   "PAYMENT",
        entityType:    dto.entityType,
        entityId:      dto.entityId ?? null,
        voucherDate:   payDate,
        narration:     `Due payment to ${po.supplier.name} | Ref: ${po.purchaseNo}`,
        totalDebit:    new Decimal(dto.amount),
        totalCredit:   new Decimal(dto.amount),
        status:        "POSTED",
        isAuto:        false,
        referenceType: "purchase_order",
        referenceId:   po.id,
        postingDate:   payDate,
        postedBy:      createdBy ?? "system",
        createdBy:     createdBy ?? "system",
      },
    });

    await tx.ledgerEntry.create({
      data: {
        voucherId:     voucher.id,
        accountId:     po.supplier.coaAccount!.id,
        debitAmount:   new Decimal(dto.amount),
        entityType:    dto.entityType,
        entityId:      dto.entityId ?? null,
        description:   `Reduce payable — ${po.purchaseNo}`,
        referenceType: "purchase_order",
        referenceId:   po.id,
        entryDate:     payDate,
      },
    });

    await tx.ledgerEntry.create({
      data: {
        voucherId:     voucher.id,
        accountId:     dto.coaAccountId,
        creditAmount:  new Decimal(dto.amount),
        entityType:    dto.entityType,
        entityId:      dto.entityId ?? null,
        description:   `Bank/cash paid — ${po.purchaseNo}`,
        referenceType: "purchase_order",
        referenceId:   po.id,
        entryDate:     payDate,
      },
    });

    await tx.purchasePayment.create({
      data: {
        purchaseOrderId: po.id,
        amount:          dto.amount,
        method:          dto.method,
        coaAccountId:    dto.coaAccountId,
        reference:       dto.reference,
        voucherId:       voucher.id,
      },
    });

    return voucher;
  });

  return {
    purchaseOrderId: poId,
    purchaseNo:      po.purchaseNo,
    amountPaid:      dto.amount,
    newDue,
    newStatus,
    voucherNumber:   result.voucherNumber,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────────
export async function listPurchaseOrders(query: PurchaseOrderListQuery) {
  const page  = query.page  ?? 1;
  const limit = query.limit ?? 20;
  const skip  = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (query.supplierId)  where.supplierId  = query.supplierId;
  if (query.warehouseId) where.warehouseId = query.warehouseId;
  if (query.status)      where.status      = query.status;
  if (query.search) {
    where.OR = [
      { purchaseNo: { contains: query.search, mode: "insensitive" } },
      { supplier: { name: { contains: query.search, mode: "insensitive" } } },
    ];
  }
  if (query.startDate || query.endDate) {
    const dateFilter: Record<string, Date> = {};
    if (query.startDate) dateFilter.gte = new Date(query.startDate);
    if (query.endDate)   dateFilter.lte = new Date(query.endDate);
    where.purchaseDate = dateFilter;
  }

  const [orders, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: {
        supplier:  { select: { id: true, name: true } },
        warehouse: { select: { id: true, name: true } },
        items: {
          select: {
            id: true, productName: true, variantName: true,
            quantity: true, total: true,
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
    _sum:   { totalAmount: true, paidAmount: true, dueAmount: true },
    _count: { id: true },
  });

  return {
    data: orders,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    stats: {
      count:      agg._count.id,
      totalValue: agg._sum.totalAmount ?? 0,
      totalPaid:  agg._sum.paidAmount  ?? 0,
      totalDue:   agg._sum.dueAmount   ?? 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ONE (full detail with vouchers)
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
      payments: true,
    },
  });
  if (!po) throw new Error("Purchase order not found");

  const vouchers = await prisma.voucher.findMany({
    where: { referenceType: "purchase_order", referenceId: po.id },
    include: { ledgerEntries: { include: { account: true } } },
    orderBy: { voucherDate: "asc" },
  });

  return { ...po, vouchers };
}