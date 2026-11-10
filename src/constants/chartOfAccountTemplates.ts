// src/constants/chartOfAccountTemplates.ts
import { AccountClass, AccountTypeInAccounting, AccountGroup, AccountNature } from "@prisma/client";

export interface AccountSeed {
  code: string;
  name: string;
  accountClass: AccountClass;
  accountType: AccountTypeInAccounting;
  group?: AccountGroup;
  nature: AccountNature;
}

// ---------------------------------------------------------------------------
// PLATFORM (ADMIN) COA — created once at server start, entityId: null
// ---------------------------------------------------------------------------
export const PLATFORM_ACCOUNTS: AccountSeed[] = [
  { code: 'ADM-AST-0001', name: 'Receivable from Payment Gateway (SSLCommerz)', accountClass: AccountClass.ASSET, accountType: AccountTypeInAccounting.CURRENT_ASSET, group: AccountGroup.ACCOUNTS_RECEIVABLE, nature: AccountNature.DEBIT },
  { code: 'ADM-AST-0002', name: 'Receivable from Courier (COD)',                accountClass: AccountClass.ASSET, accountType: AccountTypeInAccounting.CURRENT_ASSET, group: AccountGroup.ACCOUNTS_RECEIVABLE, nature: AccountNature.DEBIT },
  { code: 'ADM-AST-0003', name: 'Receivable from Courier (Claims)',             accountClass: AccountClass.ASSET, accountType: AccountTypeInAccounting.CURRENT_ASSET, group: AccountGroup.ACCOUNTS_RECEIVABLE, nature: AccountNature.DEBIT },
  { code: 'ADM-AST-0004', name: 'Cash in Operating Bank Account',               accountClass: AccountClass.ASSET, accountType: AccountTypeInAccounting.CURRENT_ASSET, group: AccountGroup.CASH_AND_BANK,        nature: AccountNature.DEBIT },
  { code: 'ADM-AST-0005', name: 'Input Tax Recoverable (VAT/GST)',              accountClass: AccountClass.ASSET, accountType: AccountTypeInAccounting.CURRENT_ASSET, group: AccountGroup.STATUTORY,           nature: AccountNature.DEBIT },

  { code: 'ADM-LIB-0001', name: 'Customer Deposit Liability',                   accountClass: AccountClass.LIABILITY, accountType: AccountTypeInAccounting.CURRENT_LIABILITY, group: AccountGroup.ACCOUNTS_PAYABLE, nature: AccountNature.CREDIT },
  { code: 'ADM-LIB-0002', name: 'Vendor Payables',                              accountClass: AccountClass.LIABILITY, accountType: AccountTypeInAccounting.CURRENT_LIABILITY, group: AccountGroup.ACCOUNTS_PAYABLE, nature: AccountNature.CREDIT },
  { code: 'ADM-LIB-0003', name: 'Payable to Courier',                           accountClass: AccountClass.LIABILITY, accountType: AccountTypeInAccounting.CURRENT_LIABILITY, group: AccountGroup.ACCOUNTS_PAYABLE, nature: AccountNature.CREDIT },
  { code: 'ADM-LIB-0004', name: 'Payable to Payment Gateway (Refunds)',         accountClass: AccountClass.LIABILITY, accountType: AccountTypeInAccounting.CURRENT_LIABILITY, group: AccountGroup.ACCOUNTS_PAYABLE, nature: AccountNature.CREDIT },
  { code: 'ADM-LIB-0005', name: 'Store Credit Liability',                       accountClass: AccountClass.LIABILITY, accountType: AccountTypeInAccounting.CURRENT_LIABILITY, group: AccountGroup.ACCOUNTS_PAYABLE, nature: AccountNature.CREDIT },
  { code: 'ADM-LIB-0006', name: 'Output Tax Payable (VAT/GST)',                 accountClass: AccountClass.LIABILITY, accountType: AccountTypeInAccounting.CURRENT_LIABILITY, group: AccountGroup.STATUTORY,        nature: AccountNature.CREDIT },

  { code: 'ADM-INC-0001', name: 'Platform Commission Income', accountClass: AccountClass.INCOME, accountType: AccountTypeInAccounting.INCOME, nature: AccountNature.CREDIT },
  { code: 'ADM-INC-0002', name: 'Courier Delivery Income',     accountClass: AccountClass.INCOME, accountType: AccountTypeInAccounting.INCOME, nature: AccountNature.CREDIT },

  { code: 'ADM-EXP-0001', name: 'Platform Discount Expense',        accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.OPERATING_EXPENSE, nature: AccountNature.DEBIT },
  { code: 'ADM-EXP-0002', name: 'Payment Gateway Fees Expense',     accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.DIRECT_EXPENSE,    nature: AccountNature.DEBIT },
  { code: 'ADM-EXP-0003', name: 'COD Collection Fees Expense',      accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.DIRECT_EXPENSE,    nature: AccountNature.DEBIT },
  { code: 'ADM-EXP-0004', name: 'Courier Delivery Fees Expense',    accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.DIRECT_EXPENSE,    nature: AccountNature.DEBIT },
  { code: 'ADM-EXP-0005', name: 'Courier Return Delivery Expense',  accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.DIRECT_EXPENSE,    nature: AccountNature.DEBIT },
  { code: 'ADM-EXP-0006', name: 'Lost in Transit Expense',          accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.OPERATING_EXPENSE, nature: AccountNature.DEBIT },
  { code: 'ADM-EXP-0007', name: 'Goodwill/Platform Compensation',   accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.OPERATING_EXPENSE, nature: AccountNature.DEBIT },
];

