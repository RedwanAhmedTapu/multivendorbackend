-- FinixMart subscription platform + vendor payout scheduling (2026-11).
-- docs/subscription-payout-audit.md.
--
-- ADDITIVE ONLY: new enums, new tables, and new nullable / defaulted columns on
-- vendor_subscriptions. No existing column, row, index or constraint is changed
-- or dropped. Legacy vendor_subscriptions rows keep planType / isActive and get
-- status = NULL (= no plan entitlements). POS tables are untouched.
-- Generated with `prisma migrate diff` (schema to schema, offline) + the CHECK
-- constraints at the end.
-- CreateEnum
CREATE TYPE "public"."SubPackageStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "public"."SubPackageVisibility" AS ENUM ('PUBLIC', 'HIDDEN');

-- CreateEnum
CREATE TYPE "public"."VendorSubStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "public"."VendorSubSource" AS ENUM ('TRIAL', 'PAID', 'COMPLIMENTARY', 'OFFER', 'ADMIN');

-- CreateEnum
CREATE TYPE "public"."SubOfferKind" AS ENUM ('PRICE_OVERRIDE', 'PERCENT_DISCOUNT', 'FIXED_DISCOUNT', 'FREE_PLAN', 'FREE_FEATURE');

-- CreateEnum
CREATE TYPE "public"."SubOfferStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."SubOfferAfterExpiry" AS ENUM ('NORMAL_PRICE', 'PREVIOUS_SUBSCRIPTION', 'SWITCH_PLAN', 'DISABLE_FEATURE', 'MANUAL_RENEWAL');

-- CreateEnum
CREATE TYPE "public"."SubPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "public"."PayoutCycle" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "public"."PayoutBatchStatus" AS ENUM ('DRAFT', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."PayoutItemStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'HELD', 'CANCELLED');

-- AlterTable
ALTER TABLE "public"."vendor_subscriptions" ADD COLUMN     "amountPaid" DECIMAL(18,2),
ADD COLUMN     "autoRenew" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'BDT',
ADD COLUMN     "cycleId" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "graceDays" INTEGER,
ADD COLUMN     "offerId" TEXT,
ADD COLUMN     "packageId" TEXT,
ADD COLUMN     "previousPackageId" TEXT,
ADD COLUMN     "reminderSentFor" TIMESTAMP(3),
ADD COLUMN     "source" "public"."VendorSubSource",
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "status" "public"."VendorSubStatus",
ADD COLUMN     "suspendedReason" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."subscription_features" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "category" TEXT,
    "limitDefs" JSONB NOT NULL DEFAULT '[]',
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."subscription_packages" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "public"."SubPackageStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "public"."SubPackageVisibility" NOT NULL DEFAULT 'PUBLIC',
    "isPopular" BOOLEAN NOT NULL DEFAULT false,
    "trialDays" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."subscription_package_features" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "featureId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "subscription_package_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."subscription_cycles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."subscription_package_prices" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "price" DECIMAL(18,2) NOT NULL,
    "promoPrice" DECIMAL(18,2),
    "discountPercent" DECIMAL(5,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_package_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_subscription_events" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "paymentId" TEXT,
    "offerId" TEXT,
    "actorUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_subscription_offers" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" "public"."SubOfferKind" NOT NULL,
    "packageId" TEXT,
    "cycleId" TEXT,
    "featureId" TEXT,
    "value" DECIMAL(18,2),
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "public"."SubOfferStatus" NOT NULL DEFAULT 'ACTIVE',
    "afterExpiry" "public"."SubOfferAfterExpiry" NOT NULL DEFAULT 'MANUAL_RENEWAL',
    "afterExpiryPackageId" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_subscription_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."subscription_payments" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "listAmount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "status" "public"."SubPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "offerId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "recordedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_feature_usage" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "featureId" TEXT NOT NULL,
    "limitKey" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_feature_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_payout_rules" (
    "vendorId" TEXT NOT NULL,
    "cycle" "public"."PayoutCycle",
    "weekday" INTEGER,
    "monthDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "customIntervalDays" INTEGER,
    "anchorDate" TIMESTAMP(3),
    "minThreshold" DECIMAL(18,2),
    "settlementDelayDays" INTEGER,
    "requireApproval" BOOLEAN,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "holdUntil" TIMESTAMP(3),
    "holdReason" TEXT,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_payout_rules_pkey" PRIMARY KEY ("vendorId")
);

