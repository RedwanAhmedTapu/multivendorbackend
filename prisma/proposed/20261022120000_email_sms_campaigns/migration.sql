-- PROPOSED ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â NOT APPLIED. Design revision 4 (approved corrections applied).
-- Email & SMS campaigns: 7 PostgreSQL enums + 5 tables. Additive only: no ALTER
-- or DROP of existing objects, no data statements, no reference to any existing
-- table except the FK to public.users (see recipients.userId).
--
-- Rollback order (hand-written; Prisma emits no down migration):
--   DROP the eight tables first (hash_versions, suppression_events, suppressions,
--   then DROP TYPE the ten enum types. Dropping types while tables still use
--   them fails, and a half-rolled-back database keeps orphaned types that block
--   recreating the same names.

-- CreateEnum
CREATE TYPE "public"."EmailSmsChannel" AS ENUM ('EMAIL', 'SMS');
CREATE TYPE "public"."EmailSmsCampaignType" AS ENUM ('WELCOME', 'PROMOTIONAL', 'TRANSACTIONAL', 'REMINDER');
CREATE TYPE "public"."EmailSmsCampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SUBMITTED', 'COMPLETED', 'CANCELLED', 'FAILED');
-- Audience selection for a campaign. Separate from EmailSmsRecipientSource on
-- purpose: a campaign's audience kind and a row's provenance are different facts.
CREATE TYPE "public"."EmailSmsAudienceKind" AS ENUM ('USER', 'SEGMENT', 'CUSTOM');
CREATE TYPE "public"."EmailSmsRecipientSource" AS ENUM ('USER', 'SEGMENT', 'CUSTOM');
CREATE TYPE "public"."EmailSmsSendState" AS ENUM ('QUEUED', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'DELIVERED', 'BOUNCED', 'FAILED');
CREATE TYPE "public"."EmailSmsActivityKind" AS ENUM ('CREATED', 'SCHEDULED', 'STARTED', 'SUBMITTED', 'COMPLETED', 'CANCELLED', 'FAILED');
-- Suppression is a separate concern from sending: reason says why an address is out,
-- source says how we learned it. Both are enums so an unknown value cannot be stored.
CREATE TYPE "public"."EmailSmsSuppressionReason" AS ENUM ('UNSUBSCRIBE', 'HARD_BOUNCE', 'COMPLAINT', 'MANUAL');
CREATE TYPE "public"."EmailSmsSuppressionSource" AS ENUM ('ADMIN', 'USER_REQUEST', 'PROVIDER_EVENT');

-- Rotation state for the suppression HMAC. A version is usable only when it is
-- COMPLETE *and* independently verified (verifiedAt + verifiedById set).
CREATE TYPE "public"."EmailSmsHashVersionState" AS ENUM ('PENDING', 'BACKFILLING', 'COMPLETE', 'RETIRED');

-- CreateTable
CREATE TABLE "public"."email_sms_campaign_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "public"."EmailSmsChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "email_sms_campaign_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."email_sms_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "public"."EmailSmsChannel" NOT NULL,
    "type" "public"."EmailSmsCampaignType" NOT NULL DEFAULT 'PROMOTIONAL',
    "status" "public"."EmailSmsCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "templateId" TEXT,
    "subjectSnapshot" TEXT,
    "bodySnapshot" TEXT NOT NULL,
    "templateNameSnapshot" TEXT,
    "audienceKind" "public"."EmailSmsAudienceKind" NOT NULL DEFAULT 'USER',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdById" TEXT,
    -- Soft delete only. A hard DELETE cascades recipients/sends away, so history is
    -- preserved by never hard-deleting a campaign that has sent attempts.
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "email_sms_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."email_sms_campaign_recipients" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "source" "public"."EmailSmsRecipientSource" NOT NULL,
    -- Nullable: a recipient row outlives the user it referenced (FK is SET NULL),
    -- so send history survives account deletion without keeping the account.
    "userId" TEXT,
    "addressHash" TEXT NOT NULL,
    -- Which HMAC key version produced addressHash. Rotation adds a version, never rewrites history.
    "hashVersion" INTEGER NOT NULL DEFAULT 1,
    -- "v1:<b64 iv>:<b64 tag>:<b64 ciphertext>" ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â AES-256-GCM, key from the secret
    -- store under CAMPAIGN_ADDRESS_KEY (name only; value never in the repo).
    "addressCipher" TEXT NOT NULL,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_sms_campaign_recipients_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."email_sms_campaign_sends" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "state" "public"."EmailSmsSendState" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3),
    -- Only ever set from a provider delivery receipt. Submission is not delivery.
    "deliveredAt" TIMESTAMP(3),
    -- Set immediately BEFORE the provider request is written. NULL means no
    -- transmission was attempted, so the row is the only retryable kind.
    "transmitStartedAt" TIMESTAMP(3),
    -- Manual resolution of an ambiguous outcome. Only ADMIN may fill these, with
    -- provider-side evidence; DELIVERED can never be set this way.
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "email_sms_campaign_sends_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."email_sms_campaign_activity" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "public"."EmailSmsActivityKind" NOT NULL,
    "message" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_sms_campaign_activity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."email_sms_hash_versions" (
    -- HMAC key version. 1 is the initial key; rotation adds 2, 3, ...
    "version" INTEGER NOT NULL,
    "state" "public"."EmailSmsHashVersionState" NOT NULL DEFAULT 'PENDING',
    -- True for the single version used to hash NEW rows. Exactly one row may set it.
    "isWriteVersion" BOOLEAN NOT NULL DEFAULT false,
    -- True while suppression lookups must consult this version (COMPLETE or RETIRED).
    "lookupEnabled" BOOLEAN NOT NULL DEFAULT false,
    -- Alias of the secret in the secret store, never the key itself.
    "keyAlias" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "backfillStartedAt" TIMESTAMP(3),
    -- Population boundary: rows created before this instant are covered by the
    -- backfill; rows created after it are dual-written at insert time. Completeness
    -- is judged against this boundary, not against a live row count.
    "backfilledBefore" TIMESTAMP(3),
    "lastProcessedId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    -- Independent verification. A backfill worker may only set state=COMPLETE after
    -- a separate verifier run has written verifiedAt/verifiedById.
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "verificationRunId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "email_sms_hash_versions_pkey" PRIMARY KEY ("version")
);

