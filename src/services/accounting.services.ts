
import type {
  AccountClass,
  AccountGroup,
  AccountTypeInAccounting,
  AccountNature,
  EntityType,
  VoucherType,
  VoucherStatus,
  EventType,
  TaxTreatment,
  ApprovalStatus,
  Prisma,
} from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { randomUUID } from "crypto";

const prisma = new PrismaClient();

const ENTITY_PREFIX = {
  ADMIN: "ADM",
  VENDOR: "VND",
};

const ACCOUNT_PREFIX = {
  ASSET: "AST",
  LIABILITY: "LIB",
  EQUITY: "EQT",
  INCOME: "INC",
  EXPENSE: "EXP",
};

async function generateAccountCode(
  entityType: "ADMIN" | "VENDOR",
  entityId: string | null,
  accountClass: AccountClass,
) {
  const prefix = `${ENTITY_PREFIX[entityType]}-${ACCOUNT_PREFIX[accountClass]}`;

  const lastAccount = await prisma.chartOfAccount.findFirst({
    where: {
      entityType,
      entityId,
      code: { startsWith: prefix },
    },
    orderBy: { createdAt: "desc" },
    select: { code: true },
  });

  let nextNumber = 1;
  if (lastAccount) {
    const lastSeq = parseInt(lastAccount.code.split("-").pop()!, 10);
    nextNumber = lastSeq + 1;
  }

  return `${prefix}-${String(nextNumber).padStart(4, "0")}`;
}

function resolveNature(accountClass: AccountClass): AccountNature {
  return accountClass === "ASSET" || accountClass === "EXPENSE"
    ? "DEBIT"
    : "CREDIT";
}

// ============================================================
// MANDATORY CHART OF ACCOUNTS — Auto Voucher Module spec, §2
// Account names below are stable identifiers referenced verbatim
// by the voucher engine. Do not rename without a migration.
// ============================================================

interface COASeed {
  name: string;
  accountClass: AccountClass;
  accountType: AccountTypeInAccounting;
  group?: AccountGroup;
  description: string;
}

