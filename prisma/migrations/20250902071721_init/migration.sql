-- AlterTable
ALTER TABLE "public"."specification_options" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "public"."product_attribute_settings" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "isVariant" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "product_attribute_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_attribute_settings_productId_attributeId_key" ON "public"."product_attribute_settings"("productId", "attributeId");

-- AddForeignKey
ALTER TABLE "public"."product_attribute_settings" ADD CONSTRAINT "product_attribute_settings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_attribute_settings" ADD CONSTRAINT "product_attribute_settings_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "public"."attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