-- At most one version may be the writer. Several versions may be COMPLETE (or RETIRED)
-- simultaneously: lookups must match every usable version during and after rotation.
CREATE UNIQUE INDEX "email_sms_hash_versions_one_writer_key" ON "public"."email_sms_hash_versions"("isWriteVersion") WHERE "isWriteVersion";
CREATE INDEX "email_sms_hash_versions_state_idx" ON "public"."email_sms_hash_versions"("state");
CREATE TABLE "public"."email_sms_suppressions" (
    "id" TEXT NOT NULL,
    -- Keyed HMAC of the normalised address (CAMPAIGN_ADDRESS_HASH_KEY). Never plaintext.
    "addressHash" TEXT NOT NULL,
    -- Which HMAC key version produced addressHash. Rotation adds a version, never rewrites history.
    "hashVersion" INTEGER NOT NULL DEFAULT 1,
    "channel" "public"."EmailSmsChannel" NOT NULL,
    "reason" "public"."EmailSmsSuppressionReason" NOT NULL,
    "source" "public"."EmailSmsSuppressionSource" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_sms_suppressions_pkey" PRIMARY KEY ("id")
);

-- Append-only audit of every suppression event, including duplicates that were
-- deduplicated (they are counted, not stored twice).
CREATE TABLE "public"."email_sms_suppression_events" (
    "id" TEXT NOT NULL,
    "suppressionId" TEXT,
    "addressHash" TEXT NOT NULL,
    -- Which HMAC key version produced addressHash. Rotation adds a version, never rewrites history.
    "hashVersion" INTEGER NOT NULL DEFAULT 1,
    "channel" "public"."EmailSmsChannel" NOT NULL,
    "reason" "public"."EmailSmsSuppressionReason" NOT NULL,
    "source" "public"."EmailSmsSuppressionSource" NOT NULL,
    "providerEventId" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_sms_suppression_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_sms_campaigns_idempotencyKey_key" ON "public"."email_sms_campaigns"("idempotencyKey");
CREATE INDEX "email_sms_campaigns_status_scheduledAt_idx" ON "public"."email_sms_campaigns"("status", "scheduledAt");
CREATE INDEX "email_sms_campaigns_channel_createdAt_idx" ON "public"."email_sms_campaigns"("channel", "createdAt");
CREATE INDEX "email_sms_campaigns_claimToken_idx" ON "public"."email_sms_campaigns"("claimToken");
CREATE INDEX "email_sms_campaigns_deletedAt_idx" ON "public"."email_sms_campaigns"("deletedAt");
CREATE INDEX "email_sms_campaign_templates_channel_deletedAt_idx" ON "public"."email_sms_campaign_templates"("channel", "deletedAt");
CREATE UNIQUE INDEX "email_sms_campaign_recipients_campaignId_addressHash_key" ON "public"."email_sms_campaign_recipients"("campaignId", "addressHash");
CREATE INDEX "email_sms_campaign_recipients_campaignId_suppressed_idx" ON "public"."email_sms_campaign_recipients"("campaignId", "suppressed");
CREATE INDEX "email_sms_campaign_recipients_userId_idx" ON "public"."email_sms_campaign_recipients"("userId");
CREATE UNIQUE INDEX "email_sms_campaign_sends_recipientId_attempt_key" ON "public"."email_sms_campaign_sends"("recipientId", "attempt");
CREATE UNIQUE INDEX "email_sms_campaign_sends_providerMessageId_key" ON "public"."email_sms_campaign_sends"("providerMessageId");
-- At most one OPEN attempt per recipient: a retry must first close the previous row.
CREATE UNIQUE INDEX "email_sms_campaign_sends_one_open_per_recipient" ON "public"."email_sms_campaign_sends"("recipientId") WHERE "state" IN ('QUEUED', 'RECONCILIATION_REQUIRED');
CREATE INDEX "email_sms_campaign_sends_campaignId_state_idx" ON "public"."email_sms_campaign_sends"("campaignId", "state");
CREATE UNIQUE INDEX "email_sms_suppressions_channel_hashVersion_addressHash_key" ON "public"."email_sms_suppressions"("channel", "hashVersion", "addressHash");
CREATE INDEX "email_sms_suppressions_addressHash_idx" ON "public"."email_sms_suppressions"("addressHash");
CREATE INDEX "email_sms_suppression_events_addressHash_createdAt_idx" ON "public"."email_sms_suppression_events"("addressHash", "createdAt");
-- Partial unique: only provider-sourced events carry an id, so manual/admin events
-- (providerEventId IS NULL) are never collapsed. Assumes event ids are unique per
-- channel; add a provider column to the key if that assumption ever fails.
CREATE UNIQUE INDEX "email_sms_suppression_events_channel_providerEventId_key" ON "public"."email_sms_suppression_events"("channel", "providerEventId") WHERE "providerEventId" IS NOT NULL;
CREATE INDEX "email_sms_campaign_activity_campaignId_createdAt_idx" ON "public"."email_sms_campaign_activity"("campaignId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."email_sms_campaigns" ADD CONSTRAINT "email_sms_campaigns_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "public"."email_sms_campaign_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."email_sms_campaign_recipients" ADD CONSTRAINT "email_sms_campaign_recipients_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."email_sms_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."email_sms_campaign_recipients" ADD CONSTRAINT "email_sms_campaign_recipients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."email_sms_campaign_sends" ADD CONSTRAINT "email_sms_campaign_sends_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."email_sms_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."email_sms_campaign_sends" ADD CONSTRAINT "email_sms_campaign_sends_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "public"."email_sms_campaign_recipients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT, not CASCADE: activity is the audit trail and must outlive a campaign.
ALTER TABLE "public"."email_sms_suppression_events" ADD CONSTRAINT "email_sms_suppression_events_suppressionId_fkey" FOREIGN KEY ("suppressionId") REFERENCES "public"."email_sms_suppressions"("id") ON DELETE SET NULL ON UPDATE CASCADE;ALTER TABLE "public"."email_sms_campaign_activity" ADD CONSTRAINT "email_sms_campaign_activity_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."email_sms_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT: the audit trail must outlive the campaign record.
ALTER TABLE "public"."email_sms_campaign_activity" ADD CONSTRAINT "email_sms_campaign_activity_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."email_sms_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
