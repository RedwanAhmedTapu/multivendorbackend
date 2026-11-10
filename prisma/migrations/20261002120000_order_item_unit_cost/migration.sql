-- AlterTable (additive, nullable - legacy rows stay NULL)
ALTER TABLE "order_items" ADD COLUMN "unitCost" DECIMAL(18,4);
