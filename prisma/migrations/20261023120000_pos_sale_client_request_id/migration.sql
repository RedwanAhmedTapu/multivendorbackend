-- PROPOSED — NOT APPLIED. Follow-up to 20261022210000_pos_subscription_lifecycle.
--
-- The copy of that migration in prisma/migrations/ predates the idempotent
-- checkout change: it adds soldByUserId / soldByEmployeeId but NOT
-- pos_sales."clientRequestId" or its unique index, while schema.prisma (and the
-- generated client) have both. Every POST /api/pos/sales filters on
-- clientRequestId first, so a database migrated from that copy fails with
-- Prisma P2022 (column does not exist) → HTTP 400 "Request could not be completed".
--
-- Additive and idempotent (safe whether or not the column already exists).
-- Existing rows keep NULL; NULLs never collide under the unique index.
-- Rollback: DROP INDEX "public"."pos_sales_vendorId_clientRequestId_key";
--           ALTER TABLE "public"."pos_sales" DROP COLUMN "clientRequestId";

ALTER TABLE "public"."pos_sales" ADD COLUMN IF NOT EXISTS "clientRequestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "pos_sales_vendorId_clientRequestId_key"
  ON "public"."pos_sales"("vendorId", "clientRequestId");
