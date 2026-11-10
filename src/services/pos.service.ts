// src/services/pos.service.ts
//
// Vendor POS — every method takes the vendor scope resolved by the session
// gate (never a client-supplied vendorId) and scopes every read/write to it.
// Records of another vendor are reported as "not found" (no existence leak).
//
// Money/stock consistency: a sale, refund, void or due collection runs in ONE
// interactive transaction on the direct (non-pooled) client — the POS row(s),
// stock deltas, stock movements and the accounting voucher (posted through
// AccountingService on the same transaction client) commit or roll back
// together. runStockMutation (Serializable + P2034 retry) is the existing
// stock-write pattern; nothing here opens a nested transaction.
//
// Customer credit: PosCustomer.due is the one authoritative outstanding debt
// (loanBalance is kept equal to it). A credit sale may only take a customer to
// due + newDue <= loanLimit (loanLimit 0 = no credit facility); the check is a
// single conditional UPDATE of the customer row inside the sale's Serializable
// transaction, so concurrent sales cannot both spend the same headroom.
// Refunds/voids cancel the unpaid due first and pay back only collected money.

import {
  Prisma,
  PosPaymentMethod,
  DiscountValueType,
  PosSaleStatus,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma, prismaDirect } from "../config/prisma.ts";
import { AccountingService, posVoucherIdempotencyKey } from "./accounting.services.ts";
import { applyStockDelta, runStockMutation } from "../modules/shared/stock-mutations.ts";
import { AppError } from "../middlewares/error.middleware.ts";
import { posActorCan, type PosActor } from "../middlewares/pos-auth.middleware.ts";

const accountingService = new AccountingService();

const PAYMENT_LABEL: Record<PosPaymentMethod, string> = {
  CASH: "Cash",
  CARD: "Card",
  BKASH: "bKash",
  NAGAD: "Nagad",
  ROCKET: "Rocket",
  BANK_TRANSFER: "Bank Transfer",
  OTHER: "Other",
};
const PAYMENT_METHODS = Object.keys(PAYMENT_LABEL) as PosPaymentMethod[];

const MAX_LINES = 200;
const MAX_QTY = 100_000;
const EPS = 0.005; // money comparisons on Float columns (2-dp values)

// ─── input shapes (client-supplied; everything is re-validated) ───────────

export interface SaleItemInput {
  variantId?: string | null;
  /** Custom (non-catalog) lines only — catalog lines use the product's own name. */
  name?: string;
  icon?: string | null;
  qty: number;
  /** Custom lines only — catalog lines are priced from the variant. */
  price?: number;
  /** Custom lines only. */
  taxRate?: number;
  warehouseId?: string | null;
  rackId?: string | null;
}

export interface CreateSaleInput {
  /** One id per checkout attempt (UUID from the terminal). A retry/double submit
   *  with the same id returns the already-created sale instead of selling twice. */
  clientRequestId?: string | null;
  customerId?: string | null;
  customerName?: string;
  bankAccountId?: string | null;
  items: SaleItemInput[];
  discountAmount?: number;
  discountPct?: number;
  discountType?: DiscountValueType;
  paidAmount: number;
  extraAmount?: number;
  dueCutAmount?: number;
  walletAddAmount?: number;
  paymentMethod: PosPaymentMethod;
  note?: string;
}

export interface RefundSaleInput {
  items?: Array<{ saleItemId: string; qty: number }>; // omit = refund everything not yet refunded
  reason?: string;
  paymentMethod?: PosPaymentMethod;
  /** One id per refund attempt: a repeat (even after the first completed) returns the first refund. */
  clientRequestId?: string | null;
}

export interface DuePaymentInput {
  payingAmount: number;
  paymentMethod: PosPaymentMethod;
  note?: string;
  /** One id per collection attempt: a repeat (even after the first completed) returns the first collection. */
  clientRequestId?: string | null;
}

export interface SaleListFilters {
  vendorId: string;
  status?: PosSaleStatus;
  customerId?: string;
  staffId?: string;
  startDate?: Date;
  endDate?: Date;
  q?: string;
  page?: number;
  limit?: number;
}

export type { PosActor };

// ─── validation helpers ───────────────────────────────────────────────────

const bad = (msg: string) => new AppError(msg, 400);
const notFound = (what: string) => new AppError(`${what} not found`, 404);
const forbidden = (msg: string) => new AppError(msg, 403);

const money2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** A client operation id (same format as a sale's clientRequestId), or null when not sent. */
function operationId(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(v)) throw bad("clientRequestId is invalid");
  return v;
}
const refundRef = (invoiceNo: string, opId: string) => `${invoiceNo}-R-${opId}`;

/**
 * Store statuses that may not open NEW POS sales (admin suspend / deactivate).
 * PENDING (onboarding) and ACTIVE may sell, subject to the subscription gate.
 * Refunds, voids and due collection stay available so existing obligations can
 * still be settled.
 */
const SALE_BLOCKED_STORE_STATUSES: ReadonlySet<string> = new Set(["SUSPENDED", "DEACTIVATED"]);
const collectionRef = (invoiceNo: string, opId: string) => `${invoiceNo}-DP-${opId}`;

/** Credit terms whose changes are audited (AuditLog, action POS_CREDIT_TERMS_CHANGED). */
const CREDIT_TERM_KEYS = ["loanLimit", "loanInterestRate", "loanTenureDays"] as const;

/** The credit rule on authoritative values: a facility exists and due + needed stays within it. */
function withinCredit(c: { loanLimit: number; due: number }, needed: number): boolean {
  const limit = Number(c.loanLimit) || 0;
  return limit > 0 && (Number(c.due) || 0) + needed <= limit + EPS;
}

/**
 * The only statements that change a POS customer's balances. Exported so the
 * Postgres-backed test runs exactly this SQL.
 */