// ---------------------------------------------------------------------------
// VENDOR COA TEMPLATE — NOT seeded on server start anymore.
// Created on-demand for a single vendor when that vendor is approved/verified
// (see VendorService.ensureVendorChartOfAccounts, called from
// updateVendorStatus / verifyVendor). Bank-specific accounts (VND-BNK-xxxx)
// are separate and created by BankAccountService when a bank account is added.
// ---------------------------------------------------------------------------
export const VENDOR_ACCOUNT_TEMPLATE: AccountSeed[] = [
  { code: 'VND-AST-0001', name: 'Receivable from Platform',       accountClass: AccountClass.ASSET, accountType: AccountTypeInAccounting.CURRENT_ASSET, group: AccountGroup.ACCOUNTS_RECEIVABLE, nature: AccountNature.DEBIT },
  { code: 'VND-AST-0002', name: 'Cash at Bank Account',            accountClass: AccountClass.ASSET, accountType: AccountTypeInAccounting.CURRENT_ASSET, group: AccountGroup.CASH_AND_BANK,        nature: AccountNature.DEBIT },
  { code: 'VND-AST-0003', name: 'Input Tax Recoverable (VAT/GST)', accountClass: AccountClass.ASSET, accountType: AccountTypeInAccounting.CURRENT_ASSET, group: AccountGroup.STATUTORY,            nature: AccountNature.DEBIT },
  { code: 'VND-AST-0004', name: 'Inventory Asset (Goods)',         accountClass: AccountClass.ASSET, accountType: AccountTypeInAccounting.CURRENT_ASSET, nature: AccountNature.DEBIT },

  { code: 'VND-LIB-0001', name: 'Output Tax Payable (VAT/GST)', accountClass: AccountClass.LIABILITY, accountType: AccountTypeInAccounting.CURRENT_LIABILITY, group: AccountGroup.STATUTORY, nature: AccountNature.CREDIT },

  { code: 'VND-INC-0001', name: 'Sales Revenue', accountClass: AccountClass.INCOME, accountType: AccountTypeInAccounting.INCOME, nature: AccountNature.CREDIT },

  { code: 'VND-EXP-0001', name: 'Sales Returns',                   accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.OPERATING_EXPENSE, nature: AccountNature.DEBIT },
  { code: 'VND-EXP-0002', name: 'Vendor Funded Discounts',         accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.OPERATING_EXPENSE, nature: AccountNature.DEBIT },
  { code: 'VND-EXP-0003', name: 'Platform Commission Expense',     accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.DIRECT_EXPENSE,    nature: AccountNature.DEBIT },
  { code: 'VND-EXP-0004', name: 'PG Fee / Shortfall Expense',      accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.DIRECT_EXPENSE,    nature: AccountNature.DEBIT },
  { code: 'VND-EXP-0005', name: 'Courier Return/Forward Expense',  accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.DIRECT_EXPENSE,    nature: AccountNature.DEBIT },
  { code: 'VND-EXP-0006', name: 'Damage/Loss Liability Expense',   accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.OPERATING_EXPENSE, nature: AccountNature.DEBIT },
  { code: 'VND-EXP-0007', name: 'Cost of Goods Sold (Expense)',    accountClass: AccountClass.EXPENSE, accountType: AccountTypeInAccounting.EXPENSE, group: AccountGroup.DIRECT_EXPENSE,    nature: AccountNature.DEBIT },
];