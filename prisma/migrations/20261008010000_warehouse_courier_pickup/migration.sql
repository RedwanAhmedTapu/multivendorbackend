-- Warehouse courier pickup mapping (forward-only, additive).
-- Adds warehouse-specific courier pickup configuration (Pathao store / RedX
-- pickup store) keyed by VendorWarehouse + CourierCredential.
-- No existing rows are modified; no historical data is backfilled.
-- CourierCredential.storeId is left untouched (legacy, no longer read by
-- Pathao/RedX quote or booking).

-- CreateEnum
CREATE TYPE "WarehouseCourierPickupStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING_APPROVAL');

-- AlterTable: cache rows are now scoped to the pickup configuration they were
-- priced for. NULL = legacy location-only rows (never read for mapped providers).
ALTER TABLE "courier_price_cache" ADD COLUMN "pickupRef" TEXT;

-- CreateIndex
CREATE INDEX "courier_price_cache_provider_pickup_to_idx" ON "courier_price_cache"("courierProviderId", "pickupRef", "toLocationId");

-- Composite FK targets (id is already the PK, so these can never conflict
-- with existing data).
CREATE UNIQUE INDEX "courier_credentials_id_courierProviderId_key" ON "courier_credentials"("id", "courierProviderId");
CREATE UNIQUE INDEX "vendor_warehouses_id_vendorId_key" ON "vendor_warehouses"("id", "vendorId");

-- CreateTable
CREATE TABLE "warehouse_courier_pickups" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "courierCredentialId" TEXT NOT NULL,
    "courierProviderId" TEXT NOT NULL,
    "providerStoreId" TEXT,
    "providerStoreName" TEXT,
    "providerCityId" TEXT,
    "providerZoneId" TEXT,
    "providerAreaId" TEXT,
    "status" "WarehouseCourierPickupStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "rawData" JSONB,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_courier_pickups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouse_courier_pickups_wh_cred_status_idx" ON "warehouse_courier_pickups"("warehouseId", "courierCredentialId", "status");
CREATE INDEX "warehouse_courier_pickups_cred_store_idx" ON "warehouse_courier_pickups"("courierCredentialId", "providerStoreId");
CREATE INDEX "warehouse_courier_pickups_vendorId_idx" ON "warehouse_courier_pickups"("vendorId");

-- AddForeignKey: mapping.vendorId must equal the warehouse's vendor.
ALTER TABLE "warehouse_courier_pickups" ADD CONSTRAINT "warehouse_courier_pickups_warehouseId_vendorId_fkey" FOREIGN KEY ("warehouseId", "vendorId") REFERENCES "vendor_warehouses"("id", "vendorId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: mapping.courierProviderId must equal the credential's provider.
ALTER TABLE "warehouse_courier_pickups" ADD CONSTRAINT "warehouse_courier_pickups_credential_provider_fkey" FOREIGN KEY ("courierCredentialId", "courierProviderId") REFERENCES "courier_credentials"("id", "courierProviderId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Raw partial uniques (not expressible in Prisma schema):
-- 1) At most one ACTIVE pickup per (warehouse, credential) — quote and booking
--    resolve exactly one store, never "the first".
CREATE UNIQUE INDEX "warehouse_courier_pickups_active_warehouse_credential_key"
  ON "warehouse_courier_pickups"("warehouseId", "courierCredentialId")
  WHERE "status" = 'ACTIVE';

-- 2) A provider store inside one merchant account can be claimed by at most
--    one open (ACTIVE / PENDING_APPROVAL) mapping — Vendor B can never be
--    mapped to Vendor A's store.
CREATE UNIQUE INDEX "warehouse_courier_pickups_open_credential_store_key"
  ON "warehouse_courier_pickups"("courierCredentialId", "providerStoreId")
  WHERE "status" IN ('ACTIVE', 'PENDING_APPROVAL') AND "providerStoreId" IS NOT NULL;
