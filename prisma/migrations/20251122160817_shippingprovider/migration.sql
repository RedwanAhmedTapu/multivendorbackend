/*
  Warnings:

  - You are about to drop the column `effectiveFrom` on the `vendor_commissions` table. All the data in the column will be lost.
  - You are about to drop the column `effectiveTo` on the `vendor_commissions` table. All the data in the column will be lost.
  - You are about to drop the column `note` on the `vendor_commissions` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."vendor_commissions" DROP COLUMN "effectiveFrom",
DROP COLUMN "effectiveTo",
DROP COLUMN "note";
