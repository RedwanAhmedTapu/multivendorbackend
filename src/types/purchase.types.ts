// ═══════════════════════════════════════════════════════════════════════════
// Merge into erp.types.ts — this covers ALL purchase-order-lifecycle types
// (create/receive/pay from before, PLUS short-close/cancel/return/refund).
// ═══════════════════════════════════════════════════════════════════════════

import type { EntityType } from "@prisma/client";

// ── CREATE ──────────────────────────────────────────────────────────────────

export interface CreatePurchaseOrderItemDTO {
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: number;
  /** Applied to unitCost to compute `total`/`newAvgCost`; NOT persisted as its
   * own column (PurchaseOrderItem has no discountPercent field). */
  discountPercent?: number;
  unitCost: number;
  mrpPrice?: number;
  sellPrice: number;
  expiryDate?: string;
}

export interface CreatePurchaseOrderDTO {
  supplierId: string;
  warehouseId: string;
  supplierInvoiceNo?: string;
  purchaseDate: string;
  vatRate?: number;
  vatCoaAccountId?: string;
  paidAmount?: number;
  vendorPaymentAccountId?: string;
  paymentMethod?: string;
  paymentReference?: string;
  notes?: string;
  entityType: EntityType;
  entityId?: string;
  items: CreatePurchaseOrderItemDTO[];
  idempotencyKey: string;
  taxTreatment?: "STANDARD" | "ZERO" | "EXEMPT";
}

// ── RECEIVE ──────────────────────────────────────────────────────────────────
// CHANGED (Group C2): each line can now split into good vs damaged quantity.
// `quantity` = total physically received for this line (good + damaged).
// Damaged units still count toward receivedQuantity (the goods DID arrive —
// AP recognition doesn't change) but are routed to WarehouseStock.damagedQty
// instead of sellable quantity.

export interface ReceivePurchaseOrderItemDTO {
  purchaseOrderItemId: string;
  /** Total units physically received (good + damaged). */
  quantity: number;
  /** Subset of `quantity` that arrived damaged. Defaults to 0. Must be <= quantity. */
  damagedQuantity?: number;
  warehouseId: string;
  rackId?: string;
  rowNumber?: number;
  shelfNumber?: number;
}

export interface ReceivePurchaseOrderDTO {
  notes?: string;
  receivedBy?: string;
  items: ReceivePurchaseOrderItemDTO[];
}

// ── PAY DUE ──────────────────────────────────────────────────────────────────

export interface PayPurchaseDueDTO {
  amount: number;
  method: string;
  coaAccountId: string;
  vendorPaymentAccountId?: string;
  reference?: string;
  entityType: EntityType;
  entityId?: string;
}

// ── SHORT-CLOSE (NEW — Group A1/A2) ──────────────────────────────────────────
// Permanently writes off the remaining un-received quantity on the given
// items (supplier will not deliver the rest). Recomputes subtotal/vat/total
// downward and reverses the proportional voucher amount. If the PO was
// already paid past the new (lower) total, the excess becomes
// PurchaseOrder.creditBalance and paymentStatus flips to OVERPAID.

export interface ShortCloseItemDTO {
  purchaseOrderItemId: string;
  /** How many of the still-outstanding units to write off. Must be
   * <= (quantity - receivedQuantity - cancelledQuantity). */
  cancelQuantity: number;
}

export interface ShortClosePurchaseOrderDTO {
  items: ShortCloseItemDTO[];
  reason: string;
  entityType: EntityType;
  entityId?: string;
}

// ── CANCEL (NEW — Group B1/B2) ───────────────────────────────────────────────
// Cancels the ENTIRE PO. Allowed at any receiving status except
// FULLY_RECEIVED. If nothing has been received yet, this fully reverses the
// original purchase voucher. If something HAS been received, the received
// portion stays (physically already in stock) and only the un-received
// remainder is reversed — i.e. this is a short-close of everything
// outstanding plus a receivingStatus flip to CANCELLED rather than
// SHORT_CLOSED. Use returnPurchaseOrderItems() separately to also send back
// already-received stock.

export interface CancelPurchaseOrderDTO {
  reason: string;
  entityType: EntityType;
  entityId?: string;
}

// ── RETURN (NEW — Group C1) ──────────────────────────────────────────────────
// Sends already-received stock back to the supplier (defective/wrong item).

export interface ReturnPurchaseOrderItemDTO {
  purchaseOrderItemId: string;
  quantity: number;
  warehouseId: string;
  rackId?: string;
  rowNumber?: number;
  shelfNumber?: number;
}

export interface ReturnPurchaseOrderDTO {
  items: ReturnPurchaseOrderItemDTO[];
  reason: string;
  returnedBy?: string;
  entityType: EntityType;
  entityId?: string;
}

// ── REFUND (NEW — Group D1) ──────────────────────────────────────────────────
// Cashes out PurchaseOrder.creditBalance (partially or fully) instead of
// carrying it forward.

export interface RefundPurchaseOrderCreditDTO {
  amount: number;
  method: string;
  coaAccountId: string;
  vendorPaymentAccountId?: string;
  reference?: string;
  entityType: EntityType;
  entityId?: string;
}

// ── LIST QUERY ───────────────────────────────────────────────────────────────

export interface PurchaseOrderListQuery {
  supplierId?: string;
  warehouseId?: string;
  receivingStatus?:
    | "DRAFT"
    | "CONFIRMED"
    | "PARTIALLY_RECEIVED"
    | "FULLY_RECEIVED"
    | "SHORT_CLOSED"
    | "CANCELLED";
  paymentStatus?: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "OVERPAID";
  startDate?: string;
  endDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}

// ── VOUCHER ENTRY (unchanged) ────────────────────────────────────────────────

export interface VoucherEntryInput {
  accountId: string;
  debitAmount?: number;
  creditAmount?: number;
  description: string;
  referenceType: string;
  referenceId: string;
}

// ── WEIGHTED AVG HELPER (unchanged) ──────────────────────────────────────────

export function calcWeightedAvg(args: {
  prevStock: number;
  prevAvgCost: number;
  incomingQty: number;
  incomingCost: number;
}): number {
  const { prevStock, prevAvgCost, incomingQty, incomingCost } = args;
  const totalQty = prevStock + incomingQty;
  if (totalQty <= 0) return incomingCost;
  return (prevStock * prevAvgCost + incomingQty * incomingCost) / totalQty;
}