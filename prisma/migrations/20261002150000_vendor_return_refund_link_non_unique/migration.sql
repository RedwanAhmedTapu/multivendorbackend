-- refundId links a VendorReturn to its refund; a refund may span multiple
-- vendor orders, so the uniqueness from the foundation migration is relaxed.
DROP INDEX "vendor_returns_refundId_key";
