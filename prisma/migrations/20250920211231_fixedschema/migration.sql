-- CreateEnum
CREATE TYPE "public"."TermsType" AS ENUM ('GENERAL', 'PRIVACY_POLICY', 'VENDOR_AGREEMENT', 'CUSTOMER_TERMS', 'DELIVERY_TERMS', 'RETURN_POLICY');

-- CreateTable
CREATE TABLE "public"."terms_and_conditions" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "type" "public"."TermsType" NOT NULL DEFAULT 'GENERAL',
    "language" TEXT NOT NULL DEFAULT 'en',
    "metaTitle" TEXT,
    "metaDesc" TEXT,

    CONSTRAINT "terms_and_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "terms_and_conditions_slug_key" ON "public"."terms_and_conditions"("slug");

-- CreateIndex
CREATE INDEX "terms_and_conditions_isActive_isPublished_idx" ON "public"."terms_and_conditions"("isActive", "isPublished");

-- CreateIndex
CREATE INDEX "terms_and_conditions_type_isActive_idx" ON "public"."terms_and_conditions"("type", "isActive");

-- AddForeignKey
ALTER TABLE "public"."terms_and_conditions" ADD CONSTRAINT "terms_and_conditions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."terms_and_conditions" ADD CONSTRAINT "terms_and_conditions_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
