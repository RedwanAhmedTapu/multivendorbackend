/*
  Warnings:

  - The values [FREE_SHIPPING,BUY_X_GET_Y] on the enum `DiscountType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "public"."DiscountType_new" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
ALTER TABLE "public"."offers" ALTER COLUMN "discountType" TYPE "public"."DiscountType_new" USING ("discountType"::text::"public"."DiscountType_new");
ALTER TYPE "public"."DiscountType" RENAME TO "DiscountType_old";
ALTER TYPE "public"."DiscountType_new" RENAME TO "DiscountType";
DROP TYPE "public"."DiscountType_old";
COMMIT;

-- AlterEnum
ALTER TYPE "public"."OfferStatus" ADD VALUE 'PAUSED';

-- DropEnum
DROP TYPE "public"."OfferCategoryType";
