/*
  Warnings:

  - The values [BUSINESS_REGISTRATION] on the enum `DocumentType` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "public"."BusinessType" AS ENUM ('PROPRIETORSHIP', 'LIMITED_COMPANY', 'PARTNERSHIP_FIRM');

-- AlterEnum
BEGIN;
CREATE TYPE "public"."DocumentType_new" AS ENUM ('NATIONAL_ID_FRONT', 'NATIONAL_ID_BACK', 'PASSPORT_FRONT', 'PASSPORT_BACK', 'TRADE_LICENSE', 'RJSC_REGISTRATION', 'TIN_CERTIFICATE', 'VAT_CERTIFICATE', 'OTHER');
ALTER TABLE "public"."vendor_documents" ALTER COLUMN "type" TYPE "public"."DocumentType_new" USING ("type"::text::"public"."DocumentType_new");
ALTER TYPE "public"."DocumentType" RENAME TO "DocumentType_old";
ALTER TYPE "public"."DocumentType_new" RENAME TO "DocumentType";
DROP TYPE "public"."DocumentType_old";
COMMIT;

-- DropIndex
DROP INDEX "public"."vendor_documents_vendorId_key";

-- AlterTable
ALTER TABLE "public"."vendors" ADD COLUMN     "businessType" "public"."BusinessType";

-- CreateIndex
CREATE INDEX "vendor_documents_vendorId_idx" ON "public"."vendor_documents"("vendorId");
