import type {
  SupplierType,
  SupplierStatus,
  PurchaseOrderStatus,
  StockMovementType,
  EntityType,
  VoucherType,
} from '@prisma/client';

// ─────────────────────────────────────────────
// SUPPLIER
// ─────────────────────────────────────────────
export interface CreateSupplierDTO {
  name: string;
  supplierType: SupplierType;
  contactName?: string;
  phone: string;
  phone2?: string;
  email: string;
  country?: string;
  city?: string;
  zipCode?: string;
  fullAddress?: string;
  paymentTerms?: string;
  creditLimit?: number;
  bankAccountName?: string;
  bankAccountNo?: string;
  bankName?: string;
  bankBranch?: string;
  routingNo?: string;
  notes?: string;
  // entityType / entityId for COA scoping
  entityType: EntityType;
  entityId?: string;
}

export interface UpdateSupplierDTO extends Partial<Omit<CreateSupplierDTO, 'name' | 'entityType' | 'entityId'>> {
  status?: SupplierStatus;
}

export interface SupplierListQuery {
  search?: string;
  status?: SupplierStatus;
  supplierType?: SupplierType;
  entityType?: EntityType;
  entityId?: string;
  page?: number;
  limit?: number;
}

// ─────────────────────────────────────────────
// PURCHASE ORDER
// ─────────────────────────────────────────────
export interface PurchaseItemInput {
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: number;
  unitCost: number;
  sellPrice: number;
  expiryDate?: string | null;
}

export interface CreatePurchaseOrderDTO {
  purchaseDate: string;           // ISO date string
  supplierId: string;
  warehouseId: string;
  supplierInvoiceNo?: string;
  vatRate?: number;               // e.g. 0.05 = 5%
  vatCoaAccountId?: string;       // COA id for VAT input
  paidAmount?: number;
  paymentMethod?: string;
  paymentCoaAccountId?: string;   // COA id for bank/cash
  paymentReference?: string;
  notes?: string;
  items: PurchaseItemInput[];
  entityType: EntityType;
  entityId?: string;
}

export interface PayPurchaseDueDTO {
  amount: number;
  method: string;
  coaAccountId: string;
  reference?: string;
  entityType: EntityType;
  entityId?: string;
}

export interface PurchaseOrderListQuery {
  supplierId?: string;
  warehouseId?: string;
  status?: PurchaseOrderStatus;
  startDate?: string;
  endDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}

// ─────────────────────────────────────────────
// STOCK / INVENTORY
// ─────────────────────────────────────────────
export interface StockListQuery {
  warehouseId?: string;
  categoryId?: string;
  status?: 'in_stock' | 'low_stock' | 'out_stock' | 'overstock';
  q?: string;
  page?: number;
  limit?: number;
}

export interface StockAdjustDTO {
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
}

export interface StockSellDamageDTO {
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