// Table 1 — Platform's Core COA (Admin Account), 20 accounts (§2.1)
const PLATFORM_COA: COASeed[] = [
  { name: "Receivable from Payment Gateway (SSLCommerz)", accountClass: "ASSET", accountType: "CURRENT_ASSET", group: "ACCOUNTS_RECEIVABLE", description: "Money pending from SSLCommerz" },
  { name: "Receivable from Courier (COD)", accountClass: "ASSET", accountType: "CURRENT_ASSET", group: "ACCOUNTS_RECEIVABLE", description: "COD money pending from Pathao/RedX" },
  { name: "Receivable from Courier (Claims)", accountClass: "ASSET", accountType: "CURRENT_ASSET", group: "ACCOUNTS_RECEIVABLE", description: "Insurance/compensation for lost goods" },
  { name: "Cash in Operating Bank Account", accountClass: "ASSET", accountType: "CURRENT_ASSET", group: "CASH_AND_BANK", description: "Platform's settled cash" },
  { name: "Customer Deposit Liability", accountClass: "LIABILITY", accountType: "CURRENT_LIABILITY", group: "EXPENSE_LIABILITIES", description: "Money held in escrow before delivery" },
  { name: "Vendor Payables", accountClass: "LIABILITY", accountType: "CURRENT_LIABILITY", group: "ACCOUNTS_PAYABLE", description: "Money owed to Vendors" },
  { name: "Payable to Courier", accountClass: "LIABILITY", accountType: "CURRENT_LIABILITY", group: "ACCOUNTS_PAYABLE", description: "Courier fees owed" },
  { name: "Payable to Payment Gateway (Refunds)", accountClass: "LIABILITY", accountType: "CURRENT_LIABILITY", group: "ACCOUNTS_PAYABLE", description: "Refunds queued for SSLCommerz processing" },
  { name: "Store Credit Liability", accountClass: "LIABILITY", accountType: "CURRENT_LIABILITY", group: "EXPENSE_LIABILITIES", description: "Issued wallet/store credit" },
  { name: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", accountType: "CURRENT_LIABILITY", group: "STATUTORY", description: "Tax collected on commissions/shipping" },
  { name: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", accountType: "CURRENT_ASSET", group: "ACCOUNTS_RECEIVABLE", description: "Tax paid on expenses (courier/gateway)" },
  { name: "Platform Commission Income", accountClass: "INCOME", accountType: "INCOME", description: "Commission earned" },
  { name: "Courier Delivery Income", accountClass: "INCOME", accountType: "INCOME", description: "Markup earned on shipping" },
  { name: "Platform Discount Expense", accountClass: "EXPENSE", accountType: "EXPENSE", group: "OPERATING_EXPENSE", description: "Discounts funded by the platform (contra-income)" },
  { name: "Payment Gateway Fees Expense", accountClass: "EXPENSE", accountType: "EXPENSE", group: "OPERATING_EXPENSE", description: "SSLCommerz transaction fees" },
  { name: "COD Collection Fees Expense", accountClass: "EXPENSE", accountType: "EXPENSE", group: "OPERATING_EXPENSE", description: "Percentage-based COD collection fee" },
  { name: "Courier Delivery Fees Expense", accountClass: "EXPENSE", accountType: "EXPENSE", group: "DIRECT_EXPENSE", description: "Base courier delivery cost (forward leg)" },
  { name: "Courier Return Delivery Expense", accountClass: "EXPENSE", accountType: "EXPENSE", group: "DIRECT_EXPENSE", description: "Courier return-leg delivery cost (RTS / failed COD)" },
  { name: "Lost in Transit Expense", accountClass: "EXPENSE", accountType: "EXPENSE", group: "OPERATING_EXPENSE", description: "Write-offs for lost/uncompensated parcels" },
  { name: "Goodwill/Platform Compensation", accountClass: "EXPENSE", accountType: "EXPENSE", group: "OPERATING_EXPENSE", description: "Refunds issued without charging vendor" },
];

// What the vendor's own POS customers owe (credit sales). Kept apart from
// "Receivable from Platform" — that account is the vendor's side of the
// marketplace settlement and is reconciled against the platform's "Vendor
// Payables" (getDriftReport), so customer debt must never be posted to it.
export const POS_CUSTOMER_RECEIVABLE = "POS Customer Receivable";

/** Voucher.idempotencyKey of a POS voucher (globally unique column, so the vendor is part of it). */
export function posVoucherIdempotencyKey(voucherType: string, eventType: string, refType: string, vendorId: string, refId: string): string {
  return `${voucherType}:${eventType}:${refType}:${vendorId}:${refId}`;
}

// Table 2 — Vendor's Core COA (Per-Vendor Ledger), 14 accounts (§2.2 + POS customer receivable)
const VENDOR_COA: COASeed[] = [
  { name: "Receivable from Platform", accountClass: "ASSET", accountType: "CURRENT_ASSET", group: "ACCOUNTS_RECEIVABLE", description: "Money owed to vendor" },
  { name: POS_CUSTOMER_RECEIVABLE, accountClass: "ASSET", accountType: "CURRENT_ASSET", group: "ACCOUNTS_RECEIVABLE", description: "Credit sales owed by the vendor's POS customers" },
  { name: "Cash at Bank Account", accountClass: "ASSET", accountType: "CURRENT_ASSET", group: "CASH_AND_BANK", description: "Vendor's settled balance" },
  { name: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", accountType: "CURRENT_LIABILITY", group: "STATUTORY", description: "Tax collected on sales" },
  { name: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", accountType: "CURRENT_ASSET", group: "ACCOUNTS_RECEIVABLE", description: "Tax paid on commission/fees" },
  { name: "Sales Revenue", accountClass: "INCOME", accountType: "INCOME", description: "Gross product sales" },
  { name: "Sales Returns", accountClass: "INCOME", accountType: "INCOME", description: "Reversals for returned/canceled items (contra-income)" },
  { name: "Vendor Funded Discounts", accountClass: "INCOME", accountType: "INCOME", description: "Discounts absorbed by vendor (contra-income)" },
  { name: "Platform Commission Expense", accountClass: "EXPENSE", accountType: "EXPENSE", group: "DIRECT_EXPENSE", description: "Commission paid to platform" },
  { name: "PG Fee / Shortfall Expense", accountClass: "EXPENSE", accountType: "EXPENSE", group: "DIRECT_EXPENSE", description: "Non-refundable PG fees or COD short-pays" },
  { name: "Courier Return/Forward Expense", accountClass: "EXPENSE", accountType: "EXPENSE", group: "DIRECT_EXPENSE", description: "Failed delivery fees borne by vendor" },
  { name: "Damage/Loss Liability Expense", accountClass: "EXPENSE", accountType: "EXPENSE", group: "OPERATING_EXPENSE", description: "Write-offs for vendor-side damage/loss/penalty" },
  { name: "Inventory Asset (Goods)", accountClass: "ASSET", accountType: "CURRENT_ASSET", group: "ACCOUNTS_RECEIVABLE", description: "Vendor's on-hand stock, carried at cost" },
  { name: "Cost of Goods Sold (Expense)", accountClass: "EXPENSE", accountType: "EXPENSE", group: "DIRECT_EXPENSE", description: "Cost basis of inventory relieved on each sale" },
];

// Payment Method → COA Account Mapping for POS
const PAYMENT_COA_NAME: Record<string, string> = {
  CASH: "Cash at Bank Account",
  CARD: "Cash at Bank Account",
  BKASH: "Cash at Bank Account",
  NAGAD: "Cash at Bank Account",
  ROCKET: "Rocket Wallet",
  BANK_TRANSFER: "Bank Account",
  OTHER: "Cash in Hand",
};


function paymentCOAName(method: string): string {
  return PAYMENT_COA_NAME[method?.toUpperCase()] ?? "Cash at Bank Account";
}


function d(v: Decimal | number | undefined | null): Decimal {
  return new Decimal(v ?? 0);
}

// ============================================================
// Generic journal-entry building blocks shared by every event
// in Phases 1-10. `JournalEntryInput` carries an account NAME
// (resolved against the COA at post time) rather than an ID, so
// event methods read the same way the spec's journal tables do.
// ============================================================

interface JournalEntryInput {
  accountName: string;
  accountClass: AccountClass;
  debit?: Decimal | number;
  credit?: Decimal | number;
  description: string;
  referenceType?: string;
  referenceId?: string;
}

interface LedgerSideInput {
  voucherType: VoucherType;
  narration: string;
  entries: JournalEntryInput[];
  voucherDate?: Date;
  vendorId?: string; // only for the platform side, to denormalize Voucher.vendorId
}

// REPLACE THIS:
interface PairedVoucherInput {
  idempotencyKey: string;
  eventTrigger: EventType;
  referenceType: string;
  referenceId: string;
  orderId?: string;
  customerId?: string;
  courierId?: string;
  paymentGatewayId?: string;
  settlementBatchId?: string;
  taxTreatment?: TaxTreatment;
  lineItemDetails?: any;
  platform?: LedgerSideInput;
  vendor?: { vendorId: string } & LedgerSideInput;
  createdBy?: string;
}

// WITH THIS:
interface PairedVoucherInput {
  idempotencyKey: string;
  eventTrigger: EventType;
  referenceType: string;
  referenceId: string;
  orderId?: string;
  customerId?: string;
  courierId?: string;
  paymentGatewayId?: string;
  settlementBatchId?: string;
  taxTreatment?: TaxTreatment;
  lineItemDetails?: any;
  // Manual-approval workflow (spec: fraud-variant chargeback, ADJ-1).
  // When approvalStatus is "PENDING", postPairedVoucher will create the
  // voucher(s) as DRAFT and skip auto-posting, holding them for review.
  approvalId?: string;
  approvalStatus?: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: Date;
  platform?: LedgerSideInput;
  vendor?: { vendorId: string } & LedgerSideInput;
  createdBy?: string;
}

export interface POSSaleItem {
  productId: string;
  name: string;
  qty: number;
  sellingPrice: Decimal;
  costPrice: Decimal;
  vatRate: number;
}

export interface POSSaleData {
  invoiceId: string;
  voucherNo?: string;
  vendorId: string;
  customerId?: string | null;
  customerName: string;
  items: POSSaleItem[];
  subtotal: Decimal;
  discountAmount: Decimal;
  discountType: "pct" | "flat";
  discountPct: number;
  vatAmount: Decimal;
  netBilling: Decimal;
  cogsTotal: Decimal;
  paidAmount: Decimal;
  dueAmount: Decimal;
  paymentMethod: string;
  saleDate: Date;
  couponNote?: string;
}

export interface POSRefundData {
  originalInvoiceId: string;
  refundInvoiceId: string;
  vendorId: string;
  customerId?: string | null;
  customerName: string;
  refundItems: POSSaleItem[];
  refundSubtotal: Decimal;
  refundDiscount: Decimal;
  refundVat: Decimal;
  refundNet: Decimal;
  refundCogs: Decimal;
  paymentMethod: string;
  refundDate: Date;
  /** Part of refundNet paid back in money (default: all of it). */
  cashRefund?: Decimal;
  /** Part of refundNet that cancels the customer's unpaid due instead. */
  receivableCut?: Decimal;
  /** The receivable account the original sale debited (see posReceivableAccountForSale). */
  receivableAccountId?: string;
}

export interface POSDuePaymentData {
  originalInvoiceId: string;
  paymentInvoiceId: string;
  vendorId: string;
  customerId: string;
  customerName: string;
  payingAmount: Decimal;
  paymentMethod: string;
  paymentDate: Date;
  note?: string;
  /** The receivable account the original sale debited (see posReceivableAccountForSale). */
  receivableAccountId?: string;
}

export class AccountingService {
  // ============================================
  // 0. CHART OF ACCOUNTS SEEDING (spec §2)
  // ============================================

  /** Idempotently creates every Platform (Admin) COA account from Table 1. */
  async seedPlatformCOA(userId: string) {
    const created: any[] = [];
    for (const seed of PLATFORM_COA) {
      const existing = await prisma.chartOfAccount.findFirst({
        where: { entityType: "ADMIN", entityId: null, name: seed.name },
      });
      if (existing) continue;
      const coa = await this.createChartOfAccount({
        name: seed.name,
        accountClass: seed.accountClass,
        accountType: seed.accountType,
        group: seed.group,
        entityType: "ADMIN",
        entityId: null,
        isSystem: true,
        description: seed.description,
        userId,
      });
      created.push(coa);
    }
    return created;
  }

  /** Idempotently creates every per-vendor COA account from Table 2. */
  async seedVendorCOA(vendorId: string, userId: string) {
    const created: any[] = [];
    for (const seed of VENDOR_COA) {
      const existing = await prisma.chartOfAccount.findFirst({
        where: { entityType: "VENDOR", entityId: vendorId, name: seed.name },
      });
      if (existing) continue;
      const coa = await this.createChartOfAccount({
        name: seed.name,
        accountClass: seed.accountClass,
        accountType: seed.accountType,
        group: seed.group,
        entityType: "VENDOR",
        entityId: vendorId,
        isSystem: true,
        description: seed.description,
        userId,
      });
      created.push(coa);
    }
    return created;
  }

  // ============================================
  // 1. CHART OF ACCOUNTS
  // ============================================

  async createChartOfAccount(data: {
    name: string;
    accountClass: AccountClass;
    accountType: AccountTypeInAccounting;
    group?: AccountGroup;
    entityType: EntityType;
    entityId?: string | null;
    isSystem?: boolean;
    description?: string | null;
    userId: string;
  }) {
    await this.validateEntityAccess(data.entityType, data.entityId ?? null, data.userId);

    const code = await generateAccountCode(data.entityType, data.entityId ?? null, data.accountClass);
    const nature = resolveNature(data.accountClass);

    const coa = await prisma.chartOfAccount.create({
      data: {
        code,
        name: data.name,
        accountClass: data.accountClass,
        accountType: data.accountType,
        group: data.group,
        nature,
        entityType: data.entityType,
        entityId: data.entityId ?? null,
        isSystem: data.isSystem ?? false,
        isActive: true,
        canDelete: true,
        description: data.description,
      },
    });

    await this.createAuditLog({
      action: "CREATE",
      entityName: "chart_of_accounts",
      entityId: coa.id,
      userId: data.userId,
      newData: coa,
    });

    return coa;
  }

  async updateChartOfAccount(
    id: string,
    data: { name?: string; group?: AccountGroup; description?: string | null; isActive?: boolean },
    userId: string,
  ) {
    const existing = await prisma.chartOfAccount.findUnique({ where: { id } });
    if (!existing) throw new Error("Account not found");
    if (existing.isSystem) throw new Error("System accounts cannot be modified");
    if (!existing.canDelete) throw new Error("This account cannot be modified");

    await this.validateEntityAccess(existing.entityType, existing.entityId, userId);

    const updated = await prisma.chartOfAccount.update({
      where: { id },
      data: {
        name: data.name,
        group: data.group,
        description: data.description,
        isActive: data.isActive,
        updatedAt: new Date(),
      },
    });

    await this.createAuditLog({
      action: "UPDATE",
      entityName: "chart_of_accounts",
      entityId: id,
      userId,
      oldData: existing,
      newData: updated,
    });

    return updated;
  }

  async deleteChartOfAccount(id: string, userId: string) {
    const existing = await prisma.chartOfAccount.findUnique({
      where: { id },
      include: { ledgerEntries: true },
    });

    if (!existing) throw new Error("Account not found");
    if (existing.isSystem) throw new Error("System accounts cannot be deleted");
    if (!existing.canDelete) throw new Error("This account cannot be deleted");
    if (existing.ledgerEntries.length > 0) {
      throw new Error("Cannot delete account with existing transactions");
    }

    await this.validateEntityAccess(existing.entityType, existing.entityId, userId);
    await prisma.chartOfAccount.delete({ where: { id } });

    await this.createAuditLog({
      action: "DELETE",
      entityName: "chart_of_accounts",
      entityId: id,
      userId,
      oldData: existing,
    });

    return { success: true, message: "Account deleted successfully" };
  }

  async getChartOfAccounts(entityType: EntityType, entityId?: string) {
    return prisma.chartOfAccount.findMany({
      where: { entityType, entityId: entityId || null, isActive: true },
      orderBy: [{ code: "asc" }],
    });
  }

  async getChartOfAccountById(id: string) {
    return prisma.chartOfAccount.findUnique({
      where: { id },
      include: { ledgerEntries: { take: 10, orderBy: { entryDate: "desc" } } },
    });
  }

  // ============================================
  // 2. VOUCHER SYSTEM (core primitives)
  // ============================================

  private buildIdempotencyKey(
    voucherType: VoucherType,
    eventTrigger?: EventType,
    referenceType?: string,
    referenceId?: string,
  ): string {
    if (referenceType && referenceId) {
      return `${voucherType}:${eventTrigger ?? "MANUAL"}:${referenceType}:${referenceId}`;
    }
    return `${voucherType}:${eventTrigger ?? "MANUAL"}:${randomUUID()}`;
  }

  async createVoucher(data: {
    voucherType: VoucherType;
    entityType: EntityType;
    entityId?: string;
    voucherDate?: Date;
    narration: string;
    entries: Array<{
      accountId: string;
      debitAmount?: Decimal | number;
      creditAmount?: Decimal | number;
      description?: string;
      referenceType?: string;
      referenceId?: string;
      costCenter?: string;
      department?: string;
    }>;
    referenceType?: string;
    referenceId?: string;
    createdBy: string;
    isAuto?: boolean;
    eventTrigger?: EventType;
    idempotencyKey?: string;
    orderId?: string;
    customerId?: string;
    vendorId?: string;
    courierId?: string;
    paymentGatewayId?: string;
    taxTreatment?: TaxTreatment;
    lineItemDetails?: any;
     settlementBatchId?: string;
    approvalId?: string;
    approvalStatus?: ApprovalStatus;
    approvedBy?: string;
    approvedAt?: Date;
    costCenter?: string;
    department?: string;
  }) {
    const totalDebit = data.entries.reduce((sum, e) => sum.plus(d(e.debitAmount)), new Decimal(0));
    const totalCredit = data.entries.reduce((sum, e) => sum.plus(d(e.creditAmount)), new Decimal(0));

    if (!totalDebit.equals(totalCredit)) throw new Error("Debit must equal Credit");
    if (totalDebit.isZero()) throw new Error("Voucher amount cannot be zero");

    for (const e of data.entries) {
      const deb = d(e.debitAmount);
      const cred = d(e.creditAmount);
      if (deb.isZero() && cred.isZero()) throw new Error("Each entry must have debit or credit");
      if (!deb.isZero() && !cred.isZero()) throw new Error("Entry cannot have both debit and credit");
    }

    const idempotencyKey =
      data.idempotencyKey ??
      this.buildIdempotencyKey(data.voucherType, data.eventTrigger, data.referenceType, data.referenceId);

    const existingVoucher = await prisma.voucher.findUnique({ where: { idempotencyKey } });
    if (existingVoucher) return this.getVoucherById(existingVoucher.id);

    const voucherNumber = await this.generateVoucherNumber(data.voucherType, data.entityType, data.entityId);
    const resolvedVendorId = data.vendorId ?? (data.entityType === "VENDOR" ? data.entityId : undefined);

    let voucher;
    try {
      voucher = await prisma.$transaction(async (tx) => {
        const v = await tx.voucher.create({
          data: {
            voucherNumber,
            voucherType: data.voucherType,
            entityType: data.entityType,
            entityId: data.entityId,
            voucherDate: data.voucherDate ?? new Date(),
            narration: data.narration,
            totalDebit,
            totalCredit,
            status: "DRAFT",
            isAuto: data.isAuto ?? false,
            eventTrigger: data.eventTrigger,
            idempotencyKey,
            referenceType: data.referenceType,
            referenceId: data.referenceId,
            orderId: data.orderId,
            customerId: data.customerId,
            vendorId: resolvedVendorId,
            courierId: data.courierId,
            paymentGatewayId: data.paymentGatewayId,
            taxTreatment: data.taxTreatment ?? "STANDARD",
            lineItemDetails: data.lineItemDetails,
            settlementBatchId: data.settlementBatchId,
            approvalId: data.approvalId,
            approvalStatus: data.approvalStatus ?? (data.approvalId ? "APPROVED" : "NOT_REQUIRED"),
            approvedBy: data.approvedBy,
            approvedAt: data.approvedAt,
            costCenter: data.costCenter,
            department: data.department,
            createdBy: data.createdBy,
          },
        });

        for (const entry of data.entries) {
          await tx.voucherDraftEntry.create({
            data: {
              voucherId: v.id,
              accountId: entry.accountId,
              debitAmount: d(entry.debitAmount),
              creditAmount: d(entry.creditAmount),
              description: entry.description,
              referenceType: entry.referenceType,
              referenceId: entry.referenceId,
              costCenter: entry.costCenter,
              department: entry.department,
            },
          });
        }
        return v;
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        const dup = await prisma.voucher.findUnique({ where: { idempotencyKey } });
        if (dup) return this.getVoucherById(dup.id);
      }
      throw err;
    }

    await this.createAuditLog({
      action: "CREATE",
      entityName: "vouchers",
      entityId: voucher.id,
      userId: data.createdBy,
      newData: voucher,
    });

    return this.getVoucherById(voucher.id);
  }

  async getVoucherById(id: string, db?: Prisma.TransactionClient) {
    return (db ?? prisma).voucher.findUnique({
      where: { id },
      include: { ledgerEntries: { include: { account: true } } },
    });
  }

  async getVouchers(filters: {
    entityType: EntityType;
    entityId?: string;
    voucherType?: VoucherType;
    status?: VoucherStatus;
    startDate?: Date;
    endDate?: Date;
    referenceType?: string;
    referenceId?: string;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = { entityType: filters.entityType, entityId: filters.entityId || null };
    if (filters.voucherType) where.voucherType = filters.voucherType;
    if (filters.status) where.status = filters.status;
    if (filters.referenceType) where.referenceType = filters.referenceType;
    if (filters.referenceId) where.referenceId = filters.referenceId;
    if (filters.startDate || filters.endDate) {
      where.voucherDate = {};
      if (filters.startDate) where.voucherDate.gte = filters.startDate;
      if (filters.endDate) where.voucherDate.lte = filters.endDate;
    }

    const [vouchers, total] = await Promise.all([
      prisma.voucher.findMany({
        where,
        include: { ledgerEntries: { include: { account: true } } },
        orderBy: [{ voucherDate: "desc" }, { createdAt: "desc" }],
        skip,
        take: limit,
      }),
      prisma.voucher.count({ where }),
    ]);

    return { data: vouchers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

 async postVoucher(voucherId: string, userId: string, db: any = prisma) {
  // `db` is injectable (same pattern as getVoucherById) so the concurrency
  // regression tests can drive this method with a fake client; production
  // callers pass nothing and get the module client as before.
  const voucher = await db.voucher.findUnique({ where: { id: voucherId } });
  if (!voucher) throw new Error("Voucher not found");
  if (voucher.status !== "DRAFT") throw new Error("Only DRAFT vouchers can be posted");
  if (voucher.isLocked) throw new Error("Voucher is locked");

  await this.validateEntityAccess(voucher.entityType, voucher.entityId, userId);

  const draftEntries = await db.voucherDraftEntry.findMany({ where: { voucherId } });
  if (!draftEntries.length) throw new Error("No draft entries found");

  // Resolve the vendor's "Receivable from Platform" account up front so the
  // VendorPayable cache update can be computed and committed INSIDE the
  // same transaction as the ledger posting — if either fails, both roll back.
  let receivableAccountId: string | null = null;
  if (voucher.entityType === "VENDOR" && voucher.entityId) {
    const receivableAccount = await db.chartOfAccount.findFirst({
      where: { entityType: "VENDOR", entityId: voucher.entityId, name: "Receivable from Platform" },
      select: { id: true },
    });
    receivableAccountId = receivableAccount?.id ?? null;
  }

  await db.$transaction(async (tx: any) => {
    // #K5 fix (2026-11-08): claim the voucher INSIDE the transaction with a
    // guarded updateMany — the UPDATE takes a row lock and re-evaluates the
    // WHERE after any concurrent poster commits, so exactly one concurrent
    // postVoucher() call can ever win. Previously the DRAFT/locked checks
    // happened only OUTSIDE the transaction (lines above): two concurrent
    // posts of the same voucher both passed, both inserted LedgerEntry rows
    // and both incremented VendorPayable. The loser now rolls back with the
    // same "Only DRAFT vouchers can be posted" error shape callers already
    // see for an already-posted voucher, and inserts nothing.
    const claim = await tx.voucher.updateMany({
      where: { id: voucherId, status: "DRAFT", isLocked: false },
      data: { status: "POSTED", postingDate: new Date(), postedBy: userId, updatedBy: userId },
    });
    if (claim.count === 0) throw new Error("Only DRAFT vouchers can be posted");

    for (const entry of draftEntries) {
      await tx.ledgerEntry.create({
        data: {
          voucherId,
          accountId: entry.accountId,
          debitAmount: entry.debitAmount,
          creditAmount: entry.creditAmount,
          entityType: voucher.entityType,
          entityId: voucher.entityId,
          description: entry.description,
          referenceType: entry.referenceType,
          referenceId: entry.referenceId,
          costCenter: entry.costCenter,
          department: entry.department,
          entryDate: voucher.voucherDate,
        },
      });
    }

    await tx.voucherDraftEntry.deleteMany({ where: { voucherId } });

    // Keep VendorPayable in sync atomically, using the SAME draftEntries
    // being posted (not a re-query after commit) — this is what makes
    // Fix #4's double-update bug in payout impossible: every vendor
    // voucher (SALES, RETURN, EXPENSE, CHARGEBACK, ADJUSTMENT, RECEIPT...)
    // updates the cache exactly once, here, from its own ledger movement
    // on "Receivable from Platform".
    if (receivableAccountId && voucher.entityId) {
      const netDelta = (draftEntries as any[])
        .filter((e: any) => e.accountId === receivableAccountId)
        .reduce((sum: Decimal, e: any) => sum.plus(e.debitAmount).minus(e.creditAmount), new Decimal(0));

      if (!netDelta.isZero()) {
        const isSale = voucher.voucherType === "SALES";
        const positiveDelta = netDelta.greaterThan(0) ? netDelta : new Decimal(0);

        await tx.vendorPayable.upsert({
          where: { vendorId: voucher.entityId },
          update: {
            balance: { increment: netDelta },
            totalPayable: { increment: positiveDelta },
            ...(isSale
              ? { totalSales: { increment: positiveDelta }, totalOrders: { increment: 1 }, lastSaleAt: new Date() }
              : {}),
            lastSyncedAt: new Date(),
          },
          create: {
            vendorId: voucher.entityId,
            balance: netDelta,
            totalPayable: positiveDelta,
            totalSales: isSale ? positiveDelta : new Decimal(0),
            totalOrders: isSale ? 1 : 0,
            lastSaleAt: isSale ? new Date() : undefined,
            lastSyncedAt: new Date(),
          },
        });
      }
    }
  });

  await this.createAuditLog({ action: "POST", entityName: "vouchers", entityId: voucherId, userId });

  return this.getVoucherById(voucherId);
}
/**
 * Explicit approval step for vouchers held with approvalStatus=PENDING
 * (spec: fraud-variant chargeback, ADJ-1). This is the ONLY path that
 * should ever post a PENDING voucher — createVoucher()/postPairedVoucher()
 * deliberately refuse to auto-post these.
 */
async approveAndPostVoucher(voucherId: string, approvedBy: string) {
  const voucher = await prisma.voucher.findUnique({ where: { id: voucherId } });
  if (!voucher) throw new Error("Voucher not found");
  if (voucher.approvalStatus !== "PENDING") {
    throw new Error(`Voucher is not pending approval (current status: ${voucher.approvalStatus})`);
  }
  if (voucher.status !== "DRAFT") throw new Error("Only DRAFT vouchers can be approved and posted");

  await prisma.voucher.update({
    where: { id: voucherId },
    data: { approvalStatus: "APPROVED", approvedBy, approvedAt: new Date() },
  });

  await this.createAuditLog({
    action: "APPROVE",
    entityName: "vouchers",
    entityId: voucherId,
    userId: approvedBy,
    oldData: { approvalStatus: "PENDING" },
    newData: { approvalStatus: "APPROVED", approvedBy },
  });

  return this.postVoucher(voucherId, approvedBy);
}

/** Rejects a pending voucher instead of posting it. Voucher stays as a permanent DRAFT/REJECTED record for audit. */
async rejectVoucher(voucherId: string, rejectedBy: string, reason: string) {
  const voucher = await prisma.voucher.findUnique({ where: { id: voucherId } });
  if (!voucher) throw new Error("Voucher not found");
  if (voucher.approvalStatus !== "PENDING") {
    throw new Error(`Voucher is not pending approval (current status: ${voucher.approvalStatus})`);
  }

  const updated = await prisma.voucher.update({
    where: { id: voucherId },
    data: {
      approvalStatus: "REJECTED",
      status: "CANCELLED",
      cancelledBy: rejectedBy,
      cancelledAt: new Date(),
      cancelReason: reason,
    },
  });

  await this.createAuditLog({
    action: "REJECT",
    entityName: "vouchers",
    entityId: voucherId,
    userId: rejectedBy,
    newData: { approvalStatus: "REJECTED", reason },
  });

  return updated;
}
  async lockVoucher(voucherId: string, userId: string) {
    const voucher = await prisma.voucher.findUnique({ where: { id: voucherId } });
    if (!voucher) throw new Error("Voucher not found");
    if (voucher.isAuto) throw new Error("Auto vouchers cannot be manually locked");
    if (voucher.status !== "POSTED") throw new Error("Only POSTED vouchers can be locked");
    if (voucher.isLocked) throw new Error("Voucher is already locked");
    if (voucher.entityType !== "ADMIN") throw new Error("Only admin can lock vouchers");

    const updated = await prisma.voucher.update({
      where: { id: voucherId },
      data: { isLocked: true, lockedBy: userId, lockedAt: new Date(), updatedBy: userId },
    });

    await this.createAuditLog({
      action: "LOCK",
      entityName: "vouchers",
      entityId: voucherId,
      userId,
      oldData: voucher,
      newData: updated,
    });

    return updated;
  }

  async reverseVoucher(voucherId: string, reason: string, userId: string) {
    const voucher = await prisma.voucher.findUnique({
      where: { id: voucherId },
      include: { ledgerEntries: true },
    });

    if (!voucher) throw new Error("Voucher not found");
    if (voucher.status !== "POSTED") throw new Error("Only POSTED vouchers can be reversed");
    if (voucher.isLocked) throw new Error("Locked vouchers cannot be reversed");
    if (voucher.isReversed) throw new Error("Already reversed");

    await this.validateEntityAccess(voucher.entityType, voucher.entityId, userId);

    const reversalEntries = voucher.ledgerEntries.map((e) => ({
      accountId: e.accountId,
      debitAmount: e.creditAmount,
      creditAmount: e.debitAmount,
      description: `Reversal of ${voucher.voucherNumber}`,
      referenceType: e.referenceType ?? undefined,
      referenceId: e.referenceId ?? undefined,
      costCenter: e.costCenter ?? undefined,
      department: e.department ?? undefined,
    }));

    const reversalVoucher = await this.createVoucher({
      voucherType: voucher.voucherType,
      entityType: voucher.entityType,
      entityId: voucher.entityId ?? undefined,
      narration: `REVERSAL: ${voucher.narration} (${reason})`,
      entries: reversalEntries,
      referenceType: voucher.referenceType ?? undefined,
      referenceId: voucher.referenceId ?? undefined,
      vendorId: voucher.vendorId ?? undefined,
      orderId: voucher.orderId ?? undefined,
      customerId: voucher.customerId ?? undefined,
      createdBy: userId,
    });

    if (!reversalVoucher) throw new Error("Failed to create reversal voucher");

    await this.postVoucher(reversalVoucher.id, userId);

    await prisma.voucher.update({
      where: { id: voucherId },
      data: { status: "REVERSED", isReversed: true, reversedById: reversalVoucher.id, updatedBy: userId },
    });

    await prisma.voucher.update({ where: { id: reversalVoucher.id }, data: { reversalOfId: voucherId } });

    await this.createAuditLog({
      action: "REVERSE",
      entityName: "vouchers",
      entityId: voucherId,
      userId,
      newData: { reversalVoucherId: reversalVoucher.id, reason },
    });

    return { originalVoucher: voucherId, reversalVoucher: reversalVoucher.id };
  }

  async cancelVoucher(voucherId: string, reason: string, userId: string) {
    const voucher = await prisma.voucher.findUnique({ where: { id: voucherId } });
    if (!voucher) throw new Error("Voucher not found");
    if (voucher.status !== "DRAFT") throw new Error("Only DRAFT vouchers can be cancelled");
    if (voucher.isAuto) throw new Error("Auto vouchers cannot be cancelled manually");

    await this.validateEntityAccess(voucher.entityType, voucher.entityId, userId);

    const updated = await prisma.voucher.update({
      where: { id: voucherId },
      data: { status: "CANCELLED", cancelledBy: userId, cancelledAt: new Date(), cancelReason: reason, updatedBy: userId },
    });

    await this.createAuditLog({
      action: "UPDATE",
      entityName: "vouchers",
      entityId: voucherId,
      userId,
      oldData: voucher,
      newData: { status: "CANCELLED", cancelReason: reason },
    });

    return updated;
  }

  // ============================================================
  // 3. DUAL-LEDGER POSTING ENGINE (generic, spec-aligned)
  // Every Phase 1-9 event ultimately reduces to: resolve account
  // names against the COA, build a balanced platform-side voucher
  // and (usually) a balanced vendor-side voucher, check idempotency
  // per the spec's key formula, post both immediately (real-time
  // events) and return both. This is what §10 calls the dual-ledger
  // invariant: Vendor Payables (platform) must always tie to
  // Receivable from Platform (vendor).
  // ============================================================

  private async resolveEntries(
    entityType: EntityType,
    entityId: string | null,
    entries: JournalEntryInput[],
  ) {
    const resolved = [];
    for (const e of entries) {
      const deb = d(e.debit);
      const cred = d(e.credit);
      if (deb.isZero() && cred.isZero()) continue; // skip zero-amount lines (e.g. no VAT on exempt items)
      const accountId = await this.getAccountId(entityType, entityId, e.accountClass, e.accountName);
      resolved.push({
        accountId,
        debitAmount: deb,
        creditAmount: cred,
        description: e.description,
        referenceType: e.referenceType,
        referenceId: e.referenceId,
      });
    }
    return resolved;
  }

  /**
   * Posts the platform-side and (optionally) vendor-side vouchers for
   * one business event, honoring per-side idempotency and posting both
   * immediately (the vast majority of Phase 1-9 events are real-time).
   * Returns { platform, vendor } — either may be null if not supplied.
   */
  /**
   * #K6: duplicate real-time triggers (e.g. concurrent DELIVERED webhooks for
   * the same consignment) both pass the caller's `status === "DRAFT"` check
   * on the SAME idempotent-hit voucher row and both enter postVoucher. #K5's
   * guarded claim guarantees exactly one posts; the loser throws "Only DRAFT
   * vouchers can be posted". That lost race is a SUCCESS outcome — the event
   * is already accounted — so re-read and return the POSTED voucher instead
   * of letting the error escape into the caller (a webhook 500 would make the
   * provider retry-storm an already-correct posting). A re-read that finds
   * anything but POSTED (e.g. CANCELLED) or any other error rethrows.
   */
  private async postVoucherIdempotent(voucherId: string, createdBy: string) {
    try {
      return await this.postVoucher(voucherId, createdBy);
    } catch (err: any) {
      if (err?.message !== "Only DRAFT vouchers can be posted") throw err;
      const reread = await this.getVoucherById(voucherId);
      if (reread?.status === "POSTED") return reread;
      throw err;
    }
  }

 private async postPairedVoucher(input: PairedVoucherInput) {
  const createdBy = input.createdBy ?? "system";
  let platform = null as any;
  let vendor = null as any;

  if (input.platform) {
    const platformKey = `${input.idempotencyKey}:PLATFORM`;
    const entries = await this.resolveEntries("ADMIN", null, input.platform.entries);
    platform = await this.createVoucher({
      voucherType: input.platform.voucherType,
      entityType: "ADMIN",
      voucherDate: input.platform.voucherDate,
      narration: input.platform.narration,
      entries,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      isAuto: true,
      eventTrigger: input.eventTrigger,
      idempotencyKey: platformKey,
      orderId: input.orderId,
      customerId: input.customerId,
      vendorId: input.platform.vendorId,
      courierId: input.courierId,
      paymentGatewayId: input.paymentGatewayId,
      taxTreatment: input.taxTreatment,
      lineItemDetails: input.lineItemDetails,
      settlementBatchId: input.settlementBatchId,
      approvalId: input.approvalId,
      approvalStatus: input.approvalStatus,
      approvedBy: input.approvedBy,
      approvedAt: input.approvedAt,
      createdBy,
    });
    if (platform && platform.status === "DRAFT" && platform.approvalStatus !== "PENDING") {
      platform = await this.postVoucherIdempotent(platform.id, createdBy);
    }
  }

  if (input.vendor) {
    const vendorKey = `${input.idempotencyKey}:VENDOR`;
    const entries = await this.resolveEntries("VENDOR", input.vendor.vendorId, input.vendor.entries);
    vendor = await this.createVoucher({
      voucherType: input.vendor.voucherType,
      entityType: "VENDOR",
      entityId: input.vendor.vendorId,
      voucherDate: input.vendor.voucherDate,
      narration: input.vendor.narration,
      entries,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      isAuto: true,
      eventTrigger: input.eventTrigger,
      idempotencyKey: vendorKey,
      orderId: input.orderId,
      customerId: input.customerId,
      vendorId: input.vendor.vendorId,
      courierId: input.courierId,
      taxTreatment: input.taxTreatment,
      lineItemDetails: input.lineItemDetails,
      settlementBatchId: input.settlementBatchId,
      approvalId: input.approvalId,
      approvalStatus: input.approvalStatus,
      approvedBy: input.approvedBy,
      approvedAt: input.approvedAt,
      createdBy,
    });
    if (vendor && vendor.status === "DRAFT" && vendor.approvalStatus !== "PENDING") {
      vendor = await this.postVoucherIdempotent(vendor.id, createdBy);
    }
  }

  // Surface pending-approval state explicitly so callers don't mistake
  // a held-back DRAFT voucher for a normally-posted one.
  const pendingApproval =
    (platform?.status === "DRAFT" && platform?.approvalStatus === "PENDING") ||
    (vendor?.status === "DRAFT" && vendor?.approvalStatus === "PENDING");

  return { platform, vendor, pendingApproval };
}

  // ============================================================
  // PHASE 1 — ORDER PLACEMENT (Events 0a, 0b)
  // No vendor entries; establishes Customer Deposit Liability escrow.
  // ============================================================

  async createEvent0aOnlinePayment(data: {
    orderId: string;
    customerId?: string;
    amount: Decimal | number;
    paymentGatewayId: string;
    orderDate?: Date;
    createdBy?: string;
  }) {
    const amount = d(data.amount);
    return this.postPairedVoucher({
      idempotencyKey: `ORDER_PLACED:SSLCommerz:${data.orderId}:${data.paymentGatewayId}`,
      eventTrigger: "ORDER_PLACED",
      referenceType: "order",
      referenceId: data.orderId,
      orderId: data.orderId,
      customerId: data.customerId,
      paymentGatewayId: data.paymentGatewayId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "RECEIPT",
        narration: `Online payment captured — Order #${data.orderId}`,
        voucherDate: data.orderDate,
        entries: [
          { accountName: "Receivable from Payment Gateway (SSLCommerz)", accountClass: "ASSET", debit: amount, description: "Funds captured, pending settlement" },
          { accountName: "Customer Deposit Liability", accountClass: "LIABILITY", credit: amount, description: "Escrow held pending delivery" },
        ],
      },
    });
  }

  async createEvent0bSplitFundedPayment(data: {
    orderId: string;
    customerId?: string;
    cashAmount: Decimal | number;
    storeCreditAmount: Decimal | number;
    paymentGatewayId: string;
    orderDate?: Date;
    createdBy?: string;
  }) {
    const cash = d(data.cashAmount);
    const credit = d(data.storeCreditAmount);
    const total = cash.plus(credit);
    return this.postPairedVoucher({
      idempotencyKey: `ORDER_PLACED:SPLIT:${data.orderId}:${data.paymentGatewayId}`,
      eventTrigger: "ORDER_PLACED",
      referenceType: "order",
      referenceId: data.orderId,
      orderId: data.orderId,
      customerId: data.customerId,
      paymentGatewayId: data.paymentGatewayId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "RECEIPT",
        narration: `Split-funded payment captured — Order #${data.orderId}`,
        voucherDate: data.orderDate,
        entries: [
          { accountName: "Receivable from Payment Gateway (SSLCommerz)", accountClass: "ASSET", debit: cash, description: "Cash portion pending from gateway" },
          { accountName: "Store Credit Liability", accountClass: "LIABILITY", debit: credit, description: "Customer redeems store credit" },
          { accountName: "Customer Deposit Liability", accountClass: "LIABILITY", credit: total, description: "Full order value now held in escrow" },
        ],
      },
    });
  }

  // ============================================================
  // PHASE 2 — PAYMENT CAPTURE (Event 8.A) — see also Phase 8 block
  // ============================================================

  async createEvent8aPGSettlement(data: {
    settlementBatchId: string;
    paymentGatewayId: string;
    grossAmount: Decimal | number;
    gatewayFee: Decimal | number;
    settlementDate?: Date;
    createdBy?: string;
  }) {
    const gross = d(data.grossAmount);
    const fee = d(data.gatewayFee);
    const net = gross.minus(fee);
    return this.postPairedVoucher({
      idempotencyKey: `SETTLEMENT:SETTLED:${data.settlementBatchId}:${data.paymentGatewayId}`,
      eventTrigger: "SETTLED",
      referenceType: "settlement_batch",
      referenceId: data.settlementBatchId,
      paymentGatewayId: data.paymentGatewayId,
      settlementBatchId: data.settlementBatchId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "SETTLEMENT",
        narration: `SSLCommerz T+1 settlement — batch ${data.settlementBatchId}`,
        voucherDate: data.settlementDate,
        entries: [
          { accountName: "Cash in Operating Bank Account", accountClass: "ASSET", debit: net, description: "Bank deposit" },
          { accountName: "Payment Gateway Fees Expense", accountClass: "EXPENSE", debit: fee, description: "SSLCommerz fee" },
          { accountName: "Receivable from Payment Gateway (SSLCommerz)", accountClass: "ASSET", credit: gross, description: "Clearance" },
        ],
      },
    });
  }

  // ============================================================
  // PHASE 3 — DELIVERY RECOGNITION (Events 1, 1-COD, 12, and the
  // discount/free-shipping variants Event 2 & Event 13)
  // ============================================================

  async createDeliveryVoucher(data: {
    orderId: string;
    vendorId: string;
    deliveryId: string;
    customerId?: string;
    courierId?: string;
    paymentMethod: "ONLINE" | "COD" | "STORE_CREDIT";
    productBase: Decimal | number; // discounted base if a discount applies
    productVat: Decimal | number;
    shippingBase: Decimal | number; // 0 if free-shipping promo
    shippingVat: Decimal | number;
    commissionBase: Decimal | number; // computed on discounted base per spec
    commissionVat: Decimal | number;
    courierCostBase: Decimal | number;
    courierCostVat: Decimal | number;
    cogsAmount: Decimal | number;
    discountAmount?: Decimal | number; // Event 2 — vendor-funded discount (contra-income, gross method)
    platformFundedDiscount?: Decimal | number; // Event 2 split-funded variant
    freeShippingPlatformAbsorbed?: boolean; // Event 13
    lineItemDetails?: any; // PHASE 2 BATCH 1C-2c: per-SKU sale-time tax snapshot
    deliveryDate?: Date;
    createdBy?: string;
  }) {
    const productBase = d(data.productBase);
    const productVat = d(data.productVat);
    const shippingBase = d(data.shippingBase);
    const shippingVat = d(data.shippingVat);
    const commissionBase = d(data.commissionBase);
    const commissionVat = d(data.commissionVat);
    const courierBase = d(data.courierCostBase);
    const courierVat = d(data.courierCostVat);
    const cogs = d(data.cogsAmount);
    const discount = d(data.discountAmount);
    const platformDiscountShare = d(data.platformFundedDiscount);
    const vendorDiscountShare = discount.minus(platformDiscountShare);

    const escrowOrCollection = productBase.plus(productVat).plus(shippingBase).plus(shippingVat);
const netCommission = commissionBase.plus(commissionVat);

const vendorPayable = productBase
  .plus(productVat)
  .minus(netCommission)
  .plus(platformDiscountShare);
const courierTotal = courierBase.plus(courierVat);

    const platformEscrowLine: JournalEntryInput =
      data.paymentMethod === "COD"
        ? { accountName: "Receivable from Courier (COD)", accountClass: "ASSET", debit: escrowOrCollection, description: "Cash collected by courier, pending remittance" }
        : { accountName: "Customer Deposit Liability", accountClass: "LIABILITY", debit: escrowOrCollection, description: "Release escrow" };

    const platformEntries: JournalEntryInput[] = [platformEscrowLine];

    if (data.freeShippingPlatformAbsorbed) {
      platformEntries.push({ accountName: "Platform Discount Expense", accountClass: "EXPENSE", debit: courierBase, description: "Platform absorbs shipping base" });
    } else {
      platformEntries.push({ accountName: "Courier Delivery Fees Expense", accountClass: "EXPENSE", debit: courierBase, description: "Base courier cost" });
    }
    platformEntries.push({ accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: courierVat, description: "VAT on courier fee" });
    platformEntries.push({ accountName: "Vendor Payables", accountClass: "LIABILITY", credit: vendorPayable, description: "Owed to vendor" });
    platformEntries.push({ accountName: "Platform Commission Income", accountClass: "INCOME", credit: commissionBase, description: "Commission earned" });
    platformEntries.push({ accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: commissionVat, description: "VAT on commission" });
    if (!data.freeShippingPlatformAbsorbed && shippingBase.greaterThan(0)) {
      platformEntries.push({ accountName: "Courier Delivery Income", accountClass: "INCOME", credit: shippingBase, description: "Shipping income base" });
      platformEntries.push({ accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: shippingVat, description: "VAT on shipping" });
    }
    platformEntries.push({ accountName: "Payable to Courier", accountClass: "LIABILITY", credit: courierTotal, description: "Courier fee + VAT" });
    if (platformDiscountShare.greaterThan(0)) {
      platformEntries.push({ accountName: "Platform Discount Expense", accountClass: "EXPENSE", debit: platformDiscountShare, description: "Platform-funded portion of discount" });
    }

    const vendorEntries: JournalEntryInput[] = [
      { accountName: "Receivable from Platform", accountClass: "ASSET", debit: vendorPayable, description: "Net receivable" },
      { accountName: "Platform Commission Expense", accountClass: "EXPENSE", debit: commissionBase, description: "Commission expense" },
      { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: commissionVat, description: "VAT on commission" },
    ];
    if (vendorDiscountShare.greaterThan(0)) {
      vendorEntries.push({ accountName: "Vendor Funded Discounts", accountClass: "INCOME", debit: vendorDiscountShare, description: "Discount given (contra-income)" });
    }
    // Gross-method: Sales Revenue always at gross (pre-discount) base
    const grossProductBase = productBase.plus(discount);
    vendorEntries.push({ accountName: "Sales Revenue", accountClass: "INCOME", credit: discount.greaterThan(0) ? grossProductBase : productBase, description: "Product sold (gross)" });
    vendorEntries.push({ accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: productVat, description: "VAT on discounted base" });
    if (cogs.greaterThan(0)) {
      vendorEntries.push({ accountName: "Cost of Goods Sold (Expense)", accountClass: "EXPENSE", debit: cogs, description: "Relieve inventory at cost" });
      vendorEntries.push({ accountName: "Inventory Asset (Goods)", accountClass: "ASSET", credit: cogs, description: "Product shipped out of stock" });
    }

    const variantFlag = data.freeShippingPlatformAbsorbed ? "free_shipping" : discount.greaterThan(0) ? "discount" : "std";

    return this.postPairedVoucher({
      idempotencyKey: `DELIVERED:${data.deliveryId}:${data.paymentMethod}:${variantFlag}:${data.orderId}`,
      eventTrigger: "DELIVERED",
      referenceType: "order",
      referenceId: data.orderId,
      orderId: data.orderId,
      customerId: data.customerId,
      courierId: data.courierId,
      lineItemDetails: data.lineItemDetails,
      createdBy: data.createdBy,
      platform: {
        voucherType: "SALES",
        narration: `Delivery recognized — Order #${data.orderId} (${data.paymentMethod})`,
        voucherDate: data.deliveryDate,
        vendorId: data.vendorId,
        entries: platformEntries,
      },
      vendor: {
        vendorId: data.vendorId,
        voucherType: "SALES",
        narration: `Sale recognized on delivery — Order #${data.orderId}`,
        voucherDate: data.deliveryDate,
        entries: vendorEntries,
      },
    });
  }

  // ============================================================
  // PHASE 4 — RETURNS & REFUNDS (Events 3, 4, 5, 3-V)
  // ============================================================

  /** Covers both Event 3 (full) and Event 4 (partial, via lineItemId). */
  async createReturnVoucher(data: {
    orderId: string;
    returnId: string;
    lineItemId?: string; // present => partial return (Event 4)
    vendorId: string;
    customerId?: string;
    productBase: Decimal | number;
    productVat: Decimal | number;
    commissionBase: Decimal | number;
    commissionVat: Decimal | number;
    pgFeeNonRefundable: Decimal | number;
    returnCourierBase: Decimal | number;
    returnCourierVat: Decimal | number;
    cogsToRestore?: Decimal | number; // omit/0 if goods not physically recovered
    refundMethod?: "PG" | "WALLET";
    returnDate?: Date;
    createdBy?: string;
  }) {
    const productBase = d(data.productBase);
    const productVat = d(data.productVat);
    const commissionBase = d(data.commissionBase);
    const commissionVat = d(data.commissionVat);
    const pgFee = d(data.pgFeeNonRefundable);
    const returnCourierBase = d(data.returnCourierBase);
    const returnCourierVat = d(data.returnCourierVat);
    const cogs = d(data.cogsToRestore);
    const refundAmount = productBase.plus(productVat);
    const netCommission = commissionBase.plus(commissionVat);
    const returnCourierTotal = returnCourierBase.plus(returnCourierVat);

    const platformEntries: JournalEntryInput[] = [
      { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: refundAmount, description: "Reverse product + VAT" },
      data.refundMethod === "WALLET"
        ? { accountName: "Store Credit Liability", accountClass: "LIABILITY", credit: refundAmount, description: "Refund issued as store credit" }
        : { accountName: "Payable to Payment Gateway (Refunds)", accountClass: "LIABILITY", credit: refundAmount, description: "Refund to customer" },
      { accountName: "Platform Commission Income", accountClass: "INCOME", debit: commissionBase, description: "Reverse commission base" },
      { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", debit: commissionVat, description: "Reverse VAT on commission" },
      { accountName: "Vendor Payables", accountClass: "LIABILITY", credit: netCommission, description: "Restore commission to vendor" },
      { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: pgFee, description: "Charge vendor for non-refundable PG fee" },
      { accountName: "Payment Gateway Fees Expense", accountClass: "EXPENSE", credit: pgFee, description: "Reverse original PG fee" },
      { accountName: "Courier Return Delivery Expense", accountClass: "EXPENSE", debit: returnCourierBase, description: "Accrue return-leg courier cost" },
      { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: returnCourierVat, description: "VAT on return-leg courier cost" },
      { accountName: "Payable to Courier", accountClass: "LIABILITY", credit: returnCourierTotal, description: "Return fee owed to courier" },
      { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: returnCourierTotal, description: "Charge vendor for return shipping" },
      { accountName: "Courier Return Delivery Expense", accountClass: "EXPENSE", credit: returnCourierBase, description: "Reclass return-leg cost to vendor" },
      { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", credit: returnCourierVat, description: "Reclass VAT to vendor" },
    ];

    const vendorEntries: JournalEntryInput[] = [
      { accountName: "Sales Returns", accountClass: "INCOME", debit: productBase, description: "Reverse product base" },
      { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", debit: productVat, description: "Reverse VAT" },
      { accountName: "Receivable from Platform", accountClass: "ASSET", credit: refundAmount, description: "Reduce receivable for refund" },
      { accountName: "Receivable from Platform", accountClass: "ASSET", debit: netCommission, description: "Restore net commission" },
      { accountName: "Platform Commission Expense", accountClass: "EXPENSE", credit: commissionBase, description: "Reverse commission base" },
      { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", credit: commissionVat, description: "Reverse VAT on commission" },
      { accountName: "PG Fee / Shortfall Expense", accountClass: "EXPENSE", debit: pgFee, description: "Vendor bears lost PG fee" },
      { accountName: "Receivable from Platform", accountClass: "ASSET", credit: pgFee, description: "Reduce receivable for PG fee" },
      { accountName: "Courier Return/Forward Expense", accountClass: "EXPENSE", debit: returnCourierBase, description: "Vendor bears return shipping" },
      { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: returnCourierVat, description: "VAT on return shipping" },
      { accountName: "Receivable from Platform", accountClass: "ASSET", credit: returnCourierTotal, description: "Reduce receivable for shipping" },
    ];
    if (cogs.greaterThan(0)) {
      vendorEntries.push({ accountName: "Inventory Asset (Goods)", accountClass: "ASSET", debit: cogs, description: "Item returned, restored to stock" });
      vendorEntries.push({ accountName: "Cost of Goods Sold (Expense)", accountClass: "EXPENSE", credit: cogs, description: "Reverse cost recognized at original sale" });
    }

    const refKey = data.lineItemId
      ? `RETURNED:${data.orderId}:${data.returnId}:${data.lineItemId}`
      : `RETURNED:${data.orderId}:${data.returnId}`;

    return this.postPairedVoucher({
      idempotencyKey: refKey,
      eventTrigger: "RETURNED",
      referenceType: "return",
      referenceId: data.returnId,
      orderId: data.orderId,
      customerId: data.customerId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "RETURN",
        narration: `${data.lineItemId ? "Partial" : "Full"} return — Order #${data.orderId}`,
        voucherDate: data.returnDate,
        vendorId: data.vendorId,
        entries: platformEntries,
      },
      vendor: {
        vendorId: data.vendorId,
        voucherType: "RETURN",
        narration: `Return processed — Order #${data.orderId}`,
        voucherDate: data.returnDate,
        entries: vendorEntries,
      },
    });
  }

  /** Event 5 — Platform-funded goodwill refund. No vendor entry. */
  async createGoodwillRefundVoucher(data: {
    orderId: string;
    refundId: string;
    amount: Decimal | number;
    refundMethod?: "PG" | "WALLET";
    refundDate?: Date;
    createdBy?: string;
  }) {
    const amount = d(data.amount);
    return this.postPairedVoucher({
      idempotencyKey: `GOODWILL_REFUND:PLATFORM:${data.orderId}:${data.refundId}`,
      eventTrigger: "GOODWILL_REFUND",
      referenceType: "refund",
      referenceId: data.refundId,
      orderId: data.orderId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "REFUND",
        narration: `Goodwill refund — Order #${data.orderId}`,
        voucherDate: data.refundDate,
        entries: [
          { accountName: "Goodwill/Platform Compensation", accountClass: "EXPENSE", debit: amount, description: "Platform absorbs cost" },
          data.refundMethod === "WALLET"
            ? { accountName: "Store Credit Liability", accountClass: "LIABILITY", credit: amount, description: "Refund issued as store credit" }
            : { accountName: "Payable to Payment Gateway (Refunds)", accountClass: "LIABILITY", credit: amount, description: "Queue refund to customer" },
        ],
      },
    });
  }

  /** Event 3-V — Vendor cancels after payment, before delivery. */
  async createVendorCancellationVoucher(data: {
    orderId: string;
    cancellationId: string;
    vendorId: string;
    escrowAmount: Decimal | number;
    pgFee: Decimal | number;
    cancellationPenalty: Decimal | number;
    cancelDate?: Date;
    createdBy?: string;
  }) {
    const escrow = d(data.escrowAmount);
    const pgFee = d(data.pgFee);
    const penalty = d(data.cancellationPenalty);
    const vendorCharge = pgFee.plus(penalty);

    return this.postPairedVoucher({
      idempotencyKey: `VENDOR_CANCEL:POST_PAYMENT:${data.orderId}:${data.cancellationId}`,
      eventTrigger: "VENDOR_CANCEL",
      referenceType: "cancellation",
      referenceId: data.cancellationId,
      orderId: data.orderId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "REFUND",
        narration: `Vendor cancellation after payment — Order #${data.orderId}`,
        voucherDate: data.cancelDate,
        vendorId: data.vendorId,
        entries: [
          { accountName: "Customer Deposit Liability", accountClass: "LIABILITY", debit: escrow, description: "Extinguish escrow (no delivery)" },
          { accountName: "Payable to Payment Gateway (Refunds)", accountClass: "LIABILITY", credit: escrow, description: "Full refund to customer" },
          { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: pgFee, description: "Charge vendor for non-refundable PG fee" },
          { accountName: "Payment Gateway Fees Expense", accountClass: "EXPENSE", credit: pgFee, description: "Reverse original PG fee" },
          { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: penalty, description: "Charge vendor for cancellation penalty" },
          { accountName: "Goodwill/Platform Compensation", accountClass: "EXPENSE", credit: penalty, description: "Recharge goodwill cost to vendor" },
        ],
      },
      vendor: {
        vendorId: data.vendorId,
        voucherType: "ADJUSTMENT",
        narration: `Cancellation penalty + PG fee — Order #${data.orderId}`,
        voucherDate: data.cancelDate,
        entries: [
          { accountName: "Damage/Loss Liability Expense", accountClass: "EXPENSE", debit: penalty, description: "Vendor bears cancellation penalty" },
          { accountName: "PG Fee / Shortfall Expense", accountClass: "EXPENSE", debit: pgFee, description: "Vendor bears lost PG fee" },
          { accountName: "Receivable from Platform", accountClass: "ASSET", credit: vendorCharge, description: "Net receivable reduction" },
        ],
      },
    });
  }

  // ============================================================
  // PHASE 5 — COD SCENARIOS (Events 6, 7, 7-V)
  // ============================================================

  /** Event 6 — COD RTS / delivery failure. Two-step accrue-then-reclass. */
  async createCODFailureVoucher(data: {
    orderId: string;
    rtsId: string;
    vendorId: string;
    forwardFeeBase: Decimal | number;
    returnFeeBase: Decimal | number;
    vat: Decimal | number;
    rtsDate?: Date;
    createdBy?: string;
  }) {
    const forward = d(data.forwardFeeBase);
    const ret = d(data.returnFeeBase);
    const vat = d(data.vat);
    const total = forward.plus(ret).plus(vat);

    return this.postPairedVoucher({
      idempotencyKey: `RTS:${data.orderId}:${data.rtsId}`,
      eventTrigger: "RTS",
      referenceType: "rts",
      referenceId: data.rtsId,
      orderId: data.orderId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "EXPENSE",
        narration: `COD RTS — Order #${data.orderId}`,
        voucherDate: data.rtsDate,
        vendorId: data.vendorId,
        entries: [
          { accountName: "Courier Delivery Fees Expense", accountClass: "EXPENSE", debit: forward, description: "Forward delivery fee" },
          { accountName: "Courier Return Delivery Expense", accountClass: "EXPENSE", debit: ret, description: "Return delivery fee" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: vat, description: "VAT on courier fees" },
          { accountName: "Payable to Courier", accountClass: "LIABILITY", credit: total, description: "Total liability to courier" },
          { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: total, description: "Charge vendor for failure" },
          { accountName: "Courier Delivery Fees Expense", accountClass: "EXPENSE", credit: forward, description: "Reverse forward fee (reclass)" },
          { accountName: "Courier Return Delivery Expense", accountClass: "EXPENSE", credit: ret, description: "Reverse return fee (reclass)" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", credit: vat, description: "Reverse VAT (reclass)" },
        ],
      },
      vendor: {
        vendorId: data.vendorId,
        voucherType: "EXPENSE",
        narration: `Failed COD delivery cost — Order #${data.orderId}`,
        voucherDate: data.rtsDate,
        entries: [
          { accountName: "Courier Return/Forward Expense", accountClass: "EXPENSE", debit: forward.plus(ret), description: "Total failed delivery cost" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: vat, description: "VAT on courier cost" },
          { accountName: "Receivable from Platform", accountClass: "ASSET", credit: total, description: "Liability to platform" },
        ],
      },
    });
  }

  /** Event 7 — COD short-payment; posts revenue at amount actually collected. */
  async createCODShortPaymentVoucher(data: {
    orderId: string;
    deliveryId: string;
    vendorId: string;
    customerId?: string;
    courierId?: string;
    collectedAmount: Decimal | number; // actual cash collected
    fullPayableAmount: Decimal | number; // what vendor would have received in full (Event 1-COD)
    productBase: Decimal | number;
    productVat: Decimal | number;
    commissionBase: Decimal | number;
    commissionVat: Decimal | number;
    courierCostBase: Decimal | number;
    courierCostVat: Decimal | number;
    shippingBase: Decimal | number;
    shippingVat: Decimal | number;
    cogsAmount: Decimal | number;
    deliveryDate?: Date;
    createdBy?: string;
  }) {
    const collected = d(data.collectedAmount);
    const fullPayable = d(data.fullPayableAmount);
    const productBase = d(data.productBase);
    const productVat = d(data.productVat);
    const commissionBase = d(data.commissionBase);
    const commissionVat = d(data.commissionVat);
    const courierBase = d(data.courierCostBase);
    const courierVat = d(data.courierCostVat);
    const shippingBase = d(data.shippingBase);
    const shippingVat = d(data.shippingVat);
    const cogs = d(data.cogsAmount);
    const vendorPayable = fullPayable; // caller supplies already-shortfall-adjusted payable
    const courierTotal = courierBase.plus(courierVat);
    const trueShortfall = productBase.plus(productVat).plus(shippingBase).plus(shippingVat).minus(collected);

    return this.postPairedVoucher({
      idempotencyKey: `DELIVERED:${data.deliveryId}:COD:short_payment:${data.orderId}`,
      eventTrigger: "DELIVERED",
      referenceType: "order",
      referenceId: data.orderId,
      orderId: data.orderId,
      customerId: data.customerId,
      courierId: data.courierId,
      lineItemDetails: { shortPayment: true, expected: fullPayable.toString(), collected: collected.toString() },
      createdBy: data.createdBy,
      platform: {
        voucherType: "SALES",
        narration: `COD short-payment delivery — Order #${data.orderId}`,
        voucherDate: data.deliveryDate,
        vendorId: data.vendorId,
        entries: [
          { accountName: "Receivable from Courier (COD)", accountClass: "ASSET", debit: collected, description: "Amount actually collected" },
          { accountName: "Courier Delivery Fees Expense", accountClass: "EXPENSE", debit: courierBase, description: "Base courier cost" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: courierVat, description: "VAT on courier fee" },
          { accountName: "Vendor Payables", accountClass: "LIABILITY", credit: vendorPayable, description: "Owed to vendor (net of shortfall)" },
          { accountName: "Platform Commission Income", accountClass: "INCOME", credit: commissionBase, description: "Commission earned" },
          { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: commissionVat, description: "VAT on commission" },
          { accountName: "Courier Delivery Income", accountClass: "INCOME", credit: shippingBase, description: "Shipping income" },
          { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: shippingVat, description: "VAT on shipping" },
          { accountName: "Payable to Courier", accountClass: "LIABILITY", credit: courierTotal, description: "Courier fee + VAT" },
        ],
      },
      vendor: {
        vendorId: data.vendorId,
        voucherType: "SALES",
        narration: `Sale recognized (short-paid) — Order #${data.orderId}`,
        voucherDate: data.deliveryDate,
        entries: [
          { accountName: "Receivable from Platform", accountClass: "ASSET", debit: vendorPayable, description: "Net receivable" },
          { accountName: "Platform Commission Expense", accountClass: "EXPENSE", debit: commissionBase, description: "Commission expense" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: commissionVat, description: "VAT on commission" },
          { accountName: "PG Fee / Shortfall Expense", accountClass: "EXPENSE", debit: trueShortfall.greaterThan(0) ? trueShortfall : new Decimal(0), description: "Vendor absorbs shortfall" },
          { accountName: "Sales Revenue", accountClass: "INCOME", credit: productBase, description: "Product sold (base)" },
          { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: productVat, description: "VAT on sale" },
          { accountName: "Cost of Goods Sold (Expense)", accountClass: "EXPENSE", debit: cogs, description: "Relieve inventory at cost" },
          { accountName: "Inventory Asset (Goods)", accountClass: "ASSET", credit: cogs, description: "Product shipped out of stock" },
        ],
      },
    });
  }

  /** Event 7-V — delivery failed after courier collected a partial amount. */
  async createPartialCollectionFailureVoucher(data: {
    orderId: string;
    rtsId: string;
    vendorId: string;
    partialCollectionAmount: Decimal | number;
    forwardFeeBase: Decimal | number;
    returnFeeBase: Decimal | number;
    vat: Decimal | number;
    rtsDate?: Date;
    createdBy?: string;
  }) {
    const partial = d(data.partialCollectionAmount);
    const forward = d(data.forwardFeeBase);
    const ret = d(data.returnFeeBase);
    const vat = d(data.vat);
    const courierFees = forward.plus(ret).plus(vat);
    const payableToCourier = partial.plus(courierFees);

    return this.postPairedVoucher({
      idempotencyKey: `RTS:partial_collection:${data.orderId}:${data.rtsId}`,
      eventTrigger: "RTS",
      referenceType: "rts",
      referenceId: data.rtsId,
      orderId: data.orderId,
      lineItemDetails: { partialCollectionAmount: partial.toString() },
      createdBy: data.createdBy,
      platform: {
        voucherType: "EXPENSE",
        narration: `Delivery failure after partial COD collection — Order #${data.orderId}`,
        voucherDate: data.rtsDate,
        vendorId: data.vendorId,
        entries: [
          { accountName: "Receivable from Courier (COD)", accountClass: "ASSET", debit: partial, description: "Partial collection (to be returned to customer)" },
          { accountName: "Courier Delivery Fees Expense", accountClass: "EXPENSE", debit: forward, description: "Accrue forward delivery fee" },
          { accountName: "Courier Return Delivery Expense", accountClass: "EXPENSE", debit: ret, description: "Accrue return delivery fee" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: vat, description: "VAT on courier fees" },
          { accountName: "Payable to Courier", accountClass: "LIABILITY", credit: payableToCourier, description: "Customer refund + courier fees" },
          { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: courierFees, description: "Charge vendor for courier fees" },
          { accountName: "Courier Delivery Fees Expense", accountClass: "EXPENSE", credit: forward, description: "Reclass forward fee to vendor" },
          { accountName: "Courier Return Delivery Expense", accountClass: "EXPENSE", credit: ret, description: "Reclass return fee to vendor" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", credit: vat, description: "Reclass VAT to vendor" },
        ],
      },
      vendor: {
        vendorId: data.vendorId,
        voucherType: "EXPENSE",
        narration: `Failed delivery cost (partial collection) — Order #${data.orderId}`,
        voucherDate: data.rtsDate,
        entries: [
          { accountName: "Courier Return/Forward Expense", accountClass: "EXPENSE", debit: forward.plus(ret), description: "Total failed delivery cost" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: vat, description: "VAT on courier cost" },
          { accountName: "Receivable from Platform", accountClass: "ASSET", credit: courierFees, description: "Liability to platform" },
        ],
      },
    });
  }

  // ============================================================
  // PHASE 6 — DISPUTES & CLAIMS (Events 8, 9)
  // ============================================================

 /** Event 8 — Chargeback. FRAUD variant requires manual approval (held DRAFT). */
async createChargebackVoucher(data: {
  orderId: string;
  chargebackId: string;
  vendorId: string;
  customerId?: string;
  chargebackAmount: Decimal | number;
  commissionBase: Decimal | number;
  commissionVat: Decimal | number;
  shippingIncome: Decimal | number;
  shippingVat: Decimal | number;
  penalty: Decimal | number;
  productBase: Decimal | number;
  productVat: Decimal | number;
  cogsToRestore?: Decimal | number;
  chargebackReason?: "FRIENDLY_FRAUD" | "FRAUD" | "PRODUCT_DISPUTE";
  approvalId?: string;
  approvedBy?: string;
  chargebackDate?: Date;
  createdBy?: string;
}) {
  const reason = data.chargebackReason ?? "FRIENDLY_FRAUD";

  if (reason === "FRAUD" && !data.approvalId) {
    throw new Error(
      "Chargeback reason FRAUD requires a fraud-review approvalId — voucher will be held as PENDING until approveAndPostVoucher() is called",
    );
  }

  const chargebackAmount = d(data.chargebackAmount);
  const commissionBase = d(data.commissionBase);
  const commissionVat = d(data.commissionVat);
  const shippingIncome = d(data.shippingIncome);
  const shippingVat = d(data.shippingVat);
  const productBase = d(data.productBase);
  const productVat = d(data.productVat);
  const penalty = d(data.penalty);

  // §17.6(b) / reason-specific policy:
  // - PRODUCT_DISPUTE: COGS is NEVER reversed — goods typically not returned.
  // - FRIENDLY_FRAUD / FRAUD: COGS reversed only if goods physically recovered (caller decides via cogsToRestore).
  const cogs = reason === "PRODUCT_DISPUTE" ? new Decimal(0) : d(data.cogsToRestore);

  // restoreIncome is the commission+shipping income reversal amount — this is
  // ALWAYS posted the same way structurally (both books stay balanced),
  // regardless of reason. What differs for FRAUD is a SEPARATE, self-balancing
  // "recharge" pair (mirroring Event 3-V's pattern) that claws the restored
  // amount back off the vendor as a fraud penalty — recorded as Damage/Loss
  // Liability Expense instead of ordinary commission bookkeeping.
  const restoreIncome = commissionBase.plus(commissionVat).plus(shippingIncome).plus(shippingVat);

  const platformEntries: JournalEntryInput[] = [
    { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: chargebackAmount, description: "Charge vendor for refund + penalty" },
    { accountName: "Platform Commission Income", accountClass: "INCOME", debit: commissionBase, description: "Reverse commission income" },
    { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", debit: commissionVat, description: "Reverse VAT on commission" },
    { accountName: "Courier Delivery Income", accountClass: "INCOME", debit: shippingIncome, description: "Reverse shipping income" },
    { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", debit: shippingVat, description: "Reverse VAT on shipping" },
    { accountName: "Receivable from Payment Gateway (SSLCommerz)", accountClass: "ASSET", credit: chargebackAmount, description: "Gateway clawback" },
    { accountName: "Vendor Payables", accountClass: "LIABILITY", credit: restoreIncome, description: "Restore payable for reversed income" },
  ];
  if (reason === "FRAUD") {
    // Extra self-balancing pair: claw the restored amount back off the vendor.
    platformEntries.push(
      { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: restoreIncome, description: "Recharge forfeited commission — fraud penalty (FRAUD reason)" },
      { accountName: "Goodwill/Platform Compensation", accountClass: "EXPENSE", credit: restoreIncome, description: "Offset — commission not restored due to vendor fraud" },
    );
  }

  const vendorNetReduction = chargebackAmount.minus(restoreIncome);

  const vendorEntries: JournalEntryInput[] = [
    { accountName: "Sales Returns", accountClass: "INCOME", debit: productBase, description: "Reverse sale base" },
    { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", debit: productVat, description: "Reverse VAT on sale" },
    { accountName: "Damage/Loss Liability Expense", accountClass: "EXPENSE", debit: penalty, description: "Vendor bears chargeback penalty" },
    { accountName: "Receivable from Platform", accountClass: "ASSET", credit: vendorNetReduction, description: "Net receivable reduction" },
    { accountName: "Platform Commission Expense", accountClass: "EXPENSE", credit: commissionBase, description: "Reverse commission expense" },
    { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", credit: commissionVat, description: "Reverse input VAT on commission" },
  ];
  if (reason === "FRAUD") {
    vendorEntries.push(
      { accountName: "Damage/Loss Liability Expense", accountClass: "EXPENSE", debit: restoreIncome, description: "Forfeited commission recharged as fraud penalty" },
      { accountName: "Receivable from Platform", accountClass: "ASSET", credit: restoreIncome, description: "Additional reduction — fraud penalty" },
    );
  }
  if (cogs.greaterThan(0)) {
    vendorEntries.push(
      { accountName: "Inventory Asset (Goods)", accountClass: "ASSET", debit: cogs, description: "Goods recovered — see §17.6" },
      { accountName: "Cost of Goods Sold (Expense)", accountClass: "EXPENSE", credit: cogs, description: "Reverse cost recognized at original sale" },
    );
  }

  return this.postPairedVoucher({
    idempotencyKey: `CHARGEBACK:${data.orderId}:${data.chargebackId}:${chargebackAmount.toString()}`,
    eventTrigger: "CHARGEBACK",
    referenceType: "chargeback",
    referenceId: data.chargebackId,
    orderId: data.orderId,
    customerId: data.customerId,
    approvalId: data.approvalId,
    approvalStatus: reason === "FRAUD" ? "PENDING" : undefined,
    createdBy: data.createdBy,
    platform: {
      voucherType: "CHARGEBACK",
      narration: `Chargeback — Order #${data.orderId} (${reason})`,
      voucherDate: data.chargebackDate,
      vendorId: data.vendorId,
      entries: platformEntries,
    },
    vendor: {
      vendorId: data.vendorId,
      voucherType: "CHARGEBACK",
      narration: `Chargeback processed — Order #${data.orderId}`,
      voucherDate: data.chargebackDate,
      entries: vendorEntries,
    },
  });
}

  /** Event 9 — Lost in transit / courier damage (conservative total-loss posting, §17.4). */
  async createLostOrDamagedVoucher(data: {
    orderId: string;
    claimId: string;
    vendorId: string;
    customerId?: string;
    escrowAmount: Decimal | number; // full order value refunded from escrow
    insuranceRecovery: Decimal | number; // salvaged value paid to vendor
    cogsAmount: Decimal | number;
    lossType?: "LOST_IN_TRANSIT" | "DAMAGED_BY_COURIER";
    claimDate?: Date;
    createdBy?: string;
  }) {
    const escrow = d(data.escrowAmount);
    const recovery = d(data.insuranceRecovery);
    const cogs = d(data.cogsAmount);

    return this.postPairedVoucher({
      idempotencyKey: `LOST_OR_DAMAGED:${data.orderId}:${data.claimId}`,
      eventTrigger: "LOST_OR_DAMAGED",
      referenceType: "claim",
      referenceId: data.claimId,
      orderId: data.orderId,
      customerId: data.customerId,
      lineItemDetails: { lossType: data.lossType ?? "LOST_IN_TRANSIT" },
      createdBy: data.createdBy,
      platform: {
        voucherType: "REFUND",
        narration: `Lost/damaged in transit — Order #${data.orderId}`,
        voucherDate: data.claimDate,
        vendorId: data.vendorId,
        entries: [
          { accountName: "Customer Deposit Liability", accountClass: "LIABILITY", debit: escrow, description: "Extinguish escrow (customer prepaid)" },
          { accountName: "Receivable from Courier (Claims)", accountClass: "ASSET", debit: recovery, description: "Insurance recovery from courier" },
          { accountName: "Payable to Payment Gateway (Refunds)", accountClass: "LIABILITY", credit: escrow, description: "Refund to customer" },
          { accountName: "Vendor Payables", accountClass: "LIABILITY", credit: recovery, description: "Vendor paid salvaged value" },
        ],
      },
      vendor: {
        vendorId: data.vendorId,
        voucherType: "SALES",
        narration: `Salvaged-value recognition — Order #${data.orderId}`,
        voucherDate: data.claimDate,
        entries: [
          { accountName: "Receivable from Platform", accountClass: "ASSET", debit: recovery, description: "Net receivable (salvaged value)" },
          { accountName: "Sales Revenue", accountClass: "INCOME", credit: recovery, description: "Product sold (salvaged value)" },
          { accountName: "Cost of Goods Sold (Expense)", accountClass: "EXPENSE", debit: cogs, description: "Full cost write-off — goods are gone" },
          { accountName: "Inventory Asset (Goods)", accountClass: "ASSET", credit: cogs, description: "Physical stock is gone; relieve in full" },
        ],
      },
    });
  }

  // ============================================================
  // PHASE 7 — MULTI-VENDOR OPERATIONS (Events 10, 11, 14)
  // Events 2 (discount) and 13 (free shipping) are handled as
  // variants of createDeliveryVoucher above.
  // ============================================================

  /** Event 10 — Multi-vendor split order. One platform voucher, N vendor vouchers. */
  async createMultiVendorSplitVoucher(data: {
    orderId: string;
    deliveryId: string;
    customerId?: string;
    courierId?: string;
    escrowAmount: Decimal | number;
    courierCostBase: Decimal | number;
    courierCostVat: Decimal | number;
    shippingIncomeBase: Decimal | number;
    shippingIncomeVat: Decimal | number;
    vendors: Array<{
      vendorId: string;
      productBase: Decimal | number;
      productVat: Decimal | number;
      commissionBase: Decimal | number;
      commissionVat: Decimal | number;
      cogsAmount: Decimal | number;
    }>;
    deliveryDate?: Date;
    createdBy?: string;
  }) {
    const escrow = d(data.escrowAmount);
    const courierBase = d(data.courierCostBase);
    const courierVat = d(data.courierCostVat);
    const shippingBase = d(data.shippingIncomeBase);
    const shippingVat = d(data.shippingIncomeVat);
    const courierTotal = courierBase.plus(courierVat);

    const platformEntries: JournalEntryInput[] = [
      { accountName: "Customer Deposit Liability", accountClass: "LIABILITY", debit: escrow, description: "Release escrow" },
      { accountName: "Courier Delivery Fees Expense", accountClass: "EXPENSE", debit: courierBase, description: "Base courier cost" },
      { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: courierVat, description: "VAT on courier fee" },
    ];

    let totalCommissionBase = new Decimal(0);
    let totalCommissionVat = new Decimal(0);
    for (const v of data.vendors) {
      const productBase = d(v.productBase);
      const productVat = d(v.productVat);
      const commissionBase = d(v.commissionBase);
      const commissionVat = d(v.commissionVat);
      const vendorNet = productBase.plus(productVat).minus(commissionBase).minus(commissionVat);
      platformEntries.push({
        accountName: "Vendor Payables",
        accountClass: "LIABILITY",
        credit: vendorNet,
        description: `Owed to vendor ${v.vendorId}`,
        referenceType: "vendor",
        referenceId: v.vendorId,
      });
      totalCommissionBase = totalCommissionBase.plus(commissionBase);
      totalCommissionVat = totalCommissionVat.plus(commissionVat);
    }
    platformEntries.push({ accountName: "Platform Commission Income", accountClass: "INCOME", credit: totalCommissionBase, description: "Commission earned (all vendors)" });
    platformEntries.push({ accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: totalCommissionVat, description: "VAT on commission" });
    platformEntries.push({ accountName: "Courier Delivery Income", accountClass: "INCOME", credit: shippingBase, description: "Shipping income base" });
    platformEntries.push({ accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: shippingVat, description: "VAT on shipping" });
    platformEntries.push({ accountName: "Payable to Courier", accountClass: "LIABILITY", credit: courierTotal, description: "Courier fee + VAT" });

    const platformResult = await this.postPairedVoucher({
      idempotencyKey: `DELIVERED:${data.deliveryId}:MULTI:${data.orderId}`,
      eventTrigger: "DELIVERED",
      referenceType: "order",
      referenceId: data.orderId,
      orderId: data.orderId,
      customerId: data.customerId,
      courierId: data.courierId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "SALES",
        narration: `Multi-vendor split delivery — Order #${data.orderId}`,
        voucherDate: data.deliveryDate,
        entries: platformEntries,
      },
    });

    const vendorResults = [];
    for (const v of data.vendors) {
      const productBase = d(v.productBase);
      const productVat = d(v.productVat);
      const commissionBase = d(v.commissionBase);
      const commissionVat = d(v.commissionVat);
      const cogs = d(v.cogsAmount);
      const vendorNet = productBase.plus(productVat).minus(commissionBase).minus(commissionVat);

      const vendorEntries: JournalEntryInput[] = [
        { accountName: "Receivable from Platform", accountClass: "ASSET", debit: vendorNet, description: "Net receivable" },
        { accountName: "Platform Commission Expense", accountClass: "EXPENSE", debit: commissionBase, description: "Commission expense" },
        { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: commissionVat, description: "VAT on commission" },
        { accountName: "Sales Revenue", accountClass: "INCOME", credit: productBase, description: "Product sold (base)" },
        { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: productVat, description: "VAT on sale" },
      ];
      if (cogs.greaterThan(0)) {
        vendorEntries.push({ accountName: "Cost of Goods Sold (Expense)", accountClass: "EXPENSE", debit: cogs, description: "Relieve inventory at cost" });
        vendorEntries.push({ accountName: "Inventory Asset (Goods)", accountClass: "ASSET", credit: cogs, description: "Product shipped out of stock" });
      }

      const result = await this.postPairedVoucher({
       idempotencyKey: `DELIVERED:${data.deliveryId}:MULTI:${data.orderId}:${v.vendorId}`,
        eventTrigger: "DELIVERED",
        referenceType: "order",
        referenceId: data.orderId,
        orderId: data.orderId,
        customerId: data.customerId,
        createdBy: data.createdBy,
        vendor: {
          vendorId: v.vendorId,
          voucherType: "SALES",
          narration: `Sale recognized (multi-vendor split) — Order #${data.orderId}`,
          voucherDate: data.deliveryDate,
          entries: vendorEntries,
        },
      });
      vendorResults.push(result.vendor);
    }

    return { platform: platformResult.platform, vendors: vendorResults };
  }

  /** Event 11 — Exchange/replacement. Original sale stands; new shipment cost only. */
  async createExchangeVoucher(data: {
    orderId: string;
    replacementId: string;
    vendorId: string;
    courierId?: string;
    shippingBase: Decimal | number;
    shippingVat: Decimal | number;
    cogsForReplacement: Decimal | number;
    shipDate?: Date;
    createdBy?: string;
  }) {
    const base = d(data.shippingBase);
    const vat = d(data.shippingVat);
    const total = base.plus(vat);
    const cogs = d(data.cogsForReplacement);

    return this.postPairedVoucher({
      idempotencyKey: `EXCHANGE_SHIPPED:${data.orderId}:${data.replacementId}`,
      eventTrigger: "EXCHANGE_SHIPPED",
      referenceType: "exchange",
      referenceId: data.replacementId,
      orderId: data.orderId,
      courierId: data.courierId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "JOURNAL",
        narration: `Replacement shipment — Order #${data.orderId}`,
        voucherDate: data.shipDate,
        vendorId: data.vendorId,
        entries: [
          { accountName: "Courier Delivery Fees Expense", accountClass: "EXPENSE", debit: base, description: "Accrue replacement shipment cost" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: vat, description: "VAT on replacement shipment" },
          { accountName: "Payable to Courier", accountClass: "LIABILITY", credit: total, description: "Courier fee owed" },
          { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: total, description: "Charge vendor for replacement shipping" },
          { accountName: "Courier Delivery Fees Expense", accountClass: "EXPENSE", credit: base, description: "Reclass replacement cost to vendor" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", credit: vat, description: "Reclass VAT to vendor" },
        ],
      },
      vendor: {
        vendorId: data.vendorId,
        voucherType: "EXPENSE",
        narration: `Replacement unit shipped — Order #${data.orderId}`,
        voucherDate: data.shipDate,
        entries: [
          { accountName: "Courier Return/Forward Expense", accountClass: "EXPENSE", debit: base, description: "Replacement shipping" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: vat, description: "VAT on shipping" },
          { accountName: "Receivable from Platform", accountClass: "ASSET", credit: total, description: "Liability to platform" },
          { accountName: "Cost of Goods Sold (Expense)", accountClass: "EXPENSE", debit: cogs, description: "Relieve inventory for replacement unit" },
          { accountName: "Inventory Asset (Goods)", accountClass: "ASSET", credit: cogs, description: "Replacement unit shipped out of stock" },
        ],
      },
    });
  }

  /** Event 14 — Partial delivery: one item ships, another is cancelled pre-shipment. */
  async createPartialDeliveryVoucher(data: {
    orderId: string;
    deliveryId: string;
    vendorId: string;
    customerId?: string;
    courierId?: string;
    deliveredItemBase: Decimal | number;
    deliveredItemVat: Decimal | number;
    cancelledItemBase: Decimal | number;
    cancelledItemVat: Decimal | number;
    shippingIncomeBase: Decimal | number; // full, non-refundable
    shippingIncomeVat: Decimal | number;
    courierCostBase: Decimal | number;
    courierCostVat: Decimal | number;
    commissionBase: Decimal | number; // on delivered item only
    commissionVat: Decimal | number;
    cogsForDeliveredItem: Decimal | number;
    deliveryDate?: Date;
    createdBy?: string;
  }) {
    const deliveredBase = d(data.deliveredItemBase);
    const deliveredVat = d(data.deliveredItemVat);
    const cancelledBase = d(data.cancelledItemBase);
    const cancelledVat = d(data.cancelledItemVat);
    const shippingBase = d(data.shippingIncomeBase);
    const shippingVat = d(data.shippingIncomeVat);
    const courierBase = d(data.courierCostBase);
    const courierVat = d(data.courierCostVat);
    const commissionBase = d(data.commissionBase);
    const commissionVat = d(data.commissionVat);
    const cogs = d(data.cogsForDeliveredItem);

    const cancelledRefund = cancelledBase.plus(cancelledVat);
    const vendorPayable = deliveredBase.plus(deliveredVat).minus(commissionBase).minus(commissionVat);
    const courierTotal = courierBase.plus(courierVat);

    return this.postPairedVoucher({
      idempotencyKey: `DELIVERED:${data.deliveryId}:partial_delivery:${data.orderId}`,
      eventTrigger: "DELIVERED",
      referenceType: "order",
      referenceId: data.orderId,
      orderId: data.orderId,
      customerId: data.customerId,
      courierId: data.courierId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "SALES",
        narration: `Partial delivery (item cancelled pre-shipment) — Order #${data.orderId}`,
        voucherDate: data.deliveryDate,
        vendorId: data.vendorId,
        entries: [
          { accountName: "Customer Deposit Liability", accountClass: "LIABILITY", debit: deliveredBase.plus(deliveredVat), description: "Release escrow for delivered item" },
          { accountName: "Customer Deposit Liability", accountClass: "LIABILITY", debit: cancelledRefund, description: "Reverse escrow for cancelled item" },
          { accountName: "Customer Deposit Liability", accountClass: "LIABILITY", debit: shippingBase.plus(shippingVat), description: "Shipping earned (non-refundable)" },
          { accountName: "Courier Delivery Fees Expense", accountClass: "EXPENSE", debit: courierBase, description: "Base courier cost" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: courierVat, description: "VAT on courier fee" },
          { accountName: "Payable to Payment Gateway (Refunds)", accountClass: "LIABILITY", credit: cancelledRefund, description: "Refund for cancelled item" },
          { accountName: "Vendor Payables", accountClass: "LIABILITY", credit: vendorPayable, description: "Owed for delivered item" },
          { accountName: "Platform Commission Income", accountClass: "INCOME", credit: commissionBase, description: "Commission on delivered item" },
          { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: commissionVat, description: "VAT on commission" },
          { accountName: "Courier Delivery Income", accountClass: "INCOME", credit: shippingBase, description: "Shipping income" },
          { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: shippingVat, description: "VAT on shipping" },
          { accountName: "Payable to Courier", accountClass: "LIABILITY", credit: courierTotal, description: "Courier fee + VAT" },
        ],
      },
      vendor: {
        vendorId: data.vendorId,
        voucherType: "SALES",
        narration: `Partial delivery — Order #${data.orderId}`,
        voucherDate: data.deliveryDate,
        entries: [
          { accountName: "Receivable from Platform", accountClass: "ASSET", debit: vendorPayable, description: "Net receivable for delivered item" },
          { accountName: "Platform Commission Expense", accountClass: "EXPENSE", debit: commissionBase, description: "Commission expense" },
          { accountName: "Input Tax Recoverable (VAT/GST)", accountClass: "ASSET", debit: commissionVat, description: "VAT on commission" },
          { accountName: "Sales Revenue", accountClass: "INCOME", credit: deliveredBase, description: "Delivered item sold" },
          { accountName: "Output Tax Payable (VAT/GST)", accountClass: "LIABILITY", credit: deliveredVat, description: "VAT on sale" },
          { accountName: "Cost of Goods Sold (Expense)", accountClass: "EXPENSE", debit: cogs, description: "Relieve inventory for delivered item" },
          { accountName: "Inventory Asset (Goods)", accountClass: "ASSET", credit: cogs, description: "Delivered item shipped out of stock" },
        ],
      },
    });
  }

  // ============================================================
  // PHASE 8 — SETTLEMENT (Events 8.B, 8.C, 8.D)
  // ============================================================

  /** Event 8.B — Courier COD remittance (RedX, next day). */
  async createCourierCODSettlementVoucher(data: {
    settlementBatchId: string;
    courierId: string;
    grossExpected: Decimal | number;
    codFeeRatePct?: number; // default 1%
    deliveryFeeDeduction: Decimal | number;
    settlementDate?: Date;
    createdBy?: string;
  }) {
    const gross = d(data.grossExpected);
    const feeRate = new Decimal((data.codFeeRatePct ?? 1) / 100);
    const codFee = gross.times(feeRate);
    const deliveryFee = d(data.deliveryFeeDeduction);
    const cash = gross.minus(codFee).minus(deliveryFee);

    return this.postPairedVoucher({
      idempotencyKey: `SETTLEMENT:${data.settlementBatchId}:${data.courierId}`,
      eventTrigger: "SETTLED",
      referenceType: "settlement_batch",
      referenceId: data.settlementBatchId,
      courierId: data.courierId,
      settlementBatchId: data.settlementBatchId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "SETTLEMENT",
        narration: `Courier COD settlement — batch ${data.settlementBatchId}`,
        voucherDate: data.settlementDate,
        entries: [
          { accountName: "Cash in Operating Bank Account", accountClass: "ASSET", debit: cash, description: "Bank deposit" },
          { accountName: "COD Collection Fees Expense", accountClass: "EXPENSE", debit: codFee, description: "Courier COD fee" },
          { accountName: "Payable to Courier", accountClass: "LIABILITY", debit: deliveryFee, description: "Delivery fee deduction" },
          { accountName: "Receivable from Courier (COD)", accountClass: "ASSET", credit: gross, description: "Clearance" },
        ],
      },
    });
  }

  /** Event 8.C — Weekly vendor payout, clears Vendor Payables to zero. */
  async createVendorPayoutSettlementVoucher(data: {
  settlementBatchId: string;
  vendorId: string;
  amount: Decimal | number;
  payoutDate?: Date;
  createdBy?: string;
}) {
  const amount = d(data.amount);
  const result = await this.postPairedVoucher({
    idempotencyKey: `SETTLEMENT:${data.settlementBatchId}:${data.vendorId}`,
    eventTrigger: "VENDOR_PAYOUT",
    referenceType: "settlement_batch",
    referenceId: data.settlementBatchId,
    settlementBatchId: data.settlementBatchId,
    createdBy: data.createdBy,
    platform: {
      voucherType: "PAYOUT",
      narration: `Weekly vendor payout — ${data.vendorId}`,
      voucherDate: data.payoutDate,
      vendorId: data.vendorId,
      entries: [
        { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: amount, description: "Clear vendor liability" },
        { accountName: "Cash in Operating Bank Account", accountClass: "ASSET", credit: amount, description: "Bank withdrawal" },
      ],
    },
    vendor: {
      vendorId: data.vendorId,
      voucherType: "RECEIPT",
      narration: `Payout received from platform`,
      voucherDate: data.payoutDate,
      entries: [
        { accountName: "Cash at Bank Account", accountClass: "ASSET", debit: amount, description: "Funds received" },
        { accountName: "Receivable from Platform", accountClass: "ASSET", credit: amount, description: "Clearance" },
      ],
    },
  });

  // `balance` / `totalPayable` are already decremented atomically inside
  // postVoucher()'s VendorPayable sync (driven by the "Receivable from
  // Platform" credit on the vendor RECEIPT voucher above). Only the
  // payout-specific counters are touched here — updating `balance` again
  // would double-count the decrement.
  await prisma.vendorPayable.upsert({
    where: { vendorId: data.vendorId },
    update: { totalPaid: { increment: amount }, totalPayouts: { increment: 1 }, lastPayoutAt: new Date(), lastSyncedAt: new Date() },
    create: { vendorId: data.vendorId, balance: amount.negated(), totalPaid: amount, totalPayouts: 1, lastPayoutAt: new Date() },
  });

  return result;
}

  /**
   * Scheduled vendor payout (modules/payouts): same accounts as the settlement
   * payout above, idempotent per payout batch item, not tied to a gateway
   * SettlementBatch. The vendor RECEIPT's "Receivable from Platform" credit
   * reduces VendorPayable.balance inside postVoucher(); the payout counters
   * are updated by the payout service only when its APPROVED → PAID claim
   * succeeds, so a retry never double-counts.
   */
  async createVendorPayoutVoucher(data: { payoutItemId: string; vendorId: string; amount: Decimal | number; payoutDate?: Date; createdBy?: string }) {
    const amount = d(data.amount);
    if (!amount.greaterThan(0)) throw new Error("Payout amount must be positive");
    return this.postPairedVoucher({
      idempotencyKey: `VENDOR_PAYOUT:${data.payoutItemId}`,
      eventTrigger: "VENDOR_PAYOUT",
      referenceType: "payout_batch_item",
      referenceId: data.payoutItemId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "PAYOUT",
        narration: `Scheduled vendor payout — ${data.vendorId}`,
        voucherDate: data.payoutDate,
        vendorId: data.vendorId,
        entries: [
          { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: amount, description: "Clear vendor liability" },
          { accountName: "Cash in Operating Bank Account", accountClass: "ASSET", credit: amount, description: "Bank transfer to vendor" },
        ],
      },
      vendor: {
        vendorId: data.vendorId,
        voucherType: "RECEIPT",
        narration: "Payout received from platform",
        voucherDate: data.payoutDate,
        entries: [
          { accountName: "Cash at Bank Account", accountClass: "ASSET", debit: amount, description: "Funds received" },
          { accountName: "Receivable from Platform", accountClass: "ASSET", credit: amount, description: "Clearance" },
        ],
      },
    });
  }

  /** Event 8.D — Courier remits less than expected (shortage). Exercises Lost in Transit Expense. */
  async createCourierSettlementShortageVoucher(data: {
    settlementBatchId: string;
    courierId: string;
    grossExpected: Decimal | number;
    codFeeRatePct?: number;
    deliveryFeeDeduction: Decimal | number;
    actualReceived: Decimal | number;
    recoverable?: boolean; // true => post as Receivable from Courier (Claims) instead of expense
    settlementDate?: Date;
    createdBy?: string;
  }) {
    const gross = d(data.grossExpected);
    const feeRate = new Decimal((data.codFeeRatePct ?? 1) / 100);
    const codFee = gross.times(feeRate);
    const deliveryFee = d(data.deliveryFeeDeduction);
    const actual = d(data.actualReceived);
    const expectedNet = gross.minus(codFee).minus(deliveryFee);
    const shortage = expectedNet.minus(actual);

    const entries: JournalEntryInput[] = [
      { accountName: "Cash in Operating Bank Account", accountClass: "ASSET", debit: actual, description: "Bank deposit (actual received)" },
      { accountName: "COD Collection Fees Expense", accountClass: "EXPENSE", debit: codFee, description: "Courier COD fee (on full expected)" },
      { accountName: "Payable to Courier", accountClass: "LIABILITY", debit: deliveryFee, description: "Delivery fee deduction" },
    ];
    if (shortage.greaterThan(0)) {
      entries.push(
        data.recoverable
          ? { accountName: "Receivable from Courier (Claims)", accountClass: "ASSET", debit: shortage, description: "Shortage under dispute" }
          : { accountName: "Lost in Transit Expense", accountClass: "EXPENSE", debit: shortage, description: "Unrecoverable shortage" },
      );
    }
    entries.push({ accountName: "Receivable from Courier (COD)", accountClass: "ASSET", credit: gross, description: "Clearance (full expected)" });

    return this.postPairedVoucher({
      idempotencyKey: `SETTLEMENT:shortage:${data.settlementBatchId}:${data.courierId}`,
      eventTrigger: "SETTLED",
      referenceType: "settlement_batch",
      referenceId: data.settlementBatchId,
      courierId: data.courierId,
      settlementBatchId: data.settlementBatchId,
      createdBy: data.createdBy,
      platform: {
        voucherType: "SETTLEMENT",
        narration: `Courier settlement shortage — batch ${data.settlementBatchId}`,
        voucherDate: data.settlementDate,
        entries,
      },
    });
  }

  // ============================================================
  // PHASE 9 — MANUAL ADJUSTMENTS (Event ADJ-1)
  // ============================================================

 /** Event ADJ-1 — Generic accountant-approved correction to Vendor Payables. */
async createGenericAdjustmentVoucher(data: {
  adjustmentId: string;
  approvalId: string;
  vendorId: string;
  amount: Decimal | number;
  direction: "REDUCE_PAYABLE" | "INCREASE_PAYABLE";
  reason: string;
  referencedVoucherId?: string;
  adjustmentDate?: Date;
  createdBy?: string;
}) {
  const amount = d(data.amount);
  const reduce = data.direction === "REDUCE_PAYABLE";

  // ADJ-1 is ALWAYS manual and ALWAYS requires accountant sign-off (spec §Phase 9).
  // Held as PENDING here regardless of what approvalId is passed — the caller
  // must separately call approveAndPostVoucher() with the reviewing accountant's
  // id to actually post it. This closes the gap where any string approvalId
  // used to auto-post the voucher immediately.
  return this.postPairedVoucher({
    idempotencyKey: `ADJUSTMENT:${data.adjustmentId}:${data.approvalId}`,
    eventTrigger: "ADJUSTMENT",
    referenceType: "adjustment",
    referenceId: data.adjustmentId,
    approvalId: data.approvalId,
    approvalStatus: "PENDING",
    createdBy: data.createdBy,
    platform: {
      voucherType: "ADJUSTMENT",
      narration: `Manual adjustment — ${data.reason}`,
      voucherDate: data.adjustmentDate,
      vendorId: data.vendorId,
      entries: reduce
        ? [
            { accountName: "Vendor Payables", accountClass: "LIABILITY", debit: amount, description: "Reduce payable for overpaid vendor" },
            { accountName: "Platform Commission Income", accountClass: "INCOME", credit: amount, description: "Recognize additional commission" },
          ]
        : [
            { accountName: "Platform Commission Income", accountClass: "INCOME", debit: amount, description: "Reverse over-recognized commission" },
            { accountName: "Vendor Payables", accountClass: "LIABILITY", credit: amount, description: "Increase payable to vendor" },
          ],
    },
    vendor: {
      vendorId: data.vendorId,
      voucherType: "ADJUSTMENT",
      narration: `Manual adjustment — ${data.reason}`,
      voucherDate: data.adjustmentDate,
      entries: reduce
        ? [
            { accountName: "Platform Commission Expense", accountClass: "EXPENSE", debit: amount, description: "Additional commission owed" },
            { accountName: "Receivable from Platform", accountClass: "ASSET", credit: amount, description: "Reduce future payout" },
          ]
        : [
            { accountName: "Receivable from Platform", accountClass: "ASSET", debit: amount, description: "Increase future payout" },
            { accountName: "Platform Commission Expense", accountClass: "EXPENSE", credit: amount, description: "Reverse commission expense" },
          ],
    },
  });
}

  // ============================================================
  // PHASE 10 — RECONCILIATION (§10.1-10.4)
  // ============================================================

  /** Query 1 — drift detection. Hard-stops a batch's bank transfer if non-zero. */
  async getDriftReport() {
    const [payablesAgg, receivableAgg] = await Promise.all([
      prisma.chartOfAccount.findMany({
        where: { entityType: "ADMIN", name: "Vendor Payables" },
        include: { ledgerEntries: true },
      }),
      prisma.chartOfAccount.findMany({
        where: { entityType: "VENDOR", name: "Receivable from Platform" },
        include: { ledgerEntries: true },
      }),
    ]);

    const sumBalance = (accounts: any[], nature: "DEBIT" | "CREDIT") =>
      accounts.reduce((sum, acc) => {
        const accBalance = acc.ledgerEntries.reduce((s: Decimal, e: any) => {
          return nature === "CREDIT"
            ? s.plus(e.creditAmount).minus(e.debitAmount)
            : s.plus(e.debitAmount).minus(e.creditAmount);
        }, new Decimal(0));
        return sum.plus(accBalance);
      }, new Decimal(0));

    const platformTotal = sumBalance(payablesAgg, "CREDIT");
    const vendorTotal = sumBalance(receivableAgg, "DEBIT");
    const drift = platformTotal.minus(vendorTotal);

    return {
      platformTotal: platformTotal.toString(),
      vendorTotal: vendorTotal.toString(),
      drift: drift.toString(),
      hardStop: drift.abs().greaterThan(new Decimal("0.01")),
    };
  }

  /** Query 2 — orphaned vouchers (order_id with no matching Order row). */
  async getOrphanedVouchers() {
    const vouchers = await prisma.voucher.findMany({
      where: { orderId: { not: null } },
      select: { id: true, voucherType: true, orderId: true, postingDate: true },
    });
    const orderIds = [...new Set(vouchers.map((v) => v.orderId!).filter(Boolean))];
    const existingOrders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true },
    });
    const existingSet = new Set(existingOrders.map((o) => o.id));
    return vouchers.filter((v) => v.orderId && !existingSet.has(v.orderId));
  }

  /** Query 3 — refund vouchers older than 7 days still unreversed / unsettled. */
  async getUnreversedRefunds() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return prisma.voucher.findMany({
      where: {
        voucherType: "REFUND",
        isReversed: false,
        postingDate: { lt: sevenDaysAgo, not: null },
      },
      orderBy: { postingDate: "asc" },
    });
  }

  // ============================================================
  // AUTO VOUCHER DISPATCH (routes event-type strings to the
  // spec-aligned handlers above; falls back to legacy handlers
  // for events not in this refactor's initial scope, e.g. POS/Purchase).
  // ============================================================

  async createAutoVoucher(eventType: string, data: any) {
    switch (eventType) {
      // Phase 1
      case "EVENT_0A_ONLINE_PAYMENT":
        return this.createEvent0aOnlinePayment(data);
      case "EVENT_0B_SPLIT_FUNDED":
        return this.createEvent0bSplitFundedPayment(data);
      // Phase 2 / 8.A
      case "EVENT_8A_PG_SETTLEMENT":
        return this.createEvent8aPGSettlement(data);
      // Phase 3 (1 / 1-COD / 12 / 2 / 13 all funnel through createDeliveryVoucher)
      case "EVENT_1_DELIVERY":
      case "EVENT_1_COD_DELIVERY":
      case "EVENT_12_STORE_CREDIT_DELIVERY":
      case "EVENT_2_VENDOR_DISCOUNT":
      case "EVENT_13_FREE_SHIPPING":
        return this.createDeliveryVoucher(data);
      // Phase 4
      case "EVENT_3_FULL_RETURN":
      case "EVENT_4_PARTIAL_RETURN":
        return this.createReturnVoucher(data);
      case "EVENT_5_GOODWILL_REFUND":
        return this.createGoodwillRefundVoucher(data);
      case "EVENT_3V_VENDOR_CANCEL":
        return this.createVendorCancellationVoucher(data);
      // Phase 5
      case "EVENT_6_COD_RTS":
        return this.createCODFailureVoucher(data);
      case "EVENT_7_COD_SHORT_PAYMENT":
        return this.createCODShortPaymentVoucher(data);
      case "EVENT_7V_PARTIAL_COLLECTION_FAILURE":
        return this.createPartialCollectionFailureVoucher(data);
      // Phase 6
      case "EVENT_8_CHARGEBACK":
        return this.createChargebackVoucher(data);
      case "EVENT_9_LOST_OR_DAMAGED":
        return this.createLostOrDamagedVoucher(data);
      // Phase 7
      case "EVENT_10_MULTI_VENDOR_SPLIT":
        return this.createMultiVendorSplitVoucher(data);
      case "EVENT_11_EXCHANGE":
        return this.createExchangeVoucher(data);
      case "EVENT_14_PARTIAL_DELIVERY":
        return this.createPartialDeliveryVoucher(data);
      // Phase 8
      case "EVENT_8B_COURIER_COD_SETTLEMENT":
        return this.createCourierCODSettlementVoucher(data);
      case "EVENT_8C_VENDOR_PAYOUT":
        return this.createVendorPayoutSettlementVoucher(data);
      case "EVENT_8D_COURIER_SHORTAGE":
        return this.createCourierSettlementShortageVoucher(data);
      // Phase 9
      case "EVENT_ADJ1_GENERIC_ADJUSTMENT":
        return this.createGenericAdjustmentVoucher(data);

      // --- Legacy / non-order-lifecycle events (stock, purchasing, POS) ---
      case "PURCHASE_CREATED":
        return this.createPurchaseVoucher(data);
      case "PURCHASE_PAYMENT":
        return this.createPurchasePaymentVoucher(data);
      case "PURCHASE_SHORT_CLOSE":
        return this.createPurchaseShortCloseVoucher(data);
      case "PURCHASE_CANCELLED":
        return this.createPurchaseCancelVoucher(data);
      case "PURCHASE_RETURN":
        return this.createPurchaseReturnVoucher(data);
      case "PURCHASE_REFUND":
        return this.createPurchaseRefundVoucher(data);
      case "STOCK_ADJUSTMENT":
        return this.createStockAdjustmentVoucher(data);
      case "DAMAGE_RECORDED":
        return this.createDamageVoucher(data);
      case "STOCK_TRANSFER":
        return this.createStockTransferVoucher(data);
      case "DAMAGE_STOCK_SOLD":
        return this.createDamageStockSoldVoucher(data);
      case "POS_SALE_CREATED":
      case "POS_SALE_COMPLETED":
        return this.createPOSSaleVoucher(data as POSSaleData);
      case "POS_SALE_REFUNDED":
        return this.createPOSRefundVoucher(data as POSRefundData);
      case "POS_DUE_PAYMENT":
        return this.createPOSDuePaymentVoucher(data as POSDuePaymentData);

      default:
        throw new Error(`Unsupported event type: ${eventType}`);
    }
  }

  // ============================================================
  // LEGACY: PURCHASING / STOCK / POS handlers (unchanged from
  // the pre-refactor engine — still valid, out of Auto Voucher
  // Module scope per spec §17.7 for purchasing).
  // ============================================================

  private async getOrCreateSupplierAPAccount(supplierId: string, supplierName: string, vendorId: string) {
    const name = `AP — ${supplierName}`;
    let account = await prisma.chartOfAccount.findFirst({
      where: { entityType: "VENDOR", entityId: vendorId, name, isActive: true },
    });

    if (!account) {
      const code = await generateAccountCode("VENDOR", vendorId, "LIABILITY");
      account = await prisma.chartOfAccount.create({
        data: {
          code,
          name,
          accountClass: "LIABILITY",
          accountType: "CURRENT_LIABILITY",
          group: "ACCOUNTS_PAYABLE",
          nature: "CREDIT",
          entityType: "VENDOR",
          entityId: vendorId,
          isSystem: false,
          isActive: true,
          canDelete: false,
          description: `Accounts payable to supplier ${supplierName}`,
        },
      });
    }
    return account;
  }

   async createPurchaseVoucher(data: {
    purchaseOrderId: string;
    purchaseNo: string;
    supplierId: string;
    supplierName: string;
    inventoryAmount: Decimal;
    vatAmount: Decimal;
    totalAmount: Decimal;
    warehouseId: string;
    vendorId: string;
    createdBy: string;
  }) {
    const supCoaAccount = await this.getOrCreateSupplierAPAccount(data.supplierId, data.supplierName, data.vendorId);

    const entries: any[] = [
      {
        accountId: await this.getAccountId("VENDOR", data.vendorId, "ASSET", "Inventory Asset (Goods)"),
        debitAmount: data.inventoryAmount,
        description: `Goods received — ${data.purchaseNo}`,
        referenceType: "purchase_order",
        referenceId: data.purchaseOrderId,
      },
    ];

    if (new Decimal(data.vatAmount).greaterThan(0)) {
      entries.push({
        accountId: await this.getAccountId("VENDOR", data.vendorId, "ASSET", "Input Tax Recoverable (VAT/GST)"),
        debitAmount: data.vatAmount,
        description: `VAT input — ${data.purchaseNo}`,
        referenceType: "purchase_order",
        referenceId: data.purchaseOrderId,
      });
    }

    entries.push({
      accountId: supCoaAccount.id,
      creditAmount: data.totalAmount,
      description: `Payable to ${data.supplierName} — ${data.purchaseNo}`,
      referenceType: "purchase_order",
      referenceId: data.purchaseOrderId,
    });

    const voucher = await this.createVoucher({
      voucherType: "PURCHASE",
      entityType: "VENDOR",
      entityId: data.vendorId,
      voucherDate: new Date(),
      narration: `Purchase from ${data.supplierName} | Ref: ${data.purchaseNo}`,
      entries,
      referenceType: "purchase_order",
      referenceId: data.purchaseOrderId,
      isAuto: true,
      eventTrigger: "PURCHASE_CREATED",
      vendorId: data.vendorId,
      createdBy: data.createdBy,
    });

    if (!voucher) throw new Error("Failed to create purchase voucher");
    await this.postVoucher(voucher.id, data.createdBy);
    return voucher;
  }

   async createPurchasePaymentVoucher(data: {
    purchaseOrderId: string;
    purchaseNo: string;
    supplierId: string;
    supplierName: string;
    amount: Decimal;
    bankCoaId: string;
    paymentMethod: string;
    reference?: string;
    vendorId: string;
    purchasePaymentId: string;
    createdBy: string;
  }) {
    const supCoaAccount = await this.getOrCreateSupplierAPAccount(data.supplierId, data.supplierName, data.vendorId);

   

    const voucher = await this.createVoucher({
      voucherType: "PAYMENT",
      entityType: "VENDOR",
      entityId: data.vendorId,
      voucherDate: new Date(),
      narration: `Payment to ${data.supplierName} | Ref: ${data.purchaseNo}${data.reference ? " | " + data.reference : ""}`,
      entries: [
        {
          accountId: supCoaAccount.id,
          debitAmount: data.amount,
          description: `Reduce payable — ${data.purchaseNo}`,
          referenceType: "purchase_order",
          referenceId: data.purchaseOrderId,
        },
        {
          accountId: data.bankCoaId,
          creditAmount: data.amount,
          description: `${data.paymentMethod} payment — ${data.purchaseNo}`,
          referenceType: "purchase_order",
          referenceId: data.purchaseOrderId,
        },
      ],
      referenceType: "purchase_payment",
      referenceId: data.purchasePaymentId,
      isAuto: true,
      eventTrigger: "PURCHASE_PAYMENT",
      vendorId: data.vendorId,
      createdBy: data.createdBy,
    });
    if (!voucher) throw new Error("Failed to create purchase payment voucher");

    await this.postVoucher(voucher.id, data.createdBy);
    await prisma.purchasePayment.update({ where: { id: data.purchasePaymentId }, data: { voucherId: voucher.id } });
    return voucher;
  }
// ═══════════════════════════════════════════════════════════════════════════
// ADD THESE METHODS to your existing AccountingService class (accounting.services.ts).
// They reuse the same helpers your two existing methods already rely on:
//   - this.getOrCreateSupplierAPAccount(supplierId, supplierName, vendorId)
//   - this.getAccountId(entityType, entityId, accountType, accountName)
//   - this.createVoucher({...})
//   - this.postVoucher(voucherId, createdBy)
//
// ACCOUNTING LOGIC (why these entries, in plain terms):
//
// Original purchase voucher:  Dr Inventory + Dr VAT Input   Cr Supplier AP
// Original payment voucher:   Dr Supplier AP                Cr Bank
//
// SHORT-CLOSE / CANCEL (goods that will never arrive) is the mirror image of
// the purchase voucher, for the un-received portion only:
//   Dr Supplier AP (reduce what we owe)     Cr Inventory     Cr VAT Input
//
// If the PO was already paid in full before the short-close/cancel, the AP
// account (which the payment voucher already brought to zero) now goes into
// a DEBIT balance — that debit balance IS the overpayment. We surface it as
// PurchaseOrder.creditBalance rather than inventing a new COA account, since
// it's still sitting on the same supplier AP ledger, just the wrong side.
//
// RETURN (C1, stock already received, now sent back) reverses inventory at
// the ORIGINAL PO unit cost (not current avgCost — see PurchaseReturnItem
// comment) and reduces the payable by the same amount:
//   Dr Supplier AP     Cr Inventory Asset
//
// REFUND (D1) is cash actually coming back from the supplier, clearing
// creditBalance:
//   Dr Bank     Cr Supplier AP
// ═══════════════════════════════════════════════════════════════════════════


/**
 * Shared reversal-entry builder for short-close and full cancellation —
 * they are the same accounting shape, just different scope (partial vs
 * whole PO) and a different eventTrigger/narration.
 */
/**
 * Shared reversal-entry builder for short-close and full cancellation.
 */
private async buildPurchaseReversalEntries(data: {
  purchaseOrderId: string;
  inventoryReversalAmount: Decimal;
  vatReversalAmount: Decimal;
  totalReversalAmount: Decimal;
  vendorId: string;
}) {
  const entries: any[] = [
    {
      accountId: await this.getAccountId("VENDOR", data.vendorId, "ASSET", "Inventory Asset (Goods)"),
      creditAmount: data.inventoryReversalAmount,
      description: `Inventory reversal — PO ${data.purchaseOrderId}`,
      referenceType: "purchase_order",
      referenceId: data.purchaseOrderId,
    },
  ];

  if (new Decimal(data.vatReversalAmount).greaterThan(0)) {
    entries.push({
      accountId: await this.getAccountId("VENDOR", data.vendorId, "ASSET", "Input Tax Recoverable (VAT/GST)"),
      creditAmount: data.vatReversalAmount,
      description: `VAT input reversal — PO ${data.purchaseOrderId}`,
      referenceType: "purchase_order",
      referenceId: data.purchaseOrderId,
    });
  }

  return entries;
}

async createPurchaseShortCloseVoucher(data: {
  purchaseOrderId: string;
  purchaseNo: string;
  supplierId: string;
  supplierName: string;
  inventoryReversalAmount: Decimal;
  vatReversalAmount: Decimal;
  totalReversalAmount: Decimal;
  vendorId: string;
  reason?: string;
  createdBy: string;
}) {
  const supCoaAccount = await this.getOrCreateSupplierAPAccount(
    data.supplierId,
    data.supplierName,
    data.vendorId,
  );

  const entries = await this.buildPurchaseReversalEntries(data);
  entries.push({
    accountId: supCoaAccount.id,
    debitAmount: data.totalReversalAmount,
    description: `Short-close reversal — ${data.purchaseNo}${data.reason ? " | " + data.reason : ""}`,
    referenceType: "purchase_order",
    referenceId: data.purchaseOrderId,
  });

  const voucher = await this.createVoucher({
    voucherType: "PURCHASE",
    entityType: "VENDOR",
    entityId: data.vendorId,
    voucherDate: new Date(),
    narration: `Short-close: ${data.supplierName} | Ref: ${data.purchaseNo}${data.reason ? " | " + data.reason : ""}`,
    entries,
    referenceType: "purchase_order",
    referenceId: data.purchaseOrderId,
    isAuto: true,
    eventTrigger: "PURCHASE_SHORT_CLOSE",
    vendorId: data.vendorId,
    createdBy: data.createdBy,
  });

  if (!voucher) throw new Error("Failed to create purchase short-close voucher");
  await this.postVoucher(voucher.id, data.createdBy);
  return voucher;
}

async createPurchaseCancelVoucher(data: {
  purchaseOrderId: string;
  purchaseNo: string;
  supplierId: string;
  supplierName: string;
  inventoryReversalAmount: Decimal;
  vatReversalAmount: Decimal;
  totalReversalAmount: Decimal;
  vendorId: string;
  reason?: string;
  createdBy: string;
}) {
  const supCoaAccount = await this.getOrCreateSupplierAPAccount(
    data.supplierId,
    data.supplierName,
    data.vendorId,
  );

  const entries = await this.buildPurchaseReversalEntries(data);
  entries.push({
    accountId: supCoaAccount.id,
    debitAmount: data.totalReversalAmount,
    description: `Full cancellation — ${data.purchaseNo}${data.reason ? " | " + data.reason : ""}`,
    referenceType: "purchase_order",
    referenceId: data.purchaseOrderId,
  });

  const voucher = await this.createVoucher({
    voucherType: "PURCHASE",
    entityType: "VENDOR",
    entityId: data.vendorId,
    voucherDate: new Date(),
    narration: `PO Cancelled: ${data.supplierName} | Ref: ${data.purchaseNo}${data.reason ? " | " + data.reason : ""}`,
    entries,
    referenceType: "purchase_order",
    referenceId: data.purchaseOrderId,
    isAuto: true,
    eventTrigger: "PURCHASE_CANCELLED",
    vendorId: data.vendorId,
    createdBy: data.createdBy,
  });

  if (!voucher) throw new Error("Failed to create purchase cancel voucher");
  await this.postVoucher(voucher.id, data.createdBy);
  return voucher;
}

async createPurchaseReturnVoucher(data: {
  purchaseOrderId: string;
  purchaseNo: string;
  supplierId: string;
  supplierName: string;
  returnAmount: Decimal;
  vendorId: string;
  purchaseReturnId: string;
  reason?: string;
  createdBy: string;
}) {
  const supCoaAccount = await this.getOrCreateSupplierAPAccount(
    data.supplierId,
    data.supplierName,
    data.vendorId,
  );

  const voucher = await this.createVoucher({
    voucherType: "PURCHASE",
    entityType: "VENDOR",
    entityId: data.vendorId,
    voucherDate: new Date(),
    narration: `Purchase return: ${data.supplierName} | Ref: ${data.purchaseNo}${data.reason ? " | " + data.reason : ""}`,
    entries: [
      {
        accountId: supCoaAccount.id,
        debitAmount: data.returnAmount,
        description: `Return reduces payable — ${data.purchaseNo}`,
        referenceType: "purchase_return",
        referenceId: data.purchaseReturnId,
      },
      {
        accountId: await this.getAccountId("VENDOR", data.vendorId, "ASSET", "Inventory Asset (Goods)"),
        creditAmount: data.returnAmount,
        description: `Inventory out (return) — ${data.purchaseNo}`,
        referenceType: "purchase_return",
        referenceId: data.purchaseReturnId,
      },
    ],
    referenceType: "purchase_return",
    referenceId: data.purchaseReturnId,
    isAuto: true,
    eventTrigger: "PURCHASE_RETURN",
    vendorId: data.vendorId,
    createdBy: data.createdBy,
  });

  if (!voucher) throw new Error("Failed to create purchase return voucher");
  await this.postVoucher(voucher.id, data.createdBy);
  return voucher;
}

async createPurchaseRefundVoucher(data: {
  purchaseOrderId: string;
  purchaseNo: string;
  supplierId: string;
  supplierName: string;
  amount: Decimal;
  bankCoaId: string;
  vendorId: string;
  purchaseRefundId: string;
  reference?: string;
  createdBy: string;
}) {
  const supCoaAccount = await this.getOrCreateSupplierAPAccount(
    data.supplierId,
    data.supplierName,
    data.vendorId,
  );

  const voucher = await this.createVoucher({
    voucherType: "PAYMENT",
    entityType: "VENDOR",
    entityId: data.vendorId,
    voucherDate: new Date(),
    narration: `Refund from ${data.supplierName} | Ref: ${data.purchaseNo}${data.reference ? " | " + data.reference : ""}`,
    entries: [
      {
        accountId: data.bankCoaId,
        debitAmount: data.amount,
        description: `Refund received — ${data.purchaseNo}`,
        referenceType: "purchase_refund",
        referenceId: data.purchaseRefundId,
      },
      {
        accountId: supCoaAccount.id,
        creditAmount: data.amount,
        description: `Clear credit balance — ${data.purchaseNo}`,
        referenceType: "purchase_refund",
        referenceId: data.purchaseRefundId,
      },
    ],
    referenceType: "purchase_refund",
    referenceId: data.purchaseRefundId,
    isAuto: true,
    eventTrigger: "PURCHASE_REFUND",
    vendorId: data.vendorId,
    createdBy: data.createdBy,
  });

  if (!voucher) throw new Error("Failed to create purchase refund voucher");
  await this.postVoucher(voucher.id, data.createdBy);
  await prisma.purchaseRefund.update({
    where: { id: data.purchaseRefundId },
    data: { voucherId: voucher.id },
  });
  return voucher;
}




  private async createStockAdjustmentVoucher(data: {
    variantId: string;
    variantName: string;
    warehouseId: string;
    quantity: number;
    avgCost: Decimal;
    reason: string;
    vendorId: string;
    stockMovementId: string;
  }) {
    const totalValue = new Decimal(data.quantity).times(data.avgCost);

    const voucher = await this.createVoucher({
      voucherType: "EXPENSE",
      entityType: "VENDOR",
      entityId: data.vendorId,
      voucherDate: new Date(),
      narration: `Stock adjustment — ${data.variantName} qty ${data.quantity} | ${data.reason}`,
      entries: [
        {
          accountId: await this.getAccountId("VENDOR", data.vendorId, "EXPENSE", "Damage/Loss Liability Expense"),
          debitAmount: totalValue,
          description: `Adjustment expense — ${data.reason}`,
          referenceType: "stock_movement",
          referenceId: data.stockMovementId,
        },
        {
          accountId: await this.getAccountId("VENDOR", data.vendorId, "ASSET", "Inventory Asset (Goods)"),
          creditAmount: totalValue,
          description: `Inventory reduction — ${data.variantName}`,
          referenceType: "stock_movement",
          referenceId: data.stockMovementId,
        },
      ],
      referenceType: "stock_movement",
      referenceId: data.stockMovementId,
      isAuto: true,
      eventTrigger: "STOCK_ADJUSTMENT",
      vendorId: data.vendorId,
      createdBy: "system",
    });

    if (!voucher) throw new Error("Failed to create stock adjustment voucher");
    await this.postVoucher(voucher.id, "system");
    await prisma.stockMovement.update({ where: { id: data.stockMovementId }, data: { voucherId: voucher.id } });
    return voucher;
  }

  private async createDamageVoucher(data: {
    variantId: string;
    variantName: string;
    warehouseId: string;
    quantity: number;
    avgCost: Decimal;
    reason: string;
    vendorId: string;
    stockMovementId: string;
  }) {
    const totalValue = new Decimal(data.quantity).times(data.avgCost);

    const voucher = await this.createVoucher({
      voucherType: "EXPENSE",
      entityType: "VENDOR",
      entityId: data.vendorId,
      voucherDate: new Date(),
      narration: `Damage recorded — ${data.variantName} qty ${data.quantity} | ${data.reason}`,
      entries: [
        {
          accountId: await this.getAccountId("VENDOR", data.vendorId, "EXPENSE", "Damage/Loss Liability Expense"),
          debitAmount: totalValue,
          description: `Damage write-off — ${data.reason}`,
          referenceType: "stock_movement",
          referenceId: data.stockMovementId,
        },
        {
          accountId: await this.getAccountId("VENDOR", data.vendorId, "ASSET", "Inventory Asset (Goods)"),
          creditAmount: totalValue,
          description: `Remove damaged stock — ${data.variantName}`,
          referenceType: "stock_movement",
          referenceId: data.stockMovementId,
        },
      ],
      referenceType: "stock_movement",
      referenceId: data.stockMovementId,
      isAuto: true,
      eventTrigger: "DAMAGE_RECORDED",
      vendorId: data.vendorId,
      createdBy: "system",
    });

    if (!voucher) throw new Error("Failed to create damage voucher");
    await this.postVoucher(voucher.id, "system");
    await prisma.stockMovement.update({ where: { id: data.stockMovementId }, data: { voucherId: voucher.id } });
    return voucher;
  }

 
private async createStockTransferVoucher(data: {
  variantId: string;
  variantName: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: number;
  avgCost: Decimal;
  logisticsCost?: Decimal;
  bankCoaId?: string;
  vendorId: string;
  stockMovementId: string;
}) {
  const logCost = data.logisticsCost ?? new Decimal(0);

  if (!logCost.greaterThan(0)) {
    // No financial event to record — physical-only transfer.
    return null;
  }

  const voucher = await this.createVoucher({
    voucherType: "JOURNAL",
    entityType: "VENDOR",
    entityId: data.vendorId,
    voucherDate: new Date(),
    narration: `Transfer logistics cost — ${data.variantName} qty ${data.quantity} | ${data.fromWarehouseId} → ${data.toWarehouseId}`,
    entries: [
      {
        accountId: await this.getAccountId("VENDOR", data.vendorId, "EXPENSE", "Courier Return/Forward Expense"),
        debitAmount: logCost,
        description: `Transfer logistics cost — ${data.fromWarehouseId} → ${data.toWarehouseId}`,
        referenceType: "stock_movement",
        referenceId: data.stockMovementId,
      },
      {
        accountId:
          data.bankCoaId ?? (await this.getAccountId("VENDOR", data.vendorId, "ASSET", "Cash at Bank Account")),
        creditAmount: logCost,
        description: `Logistics payment for transfer`,
        referenceType: "stock_movement",
        referenceId: data.stockMovementId,
      },
    ],
    referenceType: "stock_movement",
    referenceId: data.stockMovementId,
    isAuto: true,
    eventTrigger: "STOCK_TRANSFER",
    vendorId: data.vendorId,
    createdBy: "system",
  });

  if (!voucher) throw new Error("Failed to create stock transfer voucher");
  await this.postVoucher(voucher.id, "system");
  await prisma.stockMovement.update({ where: { id: data.stockMovementId }, data: { voucherId: voucher.id } });
  return voucher;
}

  private async createDamageStockSoldVoucher(data: {
    variantId: string;
    variantName: string;
    warehouseId: string;
    quantity: number;
    saleAmount: Decimal;
    bankCoaId: string;
    vendorId: string;
    stockMovementId: string;
  }) {
    const voucher = await this.createVoucher({
      voucherType: "RECEIPT",
      entityType: "VENDOR",
      entityId: data.vendorId,
      voucherDate: new Date(),
      narration: `Damage stock sold — ${data.variantName} qty ${data.quantity} @ $${data.saleAmount}`,
      entries: [
        {
          accountId: data.bankCoaId,
          debitAmount: data.saleAmount,
          description: `Cash received for damage stock sale`,
          referenceType: "stock_movement",
          referenceId: data.stockMovementId,
        },
        {
          accountId: await this.getAccountId("VENDOR", data.vendorId, "INCOME", "Sales Revenue"),
          creditAmount: data.saleAmount,
          description: `Revenue from damaged ${data.variantName} × ${data.quantity}`,
          referenceType: "stock_movement",
          referenceId: data.stockMovementId,
        },
      ],
      referenceType: "stock_movement",
      referenceId: data.stockMovementId,
      isAuto: true,
      eventTrigger: "DAMAGE_STOCK_SOLD",
      vendorId: data.vendorId,
      createdBy: "system",
    });
    if (!voucher) throw new Error("Failed to create damage-stock-sold voucher");

    await this.postVoucher(voucher.id, "system");
    await prisma.stockMovement.update({ where: { id: data.stockMovementId }, data: { voucherId: voucher.id } });
    return voucher;
  }

  // ============================================
  // POS ACCOUNTING METHODS (unchanged)
  // ============================================

  private async resolveAccountId(
    entityType: "VENDOR" | "ADMIN",
    entityId: string | null,
    accountClass: AccountClass,
    name: string,
  ): Promise<string> {
    const account = await prisma.chartOfAccount.findFirst({
      where: { entityType, entityId: entityId ?? null, accountClass, name, isActive: true },
    });
    if (!account) throw new Error(`COA account not found: "${name}" [${accountClass}]`);
    return account.id;
  }

  /** resolveAccountId on a caller-owned transaction client (POS paths). */
  private async resolveAccountIdIn(
    db: Prisma.TransactionClient | undefined,
    entityType: "VENDOR" | "ADMIN",
    entityId: string | null,
    accountClass: AccountClass,
    name: string,
  ): Promise<string> {
    if (!db) return this.resolveAccountId(entityType, entityId, accountClass, name);
    const account = await db.chartOfAccount.findFirst({
      where: { entityType, entityId: entityId ?? null, accountClass, name, isActive: true },
    });
    if (!account) throw new Error(`COA account not found: "${name}" [${accountClass}]`);
    return account.id;
  }

  async createPOSSaleVoucher(data: POSSaleData, db?: Prisma.TransactionClient) {
    const vid = data.vendorId;
    const entries: any[] = [];

    if (new Decimal(data.paidAmount).greaterThan(0)) {
      entries.push({
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "ASSET", paymentCOAName(data.paymentMethod)),
        debitAmount: data.paidAmount,
        description: `${data.paymentMethod} received — ${data.invoiceId}`,
        referenceType: "pos_invoice",
        referenceId: data.invoiceId,
      });
    }

    if (new Decimal(data.dueAmount).greaterThan(0)) {
      entries.push({
        accountId: await this.ensurePosCustomerReceivableIn(db, vid),
        debitAmount: data.dueAmount,
        description: `Due from ${data.customerName} — ${data.invoiceId}`,
        referenceType: "pos_invoice",
        referenceId: data.invoiceId,
      });
    }

    if (new Decimal(data.discountAmount).greaterThan(0)) {
      entries.push({
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "INCOME", "Vendor Funded Discounts"),
        debitAmount: data.discountAmount,
        description: `${data.discountType === "flat" ? "Flat" : data.discountPct + "%"} discount — ${data.invoiceId}`,
        referenceType: "pos_invoice",
        referenceId: data.invoiceId,
      });
    }

    entries.push({
      accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "INCOME", "Sales Revenue"),
      creditAmount: data.subtotal,
      description: `Gross sales — ${data.invoiceId}`,
      referenceType: "pos_invoice",
      referenceId: data.invoiceId,
    });

    if (new Decimal(data.vatAmount).greaterThan(0)) {
      entries.push({
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "LIABILITY", "Output Tax Payable (VAT/GST)"),
        creditAmount: data.vatAmount,
        description: `VAT collected — ${data.invoiceId}`,
        referenceType: "pos_invoice",
        referenceId: data.invoiceId,
      });
    }

    if (new Decimal(data.cogsTotal).greaterThan(0)) {
      entries.push({
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "EXPENSE", "Cost of Goods Sold (Expense)"),
        debitAmount: data.cogsTotal,
        description: `COGS — ${data.invoiceId}`,
        referenceType: "pos_invoice",
        referenceId: data.invoiceId,
      });
      entries.push({
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "ASSET", "Inventory Asset (Goods)"),
        creditAmount: data.cogsTotal,
        description: `Inventory out — ${data.invoiceId}`,
        referenceType: "pos_invoice",
        referenceId: data.invoiceId,
      });
    }

    const voucher = await this._buildAndPostPOS({
      voucherType: "SALES",
      vendorId: vid,
      date: data.saleDate,
      narration: `POS Sale — ${data.invoiceId} | ${data.customerName} | ${data.paymentMethod}`,
      entries,
      refType: "pos_invoice",
      refId: data.invoiceId,
      eventType: "POS_SALE_COMPLETED",
    }, db);

    // No VendorPayable change: a POS sale is collected by the vendor at the
    // counter (or owed by the vendor's own customer) — the platform holds none
    // of it, so it must not raise what the platform owes the vendor for payout.
    // Customer balances (PosCustomer.due, …) are owned by PosService, which
    // updates them in the same transaction.
    return voucher;
  }

  async createPOSRefundVoucher(data: POSRefundData, db?: Prisma.TransactionClient) {
    const vid = data.vendorId;
    const entries: any[] = [];

    entries.push({
      accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "INCOME", "Sales Revenue"),
      debitAmount: data.refundSubtotal,
      description: `Refund — ${data.refundInvoiceId}`,
      referenceType: "pos_refund",
      referenceId: data.refundInvoiceId,
    });

    if (new Decimal(data.refundVat).greaterThan(0)) {
      entries.push({
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "LIABILITY", "Output Tax Payable (VAT/GST)"),
        debitAmount: data.refundVat,
        description: `Refund VAT reverse — ${data.refundInvoiceId}`,
        referenceType: "pos_refund",
        referenceId: data.refundInvoiceId,
      });
    }

    if (new Decimal(data.refundDiscount).greaterThan(0)) {
      entries.push({
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "INCOME", "Vendor Funded Discounts"),
        creditAmount: data.refundDiscount,
        description: `Refund discount reverse — ${data.refundInvoiceId}`,
        referenceType: "pos_refund",
        referenceId: data.refundInvoiceId,
      });
    }

    if (new Decimal(data.refundCogs).greaterThan(0)) {
      entries.push({
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "ASSET", "Inventory Asset (Goods)"),
        debitAmount: data.refundCogs,
        description: `Inventory restored — ${data.refundInvoiceId}`,
        referenceType: "pos_refund",
        referenceId: data.refundInvoiceId,
      });
      entries.push({
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "EXPENSE", "Cost of Goods Sold (Expense)"),
        creditAmount: data.refundCogs,
        description: `COGS reversed — ${data.refundInvoiceId}`,
        referenceType: "pos_refund",
        referenceId: data.refundInvoiceId,
      });
    }

    // Allocation (PosService.reverseInTx): the unpaid part of what is refunded
    // cancels the customer's receivable; only the collected part is paid back.
    const receivableCut = new Decimal(data.receivableCut ?? 0);
    const cashRefund = data.cashRefund !== undefined ? new Decimal(data.cashRefund) : new Decimal(data.refundNet).minus(receivableCut);
    if (receivableCut.isNegative() || cashRefund.isNegative() || !receivableCut.plus(cashRefund).equals(new Decimal(data.refundNet))) {
      throw new Error(`POS refund allocation does not add up for ${data.refundInvoiceId}`);
    }
    if (cashRefund.greaterThan(0)) {
      entries.push({
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "ASSET", paymentCOAName(data.paymentMethod)),
        creditAmount: cashRefund,
        description: `Refund paid via ${data.paymentMethod}`,
        referenceType: "pos_refund",
        referenceId: data.refundInvoiceId,
      });
    }
    if (receivableCut.greaterThan(0)) {
      entries.push({
        accountId: data.receivableAccountId ?? (await this.ensurePosCustomerReceivableIn(db, vid)),
        creditAmount: receivableCut,
        description: `Unpaid due cancelled — ${data.originalInvoiceId}`,
        referenceType: "pos_refund",
        referenceId: data.refundInvoiceId,
      });
    }

    return this._buildAndPostPOS({
      voucherType: "REFUND",
      vendorId: vid,
      date: data.refundDate,
      narration: `POS Refund — ${data.refundInvoiceId}`,
      entries,
      refType: "pos_refund",
      refId: data.refundInvoiceId,
      eventType: "POS_SALE_REFUNDED",
    }, db);
  }

  async createPOSDuePaymentVoucher(data: POSDuePaymentData, db?: Prisma.TransactionClient) {
    const vid = data.vendorId;

    const entries = [
      {
        accountId: await this.resolveAccountIdIn(db, "VENDOR", vid, "ASSET", paymentCOAName(data.paymentMethod)),
        debitAmount: data.payingAmount,
        description: `Due payment via ${data.paymentMethod}`,
        referenceType: "pos_due_payment",
        referenceId: data.paymentInvoiceId,
      },
      {
        accountId: data.receivableAccountId ?? (await this.ensurePosCustomerReceivableIn(db, vid)),
        creditAmount: data.payingAmount,
        description: `Receivable cleared — ${data.customerName}`,
        referenceType: "pos_due_payment",
        referenceId: data.paymentInvoiceId,
      },
    ];

    const voucher = await this._buildAndPostPOS({
      voucherType: "RECEIPT",
      vendorId: vid,
      date: data.paymentDate,
      narration: `POS Due Collection — ${data.paymentInvoiceId}`,
      entries,
      refType: "pos_due_payment",
      refId: data.paymentInvoiceId,
      eventType: "POS_DUE_PAYMENT",
    }, db);

    return voucher;
  }

  // POS customers are PosCustomer rows, while Voucher.customerId references a
  // marketplace User (vouchers_customerId_fkey) — so POS vouchers carry no
  // customerId. The customer stays linked through the sale (PosSale.customerId,
  // matched by the voucher's referenceId = invoice no.), the narration, and the
  // PosCustomer receivable update.
  private async _buildAndPostPOS(opts: {
    voucherType: VoucherType;
    vendorId: string;
    date: Date;
    narration: string;
    entries: any[];
    refType: string;
    refId: string;
    eventType: EventType;
  }, db?: Prisma.TransactionClient) {
    const totalDebit = opts.entries.reduce((s, e) => s.plus(new Decimal(e.debitAmount ?? 0)), new Decimal(0));
    const totalCredit = opts.entries.reduce((s, e) => s.plus(new Decimal(e.creditAmount ?? 0)), new Decimal(0));

    if (!totalDebit.equals(totalCredit)) throw new Error(`POS voucher imbalance for ${opts.refId}`);

    // POS invoice numbers are unique per vendor only (every store's first sale
    // of the day is "<prefix>-YYMMDD-0001"), and idempotencyKey is unique across
    // all vendors — so the vendor is part of the key. Without it a second store
    // "found" the first store's voucher, and linking it to its own sale broke the
    // unique pos_sales.accountingVoucherId (P2002 → HTTP 400).
    const idempotencyKey = posVoucherIdempotencyKey(opts.voucherType, opts.eventType, opts.refType, opts.vendorId, opts.refId);

    // Caller-owned transaction (POS sale / refund / due payment): every write
    // below joins it, so stock, the sale and its voucher commit or roll back
    // together. No nested $transaction, no swallowed errors.
    if (db) {
      const prior = await db.voucher.findUnique({ where: { idempotencyKey } });
      if (prior) return this.getVoucherById(prior.id, db);
      const number = await this.generateVoucherNumber(opts.voucherType, "VENDOR", opts.vendorId, db);
      const v = await db.voucher.create({
        data: {
          voucherNumber: number,
          voucherType: opts.voucherType,
          entityType: "VENDOR",
          entityId: opts.vendorId,
          vendorId: opts.vendorId,
          voucherDate: opts.date,
          narration: opts.narration,
          totalDebit,
          totalCredit,
          status: "DRAFT",
          isAuto: true,
          eventTrigger: opts.eventType,
          idempotencyKey,
          referenceType: opts.refType,
          referenceId: opts.refId,
          createdBy: "pos_system",
        },
      });
      for (const entry of opts.entries) {
        await db.voucherDraftEntry.create({
          data: {
            voucherId: v.id,
            accountId: entry.accountId,
            debitAmount: new Decimal(entry.debitAmount ?? 0),
            creditAmount: new Decimal(entry.creditAmount ?? 0),
            description: entry.description,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
          },
        });
      }
      await this._postPOSVoucher(v.id, opts.vendorId, db);
      return this.getVoucherById(v.id, db);
    }

    const existing = await prisma.voucher.findUnique({ where: { idempotencyKey } });
    if (existing) return this.getVoucherById(existing.id);

    const voucherNumber = await this.generateVoucherNumber(opts.voucherType, "VENDOR", opts.vendorId);

    let voucher;
    try {
      voucher = await prisma.$transaction(async (tx) => {
        const v = await tx.voucher.create({
          data: {
            voucherNumber,
            voucherType: opts.voucherType,
            entityType: "VENDOR",
            entityId: opts.vendorId,
            vendorId: opts.vendorId,
            voucherDate: opts.date,
            narration: opts.narration,
            totalDebit,
            totalCredit,
            status: "DRAFT",
            isAuto: true,
            eventTrigger: opts.eventType,
            idempotencyKey,
            referenceType: opts.refType,
            referenceId: opts.refId,
            createdBy: "pos_system",
          },
        });

        for (const entry of opts.entries) {
          await tx.voucherDraftEntry.create({
            data: {
              voucherId: v.id,
              accountId: entry.accountId,
              debitAmount: new Decimal(entry.debitAmount ?? 0),
              creditAmount: new Decimal(entry.creditAmount ?? 0),
              description: entry.description,
              referenceType: entry.referenceType,
              referenceId: entry.referenceId,
            },
          });
        }
        return v;
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        const dup = await prisma.voucher.findUnique({ where: { idempotencyKey } });
        if (dup) return this.getVoucherById(dup.id);
      }
      throw err;
    }

    await this._postPOSVoucher(voucher.id, opts.vendorId);
    return this.getVoucherById(voucher.id);
  }

  private async _postPOSVoucher(voucherId: string, vendorId: string, db?: Prisma.TransactionClient) {
    const reader = db ?? prisma;
    const voucher = await reader.voucher.findUniqueOrThrow({ where: { id: voucherId } });
    const drafts = await reader.voucherDraftEntry.findMany({ where: { voucherId } });

    const post = async (tx: Prisma.TransactionClient) => {
      for (const dft of drafts) {
        await tx.ledgerEntry.create({
          data: {
            voucherId,
            accountId: dft.accountId,
            debitAmount: dft.debitAmount,
            creditAmount: dft.creditAmount,
            entityType: "VENDOR",
            entityId: vendorId,
            description: dft.description,
            referenceType: dft.referenceType,
            referenceId: dft.referenceId,
            entryDate: voucher.voucherDate,
          },
        });
      }

      await tx.voucher.update({
        where: { id: voucherId },
        data: { status: "POSTED", postingDate: new Date(), postedBy: "pos_system" },
      });

      await tx.voucherDraftEntry.deleteMany({ where: { voucherId } });
    };
    if (db) await post(db);
    else await prisma.$transaction(post);
  }

  /**
   * The vendor's "POS Customer Receivable" account, created on first use for
   * vendors seeded before it existed (same code scheme as generateAccountCode).
   *
   * Race-safety: callers create it OUTSIDE their transaction first (db
   * undefined). Two first-time creations racing on the unique
   * (code, entityType, entityId) resolve here: the loser re-reads the winner's
   * row (or retries with the next code). Inside a transaction (db given) a
   * duplicate-key error would abort the whole transaction, so that path only
   * creates when the pre-creation was skipped.
   */
  async ensurePosCustomerReceivableIn(
    db: Prisma.TransactionClient | undefined,
    vendorId: string,
    root: Prisma.TransactionClient | PrismaClient = prisma, // the non-transaction client (injectable for tests)
  ): Promise<string> {
    const c = db ?? root;
    const find = () =>
      c.chartOfAccount.findFirst({
        where: { entityType: "VENDOR", entityId: vendorId, accountClass: "ASSET", name: POS_CUSTOMER_RECEIVABLE, isActive: true },
        select: { id: true },
      });
    const found = await find();
    if (found) return found.id;
    if (db) return this.createPosCustomerReceivable(db, vendorId);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.createPosCustomerReceivable(root, vendorId);
      } catch (err: any) {
        if (err?.code !== "P2002" || attempt >= 3) throw err;
        const winner = await find();
        if (winner) return winner.id; // a concurrent first sale created it
      }
    }
  }

  private async createPosCustomerReceivable(c: Prisma.TransactionClient | PrismaClient, vendorId: string): Promise<string> {
    const prefix = `${ENTITY_PREFIX.VENDOR}-${ACCOUNT_PREFIX.ASSET}`;
    const last = await c.chartOfAccount.findFirst({
      where: { entityType: "VENDOR", entityId: vendorId, code: { startsWith: prefix } },
      orderBy: { createdAt: "desc" },
      select: { code: true },
    });
    const next = last ? parseInt(last.code.split("-").pop()!, 10) + 1 : 1;
    const created = await c.chartOfAccount.create({
      data: {
        code: `${prefix}-${String(next).padStart(4, "0")}`,
        name: POS_CUSTOMER_RECEIVABLE,
        accountClass: "ASSET",
        accountType: "CURRENT_ASSET",
        group: "ACCOUNTS_RECEIVABLE",
        nature: resolveNature("ASSET"),
        entityType: "VENDOR",
        entityId: vendorId,
        isSystem: true,
        isActive: true,
        canDelete: true, // same as the seeded vendor accounts (createChartOfAccount)
        description: "Credit sales owed by the vendor's POS customers",
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * The receivable a POS sale's due was debited to. Sales posted before the
   * dedicated account existed used "Receivable from Platform"; their
   * collections and refunds must clear that same account, not a new one.
   */
  async posReceivableAccountForSale(db: Prisma.TransactionClient | undefined, vendorId: string, voucherId: string | null): Promise<string> {
    if (voucherId) {
      const entry = await (db ?? prisma).ledgerEntry.findFirst({
        where: {
          voucherId,
          referenceType: "pos_invoice",
          debitAmount: { gt: 0 },
          account: { entityType: "VENDOR", entityId: vendorId, name: { in: [POS_CUSTOMER_RECEIVABLE, "Receivable from Platform"] } },
        },
        select: { accountId: true },
      });
      if (entry) return entry.accountId;
    }
    return this.ensurePosCustomerReceivableIn(db, vendorId);
  }

  // ============================================
  // REPORTS
  // ============================================

  async getTrialBalance(entityType: EntityType, entityId?: string, asOf?: Date) {
    const accounts = await prisma.chartOfAccount.findMany({
      where: { entityType, entityId: entityId || null, isActive: true },
      orderBy: [{ code: "asc" }],
    });

    const trialBalance = [];
    let totalDebitSum = new Decimal(0);
    let totalCreditSum = new Decimal(0);

    for (const account of accounts) {
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { accountId: account.id, entryDate: asOf ? { lte: asOf } : undefined },
      });

      const totalDebit = ledgerEntries.reduce((sum, entry) => sum.plus(entry.debitAmount), new Decimal(0));
      const totalCredit = ledgerEntries.reduce((sum, entry) => sum.plus(entry.creditAmount), new Decimal(0));
      const balance = account.nature === "DEBIT" ? totalDebit.minus(totalCredit) : totalCredit.minus(totalDebit);

      totalDebitSum = totalDebitSum.plus(totalDebit);
      totalCreditSum = totalCreditSum.plus(totalCredit);

      trialBalance.push({
        accountCode: account.code,
        accountName: account.name,
        accountClass: account.accountClass,
        accountType: account.accountType,
        group: account.group,
        totalDebit: totalDebit.toString(),
        totalCredit: totalCredit.toString(),
        balance: balance.toString(),
        nature: account.nature,
      });
    }

    return {
      trialBalance,
      totals: {
        totalDebit: totalDebitSum.toString(),
        totalCredit: totalCreditSum.toString(),
        difference: totalDebitSum.minus(totalCreditSum).toString(),
      },
      asOf: asOf || new Date(),
    };
  }

  async getProfitAndLoss(entityType: EntityType, entityId?: string, startDate?: Date, endDate?: Date) {
    const incomeAccounts = await prisma.chartOfAccount.findMany({
      where: { entityType, entityId: entityId || null, accountClass: "INCOME", isActive: true },
    });
    const expenseAccounts = await prisma.chartOfAccount.findMany({
      where: { entityType, entityId: entityId || null, accountClass: "EXPENSE", isActive: true },
    });

    let totalIncome = new Decimal(0);
    let totalExpense = new Decimal(0);
    const incomeDetails = [];
    const expenseDetails = [];

    for (const account of incomeAccounts) {
      const entries = await prisma.ledgerEntry.findMany({
        where: {
          accountId: account.id,
          entryDate: { gte: startDate || new Date("1970-01-01"), lte: endDate || new Date() },
        },
      });
      const income = entries.reduce((sum, entry) => {
        return sum
          .plus(account.nature === "CREDIT" ? entry.creditAmount : entry.debitAmount)
          .minus(account.nature === "CREDIT" ? entry.debitAmount : entry.creditAmount);
      }, new Decimal(0));
      totalIncome = totalIncome.plus(income);
      incomeDetails.push({ accountCode: account.code, accountName: account.name, amount: income.toString() });
    }

    for (const account of expenseAccounts) {
      const entries = await prisma.ledgerEntry.findMany({
        where: {
          accountId: account.id,
          entryDate: { gte: startDate || new Date("1970-01-01"), lte: endDate || new Date() },
        },
      });
      const expense = entries.reduce((sum, entry) => {
        return sum
          .plus(account.nature === "DEBIT" ? entry.debitAmount : entry.creditAmount)
          .minus(account.nature === "DEBIT" ? entry.creditAmount : entry.debitAmount);
      }, new Decimal(0));
      totalExpense = totalExpense.plus(expense);
      expenseDetails.push({ accountCode: account.code, accountName: account.name, amount: expense.toString() });
    }

    const netProfit = totalIncome.minus(totalExpense);

    return {
      income: { accounts: incomeDetails, total: totalIncome.toString() },
      expenses: { accounts: expenseDetails, total: totalExpense.toString() },
      netProfit: netProfit.toString(),
      period: { startDate: startDate || new Date("1970-01-01"), endDate: endDate || new Date() },
    };
  }

  async getBalanceSheet(entityType: EntityType, entityId?: string, asOf?: Date) {
    const assetAccounts = await prisma.chartOfAccount.findMany({
      where: { entityType, entityId: entityId || null, accountClass: "ASSET", isActive: true },
    });
    const liabilityAccounts = await prisma.chartOfAccount.findMany({
      where: { entityType, entityId: entityId || null, accountClass: "LIABILITY", isActive: true },
    });
    const equityAccounts = await prisma.chartOfAccount.findMany({
      where: { entityType, entityId: entityId || null, accountClass: "EQUITY", isActive: true },
    });

    const calculateBalance = async (account: any) => {
      const entries = await prisma.ledgerEntry.findMany({
        where: { accountId: account.id, entryDate: asOf ? { lte: asOf } : undefined },
      });
      const totalDebit = entries.reduce((sum, entry) => sum.plus(entry.debitAmount), new Decimal(0));
      const totalCredit = entries.reduce((sum, entry) => sum.plus(entry.creditAmount), new Decimal(0));
      return account.nature === "DEBIT" ? totalDebit.minus(totalCredit) : totalCredit.minus(totalDebit);
    };

    const assets = await Promise.all(
      assetAccounts.map(async (account) => ({
        accountCode: account.code,
        accountName: account.name,
        group: account.group,
        balance: (await calculateBalance(account)).toString(),
      })),
    );
    const liabilities = await Promise.all(
      liabilityAccounts.map(async (account) => ({
        accountCode: account.code,
        accountName: account.name,
        group: account.group,
        balance: (await calculateBalance(account)).toString(),
      })),
    );
    const equity = await Promise.all(
      equityAccounts.map(async (account) => ({
        accountCode: account.code,
        accountName: account.name,
        group: account.group,
        balance: (await calculateBalance(account)).toString(),
      })),
    );

    const totalAssets = assets.reduce((sum, a) => sum.plus(new Decimal(a.balance)), new Decimal(0));
    const totalLiabilities = liabilities.reduce((sum, l) => sum.plus(new Decimal(l.balance)), new Decimal(0));
    const totalEquity = equity.reduce((sum, e) => sum.plus(new Decimal(e.balance)), new Decimal(0));

    const pl = await this.getProfitAndLoss(entityType, entityId, new Date("1970-01-01"), asOf);
    const retainedEarnings = new Decimal(pl.netProfit);

    return {
      assets: { accounts: assets, total: totalAssets.toString() },
      liabilities: { accounts: liabilities, total: totalLiabilities.toString() },
      equity: {
        accounts: equity,
        total: totalEquity.toString(),
        retainedEarnings: retainedEarnings.toString(),
        totalWithRetainedEarnings: totalEquity.plus(retainedEarnings).toString(),
      },
      totalAssets: totalAssets.toString(),
      totalLiabilitiesAndEquity: totalLiabilities.plus(totalEquity).plus(retainedEarnings).toString(),
      asOf: asOf || new Date(),
    };
  }

  async getLedger(filters: {
    accountId?: string;
    entityType: EntityType;
    entityId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page || 1;
    const limit = filters.limit || 50;
    const skip = (page - 1) * limit;

    const where: any = { entityType: filters.entityType, entityId: filters.entityId || null };
    if (filters.accountId) where.accountId = filters.accountId;
    if (filters.startDate || filters.endDate) {
      where.entryDate = {};
      if (filters.startDate) where.entryDate.gte = filters.startDate;
      if (filters.endDate) where.entryDate.lte = filters.endDate;
    }

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        include: { account: true, voucher: true },
        orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
        skip,
        take: limit,
      }),
      prisma.ledgerEntry.count({ where }),
    ]);

    let runningBalance = new Decimal(0);
    const entriesWithBalance = entries.reverse().map((entry) => {
      runningBalance = runningBalance.plus(entry.debitAmount).minus(entry.creditAmount);
      return { ...entry, runningBalance: runningBalance.toString() };
    });

    return {
      data: entriesWithBalance.reverse(),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async getVendorPayableReport(vendorId?: string) {
    const whereClause = vendorId ? { vendorId } : {};
    return prisma.vendorPayable.findMany({ where: whereClause, orderBy: [{ balance: "desc" }] });
  }

  // ============================================
  // ACCOUNTING PERIODS
  // ============================================

  async createAccountingPeriod(data: {
    periodName: string;
    periodType: string;
    startDate: Date;
    endDate: Date;
    entityType: EntityType;
    entityId?: string;
    userId: string;
  }) {
    const overlapping = await prisma.accountingPeriod.findFirst({
      where: {
        entityType: data.entityType,
        entityId: data.entityId || null,
        OR: [
          { AND: [{ startDate: { lte: data.startDate } }, { endDate: { gte: data.startDate } }] },
          { AND: [{ startDate: { lte: data.endDate } }, { endDate: { gte: data.endDate } }] },
        ],
      },
    });
    if (overlapping) throw new Error("Period overlaps with existing period");

    const period = await prisma.accountingPeriod.create({
      data: {
        periodName: data.periodName,
        periodType: data.periodType as any,
        startDate: data.startDate,
        endDate: data.endDate,
        entityType: data.entityType,
        entityId: data.entityId,
        isActive: true,
        isClosed: false,
      },
    });

    await this.createAuditLog({
      action: "CREATE",
      entityName: "accounting_periods",
      entityId: period.id,
      userId: data.userId,
      newData: period,
    });

    return period;
  }

  async closeAccountingPeriod(periodId: string, userId: string) {
    const period = await prisma.accountingPeriod.findUnique({ where: { id: periodId } });
    if (!period) throw new Error("Period not found");
    if (period.isClosed) throw new Error("Period already closed");

    const pl = await this.getProfitAndLoss(period.entityType, period.entityId ?? undefined, period.startDate, period.endDate);

    const updated = await prisma.accountingPeriod.update({
      where: { id: periodId },
      data: { isClosed: true, closedAt: new Date(), closedBy: userId },
    });

    await this.createAuditLog({
      action: "UPDATE",
      entityName: "accounting_periods",
      entityId: periodId,
      userId,
      oldData: period,
      newData: { ...updated, netProfit: pl.netProfit },
    });

    return updated;
  }

  // ============================================
  // AUDIT LOGS
  // ============================================

  async getAuditLogs(filters: {
    entityName?: string;
    entityId?: string;
    action?: string;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page || 1;
    const limit = filters.limit || 50;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.entityName) where.entityName = filters.entityName;
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.action) where.action = filters.action;
    if (filters.userId) where.userId = filters.userId;
    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = filters.startDate;
      if (filters.endDate) where.createdAt.lte = filters.endDate;
    }

    const [logs, total] = await Promise.all([
      prisma.accountingAudit.findMany({ where, orderBy: [{ createdAt: "desc" }], skip, take: limit }),
      prisma.accountingAudit.count({ where }),
    ]);

    return { data: logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  private async generateVoucherNumber(
    voucherType: VoucherType,
    _entityType: EntityType,
    _entityId?: string,
    db?: Prisma.TransactionClient,
  ): Promise<string> {
    const prefix = voucherType.substring(0, 3).toUpperCase();
    const today = new Date();
    const year = today.getFullYear().toString().substring(2);
    const month = (today.getMonth() + 1).toString().padStart(2, "0");
    const yearMonth = `${year}${month}`;

    const sequence = await (db ?? prisma).voucherSequence.upsert({
      where: { voucherType_yearMonth: { voucherType, yearMonth } },
      update: { lastNumber: { increment: 1 } },
      create: { voucherType, yearMonth, lastNumber: 1 },
    });

    return `${prefix}${yearMonth}${sequence.lastNumber.toString().padStart(4, "0")}`;
  }

  private async getAccountId(
    entityType: EntityType,
    entityId: string | null,
    accountClass: AccountClass,
    accountName: string,
  ): Promise<string> {
    const account = await prisma.chartOfAccount.findFirst({
      where: { entityType, entityId: entityId || null, accountClass, name: accountName, isActive: true },
    });

    if (!account) {
      throw new Error(
        `Account not found: ${accountName} (${accountClass}) for ${entityType}${entityId ? `:${entityId}` : ""}. ` +
          `Did you run seedPlatformCOA()/seedVendorCOA() for this entity?`,
      );
    }
    return account.id;
  }

 private async validateEntityAccess(entityType: EntityType, entityId: string | undefined | null, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, vendorId: true },
  });
  if (!user) throw new Error("Unauthorized: user not found");

  if (entityType === "ADMIN") {
    if (user.role !== "ADMIN" && user.role !== "EMPLOYEE") {
      throw new Error("Unauthorized: admin-level access required");
    }
    return true;
  }

  if (entityType === "VENDOR") {
    if (user.role === "ADMIN" || user.role === "EMPLOYEE") return true; 
    if (user.vendorId !== entityId) {
      throw new Error("Unauthorized: vendor mismatch");
    }
    return true;
  }

  throw new Error("Unauthorized: unknown entity type");
}

 

  private async createAuditLog(data: {
    action: string;
    entityName: string;
    entityId: string;
    userId?: string;
    oldData?: any;
    newData?: any;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return prisma.accountingAudit.create({
      data: {
        action: data.action as any,
        entityName: data.entityName,
        entityId: data.entityId,
        oldData: data.oldData,
        newData: data.newData,
        userId: data.userId,
        userName: data.userId,
        userRole: "USER",
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
      },
    });
  }
}