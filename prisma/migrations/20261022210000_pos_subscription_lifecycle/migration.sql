-- PROPOSED — NOT APPLIED. POS subscription lifecycle + session attribution (additive only).
-- Requires 20261022200000_pos_baseline (or an equivalent existing pos_* schema).
-- New: PosPlan, PosSubscriptionPeriod, PosTrialGrant, PosSubscriptionPayment, 3 enums;
-- pos_subscriptions gains source/planId/suspension/version/reminder columns (existing
-- rows become source=LEGACY by default); pos_sale_items gains refundedQty (default 0);
-- pos_sales gains soldByUserId / soldByEmployeeId (nullable; legacy staffId kept).
-- No DROP, no type change, no data rewrite; pos_staff rows are untouched.
-- Generated offline with prisma migrate diff (no database contacted).

-- CreateEnum
CREATE TYPE "public"."PosSubscriptionSource" AS ENUM ('TRIAL', 'PAID', 'COMPLIMENTARY', 'LEGACY');

-- CreateEnum
CREATE TYPE "public"."PosPeriodKind" AS ENUM ('TRIAL', 'PAYMENT', 'GRANT', 'EXTEND', 'REVOKE', 'SUSPEND', 'RESTORE', 'LEGACY_BACKFILL', 'EXPIRE');

-- CreateEnum
CREATE TYPE "public"."PosSubPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED');

-- AlterTable
ALTER TABLE "public"."pos_sales" ADD COLUMN     "soldByEmployeeId" TEXT,
ADD COLUMN     "soldByUserId" TEXT;

-- AlterTable
ALTER TABLE "public"."pos_sale_items" ADD COLUMN     "refundedQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."pos_subscriptions" ADD COLUMN     "planId" TEXT,
ADD COLUMN     "reminderSentFor" TIMESTAMP(3),
ADD COLUMN     "source" "public"."PosSubscriptionSource" NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedReason" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."pos_plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "durationDays" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."pos_subscription_periods" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" "public"."PosPeriodKind" NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT,
    "previousExpiresAt" TIMESTAMP(3),
    "newExpiresAt" TIMESTAMP(3),
    "planId" TEXT,
    "paymentId" TEXT,
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "reason" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_subscription_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."pos_trial_grants" (
    "vendorId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "days" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,

    CONSTRAINT "pos_trial_grants_pkey" PRIMARY KEY ("vendorId")
);

-- CreateTable
CREATE TABLE "public"."pos_subscription_payments" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "durationDays" INTEGER NOT NULL,
    "status" "public"."PosSubPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "gateway" TEXT NOT NULL,
    "paymentProviderId" TEXT,
    "tranId" TEXT NOT NULL,
    "gatewayRef" TEXT,
    "initiatedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "verification" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_plans_code_key" ON "public"."pos_plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "pos_subscription_periods_paymentId_key" ON "public"."pos_subscription_periods"("paymentId");

-- CreateIndex
CREATE INDEX "pos_subscription_periods_vendorId_createdAt_idx" ON "public"."pos_subscription_periods"("vendorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "pos_subscription_payments_tranId_key" ON "public"."pos_subscription_payments"("tranId");

-- CreateIndex
CREATE INDEX "pos_subscription_payments_vendorId_createdAt_idx" ON "public"."pos_subscription_payments"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "pos_subscription_payments_status_createdAt_idx" ON "public"."pos_subscription_payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "pos_sales_vendorId_soldByEmployeeId_idx" ON "public"."pos_sales"("vendorId", "soldByEmployeeId");

-- AddForeignKey
ALTER TABLE "public"."pos_subscriptions" ADD CONSTRAINT "pos_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."pos_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pos_subscription_periods" ADD CONSTRAINT "pos_subscription_periods_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "public"."pos_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pos_trial_grants" ADD CONSTRAINT "pos_trial_grants_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pos_subscription_payments" ADD CONSTRAINT "pos_subscription_payments_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pos_subscription_payments" ADD CONSTRAINT "pos_subscription_payments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."pos_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

