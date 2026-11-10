-- CreateEnum
CREATE TYPE "public"."PaletteKind" AS ENUM ('PRESET', 'CUSTOM');

-- CreateEnum
CREATE TYPE "public"."PaletteStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "public"."ThemeScope" AS ENUM ('PLATFORM_WEBSITE', 'ADMIN_DASHBOARD', 'VENDOR_DASHBOARD', 'VENDOR_STOREFRONT', 'CUSTOMER_DEFAULT');

-- CreateEnum
CREATE TYPE "public"."ThemeMode" AS ENUM ('LIGHT', 'DARK', 'SYSTEM');

-- CreateTable
CREATE TABLE "public"."theme_palettes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "public"."PaletteKind" NOT NULL DEFAULT 'CUSTOM',
    "status" "public"."PaletteStatus" NOT NULL DEFAULT 'DRAFT',
    "tokens" JSONB NOT NULL,
    "darkTokens" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "theme_palettes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."theme_palette_versions" (
    "id" TEXT NOT NULL,
    "paletteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "tokens" JSONB NOT NULL,
    "darkTokens" JSONB,
    "note" TEXT,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "theme_palette_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."theme_assignments" (
    "id" TEXT NOT NULL,
    "scope" "public"."ThemeScope" NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '',
    "paletteId" TEXT NOT NULL,
    "overrides" JSONB,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "theme_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_theme_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "public"."ThemeMode" NOT NULL DEFAULT 'SYSTEM',
    "paletteId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_theme_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "theme_palettes_status_idx" ON "public"."theme_palettes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "theme_palettes_name_key" ON "public"."theme_palettes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "theme_palette_versions_paletteId_version_key" ON "public"."theme_palette_versions"("paletteId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "theme_assignments_scope_scopeId_key" ON "public"."theme_assignments"("scope", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "user_theme_preferences_userId_key" ON "public"."user_theme_preferences"("userId");

-- AddForeignKey
ALTER TABLE "public"."theme_palette_versions" ADD CONSTRAINT "theme_palette_versions_paletteId_fkey" FOREIGN KEY ("paletteId") REFERENCES "public"."theme_palettes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."theme_assignments" ADD CONSTRAINT "theme_assignments_paletteId_fkey" FOREIGN KEY ("paletteId") REFERENCES "public"."theme_palettes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

