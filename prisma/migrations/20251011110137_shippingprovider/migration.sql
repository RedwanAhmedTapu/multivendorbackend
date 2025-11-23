/*
  Warnings:

  - You are about to drop the `vendor_offers` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[vendorId,categoryId]` on the table `vendor_commissions` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "public"."vendor_offers" DROP CONSTRAINT "vendor_offers_vendorId_fkey";

-- AlterTable
ALTER TABLE "public"."vendor_commissions" ADD COLUMN     "categoryId" TEXT;

-- DropTable
DROP TABLE "public"."vendor_offers";

-- CreateIndex
CREATE UNIQUE INDEX "vendor_commissions_vendorId_categoryId_key" ON "public"."vendor_commissions"("vendorId", "categoryId");

-- AddForeignKey
ALTER TABLE "public"."vendor_commissions" ADD CONSTRAINT "vendor_commissions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
