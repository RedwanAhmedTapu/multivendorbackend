/*
  Warnings:

  - You are about to drop the column `weight` on the `product_variants` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."product_variants" DROP COLUMN "weight";

-- AlterTable
ALTER TABLE "public"."products" ADD COLUMN     "nameBn" TEXT;
