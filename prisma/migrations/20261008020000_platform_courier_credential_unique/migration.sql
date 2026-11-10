-- At most ONE active PLATFORM courier credential per provider + environment.
--
-- @@unique([courierProviderId, vendorId, environment]) does not cover platform
-- credentials: PostgreSQL treats NULL vendorId values as distinct, so several
-- active platform rows could exist and quote / booking / token refresh could
-- resolve different merchant accounts. Partial unique index (not expressible
-- in the Prisma schema). Existing rows are never modified by this migration.

-- Fail with a clear message (instead of a bare index error) if duplicates
-- already exist — an operator must deactivate the extra rows first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "courier_credentials"
    WHERE "vendorId" IS NULL AND "isActive" = true
    GROUP BY "courierProviderId", "environment"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate ACTIVE platform courier credentials exist for the same provider + environment. Deactivate the extra rows (courier_credentials.isActive = false) before applying this migration.';
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "courier_credentials_platform_active_provider_env_key"
  ON "courier_credentials"("courierProviderId", "environment")
  WHERE "vendorId" IS NULL AND "isActive" = true;
