-- CreateEnum
CREATE TYPE "public"."ComponentType" AS ENUM ('STORE_BANNER', 'CATEGORY_SLIDER', 'CATEGORY_GRID', 'BANNER', 'PRODUCT_CAROUSEL', 'PRODUCT_GRID', 'FEATURED_PRODUCTS', 'COUNTDOWN_TIMER', 'VOUCHER_PROMOTION');

-- CreateEnum
CREATE TYPE "public"."BannerType" AS ENUM ('SINGLE_BANNER', 'DOUBLE_BANNER', 'THREE_BANNER', 'FOUR_BANNER', 'FIVE_BANNER', 'SLIDER_BANNER', 'SLIDER_WITH_LEFT_BANNER');

-- CreateEnum
CREATE TYPE "public"."BannerLayout" AS ENUM ('HORIZONTAL', 'VERTICAL', 'GRID', 'MASONRY');

-- CreateEnum
CREATE TYPE "public"."CategoryLayout" AS ENUM ('SLIDER', 'GRID', 'LIST');

-- CreateEnum
CREATE TYPE "public"."TimerPosition" AS ENUM ('TOP_LEFT', 'TOP_RIGHT', 'TOP_CENTER', 'BOTTOM_LEFT', 'BOTTOM_RIGHT', 'BOTTOM_CENTER', 'CENTER', 'OVERLAY_TOP', 'OVERLAY_BOTTOM');

-- CreateEnum
CREATE TYPE "public"."BackgroundType" AS ENUM ('SOLID', 'LINEAR_GRADIENT', 'RADIAL_GRADIENT', 'IMAGE');

