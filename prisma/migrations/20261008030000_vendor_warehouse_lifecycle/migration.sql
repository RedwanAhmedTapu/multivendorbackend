-- Vendor warehouse lifecycle (forward-only, additive).
-- isActive = false  → warehouse is deactivated: no NEW operational use
--                     (allocation, receiving, transfers in, POS, courier
--                     pickup linking); all historical references stay intact.
-- "Operational" is NOT stored — it is derived from existing references.
-- Existing warehouses become active; no other rows are modified.

-- AlterTable
ALTER TABLE "vendor_warehouses" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "deactivatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "vendor_warehouses_vendorId_isActive_idx" ON "vendor_warehouses"("vendorId", "isActive");
