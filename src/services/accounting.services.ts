
import type { AccountClass, AccountGroup, AccountTypeInAccounting, AccountNature, EntityType, VoucherType } from '@prisma/client';
import  { PrismaClient  } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

const prisma = new PrismaClient();
const ENTITY_PREFIX = {
  ADMIN: 'ADM',
  VENDOR: 'VND',
};

const ACCOUNT_PREFIX = {
  ASSET: 'AST',
  LIABILITY: 'LIB',
  EQUITY: 'EQT',
  INCOME: 'INC',
  EXPENSE: 'EXP',
};
async function generateAccountCode(
  entityType: 'ADMIN' | 'VENDOR',
  entityId: string | null,
  accountClass: AccountClass
) {
  const prefix =
    `${ENTITY_PREFIX[entityType]}-${ACCOUNT_PREFIX[accountClass]}`;

  // Count existing accounts with same prefix
  const lastAccount = await prisma.chartOfAccount.findFirst({
    where: {
      entityType,
      entityId,
      code: { startsWith: prefix },
    },
    orderBy: { createdAt: 'desc' },
    select: { code: true },
  });

  let nextNumber = 1;

  if (lastAccount) {
    const lastSeq = parseInt(lastAccount.code.split('-').pop()!, 10);
    nextNumber = lastSeq + 1;
  }

  return `${prefix}-${String(nextNumber).padStart(4, '0')}`;
}
function resolveNature(accountClass: AccountClass): AccountNature {
  return accountClass === 'ASSET' || accountClass === 'EXPENSE'
    ? 'DEBIT'
    : 'CREDIT';
}

export class AccountingService {
  // ============================================
  // 1. CHART OF ACCOUNTS
  // ============================================

