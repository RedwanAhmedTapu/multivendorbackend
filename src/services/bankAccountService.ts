import { prismaDirect } from "../config/prisma.ts";
import { AccountClass, AccountTypeInAccounting, AccountGroup, AccountNature, EntityType, PaymentInstrumentType } from "@prisma/client";

interface AddBankAccountInput {
  bankBranchId: string;
  accountName: string;
  accountNumber: string;
  isDefault?: boolean;
  label?: string;
}

interface AddMobileBankingInput {
  mobileProvider: string;
  walletNumber: string;
  walletKind?: string;
  label?: string;
  isDefault?: boolean;
}

interface AddCardAccountInput {
  cardProcessor: string;
  merchantId?: string;
  label?: string;
  isDefault?: boolean;
}

interface AddCashAccountInput {
  label?: string;
  isDefault?: boolean;
}

async function nextBankAccountCode(
  tx: any,
  entityType: EntityType,
  entityId: string | null,
  prefix: "VND" | "ADM",
): Promise<string> {
  // upsert একটাই DB round-trip-এ INSERT ... ON CONFLICT DO UPDATE হিসেবে
  // কম্পাইল হয় (Postgres) — এটা row-level lock নেয়, তাই দুটো concurrent
  // transaction একে অপরকে serialize করে, count()-এর মতো stale read সম্ভব না।
  const seq = await tx.accountCodeSequence.upsert({
    where: {
      entityType_entityId_prefix: {
        entityType,
        entityId: entityId ?? "",
        prefix,
      },
    },
    create: {
      entityType,
      entityId: entityId ?? "",
      prefix,
      lastNumber: 1,
    },
    update: {
      lastNumber: { increment: 1 },
    },
  });

  return `${prefix}-BNK-${String(seq.lastNumber).padStart(4, "0")}`;
}

