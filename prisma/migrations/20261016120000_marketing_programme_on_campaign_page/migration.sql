-- Marketing Center — merge: the vendor programme belongs to a campaign landing page.
--
-- NOT APPLIED. Generated offline with `prisma migrate diff` (schema → schema,
-- no database contacted). Apply AFTER 20261015120000_marketing_center_phase1:
--   1. clear any test rows from marketing_campaigns (and their registrations);
--   2. apply this migration (prisma migrate deploy);
--   3. regenerate the Prisma client and deploy the build that contains it.
--
-- What it does:
--   - marketing_campaigns becomes the vendor programme of ONE campaign_pages
--     row: adds campaignPageId (NOT NULL, unique, FK ON DELETE RESTRICT);
--   - drops the duplicated columns name, slug, description, bannerImage,
--     startAt, endAt — the page's title/slug/hero and startDate/endDate are
--     now the single source of truth;
--   - replaces the Phase 1 date CHECK (it referenced startAt/endAt) with a
--     registration-window CHECK.
-- campaign_pages is not altered: landing-page-only campaigns are unaffected.
--
-- Guard (by decision): ABORT if marketing_campaigns has any rows — this
-- migration does not auto-link existing programmes to pages.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."marketing_campaigns" LIMIT 1) THEN
    RAISE EXCEPTION 'marketing_campaigns has rows — clear the test data before running 20261016120000_marketing_programme_on_campaign_page';
  END IF;
END $$;

-- The Phase 1 window CHECK referenced startAt/endAt, which are dropped below.
ALTER TABLE "public"."marketing_campaigns" DROP CONSTRAINT IF EXISTS "marketing_campaigns_windows_chk";

-- DropIndex
DROP INDEX "public"."marketing_campaigns_slug_key";

-- DropIndex
DROP INDEX "public"."marketing_campaigns_status_startAt_endAt_idx";

-- AlterTable
ALTER TABLE "public"."marketing_campaigns" DROP COLUMN "bannerImage",
DROP COLUMN "description",
DROP COLUMN "endAt",
DROP COLUMN "name",
DROP COLUMN "slug",
DROP COLUMN "startAt",
ADD COLUMN     "campaignPageId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "marketing_campaigns_campaignPageId_key" ON "public"."marketing_campaigns"("campaignPageId");

-- CreateIndex
CREATE INDEX "marketing_campaigns_status_idx" ON "public"."marketing_campaigns"("status");

-- AddForeignKey
ALTER TABLE "public"."marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_campaignPageId_fkey" FOREIGN KEY ("campaignPageId") REFERENCES "public"."campaign_pages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Registration window ordering (the live window lives on campaign_pages and
-- its relation to registration is enforced by the service, server-side).
ALTER TABLE "public"."marketing_campaigns"
  ADD CONSTRAINT "marketing_campaigns_registration_window_chk" CHECK ("registrationStartAt" < "registrationEndAt");
