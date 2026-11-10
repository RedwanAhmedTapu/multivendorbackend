-- Allow multiple returns per vendorOrder+condition (quantity-tracked by VendorReturnItems)
DROP INDEX "vendor_returns_vendorOrderId_condition_key";
