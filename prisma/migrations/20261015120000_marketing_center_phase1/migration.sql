-- Marketing Center — Phase 1 (schema only).
--
-- NOT APPLIED. Generated offline with `prisma migrate diff` (schema → schema,
-- no database contacted). Deployment order:
--   1. back up the database;
--   2. apply this migration (prisma migrate deploy) — requires PostgreSQL 12+
--      (ALTER TYPE ... ADD VALUE inside the migration transaction);
--   3. regenerate the Prisma client and deploy the build that contains it.
--      A client generated from the new schema no longer knows `advertisements`
--      and selects the new nullable columns, so step 2 must come first.
--
-- What it does:
--   - creates the Marketing Center tables (campaigns, flash sale, promotions,
--     coins settings, paid ads + ad wallet, per-order discount breakdown);
--   - adds nullable columns: order_items.listPrice / priceSource,
--     loyalty_transactions.orderId / idempotencyKey (unique) / balanceAfter
--     (existing rows get NULL; NULLs never collide on the unique index);
--   - adds EventType values PROMOTION_SUBSIDY, AD_WALLET_TOPUP, AD_SPEND;
--   - replaces the unused `advertisements` table — guarded below: the
--     migration ABORTS (and rolls back) if that table has any rows;
--   - adds CHECK constraints for money / stock invariants (end of file).