-- CreateTable
CREATE TABLE "public"."vendor_followers" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "followedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_followers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."store_layouts" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "thumbnail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."store_layout_components" (
    "id" TEXT NOT NULL,
    "layoutId" TEXT NOT NULL,
    "type" "public"."ComponentType" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_layout_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."component_configs" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "bannerImage" TEXT,
    "bannerBackgroundType" "public"."BackgroundType",
    "bannerBackgroundColor" TEXT,
    "showChatButton" BOOLEAN NOT NULL DEFAULT true,
    "showRating" BOOLEAN NOT NULL DEFAULT true,
    "showVerifiedBadge" BOOLEAN NOT NULL DEFAULT true,
    "showFollowers" BOOLEAN NOT NULL DEFAULT true,
    "showLogo" BOOLEAN NOT NULL DEFAULT true,
    "showStoreName" BOOLEAN NOT NULL DEFAULT true,
    "categoryLayout" "public"."CategoryLayout",
    "categoriesPerRow" INTEGER,
    "showCategoryCount" BOOLEAN NOT NULL DEFAULT true,
    "categorySlideInterval" INTEGER,
    "productsPerRow" INTEGER,
    "showProductPrice" BOOLEAN NOT NULL DEFAULT true,
    "showProductRating" BOOLEAN NOT NULL DEFAULT true,
    "showAddToCart" BOOLEAN NOT NULL DEFAULT true,
    "autoSlide" BOOLEAN NOT NULL DEFAULT false,
    "slideInterval" INTEGER,
    "bannerType" "public"."BannerType",
    "bannerLayout" "public"."BannerLayout",
    "bannerHeight" TEXT,
    "bannerImages" JSONB,
    "countdownBannerImage" TEXT,
    "countdownEndDate" TIMESTAMP(3),
    "timerPosition" "public"."TimerPosition",
    "showDays" BOOLEAN NOT NULL DEFAULT true,
    "showHours" BOOLEAN NOT NULL DEFAULT true,
    "showMinutes" BOOLEAN NOT NULL DEFAULT true,
    "showSeconds" BOOLEAN NOT NULL DEFAULT true,
    "countdownTitle" TEXT,
    "countdownBackgroundColor" TEXT,
    "voucherBannerImage" TEXT,
    "voucherCode" TEXT,
    "voucherTitle" TEXT,
    "voucherDescription" TEXT,
    "voucherBackgroundColor" TEXT,
    "voucherTextColor" TEXT,
    "minOrderAmount" DOUBLE PRECISION,
    "discountAmount" DOUBLE PRECISION,
    "discountPercentage" DOUBLE PRECISION,
    "voucherValidFrom" TIMESTAMP(3),
    "voucherValidTo" TIMESTAMP(3),
    "showVoucherCode" BOOLEAN NOT NULL DEFAULT true,
    "useDefaultDesign" BOOLEAN NOT NULL DEFAULT true,
    "customCSS" TEXT,
    "padding" TEXT,
    "margin" TEXT,
    "borderRadius" TEXT,
    "boxShadow" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "component_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."component_products" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "component_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."component_categories" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "component_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."store_banner_customizations" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "bannerImage" TEXT,
    "bannerBackgroundType" "public"."BackgroundType" NOT NULL DEFAULT 'SOLID',
    "bannerBackgroundValue" TEXT,
    "showChatButton" BOOLEAN NOT NULL DEFAULT true,
    "showRating" BOOLEAN NOT NULL DEFAULT true,
    "showVerifiedBadge" BOOLEAN NOT NULL DEFAULT true,
    "showFollowers" BOOLEAN NOT NULL DEFAULT true,
    "chatButtonColor" TEXT NOT NULL DEFAULT '#14B8A6',
    "storeNameColor" TEXT NOT NULL DEFAULT '#000000',
    "textColor" TEXT NOT NULL DEFAULT '#666666',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_banner_customizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."layout_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "thumbnail" TEXT,
    "category" TEXT,
    "structure" JSONB NOT NULL,
    "isPremium" BOOLEAN NOT NULL DEFAULT false,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "rating" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "layout_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_followers_vendorId_idx" ON "public"."vendor_followers"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_followers_userId_idx" ON "public"."vendor_followers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_followers_vendorId_userId_key" ON "public"."vendor_followers"("vendorId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "store_layouts_vendorId_key" ON "public"."store_layouts"("vendorId");

-- CreateIndex
CREATE INDEX "store_layouts_vendorId_idx" ON "public"."store_layouts"("vendorId");

-- CreateIndex
CREATE INDEX "store_layout_components_layoutId_sortOrder_idx" ON "public"."store_layout_components"("layoutId", "sortOrder");

-- CreateIndex
CREATE INDEX "store_layout_components_type_idx" ON "public"."store_layout_components"("type");

-- CreateIndex
CREATE UNIQUE INDEX "component_configs_componentId_key" ON "public"."component_configs"("componentId");

-- CreateIndex
CREATE INDEX "component_products_componentId_sortOrder_idx" ON "public"."component_products"("componentId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "component_products_componentId_productId_key" ON "public"."component_products"("componentId", "productId");

-- CreateIndex
CREATE INDEX "component_categories_componentId_sortOrder_idx" ON "public"."component_categories"("componentId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "component_categories_componentId_categoryId_key" ON "public"."component_categories"("componentId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "store_banner_customizations_vendorId_key" ON "public"."store_banner_customizations"("vendorId");

-- CreateIndex
CREATE INDEX "layout_templates_category_idx" ON "public"."layout_templates"("category");

-- AddForeignKey
ALTER TABLE "public"."vendor_followers" ADD CONSTRAINT "vendor_followers_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_followers" ADD CONSTRAINT "vendor_followers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."store_layouts" ADD CONSTRAINT "store_layouts_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."store_layout_components" ADD CONSTRAINT "store_layout_components_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "public"."store_layouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."component_configs" ADD CONSTRAINT "component_configs_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "public"."store_layout_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."component_products" ADD CONSTRAINT "component_products_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "public"."store_layout_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."component_products" ADD CONSTRAINT "component_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."component_categories" ADD CONSTRAINT "component_categories_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "public"."store_layout_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."component_categories" ADD CONSTRAINT "component_categories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."store_banner_customizations" ADD CONSTRAINT "store_banner_customizations_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
