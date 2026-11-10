import type {
  EntityType,
  VoucherType,
} from '@prisma/client';

// ─────────────────────────────────────────────
// STOCK / INVENTORY
// ─────────────────────────────────────────────
export interface StockListQuery {
  warehouseId?: string;
  // FIX: rack/row/shelf-level filtering for the product list, so a vendor
  // who manages racks can narrow the inventory list down to "what's on
  // rack A-3, row 2" etc. All optional and independent — any combination
  // (just rackId, rack+row, rack+row+shelf) is valid. Only meaningful when
  // warehouseId is also given (a rack belongs to one warehouse).
  rackId?: string;
  rowNumber?: number;
  shelfNumber?: number;
  categoryId?: string;
  status?: 'in_stock' | 'low_stock' | 'out_stock' | 'overstock';
  q?: string;
  page?: number;
  limit?: number;
}

// Optional exact-shelf targeting. WarehouseStock's unique key is now
// (variantId, warehouseId, rackId, rowNumber, shelfNumber) — a variant can
// have several rows in the same warehouse. When this is omitted, stock
// operations fall back to the warehouse's untracked ("loose", rackId=null)
// row, or aggregate/consume across all rows in that warehouse.
export interface WarehouseLocationInput {
  rackId?: string;
  rowNumber?: number;
  shelfNumber?: number;
}

export interface StockAdjustDTO extends WarehouseLocationInput {
  variantId: string;
  warehouseId: string;
  quantity: number;             // positive — always deducted for adjust/damage
  reason?: string;
  notes?: string;
  entityType: EntityType;
  entityId?: string;
}

export interface StockDamageDTO extends StockAdjustDTO {}

export interface StockTransferDTO {
  variantId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: number;
  reason?: string;
  notes?: string;
  entityType: EntityType;
  entityId?: string;
  // Optional exact source/destination shelf targeting
  from?: WarehouseLocationInput;
  to?: WarehouseLocationInput;
}

export interface StockSellDamageDTO extends WarehouseLocationInput {
  variantId: string;
  warehouseId: string;
  quantity: number;
  saleAmount: number;
  receiptCoaAccountId: string;
  notes?: string;
  entityType: EntityType;
  entityId?: string;
}

// ─────────────────────────────────────────────
// INTERNAL — shared voucher entry shape
// ─────────────────────────────────────────────
export interface VoucherEntryInput {
  accountId: string;
  debitAmount?: number;
  creditAmount?: number;
  description?: string;
  referenceType?: string;
  referenceId?: string;
  costCenter?: string;
  department?: string;
}

export interface BuildVoucherParams {
  voucherType: VoucherType;
  narration: string;
  entityType: EntityType;
  entityId?: string;
  referenceType?: string;
  referenceId?: string;
  voucherDate?: Date;
  entries: VoucherEntryInput[];
  createdBy?: string;
  eventType?: string;
}

// ─────────────────────────────────────────────
// AGGREGATED STOCK SHAPE
// ProductVariant no longer carries stock/damagedQty/reservedQty itself —
// these are always derived by summing a variant's WarehouseStock rows.
// damagedQty/reservedQty are SEPARATE pools carved out of a location's
// physical stock — quantity only counts good/undamaged/unreserved units.
// available = quantity - reservedQty - damagedQty (all three are disjoint,
// not subsets of one another).
// ─────────────────────────────────────────────
export interface AggregatedStock {
  quantity: number;
  reservedQty: number;
  damagedQty: number;
  available: number;
}

export function aggregateWarehouseStock(
  rows: { quantity: number; reservedQty: number; damagedQty: number }[],
): AggregatedStock {
  const quantity = rows.reduce((s, r) => s + r.quantity, 0);
  const reservedQty = rows.reduce((s, r) => s + r.reservedQty, 0);
  const damagedQty = rows.reduce((s, r) => s + r.damagedQty, 0);
  return {
    quantity,
    reservedQty,
    damagedQty,
    available: Math.max(0, quantity - reservedQty - damagedQty),
  };
}

// ─────────────────────────────────────────────
// WEIGHTED AVERAGE COST HELPER
// ─────────────────────────────────────────────
export interface AvgCostInput {
  prevStock: number;
  prevAvgCost: number;
  incomingQty: number;
  incomingCost: number;
}

export function calcWeightedAvg(input: AvgCostInput): number {
  const { prevStock, prevAvgCost, incomingQty, incomingCost } = input;
  const totalQty = prevStock + incomingQty;
  if (totalQty === 0) return incomingCost;
  return (prevStock * prevAvgCost + incomingQty * incomingCost) / totalQty;
}

// ─────────────────────────────────────────────
// STOCK STATUS HELPER
// stock (quantity) is the gross on-hand total; damagedQty/reservedQty are
// separate pools, so available = stock - damagedQty - reservedQty.
// ─────────────────────────────────────────────
export function deriveStockStatus(
  stock: number,
  damagedQty: number,
  reservedQty: number,
  reorderLevel: number,
): 'in_stock' | 'low_stock' | 'out_stock' | 'overstock' {
  const available = Math.max(0, stock - damagedQty - reservedQty);
  if (available === 0) return 'out_stock';
  if (available <= reorderLevel) return 'low_stock';
  if (available > reorderLevel * 5) return 'overstock';
  return 'in_stock';
}