/*
  Warnings:

  - You are about to drop the column `metadata` on the `audit_logs` table. All the data in the column will be lost.
  - You are about to drop the column `employeeId` on the `users` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[email]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[phone]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - Made the column `entityId` on table `audit_logs` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "public"."SellerType" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "public"."VerificationStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "public"."DocumentType" AS ENUM ('NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENSE');

-- CreateEnum
CREATE TYPE "public"."DocumentVerificationStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."SubscriptionPlan" AS ENUM ('FREE', 'BASIC', 'PREMIUM', 'ENTERPRISE');

-- DropForeignKey
ALTER TABLE "public"."audit_logs" DROP CONSTRAINT "audit_logs_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."offers" DROP CONSTRAINT "offers_createdByVendorId_fkey";

-- DropIndex
DROP INDEX "public"."conversation_participants_conversationId_lastReadAt_idx";

-- DropIndex
DROP INDEX "public"."conversation_participants_userId_lastReadAt_idx";

-- DropIndex
DROP INDEX "public"."conversation_participants_vendorId_lastReadAt_idx";

-- DropIndex
DROP INDEX "public"."offer_usage_offerId_userId_idx";

-- DropIndex
DROP INDEX "public"."offer_usage_usedAt_idx";

-- DropIndex
DROP INDEX "public"."offers_createdByVendorId_isActive_idx";

-- DropIndex
DROP INDEX "public"."offers_type_isActive_validFrom_validTo_idx";

-- DropIndex
DROP INDEX "public"."offers_validFrom_validTo_isActive_idx";

-- DropIndex
DROP INDEX "public"."products_vendorId_idx";

-- DropIndex
DROP INDEX "public"."users_email_phone_key";

-- DropIndex
DROP INDEX "public"."vendor_offers_vendorId_idx";

-- DropIndex
DROP INDEX "public"."vendor_payouts_vendorId_idx";

-- DropIndex
DROP INDEX "public"."voucher_offers_code_idx";

-- AlterTable
ALTER TABLE "public"."attribute_values" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."attributes" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."audit_logs" DROP COLUMN "metadata",
ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "newData" JSONB,
ADD COLUMN     "oldData" JSONB,
ADD COLUMN     "userAgent" TEXT,
ALTER COLUMN "entityId" SET NOT NULL;

-- AlterTable
ALTER TABLE "public"."product_variants" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."specification_options" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."users" DROP COLUMN "employeeId";

-- AlterTable
ALTER TABLE "public"."vendors" ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "sellerType" "public"."SellerType" NOT NULL DEFAULT 'INDIVIDUAL',
ADD COLUMN     "verificationStatus" "public"."VerificationStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "public"."vendor_personal_info" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "primaryPhone" TEXT NOT NULL,
    "primaryEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_personal_info_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_addresses" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "streetAddress" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "district" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'Bangladesh',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_bank_info" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_bank_info_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_documents" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "public"."DocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "verificationStatus" "public"."DocumentVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_settings" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_subscriptions" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "planType" "public"."SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_onboarding_checklist" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "personalInfoComplete" BOOLEAN NOT NULL DEFAULT false,
    "addressComplete" BOOLEAN NOT NULL DEFAULT false,
    "bankInfoComplete" BOOLEAN NOT NULL DEFAULT false,
    "idDocumentComplete" BOOLEAN NOT NULL DEFAULT false,
    "overallComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_onboarding_checklist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_personal_info_vendorId_key" ON "public"."vendor_personal_info"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_addresses_vendorId_key" ON "public"."vendor_addresses"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_bank_info_vendorId_key" ON "public"."vendor_bank_info"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_documents_vendorId_key" ON "public"."vendor_documents"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_settings_vendorId_key" ON "public"."vendor_settings"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_subscriptions_vendorId_key" ON "public"."vendor_subscriptions"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_onboarding_checklist_vendorId_key" ON "public"."vendor_onboarding_checklist"("vendorId");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entityId_idx" ON "public"."audit_logs"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "public"."audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "public"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "public"."users"("phone");

-- AddForeignKey
ALTER TABLE "public"."audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_personal_info" ADD CONSTRAINT "vendor_personal_info_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_addresses" ADD CONSTRAINT "vendor_addresses_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_bank_info" ADD CONSTRAINT "vendor_bank_info_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_documents" ADD CONSTRAINT "vendor_documents_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_settings" ADD CONSTRAINT "vendor_settings_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_subscriptions" ADD CONSTRAINT "vendor_subscriptions_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_onboarding_checklist" ADD CONSTRAINT "vendor_onboarding_checklist_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."offers" ADD CONSTRAINT "offers_createdByVendorId_fkey" FOREIGN KEY ("createdByVendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
