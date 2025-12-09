/*
  Warnings:

  - You are about to drop the column `isForVariant` on the `category_attributes` table. All the data in the column will be lost.
  - You are about to drop the `ProductImage` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `category_specifications` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `product_attribute_settings` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `product_specification_values` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `specification_options` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `specifications` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[attributeId,value]` on the table `attribute_values` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "public"."ProductImage" DROP CONSTRAINT "ProductImage_productId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ProductImage" DROP CONSTRAINT "ProductImage_variantId_fkey";

-- DropForeignKey
ALTER TABLE "public"."category_specifications" DROP CONSTRAINT "category_specifications_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "public"."category_specifications" DROP CONSTRAINT "category_specifications_specificationId_fkey";

-- DropForeignKey
ALTER TABLE "public"."product_attribute_settings" DROP CONSTRAINT "product_attribute_settings_attributeId_fkey";

-- DropForeignKey
ALTER TABLE "public"."product_attribute_settings" DROP CONSTRAINT "product_attribute_settings_productId_fkey";

-- DropForeignKey
ALTER TABLE "public"."product_specification_values" DROP CONSTRAINT "product_specification_values_productId_fkey";

-- DropForeignKey
ALTER TABLE "public"."product_specification_values" DROP CONSTRAINT "product_specification_values_specificationId_fkey";

-- DropForeignKey
ALTER TABLE "public"."specification_options" DROP CONSTRAINT "specification_options_specificationId_fkey";

-- AlterTable
ALTER TABLE "public"."attributes" ADD COLUMN     "unit" TEXT;

-- AlterTable
ALTER TABLE "public"."category_attributes" DROP COLUMN "isForVariant",
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "public"."ProductImage";

-- DropTable
DROP TABLE "public"."category_specifications";

-- DropTable
DROP TABLE "public"."product_attribute_settings";

-- DropTable
DROP TABLE "public"."product_specification_values";

-- DropTable
DROP TABLE "public"."specification_options";

-- DropTable
DROP TABLE "public"."specifications";

-- CreateTable
CREATE TABLE "public"."product_attributes" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "isForVariant" BOOLEAN NOT NULL DEFAULT false,
    "valueString" TEXT,
    "valueNumber" DOUBLE PRECISION,
    "valueBoolean" BOOLEAN,
    "attributeValueId" TEXT,

    CONSTRAINT "product_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."product_images" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "url" TEXT NOT NULL,
    "altText" TEXT,
    "sortOrder" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."themes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "layoutType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "themes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_attributes_productId_isForVariant_idx" ON "public"."product_attributes"("productId", "isForVariant");

-- CreateIndex
CREATE UNIQUE INDEX "product_attributes_productId_attributeId_key" ON "public"."product_attributes"("productId", "attributeId");

-- CreateIndex
CREATE UNIQUE INDEX "theme_layout_type_unique" ON "public"."themes"("layoutType");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_values_attributeId_value_key" ON "public"."attribute_values"("attributeId", "value");

-- CreateIndex
CREATE INDEX "category_attributes_categoryId_sortOrder_idx" ON "public"."category_attributes"("categoryId", "sortOrder");

-- AddForeignKey
ALTER TABLE "public"."product_attributes" ADD CONSTRAINT "product_attributes_attributeValueId_fkey" FOREIGN KEY ("attributeValueId") REFERENCES "public"."attribute_values"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_attributes" ADD CONSTRAINT "product_attributes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_attributes" ADD CONSTRAINT "product_attributes_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "public"."attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_images" ADD CONSTRAINT "product_images_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "public"."product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
