import type {
  SupplierStatus,
  SupplierType,
  EntityType,
} from "@prisma/client";

/* ============================================================
   SUPPLIER REQUEST TYPES
   ============================================================ */

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

  /**
   * Determines which entity owns the supplier's
   * Accounts Payable COA account.
   */
  entityType: EntityType;
  entityId?: string;
}

export interface UpdateSupplierDTO {
  supplierType?: SupplierType;
  status?: SupplierStatus;

  contactName?: string;
  phone?: string;
  phone2?: string;
  email?: string;

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
}

export interface ToggleSupplierStatusResponse {
  id: string;
  name: string;
  status: SupplierStatus;
}

/* ============================================================
   SUPPLIER LIST / QUERY TYPES
   ============================================================ */

export interface SupplierListQuery {
  status?: SupplierStatus;
  supplierType?: SupplierType;
  search?: string;

  page?: number;
  limit?: number;
}

/* ============================================================
   SUPPLIER COA TYPES
   ============================================================ */

export interface SupplierCOA {
  id: string;
  code: string;
  name: string;
}

/**
 * Detailed COA information returned by getSupplierById()
 * when the complete ChartOfAccount relation is included.
 *
 * Keep this flexible unless you want to expose the entire
 * ChartOfAccount Prisma model to the frontend.
 */
export interface SupplierCOASummary {
  id: string;
  code: string;
  name: string;
}

/* ============================================================
   SUPPLIER BASE TYPES
   ============================================================ */

export interface Supplier {
  id: string;
  name: string;
  supplierType: SupplierType;
  status: SupplierStatus;

  contactName: string | null;
  phone: string;
  phone2: string | null;
  email: string;

  country: string | null;
  city: string | null;
  zipCode: string | null;
  fullAddress: string | null;

  paymentTerms: string | null;
  creditLimit: number;

  bankAccountName: string | null;
  bankAccountNo: string | null;
  bankName: string | null;
  bankBranch: string | null;
  routingNo: string | null;

  notes: string | null;

  createdAt: string;
  updatedAt: string;

  coaAccountId: string | null;

  coaAccount?: SupplierCOA | null;
}

/**
 * Supplier returned from getSupplierById()
 */
export interface SupplierDetail extends Supplier {
  totalDue: number;
}

/**
 * Supplier returned from supplier list.
 *
 * List API only selects:
 * id, code, name from COA.
 */
export interface SupplierListItem extends Supplier {
  totalDue: number;
  coaAccount: SupplierCOA | null;
}

/* ============================================================
   PURCHASE ORDER DUE TYPES
   ============================================================ */

export interface SupplierPendingPurchaseOrder {
  id: string;
  purchaseNo: string;
  purchaseDate: string;

  totalAmount: number;
  paidAmount: number;
  dueAmount: number;

  /**
   * Legacy field currently selected by
   * getSupplierDues().
   *
   * If your PurchaseOrder schema has already changed
   * to receivingStatus/paymentStatus, replace this
   * with those two fields.
   */
  status: string;
}

export interface SupplierDuesSummary {
  supplier: {
    id: string;
    name: string;
  };

  totalDue: number;

  pendingOrders: SupplierPendingPurchaseOrder[];
}

/* ============================================================
   PAGINATION
   ============================================================ */

export interface SupplierPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface SupplierListResponse {
  data: SupplierListItem[];
  pagination: SupplierPagination;
}

/* ============================================================
   API RESPONSE TYPES
   ============================================================ */

export interface SupplierApiResponse<T> {
  success: boolean;
  message?: string;
  data: T;
}

/* ============================================================
   COMMON SUPPLIER RESPONSE TYPES
   ============================================================ */

export interface CreateSupplierResponse extends SupplierDetail {}

export interface UpdateSupplierResponse extends SupplierDetail {}

export interface GetSupplierResponse extends SupplierDetail {}

export type ListSuppliersResponse = SupplierListResponse;

export type GetSupplierDuesResponse = SupplierDuesSummary;

export type ToggleSupplierStatusResult =
  ToggleSupplierStatusResponse;