-- AlterTable
ALTER TABLE "public"."storage_files" ADD COLUMN     "folder" TEXT;

-- CreateTable
CREATE TABLE "public"."VendorFolder" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "parentPath" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorFolder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorFolder_path_key" ON "public"."VendorFolder"("path");

-- CreateIndex
CREATE INDEX "VendorFolder_vendorId_idx" ON "public"."VendorFolder"("vendorId");

-- CreateIndex
CREATE INDEX "VendorFolder_path_idx" ON "public"."VendorFolder"("path");

-- CreateIndex
CREATE INDEX "storage_files_folder_idx" ON "public"."storage_files"("folder");

-- AddForeignKey
ALTER TABLE "public"."VendorFolder" ADD CONSTRAINT "VendorFolder_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
