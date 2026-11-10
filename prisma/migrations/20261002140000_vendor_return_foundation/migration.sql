-- CreateEnum
CREATE TYPE "VendorReturnStatus" AS ENUM ('CONFIRMED');
CREATE TYPE "ReturnCondition" AS ENUM ('SELLABLE', 'DAMAGED');

-- CreateTable
CREATE TABLE "vendor_returns" (
    "id" TEXT NOT NULL,
    "vendorOrderId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "condition" "ReturnCondition" NOT NULL,
    "status" "VendorReturnStatus" NOT NULL DEFAULT 'CONFIRMED',
    "refundId" TEXT,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_return_items" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_returns_vendorOrderId_condition_key" ON "vendor_returns"("vendorOrderId", "condition");
CREATE UNIQUE INDEX "vendor_returns_refundId_key" ON "vendor_returns"("refundId");
CREATE UNIQUE INDEX "vendor_return_items_returnId_orderItemId_key" ON "vendor_return_items"("returnId", "orderItemId");

-- AddForeignKey
ALTER TABLE "vendor_returns" ADD CONSTRAINT "vendor_returns_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "vendor_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_returns" ADD CONSTRAINT "vendor_returns_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_returns" ADD CONSTRAINT "vendor_returns_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "vendor_return_items" ADD CONSTRAINT "vendor_return_items_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "vendor_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_return_items" ADD CONSTRAINT "vendor_return_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_return_items" ADD CONSTRAINT "vendor_return_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
