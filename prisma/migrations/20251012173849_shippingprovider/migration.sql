/*
  Warnings:

  - The values [NATIONAL_ID,PASSPORT,DRIVING_LICENSE] on the enum `DocumentType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `idDocumentComplete` on the `vendor_onboarding_checklist` table. All the data in the column will be lost.
  - You are about to drop the column `firstName` on the `vendor_personal_info` table. All the data in the column will be lost.
  - You are about to drop the column `lastName` on the `vendor_personal_info` table. All the data in the column will be lost.
  - You are about to drop the column `primaryEmail` on the `vendor_personal_info` table. All the data in the column will be lost.
  - You are about to drop the column `primaryPhone` on the `vendor_personal_info` table. All the data in the column will be lost.
  - You are about to drop the column `sellerType` on the `vendors` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "public"."AccountType" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- AlterEnum
BEGIN;
CREATE TYPE "public"."DocumentType_new" AS ENUM ('NATIONAL_ID_FRONT', 'NATIONAL_ID_BACK', 'PASSPORT_FRONT', 'PASSPORT_BACK', 'BUSINESS_REGISTRATION');
ALTER TABLE "public"."vendor_documents" ALTER COLUMN "type" TYPE "public"."DocumentType_new" USING ("type"::text::"public"."DocumentType_new");
ALTER TYPE "public"."DocumentType" RENAME TO "DocumentType_old";
ALTER TYPE "public"."DocumentType_new" RENAME TO "DocumentType";
DROP TYPE "public"."DocumentType_old";
COMMIT;

-- AlterTable
ALTER TABLE "public"."vendor_onboarding_checklist" DROP COLUMN "idDocumentComplete",
ADD COLUMN     "documentsComplete" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "public"."vendor_personal_info" DROP COLUMN "firstName",
DROP COLUMN "lastName",
DROP COLUMN "primaryEmail",
DROP COLUMN "primaryPhone",
ADD COLUMN     "businessRegNo" TEXT,
ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "idName" TEXT,
ADD COLUMN     "idNumber" TEXT,
ADD COLUMN     "taxIdNumber" TEXT;

-- AlterTable
ALTER TABLE "public"."vendors" DROP COLUMN "sellerType",
ADD COLUMN     "accountType" "public"."AccountType" NOT NULL DEFAULT 'INDIVIDUAL';

-- DropEnum
DROP TYPE "public"."SellerType";
