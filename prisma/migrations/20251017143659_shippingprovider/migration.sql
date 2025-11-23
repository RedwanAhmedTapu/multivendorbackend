-- AlterTable
ALTER TABLE "public"."offer_permissions" ADD COLUMN     "canCreateBundleDeal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canCreateBuyXGetY" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canCreateFreeShipping" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canCreateLoyaltyReward" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canCreateReferralBonus" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canCreateSeasonalSale" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxBundleItems" INTEGER,
ADD COLUMN     "maxFlashSaleDuration" INTEGER,
ADD COLUMN     "maxVouchersPerOffer" INTEGER,
ALTER COLUMN "maxActiveOffers" SET DEFAULT 10,
ALTER COLUMN "maxDiscountAmount" SET DEFAULT 500,
ALTER COLUMN "requiresApproval" SET DEFAULT true;