  async createChartOfAccount(data: {
    name: string;
    nameLocal?: string | null;

    accountClass: AccountClass;
    accountType: AccountTypeInAccounting;
    group?: AccountGroup;

    entityType: EntityType;
    entityId?: string | null;

    isSystem?: boolean;
    description?: string | null;

    userId: string;
  }) {
    // 1️⃣ Validate access
    await this.validateEntityAccess(
      data.entityType,
      data.entityId ?? null,
      data.userId
    );

    // 2️⃣ Generate account code
    const code = await generateAccountCode(
      data.entityType,
      data.entityId ?? null,
      data.accountClass
    );

    // 3️⃣ Auto-resolve nature
    const nature = resolveNature(data.accountClass);

    // 4️⃣ Create account
    const coa = await prisma.chartOfAccount.create({
      data: {
        code,
        name: data.name,
        nameLocal: data.nameLocal,

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

    // 5️⃣ Audit log
    await this.createAuditLog({
      action: 'CREATE',
      entityName: 'chart_of_accounts',
      entityId: coa.id,
      userId: data.userId,
      newData: coa,
    });

    return coa;
  }

  async updateChartOfAccount(id: string, data: any, userId: string) {
    const existing = await prisma.chartOfAccount.findUnique({
      where: { id },
    });

    if (!existing) throw new Error('Account not found');
    if (existing.isSystem) throw new Error('System accounts cannot be modified');
    if (!existing.canDelete) throw new Error('This account cannot be modified');

    // Validate entity permissions
    await this.validateEntityAccess(existing.entityType, existing.entityId, userId);

    const updated = await prisma.chartOfAccount.update({
      where: { id },
      data: {
        name: data.name,
        nameLocal: data.nameLocal,
        groupName: data.groupName,
        description: data.description,
        isActive: data.isActive,
        updatedAt: new Date(),
      },
    });

    // Audit trail
    await this.createAuditLog({
      action: 'UPDATE',
      entityName: 'chart_of_accounts',
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
      include: {
        ledgerEntries: true,
        children: true,
      },
    });

    if (!existing) throw new Error('Account not found');
    if (existing.isSystem) throw new Error('System accounts cannot be deleted');
    if (!existing.canDelete) throw new Error('This account cannot be deleted');
    if (existing.ledgerEntries.length > 0) {
      throw new Error('Cannot delete account with existing transactions');
    }
    if (existing.children.length > 0) {
      throw new Error('Cannot delete account with child accounts');
    }

    await this.validateEntityAccess(existing.entityType, existing.entityId, userId);

    await prisma.chartOfAccount.delete({
      where: { id },
    });

    // Audit trail
    await this.createAuditLog({
      action: 'DELETE',
      entityName: 'chart_of_accounts',
      entityId: id,
      userId,
      oldData: existing,
    });

    return { success: true, message: 'Account deleted successfully' };
  }

  async getChartOfAccounts(entityType: EntityType, entityId?: string) {
    return prisma.chartOfAccount.findMany({
      where: {
        entityType,
        entityId: entityId || null,
        isActive: true,
      },
      orderBy: [{ code: 'asc' }],
      
    });
  }

  async getChartOfAccountById(id: string) {
    return prisma.chartOfAccount.findUnique({
      where: { id },
      include: {
        ledgerEntries: {
          take: 10,
          orderBy: { entryDate: 'desc' },
        },
      },
    });
  }

  // ============================================
  // 2. VOUCHER SYSTEM
  // ============================================

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
}) {
  // ================= VALIDATION =================
  const totalDebit = data.entries.reduce(
    (sum, e) => sum.plus(new Decimal(e.debitAmount || 0)),
    new Decimal(0),
  );

  const totalCredit = data.entries.reduce(
    (sum, e) => sum.plus(new Decimal(e.creditAmount || 0)),
    new Decimal(0),
  );

  if (!totalDebit.equals(totalCredit)) {
    throw new Error('Debit must equal Credit');
  }

  if (totalDebit.isZero()) {
    throw new Error('Voucher amount cannot be zero');
  }

  for (const e of data.entries) {
    const d = new Decimal(e.debitAmount || 0);
    const c = new Decimal(e.creditAmount || 0);

    if (d.isZero() && c.isZero()) {
      throw new Error('Each entry must have debit or credit');
    }
    if (!d.isZero() && !c.isZero()) {
      throw new Error('Entry cannot have both debit and credit');
    }
  }

  const voucherNumber = await this.generateVoucherNumber(
    data.voucherType,
    data.entityType,
    data.entityId,
  );

  // ================= TRANSACTION =================
  const voucher = await prisma.$transaction(async (tx) => {
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
        status: 'DRAFT',
        isAuto: false,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        createdBy: data.createdBy,
      },
    });

    for (const entry of data.entries) {
      await tx.voucherDraftEntry.create({
        data: {
          voucherId: v.id,
          accountId: entry.accountId,
          debitAmount: new Decimal(entry.debitAmount || 0),
          creditAmount: new Decimal(entry.creditAmount || 0),
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

  await this.createAuditLog({
    action: 'CREATE',
    entityName: 'vouchers',
    entityId: voucher.id,
    userId: data.createdBy,
    newData: voucher,
  });

  return this.getVoucherById(voucher.id);
}


  async getVoucherById(id: string) {
    return prisma.voucher.findUnique({
      where: { id },
      include: {
        ledgerEntries: {
          include: {
            account: true,
          },
        },
      },
    });
  }

  async getVouchers(filters: {
    entityType: string;
    entityId?: string;
    voucherType?: string;
    status?: string;
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

    const where: any = {
      entityType: filters.entityType,
      entityId: filters.entityId || null,
    };

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
        include: {
          ledgerEntries: {
            include: {
              account: true,
            },
          },
        },
        orderBy: [{ voucherDate: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.voucher.count({ where }),
    ]);

    return {
      data: vouchers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async postVoucher(voucherId: string, userId: string) {
  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
  });

  if (!voucher) throw new Error('Voucher not found');
  if (voucher.status !== 'DRAFT') throw new Error('Only DRAFT vouchers can be posted');
  if (voucher.isLocked) throw new Error('Voucher is locked');

  await this.validateEntityAccess(voucher.entityType, voucher.entityId, userId);

  const draftEntries = await prisma.voucherDraftEntry.findMany({
    where: { voucherId },
  });

  if (!draftEntries.length) {
    throw new Error('No draft entries found');
  }

  await prisma.$transaction(async (tx) => {
    // Create ledger entries
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

    // Post voucher
    await tx.voucher.update({
      where: { id: voucherId },
      data: {
        status: 'POSTED',
        postingDate: new Date(),
        postedBy: userId,
        updatedBy: userId,
      },
    });

    // Remove drafts
    await tx.voucherDraftEntry.deleteMany({
      where: { voucherId },
    });
  });

  if (voucher.voucherType === 'SALES' && voucher.entityType === 'VENDOR') {
    await this.updateVendorPayableFromVoucher(voucher);
  }

  await this.createAuditLog({
    action: 'POST',
    entityName: 'vouchers',
    entityId: voucherId,
    userId,
  });

  return this.getVoucherById(voucherId);
}


  async lockVoucher(voucherId: string, userId: string) {
    const voucher = await prisma.voucher.findUnique({
      where: { id: voucherId },
    });

    if (!voucher) throw new Error('Voucher not found');
    if (voucher.isAuto) throw new Error('Auto vouchers cannot be manually locked');
    if (voucher.status !== 'POSTED') throw new Error('Only POSTED vouchers can be locked');
    if (voucher.isLocked) throw new Error('Voucher is already locked');

    // Validate entity permissions (only admin can lock)
    if (voucher.entityType !== 'ADMIN') {
      throw new Error('Only admin can lock vouchers');
    }

    const updated = await prisma.voucher.update({
      where: { id: voucherId },
      data: {
        isLocked: true,
        lockedBy: userId,
        lockedAt: new Date(),
        updatedBy: userId,
      },
    });

    // Audit trail
    await this.createAuditLog({
      action: 'LOCK',
      entityName: 'vouchers',
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

  if (!voucher) throw new Error('Voucher not found');
  if (voucher.status !== 'POSTED') throw new Error('Only POSTED vouchers can be reversed');
  if (voucher.isLocked) throw new Error('Locked vouchers cannot be reversed');
  if (voucher.isReversed) throw new Error('Already reversed');

  await this.validateEntityAccess(voucher.entityType, voucher.entityId, userId);

  const reversalEntries = voucher.ledgerEntries.map(e => ({
    accountId: e.accountId,
    debitAmount: e.creditAmount,
    creditAmount: e.debitAmount,
    description: `Reversal of ${voucher.voucherNumber}`,
    referenceType: e.referenceType,
    referenceId: e.referenceId,
    costCenter: e.costCenter,
    department: e.department,
  }));

  const reversalVoucher = await this.createVoucher({
    voucherType: voucher.voucherType,
    entityType: voucher.entityType,
    entityId: voucher.entityId,
    narration: `REVERSAL: ${voucher.narration} (${reason})`,
    entries: reversalEntries,
    referenceType: voucher.referenceType,
    referenceId: voucher.referenceId,
    createdBy: userId,
  });

  await this.postVoucher(reversalVoucher.id, userId);

  await prisma.voucher.update({
    where: { id: voucherId },
    data: {
      status: 'REVERSED',
      isReversed: true,
      reversedById: reversalVoucher.id,
      updatedBy: userId,
    },
  });

  await prisma.voucher.update({
    where: { id: reversalVoucher.id },
    data: {
      reversalOfId: voucherId,
    },
  });

  await this.createAuditLog({
    action: 'REVERSE',
    entityName: 'vouchers',
    entityId: voucherId,
    userId,
    newData: { reversalVoucherId: reversalVoucher.id, reason },
  });

  return { originalVoucher: voucherId, reversalVoucher: reversalVoucher.id };
}

async cancelVoucher(voucherId: string, reason: string, userId: string) {
  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
  });

  if (!voucher) throw new Error('Voucher not found');

  // Only DRAFT vouchers can be cancelled
  if (voucher.status !== 'DRAFT') {
    throw new Error('Only DRAFT vouchers can be cancelled');
  }

  // Auto vouchers should not be cancelled manually
  if (voucher.isAuto) {
    throw new Error('Auto vouchers cannot be cancelled manually');
  }

  // Already cancelled
  if (voucher.status === 'CANCELLED') {
    throw new Error('Voucher is already cancelled');
  }

  // Entity permission validation
  await this.validateEntityAccess(
    voucher.entityType,
    voucher.entityId,
    userId
  );

  const updated = await prisma.voucher.update({
    where: { id: voucherId },
    data: {
      status: 'CANCELLED',
      cancelledBy: userId,
      cancelledAt: new Date(),
      cancelReason: reason,
      updatedBy: userId,
    },
  });

  // Audit trail
  await this.createAuditLog({
    action: 'CANCEL',
    entityName: 'vouchers',
    entityId: voucherId,
    userId,
    oldData: voucher,
    newData: {
      status: 'CANCELLED',
      cancelReason: reason,
    },
  });

  return updated;
}

  // ============================================
  // 3. AUTO VOUCHER ENGINE
  // ============================================

  async createAutoVoucher(eventType: string, data: any) {
    switch (eventType) {
      case 'ORDER_CONFIRMED':
        return this.createOrderConfirmedVoucher(data);
      case 'ORDER_DELIVERED':
        return this.createOrderDeliveredVoucher(data);
      case 'PAYMENT_RECEIVED':
        return this.createPaymentReceivedVoucher(data);
      case 'SETTLEMENT_RECEIVED':
        return this.createSettlementReceivedVoucher(data);
      case 'VENDOR_PAYOUT':
        return this.createVendorPayoutVoucher(data);
      case 'REFUND_INITIATED':
        return this.createRefundVoucher(data);
      default:
        throw new Error(`Unsupported event type: ${eventType}`);
    }
  }

  private async createOrderConfirmedVoucher(data: {
    orderId: number;
    vendorId: string;
    customerId: string;
    amount: Decimal;
    commissionRate: Decimal;
    commissionAmount: Decimal;
    netAmount: Decimal;
  }) {
    // For Vendor: Debit Customer Receivable, Credit Sales
    const vendorVoucher = await this.createVoucher({
      voucherType: 'SALES',
      entityType: 'VENDOR',
      entityId: data.vendorId,
      voucherDate: new Date(),
      narration: `Sales voucher for Order #${data.orderId}`,
      entries: [
        {
          accountId: await this.getAccountId('VENDOR', data.vendorId, 'ASSET', 'Customer Receivable'),
          debitAmount: data.amount,
          description: `Receivable from Customer for Order #${data.orderId}`,
          referenceType: 'order',
          referenceId: data.orderId.toString(),
        },
        {
          accountId: await this.getAccountId('VENDOR', data.vendorId, 'INCOME', 'Sales'),
          creditAmount: data.amount,
          description: `Sales revenue for Order #${data.orderId}`,
          referenceType: 'order',
          referenceId: data.orderId.toString(),
        },
      ],
      referenceType: 'order',
      referenceId: data.orderId.toString(),
      createdBy: 'system',
    });

    // For Admin: Debit Commission Receivable, Credit Commission Income
    const commissionVoucher = await this.createVoucher({
      voucherType: 'COMMISSION',
      entityType: 'ADMIN',
      voucherDate: new Date(),
      narration: `Commission voucher for Order #${data.orderId}`,
      entries: [
        {
          accountId: await this.getAccountId('ADMIN', null, 'ASSET', 'Vendor Commission Receivable'),
          debitAmount: data.commissionAmount,
          description: `Commission receivable from Vendor ${data.vendorId} for Order #${data.orderId}`,
          referenceType: 'order',
          referenceId: data.orderId.toString(),
        },
        {
          accountId: await this.getAccountId('ADMIN', null, 'INCOME', 'Commission Income'),
          creditAmount: data.commissionAmount,
          description: `Commission income from Order #${data.orderId}`,
          referenceType: 'order',
          referenceId: data.orderId.toString(),
        },
      ],
      referenceType: 'order',
      referenceId: data.orderId.toString(),
      createdBy: 'system',
    });

    // Mark as auto vouchers
    await prisma.voucher.update({
      where: { id: vendorVoucher.id },
      data: { isAuto: true, eventType: 'ORDER_CONFIRMED' },
    });

    await prisma.voucher.update({
      where: { id: commissionVoucher.id },
      data: { isAuto: true, eventType: 'ORDER_CONFIRMED' },
    });

    // Auto-post vouchers
    await this.postVoucher(vendorVoucher.id, 'system');
    await this.postVoucher(commissionVoucher.id, 'system');

    // Create commission record
    await prisma.commissionRecord.create({
      data: {
        orderId: data.orderId,
        vendorId: data.vendorId,
        productId: 'order',
        productName: 'Order',
        quantity: 1,
        productPrice: data.amount,
        totalAmount: data.amount,
        commissionRate: data.commissionRate,
        commissionAmount: data.commissionAmount,
        status: 'RECOGNIZED',
        recognizedAt: new Date(),
        voucherId: commissionVoucher.id,
      },
    });

    return { vendorVoucher, commissionVoucher };
  }

  private async createOrderDeliveredVoucher(data: {
    orderId: number;
    vendorId: string;
    amount: Decimal;
  }) {
    // This can be used for delivery confirmation if needed
    // For now, we consider the order confirmed as the main event
    return { message: 'Delivery voucher - implementation depends on business logic' };
  }

  private async createPaymentReceivedVoucher(data: {
    sslTransaction: any;
    orderId: number;
    vendorId: string;
    amount: Decimal;
    gatewayFee: Decimal;
    vatAmount: Decimal;
    netAmount: Decimal;
  }) {
    // For Admin: Debit Bank/Cash, Debit Gateway Charges, Credit SSL Settlement Payable
    const adminVoucher = await this.createVoucher({
      voucherType: 'RECEIPT',
      entityType: 'ADMIN',
      voucherDate: new Date(),
      narration: `Payment received for Order #${data.orderId} via SSLCommerz`,
      entries: [
        {
          accountId: await this.getAccountId('ADMIN', null, 'ASSET', 'Bank Account'),
          debitAmount: data.netAmount,
          description: `Payment for Order #${data.orderId}, Tran ID: ${data.sslTransaction.tranId}`,
          referenceType: 'ssl_transaction',
          referenceId: data.sslTransaction.id,
        },
        {
          accountId: await this.getAccountId('ADMIN', null, 'EXPENSE', 'Gateway Charges'),
          debitAmount: new Decimal(data.gatewayFee).plus(new Decimal(data.vatAmount || 0)),
          description: `Gateway charges for Order #${data.orderId}`,
          referenceType: 'ssl_transaction',
          referenceId: data.sslTransaction.id,
        },
        {
          accountId: await this.getAccountId('ADMIN', null, 'LIABILITY', 'SSL Settlement Payable'),
          creditAmount: data.amount,
          description: `Payable to vendor for Order #${data.orderId}`,
          referenceType: 'ssl_transaction',
          referenceId: data.sslTransaction.id,
        },
      ],
      referenceType: 'ssl_transaction',
      referenceId: data.sslTransaction.id,
      createdBy: 'system',
    });

    // Mark as auto voucher
    await prisma.voucher.update({
      where: { id: adminVoucher.id },
      data: { isAuto: true, eventType: 'PAYMENT_RECEIVED' },
    });

    // Update SSL transaction
    await prisma.sSLCommerzTransaction.update({
      where: { id: data.sslTransaction.id },
      data: {
        paymentVoucherId: adminVoucher.id,
        status: 'SUCCESS',
        successAt: new Date(),
      },
    });

    // Auto-post voucher
    await this.postVoucher(adminVoucher.id, 'system');

    return adminVoucher;
  }

  private async createSettlementReceivedVoucher(data: {
    settlementBatch: any;
    transactions: any[];
  }) {
    // For Admin: Debit SSL Settlement Payable, Credit Vendor Payable
    const entries = [];

    // Calculate totals
    let totalSettlement = new Decimal(0);
    const vendorTotals = new Map<string, Decimal>();

    for (const tx of data.transactions) {
      totalSettlement = totalSettlement.plus(tx.netAmount || tx.amount);
      if (tx.vendorId) {
        const current = vendorTotals.get(tx.vendorId) || new Decimal(0);
        vendorTotals.set(tx.vendorId, current.plus(tx.netAmount || tx.amount));
      }
    }

    // Entry 1: Debit SSL Settlement Payable
    entries.push({
      accountId: await this.getAccountId('ADMIN', null, 'LIABILITY', 'SSL Settlement Payable'),
      debitAmount: totalSettlement,
      description: `Settlement batch ${data.settlementBatch.batchNumber}`,
      referenceType: 'settlement_batch',
      referenceId: data.settlementBatch.id,
    });

    // Entry 2-n: Credit individual vendor payable accounts
    for (const [vendorId, amount] of vendorTotals.entries()) {
      entries.push({
        accountId: await this.getAccountId('ADMIN', null, 'LIABILITY', `Vendor Payable - ${vendorId}`),
        creditAmount: amount,
        description: `Payable to vendor ${vendorId} for settlement`,
        referenceType: 'settlement_batch',
        referenceId: data.settlementBatch.id,
      });
    }

    const voucher = await this.createVoucher({
      voucherType: 'SETTLEMENT',
      entityType: 'ADMIN',
      voucherDate: data.settlementBatch.settlementDate,
      narration: `Settlement batch ${data.settlementBatch.batchNumber}`,
      entries,
      referenceType: 'settlement_batch',
      referenceId: data.settlementBatch.id,
      createdBy: 'system',
    });

    // Mark as auto voucher
    await prisma.voucher.update({
      where: { id: voucher.id },
      data: { isAuto: true, eventType: 'SETTLEMENT_RECEIVED' },
    });

    // Update settlement batch
    await prisma.settlementBatch.update({
      where: { id: data.settlementBatch.id },
      data: {
        voucherId: voucher.id,
        status: 'RECONCILED',
        reconciledAt: new Date(),
        reconciledBy: 'system',
      },
    });

    // Update SSL transactions
    await prisma.sSLCommerzTransaction.updateMany({
      where: {
        id: {
          in: data.transactions.map((tx) => tx.id),
        },
      },
      data: {
        isSettled: true,
        settlementDate: data.settlementBatch.settlementDate,
        settlementBatchId: data.settlementBatch.id,
        settlementVoucherId: voucher.id,
      },
    });

    // Auto-post voucher
    await this.postVoucher(voucher.id, 'system');

    return voucher;
  }

  private async createVendorPayoutVoucher(data: {
    vendorId: string;
    amount: Decimal;
    bankDetails: any;
    reference: string;
  }) {
    // For Admin: Debit Vendor Payable, Credit Bank
    const adminVoucher = await this.createVoucher({
      voucherType: 'PAYOUT',
      entityType: 'ADMIN',
      voucherDate: new Date(),
      narration: `Payout to vendor ${data.vendorId}`,
      entries: [
        {
          accountId: await this.getAccountId('ADMIN', null, 'LIABILITY', `Vendor Payable - ${data.vendorId}`),
          debitAmount: data.amount,
          description: `Payout to vendor ${data.vendorId}, Ref: ${data.reference}`,
          referenceType: 'payout',
          referenceId: data.reference,
        },
        {
          accountId: await this.getAccountId('ADMIN', null, 'ASSET', 'Bank Account'),
          creditAmount: data.amount,
          description: `Bank transfer to vendor ${data.vendorId}`,
          referenceType: 'payout',
          referenceId: data.reference,
        },
      ],
      referenceType: 'payout',
      referenceId: data.reference,
      createdBy: 'system',
    });

    // For Vendor: Debit Bank, Credit Platform Receivable
    const vendorVoucher = await this.createVoucher({
      voucherType: 'RECEIPT',
      entityType: 'VENDOR',
      entityId: data.vendorId,
      voucherDate: new Date(),
      narration: `Payout received from platform`,
      entries: [
        {
          accountId: await this.getAccountId('VENDOR', data.vendorId, 'ASSET', 'Bank Account'),
          debitAmount: data.amount,
          description: `Payout received, Ref: ${data.reference}`,
          referenceType: 'payout',
          referenceId: data.reference,
        },
        {
          accountId: await this.getAccountId('VENDOR', data.vendorId, 'ASSET', 'Platform Receivable'),
          creditAmount: data.amount,
          description: `Receivable cleared by payout`,
          referenceType: 'payout',
          referenceId: data.reference,
        },
      ],
      referenceType: 'payout',
      referenceId: data.reference,
      createdBy: 'system',
    });

    // Mark as auto vouchers
    await prisma.voucher.updateMany({
      where: { id: { in: [adminVoucher.id, vendorVoucher.id] } },
      data: { isAuto: true, eventType: 'VENDOR_PAYOUT' },
    });

    // Auto-post vouchers
    await this.postVoucher(adminVoucher.id, 'system');
    await this.postVoucher(vendorVoucher.id, 'system');

    // Update vendor payable
    await this.updateVendorPayable(data.vendorId);

    return { adminVoucher, vendorVoucher };
  }

  private async createRefundVoucher(data: {
    refundRecord: any;
    orderId: number;
    vendorId: string;
    refundAmount: Decimal;
    commissionReversed: Decimal;
  }) {
    // Create refund voucher - reverse the original sale
    const refundVoucher = await this.createVoucher({
      voucherType: 'REFUND',
      entityType: 'VENDOR',
      entityId: data.vendorId,
      narration: `Refund for Order #${data.orderId}`,
      entries: [
        {
          accountId: await this.getAccountId('VENDOR', data.vendorId, 'INCOME', 'Sales'),
          debitAmount: data.refundAmount,
          description: `Sales refund for Order #${data.orderId}`,
          referenceType: 'refund',
          referenceId: data.refundRecord.id,
        },
        {
          accountId: await this.getAccountId('VENDOR', data.vendorId, 'ASSET', 'Customer Receivable'),
          creditAmount: data.refundAmount,
          description: `Customer receivable reversed for Order #${data.orderId}`,
          referenceType: 'refund',
          referenceId: data.refundRecord.id,
        },
      ],
      referenceType: 'refund',
      referenceId: data.refundRecord.id,
      createdBy: 'system',
    });

    // Commission reversal voucher
    const commissionReversalVoucher = await this.createVoucher({
      voucherType: 'COMMISSION',
      entityType: 'ADMIN',
      narration: `Commission reversal for refunded Order #${data.orderId}`,
      entries: [
        {
          accountId: await this.getAccountId('ADMIN', null, 'INCOME', 'Commission Income'),
          debitAmount: data.commissionReversed,
          description: `Commission income reversed for Order #${data.orderId}`,
          referenceType: 'refund',
          referenceId: data.refundRecord.id,
        },
        {
          accountId: await this.getAccountId('ADMIN', null, 'ASSET', 'Vendor Commission Receivable'),
          creditAmount: data.commissionReversed,
          description: `Commission receivable reversed for Order #${data.orderId}`,
          referenceType: 'refund',
          referenceId: data.refundRecord.id,
        },
      ],
      referenceType: 'refund',
      referenceId: data.refundRecord.id,
      createdBy: 'system',
    });

    // Mark as auto vouchers
    await prisma.voucher.updateMany({
      where: { id: { in: [refundVoucher.id, commissionReversalVoucher.id] } },
      data: { isAuto: true, eventType: 'REFUND_INITIATED' },
    });

    // Auto-post
    await this.postVoucher(refundVoucher.id, 'system');
    await this.postVoucher(commissionReversalVoucher.id, 'system');

    return { refundVoucher, commissionReversalVoucher };
  }

  // ============================================
  // 4. REPORTS
  // ============================================

  async getTrialBalance(entityType: string, entityId?: string, asOf?: Date) {
    const accounts = await prisma.chartOfAccount.findMany({
      where: {
        entityType,
        entityId: entityId || null,
        isActive: true,
      },
      orderBy: [{ code: 'asc' }],
    });

    const trialBalance = [];
    let totalDebitSum = new Decimal(0);
    let totalCreditSum = new Decimal(0);

    for (const account of accounts) {
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: {
          accountId: account.id,
          entryDate: asOf ? { lte: asOf } : undefined,
        },
      });

      const totalDebit = ledgerEntries.reduce((sum, entry) => {
        return sum.plus(entry.debitAmount);
      }, new Decimal(0));

      const totalCredit = ledgerEntries.reduce((sum, entry) => {
        return sum.plus(entry.creditAmount);
      }, new Decimal(0));

      const balance = account.nature === 'DEBIT' ? totalDebit.minus(totalCredit) : totalCredit.minus(totalDebit);

      totalDebitSum = totalDebitSum.plus(totalDebit);
      totalCreditSum = totalCreditSum.plus(totalCredit);

      trialBalance.push({
        accountCode: account.code,
        accountName: account.name,
        accountType: account.accountType,
        groupName: account.groupName,
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

  async getProfitAndLoss(entityType: string, entityId?: string, startDate?: Date, endDate?: Date) {
    const incomeAccounts = await prisma.chartOfAccount.findMany({
      where: {
        entityType,
        entityId: entityId || null,
        accountType: 'INCOME',
        isActive: true,
      },
    });

    const expenseAccounts = await prisma.chartOfAccount.findMany({
      where: {
        entityType,
        entityId: entityId || null,
        accountType: 'EXPENSE',
        isActive: true,
      },
    });

    let totalIncome = new Decimal(0);
    let totalExpense = new Decimal(0);
    const incomeDetails = [];
    const expenseDetails = [];

    // Calculate income
    for (const account of incomeAccounts) {
      const entries = await prisma.ledgerEntry.findMany({
        where: {
          accountId: account.id,
          entryDate: {
            gte: startDate || new Date('1970-01-01'),
            lte: endDate || new Date(),
          },
        },
      });

      const income = entries.reduce((sum, entry) => {
        return sum.plus(account.nature === 'CREDIT' ? entry.creditAmount : entry.debitAmount).minus(account.nature === 'CREDIT' ? entry.debitAmount : entry.creditAmount);
      }, new Decimal(0));

      totalIncome = totalIncome.plus(income);
      incomeDetails.push({
        accountCode: account.code,
        accountName: account.name,
        amount: income.toString(),
      });
    }

    // Calculate expenses
    for (const account of expenseAccounts) {
      const entries = await prisma.ledgerEntry.findMany({
        where: {
          accountId: account.id,
          entryDate: {
            gte: startDate || new Date('1970-01-01'),
            lte: endDate || new Date(),
          },
        },
      });

      const expense = entries.reduce((sum, entry) => {
        return sum.plus(account.nature === 'DEBIT' ? entry.debitAmount : entry.creditAmount).minus(account.nature === 'DEBIT' ? entry.creditAmount : entry.debitAmount);
      }, new Decimal(0));

      totalExpense = totalExpense.plus(expense);
      expenseDetails.push({
        accountCode: account.code,
        accountName: account.name,
        amount: expense.toString(),
      });
    }

    const netProfit = totalIncome.minus(totalExpense);

    return {
      income: {
        accounts: incomeDetails,
        total: totalIncome.toString(),
      },
      expenses: {
        accounts: expenseDetails,
        total: totalExpense.toString(),
      },
      netProfit: netProfit.toString(),
      period: {
        startDate: startDate || new Date('1970-01-01'),
        endDate: endDate || new Date(),
      },
    };
  }

  async getBalanceSheet(entityType: string, entityId?: string, asOf?: Date) {
    const assetAccounts = await prisma.chartOfAccount.findMany({
      where: {
        entityType,
        entityId: entityId || null,
        accountType: 'ASSET',
        isActive: true,
      },
    });

    const liabilityAccounts = await prisma.chartOfAccount.findMany({
      where: {
        entityType,
        entityId: entityId || null,
        accountType: 'LIABILITY',
        isActive: true,
      },
    });

    const equityAccounts = await prisma.chartOfAccount.findMany({
      where: {
        entityType,
        entityId: entityId || null,
        accountType: 'EQUITY',
        isActive: true,
      },
    });

    const calculateBalance = async (account: any) => {
      const entries = await prisma.ledgerEntry.findMany({
        where: {
          accountId: account.id,
          entryDate: asOf ? { lte: asOf } : undefined,
        },
      });

      const totalDebit = entries.reduce((sum, entry) => sum.plus(entry.debitAmount), new Decimal(0));
      const totalCredit = entries.reduce((sum, entry) => sum.plus(entry.creditAmount), new Decimal(0));

      return account.nature === 'DEBIT' ? totalDebit.minus(totalCredit) : totalCredit.minus(totalDebit);
    };

    const assets = await Promise.all(
      assetAccounts.map(async (account) => ({
        accountCode: account.code,
        accountName: account.name,
        groupName: account.groupName,
        balance: (await calculateBalance(account)).toString(),
      }))
    );

    const liabilities = await Promise.all(
      liabilityAccounts.map(async (account) => ({
        accountCode: account.code,
        accountName: account.name,
        groupName: account.groupName,
        balance: (await calculateBalance(account)).toString(),
      }))
    );

    const equity = await Promise.all(
      equityAccounts.map(async (account) => ({
        accountCode: account.code,
        accountName: account.name,
        groupName: account.groupName,
        balance: (await calculateBalance(account)).toString(),
      }))
    );

    const totalAssets = assets.reduce((sum, asset) => sum.plus(new Decimal(asset.balance)), new Decimal(0));
    const totalLiabilities = liabilities.reduce((sum, liability) => sum.plus(new Decimal(liability.balance)), new Decimal(0));
    const totalEquity = equity.reduce((sum, eq) => sum.plus(new Decimal(eq.balance)), new Decimal(0));

    // Calculate retained earnings (Profit/Loss)
    const pl = await this.getProfitAndLoss(entityType, entityId, new Date('1970-01-01'), asOf);
    const retainedEarnings = new Decimal(pl.netProfit);

    return {
      assets: {
        accounts: assets,
        total: totalAssets.toString(),
      },
      liabilities: {
        accounts: liabilities,
        total: totalLiabilities.toString(),
      },
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
    entityType: string;
    entityId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page || 1;
    const limit = filters.limit || 50;
    const skip = (page - 1) * limit;

    const where: any = {
      entityType: filters.entityType,
      entityId: filters.entityId || null,
    };

    if (filters.accountId) where.accountId = filters.accountId;

    if (filters.startDate || filters.endDate) {
      where.entryDate = {};
      if (filters.startDate) where.entryDate.gte = filters.startDate;
      if (filters.endDate) where.entryDate.lte = filters.endDate;
    }

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        include: {
          account: true,
          voucher: true,
        },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.ledgerEntry.count({ where }),
    ]);

    // Calculate running balance
    let runningBalance = new Decimal(0);
    const entriesWithBalance = entries.reverse().map((entry) => {
      runningBalance = runningBalance.plus(entry.debitAmount).minus(entry.creditAmount);
      return {
        ...entry,
        runningBalance: runningBalance.toString(),
      };
    });

    return {
      data: entriesWithBalance.reverse(),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getVendorPayableReport(vendorId?: string) {
    const whereClause = vendorId ? { vendorId } : {};

    const payables = await prisma.vendorPayable.findMany({
      where: whereClause,
      orderBy: [{ balance: 'desc' }],
    });

    return payables;
  }

  // ============================================
  // 5. ACCOUNTING PERIODS
  // ============================================

  async createAccountingPeriod(data: {
    periodName: string;
    periodType: string;
    startDate: Date;
    endDate: Date;
    entityType: string;
    entityId?: string;
    userId: string;
  }) {
    // Check for overlapping periods
    const overlapping = await prisma.accountingPeriod.findFirst({
      where: {
        entityType: data.entityType,
        entityId: data.entityId || null,
        OR: [
          {
            AND: [{ startDate: { lte: data.startDate } }, { endDate: { gte: data.startDate } }],
          },
          {
            AND: [{ startDate: { lte: data.endDate } }, { endDate: { gte: data.endDate } }],
          },
        ],
      },
    });

    if (overlapping) {
      throw new Error('Period overlaps with existing period');
    }

    const period = await prisma.accountingPeriod.create({
      data: {
        periodName: data.periodName,
        periodType: data.periodType,
        startDate: data.startDate,
        endDate: data.endDate,
        entityType: data.entityType,
        entityId: data.entityId,
        isActive: true,
        isClosed: false,
      },
    });

    await this.createAuditLog({
      action: 'CREATE',
      entityName: 'accounting_periods',
      entityId: period.id,
      userId: data.userId,
      newData: period,
    });

    return period;
  }

  async closeAccountingPeriod(periodId: string, userId: string) {
    const period = await prisma.accountingPeriod.findUnique({
      where: { id: periodId },
    });

    if (!period) throw new Error('Period not found');
    if (period.isClosed) throw new Error('Period already closed');

    // Create closing voucher
    const pl = await this.getProfitAndLoss(period.entityType, period.entityId, period.startDate, period.endDate);

    // Close the period
    const updated = await prisma.accountingPeriod.update({
      where: { id: periodId },
      data: {
        isClosed: true,
        closedAt: new Date(),
        closedBy: userId,
      },
    });

    await this.createAuditLog({
      action: 'UPDATE',
      entityName: 'accounting_periods',
      entityId: periodId,
      userId,
      oldData: period,
      newData: updated,
    });

    return updated;
  }

  // ============================================
  // 6. AUDIT LOGS
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
      prisma.accountingAudit.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.accountingAudit.count({ where }),
    ]);

    return {
      data: logs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // ============================================
  // 7. UTILITY METHODS
  // ============================================

  private async generateVoucherNumber(voucherType: string, entityType: string, entityId?: string): Promise<string> {
    const prefix = voucherType.substring(0, 3).toUpperCase();
    const today = new Date();
    const year = today.getFullYear().toString().substring(2);
    const month = (today.getMonth() + 1).toString().padStart(2, '0');

    const searchPrefix = `${prefix}${year}${month}`;

    const lastVoucher = await prisma.voucher.findFirst({
      where: {
        voucherNumber: {
          startsWith: searchPrefix,
        },
        entityType,
        entityId: entityId || null,
      },
      orderBy: [{ voucherNumber: 'desc' }],
    });

    let sequence = 1;
    if (lastVoucher) {
      const lastSeq = parseInt(lastVoucher.voucherNumber.slice(-4));
      sequence = lastSeq + 1;
    }

    return `${searchPrefix}${sequence.toString().padStart(4, '0')}`;
  }

  private async getAccountId(
    entityType: string,
    entityId: string | null,
    accountType: string,
    accountName: string
  ): Promise<string> {
    const account = await prisma.chartOfAccount.findFirst({
      where: {
        entityType,
        entityId: entityId || null,
        accountType,
        name: accountName,
        isActive: true,
      },
    });

    if (!account) {
      throw new Error(`Account not found: ${accountName} (${accountType}) for ${entityType}${entityId ? `:${entityId}` : ''}`);
    }

    return account.id;
  }

  private async validateEntityAccess(entityType: string, entityId: string | undefined, userId: string) {
    // Implement entity access validation logic
    // This should check if the user has permission to access/modify the entity
    // For now, just a placeholder that returns true
    return true;
  }

  private async updateVendorPayableFromVoucher(voucher: any) {
    if (voucher.voucherType === 'SALES' && voucher.entityType === 'VENDOR') {
      const vendorId = voucher.entityId;
      if (!vendorId) return;

      // Calculate totals from ledger entries
      const salesEntries = await prisma.ledgerEntry.findMany({
        where: {
          voucherId: voucher.id,
          account: {
            accountType: 'INCOME',
            name: 'Sales',
          },
        },
      });

      const totalSales = salesEntries.reduce((sum, entry) => {
        return sum.plus(entry.creditAmount || entry.debitAmount);
      }, new Decimal(0));

      // Update vendor payable
      await prisma.vendorPayable.upsert({
        where: { vendorId },
        update: {
          totalSales: { increment: totalSales },
          totalPayable: { increment: totalSales },
          balance: { increment: totalSales },
          totalOrders: { increment: 1 },
          lastSaleAt: new Date(),
          lastSyncedAt: new Date(),
        },
        create: {
          vendorId,
          totalSales,
          totalPayable: totalSales,
          balance: totalSales,
          totalOrders: 1,
          lastSaleAt: new Date(),
          lastSyncedAt: new Date(),
        },
      });
    }
  }

  private async updateVendorPayable(vendorId: string) {
    // Recalculate vendor payable from ledger
    const payableAccount = await prisma.chartOfAccount.findFirst({
      where: {
        entityType: 'ADMIN',
        name: { contains: `Vendor Payable - ${vendorId}` },
      },
    });

    if (!payableAccount) return;

    const ledgerEntries = await prisma.ledgerEntry.findMany({
      where: {
        accountId: payableAccount.id,
      },
    });

    const balance = ledgerEntries.reduce((sum, entry) => {
      return sum.plus(entry.creditAmount).minus(entry.debitAmount);
    }, new Decimal(0));

    await prisma.vendorPayable.upsert({
      where: { vendorId },
      update: {
        balance,
        lastSyncedAt: new Date(),
      },
      create: {
        vendorId,
        balance,
        lastSyncedAt: new Date(),
      },
    });
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
        action: data.action,
        entityName: data.entityName,
        entityId: data.entityId,
        oldData: data.oldData,
        newData: data.newData,
        userId: data.userId,
        userName: data.userId, // Should fetch from user service
        userRole: 'USER', // Should fetch from user service
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
      },
    });
    
  }
  
}