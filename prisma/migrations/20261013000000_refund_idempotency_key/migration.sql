-- Phase 4 (H-2 / D1): database-level dedupe key for refunds.
--
-- NOT APPLIED. Deployment order (gate):
--   1. apply this migration;
--   2. regenerate the Prisma client and deploy the build that contains it;
--   3. only then set REFUND_IDEMPOTENCY_KEYS=1 so cancellation refunds write
--      "order-cancel:<orderId>" and the unique index rejects a second one.
-- A client generated from the new schema selects this column by default, so
-- step 1 must come before any deploy built from that schema.
--
-- Additive and nullable: existing rows get NULL; PostgreSQL treats NULLs as
-- distinct, so no existing row can violate the new unique index.

ALTER TABLE "refunds" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "refunds_idempotencyKey_key" ON "refunds"("idempotencyKey");