-- CreateTable
CREATE TABLE "public"."payout_batches" (
    "id" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "public"."PayoutBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vendorCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payout_batch_items" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" "public"."PayoutItemStatus" NOT NULL DEFAULT 'PENDING',
    "calculation" JSONB NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "voucherId" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "heldReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payout_audit_logs" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_features_key_key" ON "public"."subscription_features"("key");

-- CreateIndex
CREATE INDEX "subscription_features_isActive_sortOrder_idx" ON "public"."subscription_features"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_packages_slug_key" ON "public"."subscription_packages"("slug");

-- CreateIndex
CREATE INDEX "subscription_packages_status_displayOrder_idx" ON "public"."subscription_packages"("status", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_package_features_packageId_featureId_key" ON "public"."subscription_package_features"("packageId", "featureId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_cycles_key_key" ON "public"."subscription_cycles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_package_prices_packageId_cycleId_key" ON "public"."subscription_package_prices"("packageId", "cycleId");

-- CreateIndex
CREATE INDEX "vendor_subscription_events_vendorId_createdAt_idx" ON "public"."vendor_subscription_events"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "vendor_subscription_offers_vendorId_status_endsAt_idx" ON "public"."vendor_subscription_offers"("vendorId", "status", "endsAt");

-- CreateIndex
CREATE INDEX "vendor_subscription_offers_status_endsAt_idx" ON "public"."vendor_subscription_offers"("status", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_idempotencyKey_key" ON "public"."subscription_payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "subscription_payments_vendorId_createdAt_idx" ON "public"."subscription_payments"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "subscription_payments_status_createdAt_idx" ON "public"."subscription_payments"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_feature_usage_vendorId_featureId_limitKey_periodKey_key" ON "public"."vendor_feature_usage"("vendorId", "featureId", "limitKey", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "payout_batches_batchNumber_key" ON "public"."payout_batches"("batchNumber");

-- CreateIndex
CREATE INDEX "payout_batches_status_scheduledFor_idx" ON "public"."payout_batches"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "payout_batch_items_vendorId_status_idx" ON "public"."payout_batch_items"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payout_batch_items_batchId_vendorId_key" ON "public"."payout_batch_items"("batchId", "vendorId");

-- CreateIndex
CREATE INDEX "payout_audit_logs_entity_entityId_createdAt_idx" ON "public"."payout_audit_logs"("entity", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "vendor_subscriptions_status_expiresAt_idx" ON "public"."vendor_subscriptions"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "public"."vendor_subscriptions" ADD CONSTRAINT "vendor_subscriptions_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."subscription_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_subscriptions" ADD CONSTRAINT "vendor_subscriptions_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "public"."subscription_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."subscription_package_features" ADD CONSTRAINT "subscription_package_features_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."subscription_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."subscription_package_features" ADD CONSTRAINT "subscription_package_features_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "public"."subscription_features"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."subscription_package_prices" ADD CONSTRAINT "subscription_package_prices_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."subscription_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."subscription_package_prices" ADD CONSTRAINT "subscription_package_prices_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "public"."subscription_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_subscription_events" ADD CONSTRAINT "vendor_subscription_events_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "public"."vendor_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_subscription_offers" ADD CONSTRAINT "vendor_subscription_offers_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_subscription_offers" ADD CONSTRAINT "vendor_subscription_offers_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."subscription_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_subscription_offers" ADD CONSTRAINT "vendor_subscription_offers_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "public"."subscription_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_subscription_offers" ADD CONSTRAINT "vendor_subscription_offers_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "public"."subscription_features"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."subscription_payments" ADD CONSTRAINT "subscription_payments_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."subscription_payments" ADD CONSTRAINT "subscription_payments_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."subscription_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."subscription_payments" ADD CONSTRAINT "subscription_payments_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "public"."subscription_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_feature_usage" ADD CONSTRAINT "vendor_feature_usage_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_feature_usage" ADD CONSTRAINT "vendor_feature_usage_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "public"."subscription_features"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_payout_rules" ADD CONSTRAINT "vendor_payout_rules_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payout_batch_items" ADD CONSTRAINT "payout_batch_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."payout_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payout_batch_items" ADD CONSTRAINT "payout_batch_items_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ── Value guards Prisma can't express ────────────────────────────────────────
ALTER TABLE "public"."subscription_cycles" ADD CONSTRAINT "subscription_cycles_months_chk" CHECK ("months" > 0 AND "months" <= 120);
ALTER TABLE "public"."subscription_package_prices" ADD CONSTRAINT "subscription_package_prices_values_chk" CHECK (
  "price" >= 0 AND ("promoPrice" IS NULL OR ("promoPrice" >= 0 AND "promoPrice" <= "price")) AND
  ("discountPercent" IS NULL OR ("discountPercent" >= 0 AND "discountPercent" <= 100))
);
ALTER TABLE "public"."vendor_subscription_offers" ADD CONSTRAINT "vendor_subscription_offers_values_chk" CHECK (
  "endsAt" > "startsAt" AND ("value" IS NULL OR "value" >= 0) AND
  ("kind" <> 'PERCENT_DISCOUNT' OR ("value" IS NOT NULL AND "value" <= 100)) AND
  ("kind" <> 'FREE_FEATURE' OR "featureId" IS NOT NULL) AND
  ("kind" = 'FREE_FEATURE' OR "packageId" IS NOT NULL)
);
ALTER TABLE "public"."subscription_payments" ADD CONSTRAINT "subscription_payments_values_chk" CHECK ("amount" >= 0 AND "listAmount" >= 0);
ALTER TABLE "public"."vendor_feature_usage" ADD CONSTRAINT "vendor_feature_usage_used_chk" CHECK ("used" >= 0);
ALTER TABLE "public"."vendor_payout_rules" ADD CONSTRAINT "vendor_payout_rules_values_chk" CHECK (
  ("weekday" IS NULL OR ("weekday" >= 0 AND "weekday" <= 6)) AND
  ("minThreshold" IS NULL OR "minThreshold" >= 0) AND
  ("settlementDelayDays" IS NULL OR ("settlementDelayDays" >= 0 AND "settlementDelayDays" <= 365)) AND
  ("customIntervalDays" IS NULL OR ("customIntervalDays" >= 1 AND "customIntervalDays" <= 365))
);
ALTER TABLE "public"."payout_batch_items" ADD CONSTRAINT "payout_batch_items_amount_chk" CHECK ("amount" > 0);
ALTER TABLE "public"."payout_batch_items" ADD CONSTRAINT "payout_batch_items_paid_chk" CHECK ("status" <> 'PAID' OR ("paidAt" IS NOT NULL AND "reference" IS NOT NULL));
