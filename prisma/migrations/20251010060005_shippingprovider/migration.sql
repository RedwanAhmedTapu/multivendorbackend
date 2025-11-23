/*
  Warnings:

  - You are about to drop the column `category` on the `offers` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "public"."OfferStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ACTIVE', 'EXPIRED');

-- AlterTable
ALTER TABLE "public"."offer_products" ADD COLUMN     "discountValue" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "public"."offers" DROP COLUMN "category",
ADD COLUMN     "status" "public"."OfferStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "public"."BuyXGetYOffer" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "buyProductId" TEXT NOT NULL,
    "getProductId" TEXT NOT NULL,
    "buyQuantity" INTEGER NOT NULL DEFAULT 1,
    "getQuantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BuyXGetYOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OfferStackRule" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "canCombineWithOtherOffers" BOOLEAN NOT NULL DEFAULT false,
    "maxStackCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OfferStackRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuyXGetYOffer_offerId_key" ON "public"."BuyXGetYOffer"("offerId");

-- AddForeignKey
ALTER TABLE "public"."BuyXGetYOffer" ADD CONSTRAINT "BuyXGetYOffer_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "public"."offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuyXGetYOffer" ADD CONSTRAINT "BuyXGetYOffer_buyProductId_fkey" FOREIGN KEY ("buyProductId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuyXGetYOffer" ADD CONSTRAINT "BuyXGetYOffer_getProductId_fkey" FOREIGN KEY ("getProductId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OfferStackRule" ADD CONSTRAINT "OfferStackRule_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "public"."offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