export const posCustomerSql = {
  /** A committed sale: adds its due within the credit rule, counts the order. Affects 0 rows when refused. */
  sale: (customerId: string, vendorId: string, dueAmount: number, netBilling: number, saleDate: Date) => Prisma.sql`
    UPDATE "pos_customers"
       SET "due" = "due" + ${dueAmount}::double precision,
           "loanBalance" = "due" + ${dueAmount}::double precision,
           "orders" = "orders" + 1,
           "spent" = "spent" + ${netBilling}::double precision,
           "lastOrderAt" = ${saleDate.toISOString()}::timestamptz AT TIME ZONE 'UTC',
           "updatedAt" = NOW() AT TIME ZONE 'UTC'
     WHERE "id" = ${customerId} AND "vendorId" = ${vendorId}
       AND (${dueAmount}::double precision <= 0
            OR ("loanLimit" > 0 AND "due" + ${dueAmount}::double precision <= "loanLimit" + ${EPS}::double precision))`,
  /** A refund / void: cancels the unpaid part from the due, takes the refunded value off spent. */
  reverse: (customerId: string, vendorId: string, dueReduced: number, refundNet: number, isVoid: boolean) => Prisma.sql`
    UPDATE "pos_customers"
       SET "due" = GREATEST("due" - ${dueReduced}::double precision, 0),
           "loanBalance" = GREATEST("due" - ${dueReduced}::double precision, 0),
           "spent" = GREATEST("spent" - ${refundNet}::double precision, 0),
           "orders" = GREATEST("orders" - ${isVoid ? 1 : 0}::integer, 0),
           "updatedAt" = NOW() AT TIME ZONE 'UTC'
     WHERE "id" = ${customerId} AND "vendorId" = ${vendorId}`,
  /** A due collection. */
  collect: (customerId: string, vendorId: string, paying: number) => Prisma.sql`
    UPDATE "pos_customers"
       SET "due" = GREATEST("due" - ${paying}::double precision, 0),
           "loanBalance" = GREATEST("due" - ${paying}::double precision, 0),
           "updatedAt" = NOW() AT TIME ZONE 'UTC'
     WHERE "id" = ${customerId} AND "vendorId" = ${vendorId}`,
};

/** Why a credit sale was refused — the terminal shows this message as-is. */
function creditRefusal(c: { loanLimit: number; due: number }, needed: number): AppError {
  const limit = Number(c.loanLimit) || 0;
  if (limit <= 0) return new AppError("This customer has no credit facility — take full payment or set a credit limit first", 409);
  const available = Math.max(limit - (Number(c.due) || 0), 0);
  return new AppError(`Credit limit exceeded: ${money2(available)} available of ${money2(limit)}, this sale needs ${money2(needed)}`, 409);
}

