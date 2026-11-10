-- 1C-13: courier booking integrity.
-- 1) Deterministic per-logical-shipment provider reference
--    ("<vendorOrderId>-<warehouseId>", re-bookings add an attempt suffix)
--    persisted for reconciliation after unknown booking outcomes.
ALTER TABLE "courier_orders" ADD COLUMN "merchantReference" TEXT;
CREATE INDEX "courier_orders_merchantReference_idx" ON "courier_orders"("merchantReference");

-- 2) Enforce one ACTIVE REGULAR logical shipment per (VendorOrder, warehouse).
--    Partial index: cancelled historical consignments do not block re-booking;
--    return/exchange legs (shipmentKind <> 'REGULAR') are unaffected.
--    Pre-checked against existing data: 0 violating groups (2026-10-04).
CREATE UNIQUE INDEX "courier_orders_active_regular_vendor_warehouse_key"
  ON "courier_orders"("vendorOrderId", "warehouseId")
  WHERE "shipmentKind" = 'REGULAR' AND "status" <> 'CANCELLED';
