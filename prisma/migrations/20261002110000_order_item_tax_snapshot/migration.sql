-- AlterTable (additive, nullable — legacy rows stay NULL, no data loss)
ALTER TABLE "order_items" ADD COLUMN "taxRate" DECIMAL(18,4);
ALTER TABLE "order_items" ADD COLUMN "taxAmount" DECIMAL(18,4);
ALTER TABLE "order_items" ADD COLUMN "taxTreatment" TEXT;
