-- Business Advisor analytics — event table (schema only).
--
-- NOT APPLIED. Generated offline with `prisma migrate diff` (schema → schema,
-- no database contacted). Purely ADDITIVE: one new enum and one new table;
-- no existing table, column or row is touched. Deployment order:
--   1. back up the database;
--   2. apply this migration (prisma migrate deploy);
--   3. regenerate the Prisma client (prisma generate) and deploy that build.
-- Until both are done, analytics recording is a silent no-op (it never
-- affects browsing, cart, checkout, orders or payments) and the Business
-- Advisor API answers 503 "analytics not set up".
--
-- Privacy: no customer names / emails / phones / addresses / tokens / payment
-- data — actorKey is pseudonymous. Retention is enforced by the application
-- (ANALYTICS_RETENTION_DAYS, default 180).

-- CreateEnum
CREATE TYPE "public"."AnalyticsEventType" AS ENUM ('PRODUCT_VIEW', 'ADD_TO_CART', 'REMOVE_FROM_CART', 'CART_QUANTITY_CHANGED', 'CHECKOUT_STARTED', 'CHECKOUT_FAILED', 'ORDER_PLACED');

-- CreateTable
CREATE TABLE "public"."analytics_events" (
    "id" TEXT NOT NULL,
    "type" "public"."AnalyticsEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "day" DATE NOT NULL,
    "vendorId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "sessionKey" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "groupKey" TEXT,
    "orderId" TEXT,
    "quantity" INTEGER,
    "valueMinor" INTEGER,
    "source" TEXT,
    "reason" TEXT,
    "dedupKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analytics_events_dedupKey_key" ON "public"."analytics_events"("dedupKey");

-- CreateIndex
CREATE INDEX "analytics_events_vendorId_day_type_idx" ON "public"."analytics_events"("vendorId", "day", "type");

-- CreateIndex
CREATE INDEX "analytics_events_vendorId_productId_day_idx" ON "public"."analytics_events"("vendorId", "productId", "day");

-- CreateIndex
CREATE INDEX "analytics_events_vendorId_sessionKey_idx" ON "public"."analytics_events"("vendorId", "sessionKey");

-- CreateIndex
CREATE INDEX "analytics_events_sessionKey_occurredAt_idx" ON "public"."analytics_events"("sessionKey", "occurredAt");

-- CreateIndex
CREATE INDEX "analytics_events_actorKey_occurredAt_idx" ON "public"."analytics_events"("actorKey", "occurredAt");

-- CreateIndex
CREATE INDEX "analytics_events_day_type_idx" ON "public"."analytics_events"("day", "type");

