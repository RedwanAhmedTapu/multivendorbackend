-- PROPOSED — NOT APPLIED. POS baseline (pos_* tables + their enums + stock_movements.posSaleId).
--
-- Why: the Pos* models exist in prisma/schema.prisma but no migration ever
-- created them, and the committed (HEAD) schema has no Pos* models. Whether
-- the target database already has these objects (e.g. via `prisma db push`)
-- is UNVERIFIED. Every statement is therefore idempotent: it creates what is
-- missing and leaves existing objects untouched.
--
-- Generated offline (no database) with:
--   prisma migrate diff --from-schema-datamodel <working schema minus POS>
--                       --to-schema-datamodel  <working schema before the subscription work> --script
-- then wrapped in IF NOT EXISTS / duplicate_object guards.
--
-- BEFORE applying anywhere, run the read-only drift check in README.md against
-- a staging copy: if pos_* tables already exist with a DIFFERENT shape, this
-- file will skip them and the lifecycle migration may fail — reconcile first.


DO $$ BEGIN
  CREATE TYPE "public"."PosPaymentMethod" AS ENUM ('CASH', 'CARD', 'BKASH', 'NAGAD', 'ROCKET', 'BANK_TRANSFER', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."DiscountValueType" AS ENUM ('PERCENT', 'FLAT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."PosSaleStatus" AS ENUM ('PAID', 'PENDING', 'REFUNDED', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."PosSubscriptionPlan" AS ENUM ('TRIAL', 'BASIC', 'PRO', 'ENTERPRISE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."PosSubStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED', 'SUSPENDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "public"."stock_movements" ADD COLUMN IF NOT EXISTS "posSaleId" TEXT;

CREATE TABLE IF NOT EXISTS "public"."pos_staff" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "avatarColor" TEXT NOT NULL DEFAULT '#0d9488',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "employeeId" TEXT,

    CONSTRAINT "pos_staff_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."pos_customers" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "nid" TEXT,
    "address" TEXT,
    "note" TEXT,
    "referrerName" TEXT,
    "referrerEmail" TEXT,
    "loanLimit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "loanBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "loanInterestRate" DOUBLE PRECISION NOT NULL DEFAULT 12,
    "loanTenureDays" INTEGER NOT NULL DEFAULT 30,
    "creditScore" TEXT NOT NULL DEFAULT 'Good',
    "walletBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "due" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "spent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastOrderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_customers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."pos_bank_accounts" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNo" TEXT NOT NULL,
    "routing" TEXT,
    "branch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_bank_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."pos_sales" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "voucherNo" TEXT NOT NULL,
    "staffId" TEXT,
    "customerId" TEXT,
    "bankAccountId" TEXT,
    "isWalkIn" BOOLEAN NOT NULL DEFAULT true,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discountPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discountType" "public"."DiscountValueType" NOT NULL DEFAULT 'PERCENT',
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netBilling" DOUBLE PRECISION NOT NULL,
    "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dueAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "extraAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dueCutAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "walletAddAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cogs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paymentMethod" "public"."PosPaymentMethod" NOT NULL DEFAULT 'CASH',
    "note" TEXT,
    "status" "public"."PosSaleStatus" NOT NULL DEFAULT 'PAID',
    "saleDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountingVoucherId" TEXT,

    CONSTRAINT "pos_sales_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."pos_sale_items" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "variantId" TEXT,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "qty" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "warehouseId" TEXT,
    "rackId" TEXT,

    CONSTRAINT "pos_sale_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."pos_settings" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
    "voucherPrefix" TEXT NOT NULL DEFAULT 'POSV',
    "currencySymbol" TEXT NOT NULL DEFAULT '৳',
    "receiptFooterText" TEXT,
    "storeOnline" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."pos_subscriptions" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "plan" "public"."PosSubscriptionPlan" NOT NULL DEFAULT 'TRIAL',
    "status" "public"."PosSubStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "price" DOUBLE PRECISION,
    "billingCycle" "public"."BillingCycle",
    "lastPaymentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pos_staff_employeeId_key" ON "public"."pos_staff"("employeeId");

CREATE INDEX IF NOT EXISTS "pos_staff_vendorId_idx" ON "public"."pos_staff"("vendorId");

CREATE UNIQUE INDEX IF NOT EXISTS "pos_staff_vendorId_username_key" ON "public"."pos_staff"("vendorId", "username");

CREATE INDEX IF NOT EXISTS "pos_customers_vendorId_idx" ON "public"."pos_customers"("vendorId");

CREATE UNIQUE INDEX IF NOT EXISTS "pos_customers_vendorId_phone_key" ON "public"."pos_customers"("vendorId", "phone");

CREATE INDEX IF NOT EXISTS "pos_bank_accounts_vendorId_idx" ON "public"."pos_bank_accounts"("vendorId");

CREATE UNIQUE INDEX IF NOT EXISTS "pos_sales_accountingVoucherId_key" ON "public"."pos_sales"("accountingVoucherId");

CREATE INDEX IF NOT EXISTS "pos_sales_vendorId_saleDate_idx" ON "public"."pos_sales"("vendorId", "saleDate");

CREATE INDEX IF NOT EXISTS "pos_sales_vendorId_status_idx" ON "public"."pos_sales"("vendorId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "pos_sales_vendorId_invoiceNo_key" ON "public"."pos_sales"("vendorId", "invoiceNo");

CREATE INDEX IF NOT EXISTS "pos_sale_items_saleId_idx" ON "public"."pos_sale_items"("saleId");

CREATE UNIQUE INDEX IF NOT EXISTS "pos_settings_vendorId_key" ON "public"."pos_settings"("vendorId");

CREATE UNIQUE INDEX IF NOT EXISTS "pos_subscriptions_vendorId_key" ON "public"."pos_subscriptions"("vendorId");

CREATE INDEX IF NOT EXISTS "pos_subscriptions_status_expiresAt_idx" ON "public"."pos_subscriptions"("status", "expiresAt");

DO $$ BEGIN
  ALTER TABLE "public"."stock_movements" ADD CONSTRAINT "stock_movements_posSaleId_fkey" FOREIGN KEY ("posSaleId") REFERENCES "public"."pos_sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_staff" ADD CONSTRAINT "pos_staff_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "public"."employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_staff" ADD CONSTRAINT "pos_staff_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_customers" ADD CONSTRAINT "pos_customers_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_bank_accounts" ADD CONSTRAINT "pos_bank_accounts_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_sales" ADD CONSTRAINT "pos_sales_accountingVoucherId_fkey" FOREIGN KEY ("accountingVoucherId") REFERENCES "public"."vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_sales" ADD CONSTRAINT "pos_sales_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "public"."pos_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_sales" ADD CONSTRAINT "pos_sales_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."pos_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_sales" ADD CONSTRAINT "pos_sales_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."pos_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_sales" ADD CONSTRAINT "pos_sales_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_sale_items" ADD CONSTRAINT "pos_sale_items_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "public"."WarehouseRack"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_sale_items" ADD CONSTRAINT "pos_sale_items_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "public"."pos_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_sale_items" ADD CONSTRAINT "pos_sale_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "public"."product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_sale_items" ADD CONSTRAINT "pos_sale_items_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "public"."vendor_warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_settings" ADD CONSTRAINT "pos_settings_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."pos_subscriptions" ADD CONSTRAINT "pos_subscriptions_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
