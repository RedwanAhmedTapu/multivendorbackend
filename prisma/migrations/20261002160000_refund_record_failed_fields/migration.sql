ALTER TABLE "refund_records" ADD COLUMN IF NOT EXISTS "failedReason" TEXT;
ALTER TABLE "refund_records" ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP(3);
