-- CreateTable
CREATE TABLE "platform_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_settings_key_key" ON "platform_settings"("key");

-- Seed (additive)
INSERT INTO "platform_settings" ("id", "key", "value", "note", "updatedAt") VALUES
  (gen_random_uuid()::text, 'commission_default_rate', '10', 'Global default commission % (level 4 fallback) - re-seedable', now()),
  (gen_random_uuid()::text, 'commission_vat_rate', 'same_as_line_tax', 'Number = commission VAT %; same_as_line_tax = per-line SKU taxRate (interim)', now()),
  (gen_random_uuid()::text, 'reservation_ttl_minutes', '30', 'Release stock held by abandoned PAYMENT_PENDING orders after N minutes (placeholder - confirm)', now());
