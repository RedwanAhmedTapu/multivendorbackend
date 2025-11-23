/*
  Warnings:

  - You are about to drop the column `country` on the `vendor_addresses` table. All the data in the column will be lost.
  - You are about to drop the column `district` on the `vendor_addresses` table. All the data in the column will be lost.
  - You are about to drop the column `postalCode` on the `vendor_addresses` table. All the data in the column will be lost.
  - You are about to drop the column `region` on the `vendor_addresses` table. All the data in the column will be lost.
  - You are about to drop the column `streetAddress` on the `vendor_addresses` table. All the data in the column will be lost.
  - Added the required column `detailsAddress` to the `vendor_addresses` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."vendor_addresses" DROP COLUMN "country",
DROP COLUMN "district",
DROP COLUMN "postalCode",
DROP COLUMN "region",
DROP COLUMN "streetAddress",
ADD COLUMN     "area" TEXT,
ADD COLUMN     "detailsAddress" TEXT NOT NULL,
ADD COLUMN     "zone" TEXT,
ALTER COLUMN "city" DROP NOT NULL;