-- Guard: never drop advertisement data. Abort unless the table is empty.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."advertisements" LIMIT 1) THEN
    RAISE EXCEPTION 'advertisements has rows — migrate or export them before running 20261015120000_marketing_center_phase1';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "public"."MarketingCampaignStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."MarketingReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "public"."CampaignInviteStatus" AS ENUM ('INVITED', 'ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "public"."FlashSaleSlotStatus" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."PromotionType" AS ENUM ('REGULAR_VOUCHER', 'OTHER_VOUCHER', 'FLEXI_COMBO', 'FREE_SHIPPING');

-- CreateEnum
CREATE TYPE "public"."PromotionChannel" AS ENUM ('LIVE_STREAM', 'EXTERNAL_SHARE');

-- CreateEnum
CREATE TYPE "public"."PromotionDiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "public"."PromotionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."PromotionScope" AS ENUM ('STORE', 'PRODUCTS');

-- CreateEnum
CREATE TYPE "public"."PromotionRedemptionStatus" AS ENUM ('APPLIED', 'REVERSED');

-- CreateEnum
CREATE TYPE "public"."AdWalletTxnType" AS ENUM ('TOPUP', 'AD_SPEND', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "public"."AdTopupStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."AdCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'OUT_OF_BUDGET', 'ENDED');

-- CreateEnum
CREATE TYPE "public"."DiscountSource" AS ENUM ('CAMPAIGN', 'FLASH_SALE', 'VOUCHER', 'FLEXI_COMBO', 'FREE_SHIPPING', 'COINS');

-- CreateEnum
CREATE TYPE "public"."DiscountLedgerStatus" AS ENUM ('PENDING', 'POSTED', 'PARTIALLY_REVERSED', 'REVERSED');

-- CreateEnum
CREATE TYPE "public"."ItemPriceSource" AS ENUM ('REGULAR', 'SPECIAL', 'CAMPAIGN', 'FLASH_SALE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."EventType" ADD VALUE 'PROMOTION_SUBSIDY';
ALTER TYPE "public"."EventType" ADD VALUE 'AD_WALLET_TOPUP';
ALTER TYPE "public"."EventType" ADD VALUE 'AD_SPEND';

-- DropForeignKey
ALTER TABLE "public"."advertisements" DROP CONSTRAINT "advertisements_vendorId_fkey";

-- AlterTable
ALTER TABLE "public"."order_items" ADD COLUMN     "listPrice" DECIMAL(18,4),
ADD COLUMN     "priceSource" "public"."ItemPriceSource";

-- AlterTable
ALTER TABLE "public"."loyalty_transactions" ADD COLUMN     "balanceAfter" INTEGER,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "orderId" TEXT;

-- DropTable
DROP TABLE "public"."advertisements";

-- CreateTable
CREATE TABLE "public"."marketing_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "bannerImage" TEXT,
    "registrationStartAt" TIMESTAMP(3) NOT NULL,
    "registrationEndAt" TIMESTAMP(3) NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "public"."MarketingCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "minDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "minStock" INTEGER NOT NULL DEFAULT 0,
    "maxProductsPerVendor" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."marketing_campaign_categories" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,

    CONSTRAINT "marketing_campaign_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."marketing_campaign_invites" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "maxProducts" INTEGER,
    "status" "public"."CampaignInviteStatus" NOT NULL DEFAULT 'INVITED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_campaign_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."campaign_registrations" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "campaignPrice" DECIMAL(18,4) NOT NULL,
    "originalPrice" DECIMAL(18,4) NOT NULL,
    "committedStock" INTEGER NOT NULL,
    "status" "public"."MarketingReviewStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."flash_sale_slots" (
    "id" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "categoryId" TEXT,
    "status" "public"."FlashSaleSlotStatus" NOT NULL DEFAULT 'SCHEDULED',
    "maxItems" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flash_sale_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."flash_sale_items" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "flashPrice" DECIMAL(18,4) NOT NULL,
    "originalPrice" DECIMAL(18,4) NOT NULL,
    "stockLimit" INTEGER NOT NULL,
    "soldQty" INTEGER NOT NULL DEFAULT 0,
    "status" "public"."MarketingReviewStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flash_sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promotions" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "public"."PromotionType" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "channel" "public"."PromotionChannel",
    "discountType" "public"."PromotionDiscountType",
    "discountValue" DECIMAL(18,4),
    "maxDiscount" DECIMAL(18,4),
    "minSpend" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "usageLimitTotal" INTEGER,
    "usageLimitPerUser" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "scope" "public"."PromotionScope" NOT NULL DEFAULT 'STORE',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "public"."PromotionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promotion_products" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "promotion_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."flexi_combo_tiers" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "minQuantity" INTEGER,
    "minAmount" DECIMAL(18,4),
    "discountType" "public"."PromotionDiscountType" NOT NULL,
    "discountValue" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "flexi_combo_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promotion_redemptions" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "vendorOrderId" TEXT,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "public"."PromotionRedemptionStatus" NOT NULL DEFAULT 'APPLIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "promotion_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_coins_settings" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "ratePercent" INTEGER NOT NULL DEFAULT 0,
    "pendingRatePercent" INTEGER,
    "pendingEffectiveAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_coins_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_coins_setting_history" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fromRate" INTEGER NOT NULL,
    "toRate" INTEGER NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "requestedById" TEXT,

    CONSTRAINT "vendor_coins_setting_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."coins_funding_rules" (
    "id" TEXT NOT NULL,
    "ratePercent" INTEGER NOT NULL,
    "sellerSharePercent" DECIMAL(5,2) NOT NULL,
    "platformSharePercent" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coins_funding_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_ad_wallets" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_ad_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_ad_wallet_txns" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "public"."AdWalletTxnType" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "balanceAfter" DECIMAL(18,4) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "adTopupPaymentId" TEXT,
    "adCampaignId" TEXT,
    "adClickId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_ad_wallet_txns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ad_topup_payments" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "gateway" TEXT NOT NULL,
    "status" "public"."AdTopupStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" TEXT,
    "gatewayMeta" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_topup_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ad_campaigns" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "public"."AdCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "dailyBudget" DECIMAL(18,4) NOT NULL,
    "bidCpc" DECIMAL(18,4) NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "spentToday" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "spentTodayDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ad_campaign_products" (
    "id" TEXT NOT NULL,
    "adCampaignId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "ad_campaign_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ad_clicks" (
    "id" TEXT NOT NULL,
    "adCampaignId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "viewerKey" TEXT NOT NULL,
    "chargedAmount" DECIMAL(18,4) NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ad_daily_stats" (
    "id" TEXT NOT NULL,
    "adCampaignId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "spend" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "revenue" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "ad_daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."order_item_discounts" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "vendorOrderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "vendorId" TEXT NOT NULL,
    "source" "public"."DiscountSource" NOT NULL,
    "sourceId" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "sellerFunded" DECIMAL(18,4) NOT NULL,
    "platformFunded" DECIMAL(18,4) NOT NULL,
    "reversedAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "ledgerStatus" "public"."DiscountLedgerStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_item_discounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketing_campaigns_slug_key" ON "public"."marketing_campaigns"("slug");

-- CreateIndex
CREATE INDEX "marketing_campaigns_status_startAt_endAt_idx" ON "public"."marketing_campaigns"("status", "startAt", "endAt");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_campaign_categories_campaignId_categoryId_key" ON "public"."marketing_campaign_categories"("campaignId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_campaign_invites_campaignId_vendorId_key" ON "public"."marketing_campaign_invites"("campaignId", "vendorId");

-- CreateIndex
CREATE INDEX "campaign_registrations_vendorId_status_idx" ON "public"."campaign_registrations"("vendorId", "status");

-- CreateIndex
CREATE INDEX "campaign_registrations_campaignId_status_idx" ON "public"."campaign_registrations"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_registrations_campaignId_variantId_key" ON "public"."campaign_registrations"("campaignId", "variantId");

-- CreateIndex
CREATE INDEX "flash_sale_slots_startAt_endAt_idx" ON "public"."flash_sale_slots"("startAt", "endAt");

-- CreateIndex
CREATE INDEX "flash_sale_slots_status_idx" ON "public"."flash_sale_slots"("status");

-- CreateIndex
CREATE INDEX "flash_sale_items_vendorId_status_idx" ON "public"."flash_sale_items"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "flash_sale_items_slotId_variantId_key" ON "public"."flash_sale_items"("slotId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_code_key" ON "public"."promotions"("code");

-- CreateIndex
CREATE INDEX "promotions_vendorId_status_idx" ON "public"."promotions"("vendorId", "status");

-- CreateIndex
CREATE INDEX "promotions_type_status_startAt_endAt_idx" ON "public"."promotions"("type", "status", "startAt", "endAt");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_products_promotionId_productId_key" ON "public"."promotion_products"("promotionId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "flexi_combo_tiers_promotionId_sortOrder_key" ON "public"."flexi_combo_tiers"("promotionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_redemptions_idempotencyKey_key" ON "public"."promotion_redemptions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "promotion_redemptions_promotionId_userId_idx" ON "public"."promotion_redemptions"("promotionId", "userId");

-- CreateIndex
CREATE INDEX "promotion_redemptions_orderId_idx" ON "public"."promotion_redemptions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_coins_settings_vendorId_key" ON "public"."vendor_coins_settings"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_coins_settings_pendingEffectiveAt_idx" ON "public"."vendor_coins_settings"("pendingEffectiveAt");

-- CreateIndex
CREATE INDEX "vendor_coins_setting_history_vendorId_requestedAt_idx" ON "public"."vendor_coins_setting_history"("vendorId", "requestedAt");

-- CreateIndex
CREATE INDEX "coins_funding_rules_ratePercent_isActive_effectiveFrom_idx" ON "public"."coins_funding_rules"("ratePercent", "isActive", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_ad_wallets_vendorId_key" ON "public"."vendor_ad_wallets"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_ad_wallet_txns_idempotencyKey_key" ON "public"."vendor_ad_wallet_txns"("idempotencyKey");

-- CreateIndex
CREATE INDEX "vendor_ad_wallet_txns_vendorId_createdAt_idx" ON "public"."vendor_ad_wallet_txns"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "vendor_ad_wallet_txns_walletId_createdAt_idx" ON "public"."vendor_ad_wallet_txns"("walletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ad_topup_payments_transactionId_key" ON "public"."ad_topup_payments"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "ad_topup_payments_idempotencyKey_key" ON "public"."ad_topup_payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ad_topup_payments_vendorId_status_idx" ON "public"."ad_topup_payments"("vendorId", "status");

-- CreateIndex
CREATE INDEX "ad_campaigns_vendorId_status_idx" ON "public"."ad_campaigns"("vendorId", "status");

-- CreateIndex
CREATE INDEX "ad_campaigns_status_startAt_idx" ON "public"."ad_campaigns"("status", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "ad_campaign_products_adCampaignId_productId_key" ON "public"."ad_campaign_products"("adCampaignId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ad_clicks_dedupeKey_key" ON "public"."ad_clicks"("dedupeKey");

-- CreateIndex
CREATE INDEX "ad_clicks_adCampaignId_createdAt_idx" ON "public"."ad_clicks"("adCampaignId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ad_daily_stats_adCampaignId_productId_date_key" ON "public"."ad_daily_stats"("adCampaignId", "productId", "date");

-- CreateIndex
CREATE INDEX "order_item_discounts_orderId_idx" ON "public"."order_item_discounts"("orderId");

-- CreateIndex
CREATE INDEX "order_item_discounts_vendorOrderId_idx" ON "public"."order_item_discounts"("vendorOrderId");

-- CreateIndex
CREATE INDEX "order_item_discounts_vendorId_ledgerStatus_idx" ON "public"."order_item_discounts"("vendorId", "ledgerStatus");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_transactions_idempotencyKey_key" ON "public"."loyalty_transactions"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "public"."loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."marketing_campaign_categories" ADD CONSTRAINT "marketing_campaign_categories_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."marketing_campaign_categories" ADD CONSTRAINT "marketing_campaign_categories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."marketing_campaign_invites" ADD CONSTRAINT "marketing_campaign_invites_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."marketing_campaign_invites" ADD CONSTRAINT "marketing_campaign_invites_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."campaign_registrations" ADD CONSTRAINT "campaign_registrations_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."campaign_registrations" ADD CONSTRAINT "campaign_registrations_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."campaign_registrations" ADD CONSTRAINT "campaign_registrations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."campaign_registrations" ADD CONSTRAINT "campaign_registrations_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "public"."product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."flash_sale_slots" ADD CONSTRAINT "flash_sale_slots_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."flash_sale_items" ADD CONSTRAINT "flash_sale_items_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "public"."flash_sale_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."flash_sale_items" ADD CONSTRAINT "flash_sale_items_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."flash_sale_items" ADD CONSTRAINT "flash_sale_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."flash_sale_items" ADD CONSTRAINT "flash_sale_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "public"."product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotions" ADD CONSTRAINT "promotions_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_products" ADD CONSTRAINT "promotion_products_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "public"."promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_products" ADD CONSTRAINT "promotion_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."flexi_combo_tiers" ADD CONSTRAINT "flexi_combo_tiers_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "public"."promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "public"."promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "public"."vendor_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_coins_settings" ADD CONSTRAINT "vendor_coins_settings_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_coins_setting_history" ADD CONSTRAINT "vendor_coins_setting_history_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_ad_wallets" ADD CONSTRAINT "vendor_ad_wallets_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_ad_wallet_txns" ADD CONSTRAINT "vendor_ad_wallet_txns_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "public"."vendor_ad_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_ad_wallet_txns" ADD CONSTRAINT "vendor_ad_wallet_txns_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_ad_wallet_txns" ADD CONSTRAINT "vendor_ad_wallet_txns_adTopupPaymentId_fkey" FOREIGN KEY ("adTopupPaymentId") REFERENCES "public"."ad_topup_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_ad_wallet_txns" ADD CONSTRAINT "vendor_ad_wallet_txns_adCampaignId_fkey" FOREIGN KEY ("adCampaignId") REFERENCES "public"."ad_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_ad_wallet_txns" ADD CONSTRAINT "vendor_ad_wallet_txns_adClickId_fkey" FOREIGN KEY ("adClickId") REFERENCES "public"."ad_clicks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ad_topup_payments" ADD CONSTRAINT "ad_topup_payments_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ad_topup_payments" ADD CONSTRAINT "ad_topup_payments_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "public"."vendor_ad_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ad_campaigns" ADD CONSTRAINT "ad_campaigns_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ad_campaign_products" ADD CONSTRAINT "ad_campaign_products_adCampaignId_fkey" FOREIGN KEY ("adCampaignId") REFERENCES "public"."ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ad_campaign_products" ADD CONSTRAINT "ad_campaign_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ad_clicks" ADD CONSTRAINT "ad_clicks_adCampaignId_fkey" FOREIGN KEY ("adCampaignId") REFERENCES "public"."ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ad_clicks" ADD CONSTRAINT "ad_clicks_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ad_clicks" ADD CONSTRAINT "ad_clicks_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ad_daily_stats" ADD CONSTRAINT "ad_daily_stats_adCampaignId_fkey" FOREIGN KEY ("adCampaignId") REFERENCES "public"."ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ad_daily_stats" ADD CONSTRAINT "ad_daily_stats_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."order_item_discounts" ADD CONSTRAINT "order_item_discounts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."order_item_discounts" ADD CONSTRAINT "order_item_discounts_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "public"."vendor_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."order_item_discounts" ADD CONSTRAINT "order_item_discounts_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "public"."order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."order_item_discounts" ADD CONSTRAINT "order_item_discounts_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────────────────────────────────────────────────────────
-- CHECK constraints (Prisma cannot express these; it does not drop them).
-- ───────────────────────────────────────────────────────────────────────────

-- Campaigns
ALTER TABLE "public"."marketing_campaigns"
  ADD CONSTRAINT "marketing_campaigns_windows_chk" CHECK ("registrationStartAt" <= "registrationEndAt" AND "startAt" < "endAt"),
  ADD CONSTRAINT "marketing_campaigns_rules_chk" CHECK ("minDiscountPercent" >= 0 AND "minDiscountPercent" <= 100 AND "minStock" >= 0 AND ("maxProductsPerVendor" IS NULL OR "maxProductsPerVendor" > 0));
ALTER TABLE "public"."campaign_registrations"
  ADD CONSTRAINT "campaign_registrations_price_chk" CHECK ("campaignPrice" > 0 AND "originalPrice" > 0 AND "campaignPrice" <= "originalPrice"),
  ADD CONSTRAINT "campaign_registrations_stock_chk" CHECK ("committedStock" >= 0);

-- Flash sale
ALTER TABLE "public"."flash_sale_slots"
  ADD CONSTRAINT "flash_sale_slots_window_chk" CHECK ("startAt" < "endAt" AND ("maxItems" IS NULL OR "maxItems" > 0));
ALTER TABLE "public"."flash_sale_items"
  ADD CONSTRAINT "flash_sale_items_price_chk" CHECK ("flashPrice" > 0 AND "originalPrice" > 0 AND "flashPrice" <= "originalPrice"),
  ADD CONSTRAINT "flash_sale_items_stock_chk" CHECK ("stockLimit" > 0 AND "soldQty" >= 0 AND "soldQty" <= "stockLimit");

-- Promotions
ALTER TABLE "public"."promotions"
  ADD CONSTRAINT "promotions_window_chk" CHECK ("startAt" < "endAt"),
  ADD CONSTRAINT "promotions_amounts_chk" CHECK ("minSpend" >= 0 AND "usedCount" >= 0
    AND ("discountValue" IS NULL OR "discountValue" >= 0)
    AND ("maxDiscount" IS NULL OR "maxDiscount" >= 0)
    AND ("discountType" IS DISTINCT FROM 'PERCENT' OR "discountValue" <= 100)
    AND ("usageLimitTotal" IS NULL OR "usageLimitTotal" > 0)
    AND ("usageLimitPerUser" IS NULL OR "usageLimitPerUser" > 0));
ALTER TABLE "public"."flexi_combo_tiers"
  ADD CONSTRAINT "flexi_combo_tiers_chk" CHECK ("discountValue" > 0
    AND ("discountType" <> 'PERCENT' OR "discountValue" <= 100)
    AND ("minQuantity" IS NOT NULL OR "minAmount" IS NOT NULL)
    AND ("minQuantity" IS NULL OR "minQuantity" > 0)
    AND ("minAmount" IS NULL OR "minAmount" > 0));
ALTER TABLE "public"."promotion_redemptions"
  ADD CONSTRAINT "promotion_redemptions_amount_chk" CHECK ("amount" >= 0);

-- Coins
ALTER TABLE "public"."vendor_coins_settings"
  ADD CONSTRAINT "vendor_coins_settings_rate_chk" CHECK ("ratePercent" IN (0, 3, 5, 7) AND ("pendingRatePercent" IS NULL OR "pendingRatePercent" IN (0, 3, 5, 7)));
ALTER TABLE "public"."vendor_coins_setting_history"
  ADD CONSTRAINT "vendor_coins_setting_history_rate_chk" CHECK ("fromRate" IN (0, 3, 5, 7) AND "toRate" IN (0, 3, 5, 7));
ALTER TABLE "public"."coins_funding_rules"
  ADD CONSTRAINT "coins_funding_rules_chk" CHECK ("ratePercent" IN (3, 5, 7)
    AND "sellerSharePercent" >= 0 AND "platformSharePercent" >= 0
    AND "sellerSharePercent" + "platformSharePercent" = 100);
ALTER TABLE "public"."loyalty_transactions"
  ADD CONSTRAINT "loyalty_transactions_balance_after_chk" CHECK ("balanceAfter" IS NULL OR "balanceAfter" >= 0);

-- Paid ads: the wallet can never go below zero
ALTER TABLE "public"."vendor_ad_wallets"
  ADD CONSTRAINT "vendor_ad_wallets_balance_chk" CHECK ("balance" >= 0);
ALTER TABLE "public"."vendor_ad_wallet_txns"
  ADD CONSTRAINT "vendor_ad_wallet_txns_amount_chk" CHECK ("amount" > 0 AND "balanceAfter" >= 0);
ALTER TABLE "public"."ad_topup_payments"
  ADD CONSTRAINT "ad_topup_payments_amount_chk" CHECK ("amount" > 0);
ALTER TABLE "public"."ad_campaigns"
  ADD CONSTRAINT "ad_campaigns_money_chk" CHECK ("dailyBudget" > 0 AND "bidCpc" > 0 AND "spentToday" >= 0 AND ("endAt" IS NULL OR "startAt" < "endAt"));
ALTER TABLE "public"."ad_clicks"
  ADD CONSTRAINT "ad_clicks_amount_chk" CHECK ("chargedAmount" >= 0);
ALTER TABLE "public"."ad_daily_stats"
  ADD CONSTRAINT "ad_daily_stats_chk" CHECK ("impressions" >= 0 AND "clicks" >= 0 AND "orders" >= 0 AND "spend" >= 0 AND "revenue" >= 0);

-- Order discount breakdown: funding always adds up; reversals never exceed it;
-- FREE_SHIPPING is shipping-level (no order line), everything else is per line.
ALTER TABLE "public"."order_item_discounts"
  ADD CONSTRAINT "order_item_discounts_split_chk" CHECK ("amount" >= 0 AND "sellerFunded" >= 0 AND "platformFunded" >= 0 AND "amount" = "sellerFunded" + "platformFunded"),
  ADD CONSTRAINT "order_item_discounts_reversal_chk" CHECK ("reversedAmount" >= 0 AND "reversedAmount" <= "amount"),
  ADD CONSTRAINT "order_item_discounts_scope_chk" CHECK (("source" = 'FREE_SHIPPING') = ("orderItemId" IS NULL));