export const BankAccountService = {
  async addVendorPaymentAccount(vendorId: string, input: AddBankAccountInput) {
    return prismaDirect.$transaction(async (tx) => {
      const branch = await tx.bankBranch.findUnique({
        where: { id: input.bankBranchId },
        include: { bank: true },
      });
      if (!branch || !branch.isActive) throw new Error("Selected branch is invalid or inactive.");
      if (!branch.bank.isActive) throw new Error("Selected bank is inactive.");

      if (input.isDefault) {
        await tx.vendorPaymentAccount.updateMany({
          where: { vendorId, type: PaymentInstrumentType.BANK, isDefault: true },
          data: { isDefault: false },
        });
      }

      const existingCount = await tx.vendorPaymentAccount.count({
        where: { vendorId, type: PaymentInstrumentType.BANK },
      });
      const isDefault = input.isDefault ?? existingCount === 0;

      const paymentAccount = await tx.vendorPaymentAccount.create({
        data: {
          vendorId,
          type: PaymentInstrumentType.BANK,
          bankBranchId: branch.id,
          accountName: input.accountName,
          accountNumber: input.accountNumber,
          label: input.label,
          isDefault,
        },
      });

      const code = await nextBankAccountCode(tx, EntityType.VENDOR, vendorId, "VND");
      const coa = await tx.chartOfAccount.create({
        data: {
          code,
          name: `${branch.bank.name} - ${input.accountNumber.slice(-4).padStart(input.accountNumber.length, "*")}`,
          accountClass: AccountClass.ASSET,
          accountType: AccountTypeInAccounting.CURRENT_ASSET,
          group: AccountGroup.CASH_AND_BANK,
          nature: AccountNature.DEBIT,
          entityType: EntityType.VENDOR,
          entityId: vendorId,
          isSystem: false,
          canDelete: false,
          description: `Bank account (${branch.bank.name}, ${branch.branchName}) added by vendor.`,
        },
      });

      return tx.vendorPaymentAccount.update({
        where: { id: paymentAccount.id },
        data: { chartOfAccountId: coa.id },
        include: { bankBranch: { include: { bank: true } }, chartOfAccount: true },
      });
    });
  },

  async addAdminPaymentAccount(input: AddBankAccountInput) {
    return prismaDirect.$transaction(async (tx) => {
      const branch = await tx.bankBranch.findUnique({
        where: { id: input.bankBranchId },
        include: { bank: true },
      });
      if (!branch || !branch.isActive) throw new Error("Selected branch is invalid or inactive.");
      if (!branch.bank.isActive) throw new Error("Selected bank is inactive.");

      if (input.isDefault) {
        await tx.adminPaymentAccount.updateMany({
          where: { type: PaymentInstrumentType.BANK, isDefault: true },
          data: { isDefault: false },
        });
      }

      const existingCount = await tx.adminPaymentAccount.count({
        where: { type: PaymentInstrumentType.BANK },
      });
      const isDefault = input.isDefault ?? existingCount === 0;

      const paymentAccount = await tx.adminPaymentAccount.create({
        data: {
          type: PaymentInstrumentType.BANK,
          bankBranchId: branch.id,
          accountName: input.accountName,
          accountNumber: input.accountNumber,
          label: input.label,
          isDefault,
        },
      });

      const code = await nextBankAccountCode(tx, EntityType.ADMIN, null, "ADM");
      const coa = await tx.chartOfAccount.create({
        data: {
          code,
          name: `${branch.bank.name} - ${input.accountNumber.slice(-4).padStart(input.accountNumber.length, "*")}`,
          accountClass: AccountClass.ASSET,
          accountType: AccountTypeInAccounting.CURRENT_ASSET,
          group: AccountGroup.CASH_AND_BANK,
          nature: AccountNature.DEBIT,
          entityType: EntityType.ADMIN,
          entityId: null,
          isSystem: false,
          canDelete: false,
          description: `Platform bank account (${branch.bank.name}, ${branch.branchName}).`,
        },
      });

      return tx.adminPaymentAccount.update({
        where: { id: paymentAccount.id },
        data: { chartOfAccountId: coa.id },
        include: { bankBranch: { include: { bank: true } }, chartOfAccount: true },
      });
    });
  },

  /**
   * FIXED: previously hardcoded `type: PaymentInstrumentType.BANK`, which
   * meant mobile-banking, card and cash accounts existed in the DB but
   * were silently excluded from every vendor's payment-accounts list.
   * Now returns every payment account of every type for this vendor,
   * grouped by type then by default-first for a stable, predictable order.
   */
  async listVendorPaymentAccounts(vendorId: string) {
    return prismaDirect.vendorPaymentAccount.findMany({
      where: { vendorId },
      include: { bankBranch: { include: { bank: true } }, chartOfAccount: true },
      orderBy: [{ type: "asc" }, { isDefault: "desc" }, { createdAt: "asc" }],
    });
  },

  /**
   * FIXED: previously hardcoded `type: PaymentInstrumentType.BANK` both when
   * looking up the account and when clearing other defaults — so calling
   * this on a MOBILE_BANKING/CARD/CASH account id always failed with
   * "not found". Now looks the account up by id+vendorId regardless of
   * type, then scopes the "only one default" rule to that account's own
   * type (so a vendor can have one default BANK account AND, separately,
   * one default MOBILE_BANKING account, etc.).
   */
  async setDefaultVendorPaymentAccount(vendorId: string, paymentAccountId: string) {
    return prismaDirect.$transaction(async (tx) => {
      const acc = await tx.vendorPaymentAccount.findFirst({
        where: { id: paymentAccountId, vendorId },
      });
      if (!acc) throw new Error("Payment account not found for this vendor.");

      await tx.vendorPaymentAccount.updateMany({
        where: { vendorId, type: acc.type, isDefault: true },
        data: { isDefault: false },
      });

      return tx.vendorPaymentAccount.update({
        where: { id: paymentAccountId },
        data: { isDefault: true },
        include: { bankBranch: { include: { bank: true } }, chartOfAccount: true },
      });
    });
  },

  async addVendorMobileBankingAccount(vendorId: string, input: AddMobileBankingInput) {
    return prismaDirect.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.vendorPaymentAccount.updateMany({
          where: { vendorId, type: PaymentInstrumentType.MOBILE_BANKING, isDefault: true },
          data: { isDefault: false },
        });
      }

      const existingCount = await tx.vendorPaymentAccount.count({
        where: { vendorId, type: PaymentInstrumentType.MOBILE_BANKING },
      });
      const isDefault = input.isDefault ?? existingCount === 0;

      const paymentAccount = await tx.vendorPaymentAccount.create({
        data: {
          vendorId,
          type: PaymentInstrumentType.MOBILE_BANKING,
          mobileProvider: input.mobileProvider as any,
          walletNumber: input.walletNumber,
          walletKind: input.walletKind,
          label: input.label,
          isDefault,
        },
      });

      const code = await nextBankAccountCode(tx, EntityType.VENDOR, vendorId, "VND");
      const coa = await tx.chartOfAccount.create({
        data: {
          code,
          name: `${input.mobileProvider} - ${input.walletNumber.slice(-4)}`,
          accountClass: AccountClass.ASSET,
          accountType: AccountTypeInAccounting.CURRENT_ASSET,
          group: AccountGroup.CASH_AND_BANK,
          nature: AccountNature.DEBIT,
          entityType: EntityType.VENDOR,
          entityId: vendorId,
          isSystem: false,
          canDelete: false,
          description: `Mobile banking account (${input.mobileProvider}) added by vendor.`,
        },
      });

      return tx.vendorPaymentAccount.update({
        where: { id: paymentAccount.id },
        data: { chartOfAccountId: coa.id },
        include: { chartOfAccount: true },
      });
    });
  },

  /**
   * NEW: was referenced by vendor.controller.ts's addBankAccount (the
   * "CARD" branch of its switch statement) but never actually existed —
   * calling it threw "BankAccountService.addVendorCardAccount is not a
   * function" and silently blocked vendors from ever adding a card
   * payment method.
   */
  async addVendorCardAccount(vendorId: string, input: AddCardAccountInput) {
    return prismaDirect.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.vendorPaymentAccount.updateMany({
          where: { vendorId, type: PaymentInstrumentType.CARD, isDefault: true },
          data: { isDefault: false },
        });
      }

      const existingCount = await tx.vendorPaymentAccount.count({
        where: { vendorId, type: PaymentInstrumentType.CARD },
      });
      const isDefault = input.isDefault ?? existingCount === 0;

      const paymentAccount = await tx.vendorPaymentAccount.create({
        data: {
          vendorId,
          type: PaymentInstrumentType.CARD,
          cardProcessor: input.cardProcessor,
          merchantId: input.merchantId,
          label: input.label,
          isDefault,
        },
      });

      const code = await nextBankAccountCode(tx, EntityType.VENDOR, vendorId, "VND");
      const coa = await tx.chartOfAccount.create({
        data: {
          code,
          name: input.label || `${input.cardProcessor} Card Account`,
          accountClass: AccountClass.ASSET,
          accountType: AccountTypeInAccounting.CURRENT_ASSET,
          group: AccountGroup.CASH_AND_BANK,
          nature: AccountNature.DEBIT,
          entityType: EntityType.VENDOR,
          entityId: vendorId,
          isSystem: false,
          canDelete: false,
          description: `Card payment account (${input.cardProcessor}) added by vendor.`,
        },
      });

      return tx.vendorPaymentAccount.update({
        where: { id: paymentAccount.id },
        data: { chartOfAccountId: coa.id },
        include: { chartOfAccount: true },
      });
    });
  },

  /**
   * NEW: same gap as addVendorCardAccount — vendor.controller.ts's "CASH"
   * branch called this, but it never existed, so vendors could never
   * actually register a cash payout preference.
   */
  async addVendorCashAccount(vendorId: string, input: AddCashAccountInput = {}) {
    return prismaDirect.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.vendorPaymentAccount.updateMany({
          where: { vendorId, type: PaymentInstrumentType.CASH, isDefault: true },
          data: { isDefault: false },
        });
      }

      const existingCount = await tx.vendorPaymentAccount.count({
        where: { vendorId, type: PaymentInstrumentType.CASH },
      });
      const isDefault = input.isDefault ?? existingCount === 0;

      const paymentAccount = await tx.vendorPaymentAccount.create({
        data: {
          vendorId,
          type: PaymentInstrumentType.CASH,
          label: input.label ?? "Cash",
          isDefault,
        },
      });

      const code = await nextBankAccountCode(tx, EntityType.VENDOR, vendorId, "VND");
      const coa = await tx.chartOfAccount.create({
        data: {
          code,
          name: input.label ?? "Cash Account",
          accountClass: AccountClass.ASSET,
          accountType: AccountTypeInAccounting.CURRENT_ASSET,
          group: AccountGroup.CASH_AND_BANK,
          nature: AccountNature.DEBIT,
          entityType: EntityType.VENDOR,
          entityId: vendorId,
          isSystem: false,
          canDelete: false,
          description: "Cash payment account added by vendor.",
        },
      });

      return tx.vendorPaymentAccount.update({
        where: { id: paymentAccount.id },
        data: { chartOfAccountId: coa.id },
        include: { chartOfAccount: true },
      });
    });
  },
};