function money(v: unknown, field: string, { required = false } = {}): number {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`${field} is required`);
    return 0;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${field} must be a non-negative number`);
  if (n > 1e12) throw bad(`${field} is too large`);
  return Math.round(n * 100) / 100;
}

function qtyOf(v: unknown, field = "qty"): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) throw bad(`${field} must be a whole number between 1 and ${MAX_QTY}`);
  return n;
}

function str(v: unknown, field: string, { required = false, max = 200 } = {}): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw bad(`${field} must be text`);
  const t = v.trim();
  if (required && !t) throw bad(`${field} is required`);
  if (t.length > max) throw bad(`${field} is too long (max ${max})`);
  return t;
}

function id(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 64) throw bad(`${field} is invalid`);
  return v;
}

function paymentMethod(v: unknown, fallback?: PosPaymentMethod): PosPaymentMethod {
  if ((v === undefined || v === null || v === "") && fallback) return fallback;
  if (!PAYMENT_METHODS.includes(v as PosPaymentMethod)) throw bad("paymentMethod is invalid");
  return v as PosPaymentMethod;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function posTx<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return runStockMutation(prismaDirect, work);
}

export class PosService {
  // ============================================
  // 0. PRODUCT LOOKUP (barcode / SKU scan) — vendor's own catalog only
  // ============================================

  async findVariantByCode(vendorId: string, code: string) {
    const trimmed = (code || "").trim();
    if (!trimmed) throw bad("Barcode/SKU is required");
    if (trimmed.length > 64) throw bad("Barcode/SKU is too long");

    const variant = await prisma.productVariant.findFirst({
      where: { OR: [{ barcode: trimmed }, { sku: trimmed }], product: { vendorId } },
      include: {
        product: { select: { id: true, name: true, nameBn: true, vendorId: true } },
        images: { take: 1, orderBy: { sortOrder: "asc" } },
      },
    });
    if (!variant) throw new AppError(`No product found for code "${trimmed}"`, 404);

    const availableQty = variant.stock - (variant.reservedQty ?? 0) - (variant.damagedQty ?? 0);
    return {
      variantId: variant.id,
      productId: variant.product.id,
      name: variant.name ? `${variant.product.name} - ${variant.name}` : variant.product.name,
      sku: variant.sku,
      barcode: variant.barcode,
      price: Number(variant.specialPrice ?? variant.price),
      taxRate: Number(variant.taxRate),
      image: variant.images[0]?.url ?? null,
      availableQty,
      availability: variant.availability,
    };
  }

  /**
   * The terminal's product grid: this vendor's sellable variants with the
   * stock that a POS sale can actually take — per active warehouse/rack, from
   * the same stock rows applyStockDelta deducts (no row/shelf slots).
   * Price and tax are shown for convenience; createSale re-prices on the server.
   */
  async listProducts(vendorId: string, opts: { q?: string; take?: number } = {}) {
    const q = typeof opts.q === "string" ? opts.q.trim().slice(0, 64) : "";
    const take = Math.min(Math.max(1, opts.take ?? 60), 200);
    const variants = await prisma.productVariant.findMany({
      where: {
        product: { vendorId, isDeleted: false },
        availability: { not: false },
        ...(q
          ? {
              OR: [
                { sku: { contains: q, mode: "insensitive" } },
                { barcode: q },
                { name: { contains: q, mode: "insensitive" } },
                { product: { name: { contains: q, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      select: {
        id: true, name: true, sku: true, barcode: true, price: true, specialPrice: true, taxRate: true,
        product: { select: { id: true, name: true, category: { select: { name: true } } } },
        images: { take: 1, orderBy: { sortOrder: "asc" }, select: { url: true } },
        warehouseStock: {
          where: { warehouse: { vendorId, isActive: true }, rowNumber: null, shelfNumber: null },
          select: {
            warehouseId: true, rackId: true, quantity: true, reservedQty: true, damagedQty: true,
            warehouse: { select: { name: true, isDefault: true } },
            rack: { select: { code: true } },
          },
        },
      },
      orderBy: { product: { name: "asc" } },
      take,
    });
    return variants.map((v) => {
      const locations = v.warehouseStock
        .map((w) => ({
          warehouseId: w.warehouseId,
          warehouseName: w.warehouse.name ?? "Warehouse",
          isDefault: w.warehouse.isDefault,
          rackId: w.rackId,
          rackCode: w.rack?.code ?? null,
          available: Math.max(0, w.quantity - w.reservedQty - w.damagedQty),
        }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.available - a.available);
      return {
        variantId: v.id,
        productId: v.product.id,
        name: v.name ? `${v.product.name} - ${v.name}` : v.product.name,
        category: v.product.category?.name ?? "Other",
        sku: v.sku,
        barcode: v.barcode,
        price: Number(v.specialPrice ?? v.price),
        taxRate: Number(v.taxRate),
        image: v.images[0]?.url ?? null,
        locations,
        totalAvailable: locations.reduce((s, l) => s + l.available, 0),
      };
    });
  }

  // ============================================
  // 1. SALE LIFECYCLE
  // ============================================

  /**
   * Catalog lines (variantId) are priced, costed and taxed from the vendor's
   * own variant — client price/cost/tax for them are ignored. A catalog line
   * must name one of the vendor's active warehouses (and, optionally, a rack
   * inside it) so the stock really moves. Custom lines (no variantId) carry
   * their own price and never touch stock.
   */
  async createSale(vendorId: string, actor: PosActor, input: CreateSaleInput) {
    if (!input || !Array.isArray(input.items) || input.items.length === 0) throw bad("Sale must have at least one item");
    // Store status from the database (never the request), before anything else is read or written.
    const store = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { status: true } });
    if (!store) throw notFound("Store");
    if (SALE_BLOCKED_STORE_STATUSES.has(store.status)) {
      throw new AppError(`This store is ${store.status.toLowerCase()} — new POS sales are paused. Refunds and due collection are still available.`, 403);
    }
    const clientRequestId = input.clientRequestId == null || input.clientRequestId === "" ? null : String(input.clientRequestId);
    if (clientRequestId !== null && !/^[A-Za-z0-9-]{8,64}$/.test(clientRequestId)) throw bad("clientRequestId is invalid");
    if (clientRequestId) {
      const prior = await prisma.posSale.findFirst({ where: { vendorId, clientRequestId }, select: { id: true } });
      if (prior) return { sale: await this.getSaleById(vendorId, prior.id), change: 0, duplicate: true };
    }
    if (input.items.length > MAX_LINES) throw bad(`A sale can have at most ${MAX_LINES} lines`);
    const method = paymentMethod(input.paymentMethod);

    // ---- ownership: variants, warehouses, racks, customer, bank account ----
    const variantIds = [...new Set(input.items.map((i) => id(i.variantId, "variantId")).filter(Boolean) as string[])];
    const warehouseIds = [...new Set(input.items.map((i) => id(i.warehouseId, "warehouseId")).filter(Boolean) as string[])];
    const rackIds = [...new Set(input.items.map((i) => id(i.rackId, "rackId")).filter(Boolean) as string[])];

    const [variants, warehouses, racks] = await Promise.all([
      variantIds.length
        ? prisma.productVariant.findMany({
            where: { id: { in: variantIds }, product: { vendorId } },
            select: { id: true, name: true, price: true, specialPrice: true, avgCost: true, taxRate: true, product: { select: { name: true } } },
          })
        : Promise.resolve([]),
      warehouseIds.length
        ? prisma.vendorWarehouse.findMany({ where: { id: { in: warehouseIds }, vendorId }, select: { id: true, isActive: true } })
        : Promise.resolve([]),
      rackIds.length
        ? prisma.warehouseRack.findMany({ where: { id: { in: rackIds } }, select: { id: true, warehouseId: true } })
        : Promise.resolve([]),
    ]);
    const variantById = new Map(variants.map((v) => [v.id, v]));
    const warehouseById = new Map(warehouses.map((w) => [w.id, w]));
    const rackById = new Map(racks.map((r) => [r.id, r]));

    const lines = input.items.map((raw, idx) => {
      const n = idx + 1;
      const qty = qtyOf(raw.qty, `items[${n}].qty`);
      const variantId = id(raw.variantId, `items[${n}].variantId`);
      const warehouseId = id(raw.warehouseId, `items[${n}].warehouseId`);
      const rackId = id(raw.rackId, `items[${n}].rackId`);
      const icon = str(raw.icon, `items[${n}].icon`, { max: 32 }) ?? null;
      if (variantId) {
        const v = variantById.get(variantId);
        if (!v) throw notFound(`Product on line ${n}`);
        if (!warehouseId) throw bad(`Line ${n}: choose the warehouse the item is sold from`);
        const w = warehouseById.get(warehouseId);
        if (!w) throw notFound(`Warehouse on line ${n}`);
        if (!w.isActive) throw new AppError(`Line ${n}: warehouse is deactivated`, 409);
        if (rackId) {
          const r = rackById.get(rackId);
          if (!r || r.warehouseId !== warehouseId) throw notFound(`Rack on line ${n}`);
        }
        return {
          variantId,
          warehouseId,
          rackId,
          icon,
          qty,
          name: v.name ? `${v.product.name} - ${v.name}` : v.product.name,
          price: Number(v.specialPrice ?? v.price),
          cost: Number(v.avgCost ?? 0),
          taxRate: Number(v.taxRate ?? 0),
        };
      }
      if (warehouseId || rackId) throw bad(`Line ${n}: a warehouse can only be set for catalog products`);
      const taxRate = money(raw.taxRate, `items[${n}].taxRate`);
      if (taxRate > 100) throw bad(`items[${n}].taxRate must be at most 100`);
      return {
        variantId: null,
        warehouseId: null,
        rackId: null,
        icon,
        qty,
        name: str(raw.name, `items[${n}].name`, { required: true, max: 200 })!,
        price: money(raw.price, `items[${n}].price`, { required: true }),
        cost: 0,
        taxRate,
      };
    });

    const customerId = id(input.customerId, "customerId");
    const bankAccountId = id(input.bankAccountId, "bankAccountId");
    const [customer, bankAccount] = await Promise.all([
      customerId ? prisma.posCustomer.findFirst({ where: { id: customerId, vendorId }, select: { id: true, name: true, loanLimit: true, due: true } }) : null,
      bankAccountId ? prisma.posBankAccount.findFirst({ where: { id: bankAccountId, vendorId }, select: { id: true } }) : null,
    ]);
    if (customerId && !customer) throw notFound("Customer");
    if (bankAccountId && !bankAccount) throw notFound("Bank account");

    // ---- totals (server-side) ----
    const subtotal = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
    const cogs = round2(lines.reduce((s, l) => s + l.cost * l.qty, 0));
    const discountType: DiscountValueType = input.discountType === "FLAT" ? "FLAT" : "PERCENT";
    const discountPct = discountType === "PERCENT" ? money(input.discountPct, "discountPct") : 0;
    if (discountPct > 100) throw bad("discountPct must be at most 100");
    const discountAmount =
      discountType === "PERCENT" ? round2(subtotal * (discountPct / 100)) : money(input.discountAmount, "discountAmount");
    if (discountAmount > subtotal + EPS) throw bad("Discount cannot exceed the subtotal");
    // Extra charges, due write-offs and wallet top-ups have no accounting yet
    // (the sale voucher has no entry for them, so a non-zero value unbalances
    // it) and there is no customer-wallet ledger — refuse them explicitly.
    for (const k of ["extraAmount", "dueCutAmount", "walletAddAmount"] as const) {
      if (money(input[k], k) > 0) throw bad(`${k} is not supported at the POS — send 0 or leave it out`);
    }
    const extraAmount = 0;
    const dueCutAmount = 0;
    const walletAddAmount = 0;
    const tendered = money(input.paidAmount, "paidAmount", { required: true });

    // ---- per-action terminal permissions (never trust the UI) ----
    if (discountAmount > 0 && !posActorCan(actor, "posDiscount")) {
      throw forbidden("You don't have permission to give discounts");
    }

    const taxableBase = subtotal - discountAmount;
    const taxAmount = round2(
      lines.reduce((s, l) => {
        const share = subtotal > 0 ? (l.price * l.qty) / subtotal : 0;
        return s + taxableBase * share * (l.taxRate / 100);
      }, 0),
    );
    const netBilling = round2(taxableBase + taxAmount + extraAmount);
    // Money handed over above the bill is change returned to the customer — it
    // is not revenue (posting it would unbalance the sale voucher).
    const change = Math.max(round2(tendered - netBilling), 0);
    const paidAmount = round2(tendered - change);
    const dueAmount = Math.max(round2(netBilling - paidAmount - dueCutAmount), 0);
    if (dueAmount > 0) {
      if (!customer) throw bad("Select a customer to sell on credit");
      if (!posActorCan(actor, "posCredit")) throw forbidden("You don't have permission to sell on credit");
      // Early, readable refusal; the authoritative check runs in the transaction.
      if (!withinCredit(customer, dueAmount)) throw creditRefusal(customer, dueAmount);
    }
    const note = str(input.note, "note", { max: 500 });
    const saleDate = new Date(); // server time — sales can't be back-dated from the terminal
    const settings = await this.getOrCreateSettings(vendorId);

    // Create the customer-receivable account (first credit sale of a store
    // seeded before it existed) OUTSIDE the sale transaction, so a race between
    // two first sales can't abort either of them (see ensurePosCustomerReceivableIn).
    if (customer && dueAmount > 0) await accountingService.ensurePosCustomerReceivableIn(undefined, vendorId);

    let saleId: string;
    try {
      saleId = await posTx(async (tx) => {
      // Re-check availability inside the transaction (rack-aware).
      for (const l of lines) {
        if (!l.variantId || !l.warehouseId) continue;
        // The exact row applyStockDelta deducts from (no row/shelf slot).
        const stock = await tx.warehouseStock.findFirst({
          where: { variantId: l.variantId, warehouseId: l.warehouseId, rackId: l.rackId ?? null, rowNumber: null, shelfNumber: null },
        });
        const available = (stock?.quantity ?? 0) - (stock?.reservedQty ?? 0) - (stock?.damagedQty ?? 0);
        if (available < l.qty) {
          throw new AppError(`Insufficient stock for "${l.name}" at this location: available ${available}, requested ${l.qty}`, 409);
        }
      }

      const invoiceNo = await this.generateSequence(tx, vendorId, settings.invoicePrefix, "invoiceNo");
      const voucherNo = await this.generateSequence(tx, vendorId, settings.voucherPrefix, "voucherNo");

      const created = await tx.posSale.create({
        data: {
          vendorId,
          invoiceNo,
          voucherNo,
          staffId: null, // legacy PosStaff attribution — no longer written
          soldByUserId: actor.userId,
          soldByEmployeeId: actor.employeeId,
          clientRequestId,
          customerId: customer?.id ?? null,
          bankAccountId: bankAccount?.id ?? null,
          isWalkIn: !customer,
          subtotal,
          discountAmount,
          discountPct,
          discountType,
          taxAmount,
          netBilling,
          paidAmount,
          dueAmount,
          extraAmount,
          dueCutAmount,
          walletAddAmount,
          cogs,
          paymentMethod: method,
          note,
          status: dueAmount > 0 ? "PENDING" : "PAID",
          saleDate,
          items: {
            create: lines.map((l) => ({
              variantId: l.variantId,
              name: l.name,
              icon: l.icon,
              qty: l.qty,
              price: l.price,
              cost: l.cost,
              taxRate: l.taxRate,
              warehouseId: l.warehouseId,
              rackId: l.rackId,
            })),
          },
        },
        include: { items: true },
      });

      for (const item of created.items) {
        if (!item.variantId || !item.warehouseId) continue;
        await applyStockDelta(tx, {
          variantId: item.variantId,
          warehouseId: item.warehouseId,
          rackId: item.rackId,
          quantityDelta: -item.qty,
          reason: `POS sale (${created.invoiceNo})`,
        });
        await tx.stockMovement.create({
          data: {
            variantId: item.variantId,
            fromWarehouseId: item.warehouseId,
            rackId: item.rackId,
            movementType: "SALE_DEDUCT",
            quantity: item.qty,
            reason: "POS Sale",
            posSaleId: created.id,
            createdBy: actor.employeeId ?? actor.userId,
          },
        });
      }

      if (customer) {
        // Authoritative credit check + the customer's running figures, in ONE
        // conditional UPDATE on the customer row. Under Serializable a
        // concurrent sale for the same customer conflicts (40001 → retried by
        // runStockMutation) and is re-checked against the new due.
        const applied = await tx.$executeRaw(posCustomerSql.sale(customer.id, vendorId, dueAmount, netBilling, saleDate));
        if (applied !== 1) {
          const now = await tx.posCustomer.findFirst({ where: { id: customer.id, vendorId }, select: { loanLimit: true, due: true } });
          if (!now) throw notFound("Customer");
          throw creditRefusal(now, dueAmount);
        }
      }

      const voucher = await accountingService.createPOSSaleVoucher(
        {
          invoiceId: created.invoiceNo,
          vendorId,
          customerId: created.customerId,
          customerName: customer?.name ?? str(input.customerName, "customerName", { max: 120 }) ?? "Walk-in Customer",
          items: created.items.map((i) => ({
            productId: i.variantId ?? i.id,
            name: i.name,
            qty: i.qty,
            sellingPrice: new Decimal(i.price),
            costPrice: new Decimal(i.cost),
            vatRate: i.taxRate,
          })),
          subtotal: new Decimal(subtotal),
          discountAmount: new Decimal(discountAmount),
          discountType: discountType === "FLAT" ? "flat" : "pct",
          discountPct,
          vatAmount: new Decimal(taxAmount),
          netBilling: new Decimal(netBilling),
          cogsTotal: new Decimal(cogs),
          paidAmount: new Decimal(paidAmount),
          dueAmount: new Decimal(dueAmount),
          paymentMethod: PAYMENT_LABEL[method],
          saleDate,
        },
        tx,
      );
      if (voucher?.id) {
        await tx.posSale.update({ where: { id: created.id }, data: { accountingVoucherId: voucher.id } });
      }
      return created.id;
    });
    } catch (err: any) {
      // A concurrent submit of the same attempt won the unique (vendorId, clientRequestId):
      // the losing transaction rolled back entirely — return the winner's sale.
      if (clientRequestId && err?.code === "P2002") {
        const prior = await prisma.posSale.findFirst({ where: { vendorId, clientRequestId }, select: { id: true } });
        if (prior) return { sale: await this.getSaleById(vendorId, prior.id), change: 0, duplicate: true };
      }
      throw err;
    }

    return { sale: await this.getSaleById(vendorId, saleId), change, duplicate: false };
  }

  /**
   * Full or partial refund of a sale of THIS vendor. Each line can be refunded
   * at most up to its sold quantity across all refunds (PosSaleItem.refundedQty,
   * incremented conditionally inside the transaction, so concurrent refunds
   * can't over-refund).
   */
  async refundSale(vendorId: string, actor: PosActor, saleId: string, input: RefundSaleInput = {}) {
    const reason = str(input.reason, "reason", { max: 300 }) ?? "POS Refund";
    const by = actor.employeeId ?? actor.userId;
    const opId = operationId(input.clientRequestId);
    try {
      return await posTx((tx) => this.reverseInTx(tx, vendorId, saleId, input.items, reason, input.paymentMethod, false, by, opId));
    } catch (err) {
      // A concurrent twin of this attempt committed first (voucher key unique,
      // or the optimistic sale update lost): ours rolled back — return theirs.
      if (opId) {
        const prior = await this.priorPosVoucher(vendorId, saleId, "REFUND", "POS_SALE_REFUNDED", "pos_refund", (inv) => refundRef(inv, opId));
        if (prior) return { voucher: prior, duplicate: true as const };
      }
      throw err;
    }
  }

  /** The voucher an earlier attempt with the same operation id posted for this vendor's sale, if any. */
  private async priorPosVoucher(
    vendorId: string,
    saleId: string,
    voucherType: string,
    eventType: string,
    refType: string,
    ref: (invoiceNo: string) => string,
  ) {
    const sale = await prisma.posSale.findFirst({ where: { id: id(saleId, "saleId") ?? "", vendorId }, select: { invoiceNo: true } });
    if (!sale) return null;
    return prisma.voucher.findUnique({ where: { idempotencyKey: posVoucherIdempotencyKey(voucherType, eventType, refType, vendorId, ref(sale.invoiceNo)) } });
  }

  /** Same-day cancellation of an untouched sale: full reversal, marked VOIDED. */
  async voidSale(vendorId: string, actor: PosActor, saleId: string, reason: string) {
    const why = str(reason, "reason", { required: true, max: 300 })!;
    return posTx(async (tx) => {
      const result = await this.reverseInTx(tx, vendorId, saleId, undefined, `VOID: ${why}`, undefined, true, actor.employeeId ?? actor.userId);
      const sale = await tx.posSale.findFirstOrThrow({ where: { id: saleId, vendorId }, select: { note: true } });
      await tx.posSale.update({
        where: { id: saleId },
        data: { status: "VOIDED", note: `${sale.note ?? ""} [VOIDED by ${actor.employeeId ? `employee ${actor.employeeId}` : `owner ${actor.userId}`}: ${why}]`.trim() },
      });
      return result;
    });
  }

  private async reverseInTx(
    tx: Prisma.TransactionClient,
    vendorId: string,
    saleId: string,
    requested: RefundSaleInput["items"],
    reason: string,
    method: unknown,
    isVoid: boolean,
    actedBy: string,
    opId: string | null = null,
  ) {
    const sale = await tx.posSale.findFirst({ where: { id: id(saleId, "saleId") ?? "", vendorId }, include: { items: true } });
    if (!sale) throw notFound("Sale");
    // Same refund attempt seen before (it completed): return it, change nothing.
    if (opId) {
      const prior = await tx.voucher.findUnique({
        where: { idempotencyKey: posVoucherIdempotencyKey("REFUND", "POS_SALE_REFUNDED", "pos_refund", vendorId, refundRef(sale.invoiceNo, opId)) },
      });
      if (prior) return { voucher: prior, duplicate: true as const };
    }
    if (sale.status === "REFUNDED" || sale.status === "VOIDED") throw new AppError(`Sale is already ${sale.status.toLowerCase()}`, 409);
    if (isVoid) {
      const today = new Date();
      const d = new Date(sale.saleDate);
      const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
      if (!sameDay) throw new AppError("Only same-day sales can be voided — use a refund instead", 409);
      if (sale.items.some((i) => (i.refundedQty ?? 0) > 0)) throw new AppError("A partly refunded sale can't be voided — refund the rest instead", 409);
    }
    const refundMethod = paymentMethod(method, sale.paymentMethod);

    let lines: { item: (typeof sale.items)[number]; qty: number }[];
    if (requested && requested.length) {
      if (!Array.isArray(requested) || requested.length > MAX_LINES) throw bad("items is invalid");
      const seen = new Set<string>();
      lines = requested.map((r, i) => {
        const itemId = id(r?.saleItemId, `items[${i + 1}].saleItemId`);
        if (!itemId || seen.has(itemId)) throw bad(`items[${i + 1}].saleItemId is invalid or repeated`);
        seen.add(itemId);
        const item = sale.items.find((si) => si.id === itemId);
        if (!item) throw notFound(`Sale line ${i + 1}`);
        const qty = qtyOf(r.qty, `items[${i + 1}].qty`);
        const left = item.qty - (item.refundedQty ?? 0);
        if (qty > left) throw bad(`Refund qty for "${item.name}" exceeds what is left to refund (${left})`);
        return { item, qty };
      });
    } else {
      lines = sale.items.map((item) => ({ item, qty: item.qty - (item.refundedQty ?? 0) })).filter((l) => l.qty > 0);
    }
    if (!lines.length) throw new AppError("Nothing left to refund on this sale", 409);

    const refundSubtotal = round2(lines.reduce((s, l) => s + l.item.price * l.qty, 0));
    const refundCogs = round2(lines.reduce((s, l) => s + l.item.cost * l.qty, 0));
    const ratio = sale.subtotal > 0 ? refundSubtotal / sale.subtotal : 1;
    const refundDiscount = round2(sale.discountAmount * ratio);
    const refundVat = round2(sale.taxAmount * ratio);
    const refundNet = round2(refundSubtotal - refundDiscount + refundVat);

    for (const { item, qty } of lines) {
      // Conditional increment: a concurrent refund of the same line loses.
      const updated = await tx.posSaleItem.updateMany({
        where: { id: item.id, saleId: sale.id, refundedQty: { lte: item.qty - qty } },
        data: { refundedQty: { increment: qty } },
      });
      if (updated.count !== 1) throw new AppError(`"${item.name}" was refunded concurrently — reload and try again`, 409);

      if (item.variantId && item.warehouseId) {
        const wh = await tx.vendorWarehouse.findFirst({ where: { id: item.warehouseId, vendorId }, select: { isActive: true } });
        if (!wh) throw notFound("Warehouse");
        if (!wh.isActive) throw new AppError("The sale's warehouse is deactivated — reactivate it to take stock back", 409);
        await applyStockDelta(tx, {
          variantId: item.variantId,
          warehouseId: item.warehouseId,
          rackId: item.rackId,
          quantityDelta: qty,
          reason: `POS refund (${sale.invoiceNo})`,
        });
        await tx.stockMovement.create({
          data: {
            variantId: item.variantId,
            toWarehouseId: item.warehouseId,
            rackId: item.rackId,
            movementType: "RETURN",
            quantity: qty,
            reason,
            posSaleId: sale.id,
            createdBy: actedBy,
          },
        });
      }
    }

    // Allocation from the persisted sale: the refunded value first cancels what
    // is still unpaid on it; only the rest — money actually collected — is paid
    // back. paidAmount + dueAmount always equals the value not yet refunded.
    const receivableCut = round2(Math.min(refundNet, Math.max(sale.dueAmount, 0)));
    const cashRefund = round2(refundNet - receivableCut);
    if (cashRefund > sale.paidAmount + 0.05) {
      throw new AppError("This refund is more than was collected on the sale — reload and try again", 409);
    }
    const newDue = round2(Math.max(sale.dueAmount - receivableCut, 0));
    const newPaid = round2(Math.max(sale.paidAmount - cashRefund, 0));
    // Optimistic on the values just read: a concurrent refund / collection loses.
    const moved = await tx.posSale.updateMany({
      where: { id: sale.id, vendorId, dueAmount: sale.dueAmount, paidAmount: sale.paidAmount },
      data: { dueAmount: newDue, paidAmount: newPaid },
    });
    if (moved.count !== 1) throw new AppError("The sale changed meanwhile — reload and try again", 409);
    if (sale.customerId) {
      const n = await tx.$executeRaw(posCustomerSql.reverse(sale.customerId, vendorId, receivableCut, refundNet, isVoid));
      if (n !== 1) throw notFound("Customer");
    }
    const receivableAccountId =
      receivableCut > 0 ? await accountingService.posReceivableAccountForSale(tx, vendorId, sale.accountingVoucherId) : undefined;

    const customerName = sale.customerId
      ? (await tx.posCustomer.findFirst({ where: { id: sale.customerId, vendorId }, select: { name: true } }))?.name ?? "Customer"
      : "Walk-in Customer";
    const refundInvoiceNo = opId ? refundRef(sale.invoiceNo, opId) : `${sale.invoiceNo}-R${Date.now().toString(36).toUpperCase()}`;

    const voucher = await accountingService.createPOSRefundVoucher(
      {
        originalInvoiceId: sale.invoiceNo,
        refundInvoiceId: refundInvoiceNo,
        vendorId,
        customerId: sale.customerId,
        customerName,
        refundItems: lines.map(({ item, qty }) => ({
          productId: item.variantId ?? item.id,
          name: item.name,
          qty,
          sellingPrice: new Decimal(item.price),
          costPrice: new Decimal(item.cost),
          vatRate: item.taxRate,
        })),
        refundSubtotal: new Decimal(refundSubtotal),
        refundDiscount: new Decimal(refundDiscount),
        refundVat: new Decimal(refundVat),
        refundNet: new Decimal(refundNet),
        refundCogs: new Decimal(refundCogs),
        paymentMethod: PAYMENT_LABEL[refundMethod],
        refundDate: new Date(),
        cashRefund: new Decimal(cashRefund),
        receivableCut: new Decimal(receivableCut),
        receivableAccountId,
      },
      tx,
    );

    const after = await tx.posSaleItem.findMany({ where: { saleId: sale.id }, select: { qty: true, refundedQty: true } });
    const fullyRefunded = after.every((i) => (i.refundedQty ?? 0) >= i.qty);
    if (fullyRefunded) await tx.posSale.update({ where: { id: sale.id }, data: { status: "REFUNDED" } });
    else if (sale.status === "PENDING" && newDue <= EPS) await tx.posSale.update({ where: { id: sale.id }, data: { status: "PAID" } });

    return { voucher, refundNet, cashRefund, dueReduced: receivableCut, isFullRefund: fullyRefunded, duplicate: false as const };
  }

  /** Collect (part of) an outstanding balance on a sale of THIS vendor. */
  async payDue(vendorId: string, actor: PosActor, saleId: string, input: DuePaymentInput) {
    const paying = money(input?.payingAmount, "payingAmount", { required: true });
    if (paying <= 0) throw bad("payingAmount must be greater than 0");
    const method = paymentMethod(input?.paymentMethod);
    const note = str(input?.note, "note", { max: 300 });
    const opId = operationId(input?.clientRequestId);

    let result: { voucher: unknown; saleId: string; duplicate: boolean };
    try {
    result = await prismaDirect.$transaction(async (tx) => {
      const sale = await tx.posSale.findFirst({ where: { id: id(saleId, "saleId") ?? "", vendorId } });
      if (!sale) throw notFound("Sale");
      // Same collection attempt seen before (it completed): return it, collect nothing.
      if (opId) {
        const prior = await tx.voucher.findUnique({
          where: { idempotencyKey: posVoucherIdempotencyKey("RECEIPT", "POS_DUE_PAYMENT", "pos_due_payment", vendorId, collectionRef(sale.invoiceNo, opId)) },
        });
        if (prior) return { voucher: prior, saleId: sale.id, duplicate: true };
      }
      if (sale.status === "VOIDED" || sale.status === "REFUNDED") throw new AppError(`Sale is ${sale.status.toLowerCase()}`, 409);
      if (!sale.customerId) throw bad("Sale has no linked customer for due payment");
      if (sale.dueAmount <= EPS) throw new AppError("Sale has no outstanding due", 409);
      if (paying > sale.dueAmount + EPS) throw bad(`Paying amount exceeds due (${sale.dueAmount})`);

      // Optimistic on the due just read — a concurrent or double-submitted
      // collection of the same sale loses (409) instead of collecting twice.
      const dec = await tx.posSale.updateMany({
        where: { id: sale.id, vendorId, dueAmount: sale.dueAmount },
        data: { dueAmount: { decrement: paying }, paidAmount: { increment: paying } },
      });
      if (dec.count !== 1) throw new AppError("The due changed meanwhile — reload and try again", 409);
      const now = await tx.posSale.findUniqueOrThrow({ where: { id: sale.id }, select: { dueAmount: true } });
      if (now.dueAmount <= EPS) {
        await tx.posSale.update({ where: { id: sale.id }, data: { dueAmount: 0, status: "PAID" } });
      }

      const customer = await tx.posCustomer.findFirst({ where: { id: sale.customerId, vendorId }, select: { name: true } });
      if (!customer) throw notFound("Customer");
      await tx.$executeRaw(posCustomerSql.collect(sale.customerId, vendorId, paying));
      const receivableAccountId = await accountingService.posReceivableAccountForSale(tx, vendorId, sale.accountingVoucherId);
      const voucher = await accountingService.createPOSDuePaymentVoucher(
        {
          originalInvoiceId: sale.invoiceNo,
          paymentInvoiceId: opId ? collectionRef(sale.invoiceNo, opId) : `${sale.invoiceNo}-DP${Date.now().toString(36).toUpperCase()}`,
          vendorId,
          customerId: sale.customerId,
          customerName: customer.name,
          payingAmount: new Decimal(paying),
          paymentMethod: PAYMENT_LABEL[method],
          paymentDate: new Date(),
          receivableAccountId,
          note: [note, `collected by ${actor.employeeId ? `employee ${actor.employeeId}` : `owner ${actor.userId}`}`].filter(Boolean).join(" · "),
        },
        tx,
      );
      return { voucher, saleId: sale.id, duplicate: false };
    });

    } catch (err) {
      // A concurrent twin of this attempt committed first; ours rolled back.
      if (opId) {
        const prior = await this.priorPosVoucher(vendorId, saleId, "RECEIPT", "POS_DUE_PAYMENT", "pos_due_payment", (inv) => collectionRef(inv, opId));
        if (prior) return { voucher: prior, sale: await this.getSaleById(vendorId, saleId), duplicate: true };
      }
      throw err;
    }

    return { voucher: result.voucher, sale: await this.getSaleById(vendorId, result.saleId), duplicate: result.duplicate };
  }

  // ============================================
  // 2. QUERIES
  // ============================================

  async getSaleById(vendorId: string, saleId: string) {
    return prisma.posSale.findFirst({
      where: { id: saleId, vendorId },
      include: {
        items: { include: { variant: true, warehouse: true, rack: true } },
        staff: { select: { id: true, displayName: true } }, // legacy attribution
        customer: true,
        bankAccount: true,
        accountingVoucher: { include: { ledgerEntries: { include: { account: true } } } },
      },
    });
  }

  async listSales(filters: SaleListFilters) {
    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(Math.max(1, filters.limit || 20), 100);
    const skip = (page - 1) * limit;

    const where: Prisma.PosSaleWhereInput = { vendorId: filters.vendorId };
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.staffId) where.staffId = filters.staffId;
    if (filters.q) where.invoiceNo = { contains: filters.q, mode: "insensitive" };
    if (filters.startDate || filters.endDate) {
      where.saleDate = {};
      if (filters.startDate) (where.saleDate as Prisma.DateTimeFilter).gte = filters.startDate;
      if (filters.endDate) (where.saleDate as Prisma.DateTimeFilter).lte = filters.endDate;
    }

    const [data, total] = await Promise.all([
      prisma.posSale.findMany({
        where,
        include: { items: true, customer: true, staff: { select: { id: true, displayName: true } } },
        orderBy: { saleDate: "desc" },
        skip,
        take: limit,
      }),
      prisma.posSale.count({ where }),
    ]);

    return { data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getDashboardSummary(vendorId: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [todaySales, dueTotal] = await Promise.all([
      prisma.posSale.aggregate({
        where: { vendorId, saleDate: { gte: startOfDay }, status: { not: "VOIDED" } },
        _sum: { netBilling: true, paidAmount: true, dueAmount: true },
        _count: true,
      }),
      prisma.posCustomer.aggregate({ where: { vendorId }, _sum: { due: true } }),
    ]);

    return {
      today: {
        salesCount: todaySales._count,
        netBilling: todaySales._sum.netBilling ?? 0,
        collected: todaySales._sum.paidAmount ?? 0,
        due: todaySales._sum.dueAmount ?? 0,
      },
      totalCustomerDue: dueTotal._sum.due ?? 0,
    };
  }

  // ============================================
  // 3. CUSTOMERS
  // ============================================

  async listCustomers(vendorId: string, q?: string) {
    const term = typeof q === "string" ? q.trim().slice(0, 100) : "";
    return prisma.posCustomer.findMany({
      where: {
        vendorId,
        ...(term ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { phone: { contains: term } }] } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
  }

  async getCustomerById(vendorId: string, customerId: string) {
    const customer = await prisma.posCustomer.findFirst({
      where: { id: customerId, vendorId },
      include: { sales: { where: { vendorId }, orderBy: { saleDate: "desc" }, take: 20 } },
    });
    if (!customer) return null;
    // Credit-term changes for THIS customer (already vendor-checked above).
    const creditHistory = await prisma.auditLog.findMany({
      where: { entity: "PosCustomer", entityId: customer.id, action: "POS_CREDIT_TERMS_CHANGED" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, createdAt: true, userId: true, oldData: true, newData: true },
    });
    return { ...customer, creditHistory };
  }

  private async auditCreditTerms(
    tx: Prisma.TransactionClient,
    vendorId: string,
    customerId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    actor?: PosActor,
  ) {
    const changed = CREDIT_TERM_KEYS.filter((k) => (before ? before[k] : undefined) !== after[k]);
    if (!changed.length) return;
    const pick = (o: Record<string, unknown> | null) => (o ? Object.fromEntries(CREDIT_TERM_KEYS.map((k) => [k, o[k]])) : null);
    await tx.auditLog.create({
      data: {
        userId: actor?.userId ?? null,
        action: "POS_CREDIT_TERMS_CHANGED",
        entity: "PosCustomer",
        entityId: customerId,
        oldData: (pick(before) ?? undefined) as Prisma.InputJsonValue | undefined,
        newData: { ...pick(after), vendorId, changed, byEmployeeId: actor?.employeeId ?? null } as Prisma.InputJsonValue,
      },
    });
  }

  /** Only profile fields; credit terms need canGrantLoan; balances (due, wallet, …) are never client-writable. */
  private customerData(data: Record<string, unknown>, canSetCredit: boolean, partial: boolean) {
    const out: Record<string, unknown> = {};
    const set = (k: string, v: unknown) => {
      if (v !== undefined) out[k] = v;
    };
    set("name", str(data.name, "name", { required: !partial, max: 120 }));
    set("phone", str(data.phone, "phone", { required: !partial, max: 20 }));
    for (const k of ["email", "nid", "address", "note", "referrerName", "referrerEmail"]) {
      if (k in data) out[k] = str(data[k], k, { max: k === "address" || k === "note" ? 500 : 120 }) ?? null;
    }
    const creditKeys = ["loanLimit", "loanInterestRate", "loanTenureDays"].filter((k) => k in data);
    if (creditKeys.length) {
      if (!canSetCredit) throw forbidden("You don't have permission to set credit terms");
      if ("loanLimit" in data) out.loanLimit = money(data.loanLimit, "loanLimit");
      if ("loanInterestRate" in data) {
        const r = money(data.loanInterestRate, "loanInterestRate");
        if (r > 100) throw bad("loanInterestRate must be at most 100");
        out.loanInterestRate = r;
      }
      if ("loanTenureDays" in data) {
        const d = Number(data.loanTenureDays);
        if (!Number.isInteger(d) || d < 0 || d > 3650) throw bad("loanTenureDays is invalid");
        out.loanTenureDays = d;
      }
    }
    return out;
  }

  async createCustomer(vendorId: string, data: Record<string, unknown>, canSetCredit: boolean, actor?: PosActor) {
    const clean = this.customerData(data ?? {}, canSetCredit, false);
    try {
      if (!CREDIT_TERM_KEYS.some((k) => k in clean)) return await prisma.posCustomer.create({ data: { ...(clean as any), vendorId } });
      return await prismaDirect.$transaction(async (tx) => {
        const created = await tx.posCustomer.create({ data: { ...(clean as any), vendorId } });
        if ((created.loanLimit ?? 0) > 0) await this.auditCreditTerms(tx, vendorId, created.id, null, created as any, actor);
        return created;
      });
    } catch (err: any) {
      if (err?.code === "P2002") throw new AppError("A customer with this phone number already exists", 409);
      throw err;
    }
  }

  async updateCustomer(vendorId: string, customerId: string, data: Record<string, unknown>, canSetCredit: boolean, actor?: PosActor) {
    const clean = this.customerData(data ?? {}, canSetCredit, true);
    const existing = await prisma.posCustomer.findFirst({ where: { id: customerId, vendorId }, select: { id: true } });
    if (!existing) throw notFound("Customer");
    try {
      if (!CREDIT_TERM_KEYS.some((k) => k in clean)) return await prisma.posCustomer.update({ where: { id: existing.id }, data: clean as any });
      return await prismaDirect.$transaction(async (tx) => {
        const before = await tx.posCustomer.findFirst({ where: { id: existing.id, vendorId } });
        if (!before) throw notFound("Customer");
        const updated = await tx.posCustomer.update({ where: { id: existing.id }, data: clean as any });
        await this.auditCreditTerms(tx, vendorId, existing.id, before as any, updated as any, actor);
        return updated;
      });
    } catch (err: any) {
      if (err?.code === "P2002") throw new AppError("A customer with this phone number already exists", 409);
      throw err;
    }
  }

  // ============================================
  // 4. LEGACY TERMINAL LOGINS (read-only)
  // ============================================
  // PosStaff logins are no longer an authentication path — the POS uses the
  // signed-in owner / employee session. Rows are kept untouched because
  // historical sales reference them (PosSale.staffId); they can only be listed.

  async listStaff(vendorId: string) {
    return prisma.posStaff.findMany({
      where: { vendorId },
      select: {
        id: true, username: true, displayName: true, isAdmin: true, isActive: true, createdAt: true, employeeId: true,
        employee: { select: { designation: true, department: true } },
        _count: { select: { sales: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  // ============================================
  // 5. BANK ACCOUNTS
  // ============================================

  async listBankAccounts(vendorId: string) {
    return prisma.posBankAccount.findMany({ where: { vendorId }, orderBy: { createdAt: "desc" } });
  }

  async createBankAccount(vendorId: string, data: Record<string, unknown>) {
    return prisma.posBankAccount.create({
      data: {
        vendorId,
        bankName: str(data?.bankName, "bankName", { required: true, max: 120 })!,
        accountName: str(data?.accountName, "accountName", { required: true, max: 120 })!,
        accountNo: str(data?.accountNo, "accountNo", { required: true, max: 40 })!,
        routing: str(data?.routing, "routing", { max: 40 }) ?? null,
        branch: str(data?.branch, "branch", { max: 120 }) ?? null,
      },
    });
  }

  // ============================================
  // 6. SETTINGS
  // ============================================

  async getOrCreateSettings(vendorId: string) {
    const existing = await prisma.posSettings.findUnique({ where: { vendorId } });
    if (existing) return existing;
    try {
      return await prisma.posSettings.create({ data: { vendorId } });
    } catch (err: any) {
      if (err?.code === "P2002") return prisma.posSettings.findUniqueOrThrow({ where: { vendorId } });
      throw err;
    }
  }

  async updateSettings(vendorId: string, data: Record<string, unknown>) {
    const clean: Record<string, unknown> = {};
    for (const k of ["invoicePrefix", "voucherPrefix"] as const) {
      if (k in data) {
        const v = str(data[k], k, { required: true, max: 10 })!.toUpperCase();
        if (!/^[A-Z0-9]{1,10}$/.test(v)) throw bad(`${k} must be 1–10 letters or digits`);
        clean[k] = v;
      }
    }
    if ("currencySymbol" in data) clean.currencySymbol = str(data.currencySymbol, "currencySymbol", { required: true, max: 5 });
    if ("receiptFooterText" in data) clean.receiptFooterText = str(data.receiptFooterText, "receiptFooterText", { max: 500 }) ?? null;
    if ("storeOnline" in data) {
      if (typeof data.storeOnline !== "boolean") throw bad("storeOnline must be true or false");
      clean.storeOnline = data.storeOnline;
    }
    return prisma.posSettings.upsert({ where: { vendorId }, update: clean, create: { vendorId, ...clean } });
  }

  // ============================================
  // 7. UTILITY
  // ============================================

  private async generateSequence(
    tx: Prisma.TransactionClient,
    vendorId: string,
    prefix: string,
    field: "invoiceNo" | "voucherNo",
  ): Promise<string> {
    const today = new Date();
    const datePart = `${today.getFullYear().toString().slice(2)}${(today.getMonth() + 1).toString().padStart(2, "0")}${today.getDate().toString().padStart(2, "0")}`;
    const searchPrefix = `${prefix}-${datePart}-`;

    // Serializable transaction (runStockMutation): two concurrent sales that
    // read the same "last" number conflict and one is retried (P2034).
    const last = await tx.posSale.findFirst({
      where: { vendorId, [field]: { startsWith: searchPrefix } } as Prisma.PosSaleWhereInput,
      orderBy: { [field]: "desc" } as Prisma.PosSaleOrderByWithRelationInput,
      select: { invoiceNo: true, voucherNo: true },
    });

    let seq = 1;
    if (last) {
      const lastVal = last[field];
      seq = parseInt(lastVal.split("-").pop() || "0", 10) + 1;
    }
    return `${searchPrefix}${seq.toString().padStart(4, "0")}`;
  }
}

export const posService = new PosService();
