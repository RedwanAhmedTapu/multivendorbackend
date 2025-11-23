-- CreateTable
CREATE TABLE "public"."vendor_storage_usage" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "totalUsedBytes" BIGINT NOT NULL DEFAULT 0,
    "freeQuotaBytes" BIGINT NOT NULL DEFAULT 5368709120,
    "paidQuotaBytes" BIGINT NOT NULL DEFAULT 0,
    "totalQuotaBytes" BIGINT NOT NULL DEFAULT 5368709120,
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "imageFiles" INTEGER NOT NULL DEFAULT 0,
    "documentFiles" INTEGER NOT NULL DEFAULT 0,
    "lastCalculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentMonthUsage" BIGINT NOT NULL DEFAULT 0,
    "lastBilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_storage_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vendor_storage_charges" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "billingPeriod" TEXT NOT NULL,
    "usedBytes" BIGINT NOT NULL,
    "chargeableBytes" BIGINT NOT NULL,
    "pricePerGB" DOUBLE PRECISION NOT NULL,
    "totalCharge" DOUBLE PRECISION NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_storage_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."storage_files" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "documentType" TEXT,
    "r2Bucket" TEXT NOT NULL,
    "r2Url" TEXT NOT NULL,
    "r2ETag" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_storage_usage_vendorId_key" ON "public"."vendor_storage_usage"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_storage_charges_vendorId_billingPeriod_idx" ON "public"."vendor_storage_charges"("vendorId", "billingPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "storage_files_fileKey_key" ON "public"."storage_files"("fileKey");

-- CreateIndex
CREATE INDEX "storage_files_vendorId_isActive_idx" ON "public"."storage_files"("vendorId", "isActive");

-- CreateIndex
CREATE INDEX "storage_files_fileKey_idx" ON "public"."storage_files"("fileKey");

-- AddForeignKey
ALTER TABLE "public"."vendor_storage_usage" ADD CONSTRAINT "vendor_storage_usage_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vendor_storage_charges" ADD CONSTRAINT "vendor_storage_charges_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."storage_files" ADD CONSTRAINT "storage_files_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
