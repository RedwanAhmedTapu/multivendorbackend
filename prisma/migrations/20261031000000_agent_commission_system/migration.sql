-- Agent Commission System (docs/agent-system-plan.md, Phase 1).
-- ADDITIVE ONLY: new enums and agent_* tables. No existing table, column,
-- index or constraint is changed. Generated with `prisma migrate diff`
-- (old schema -> new schema); the block at the end adds the partial unique
-- indexes and CHECK constraints that Prisma cannot express.

-- CreateEnum
CREATE TYPE "public"."AgentStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "public"."AgentVendorLinkSource" AS ENUM ('REFERRAL_CODE', 'AGENT_INVITE', 'ADMIN_ASSIGNED');

-- CreateEnum
CREATE TYPE "public"."AgentConfigEntity" AS ENUM ('SETTING', 'LEVEL', 'OVERRIDE', 'BONUS_RULE', 'AGENT', 'VENDOR_LINK');

-- CreateEnum
CREATE TYPE "public"."AgentConfigAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'ACTIVATE', 'DEACTIVATE', 'STATUS');

-- CreateEnum
CREATE TYPE "public"."AgentRateSource" AS ENUM ('VENDOR', 'AGENT', 'CATEGORY', 'LEVEL', 'GLOBAL');

-- CreateEnum
CREATE TYPE "public"."AgentOverrideScope" AS ENUM ('VENDOR', 'AGENT', 'CATEGORY');

-- CreateEnum
CREATE TYPE "public"."AgentBonusScope" AS ENUM ('PER_VENDOR', 'PER_AGENT');

-- CreateEnum
CREATE TYPE "public"."AgentBonusMetric" AS ENUM ('DELIVERED_ORDERS', 'DELIVERED_SALES', 'ACTIVE_VENDORS', 'NEW_VENDORS');

-- CreateEnum
CREATE TYPE "public"."AgentBonusRecurrence" AS ENUM ('ONE_TIME', 'MONTHLY');

-- CreateEnum
CREATE TYPE "public"."AgentCommissionStatus" AS ENUM ('PENDING_CLEARANCE', 'AVAILABLE', 'PARTIALLY_REVERSED', 'REVERSED');

-- CreateEnum
CREATE TYPE "public"."AgentWalletTxType" AS ENUM ('COMMISSION_CREDIT', 'COMMISSION_REVERSAL', 'BONUS_CREDIT', 'WITHDRAWAL_HOLD', 'WITHDRAWAL_RELEASE', 'WITHDRAWAL_PAID', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "public"."AgentPayoutMethodType" AS ENUM ('BKASH', 'NAGAD', 'BANK');

-- CreateEnum
CREATE TYPE "public"."AgentWithdrawalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."agents" (
    "id" TEXT NOT NULL,
    "agentCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "status" "public"."AgentStatus" NOT NULL DEFAULT 'PENDING',
    "avatar" TEXT,
    "referralCode" TEXT NOT NULL,
    "levelId" TEXT,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "notificationPrefs" JSONB NOT NULL DEFAULT '{}',
    "emailVerifiedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "statusReason" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_sessions" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_password_resets" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_vendor_links" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "source" "public"."AgentVendorLinkSource" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "assignedById" TEXT,
    "endedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_vendor_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "public"."agent_config_audits" (
    "id" TEXT NOT NULL,
    "entity" "public"."AgentConfigEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "public"."AgentConfigAction" NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "actorUserId" TEXT NOT NULL,
    "actorName" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_config_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_levels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "minActiveVendors" INTEGER NOT NULL DEFAULT 0,
    "minDeliveredSales" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "minPerformanceScore" DECIMAL(5,2),
    "commissionPercent" DECIMAL(9,4),
    "bonusAmount" DECIMAL(18,2),
    "perks" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_commission_overrides" (
    "id" TEXT NOT NULL,
    "scope" "public"."AgentOverrideScope" NOT NULL,
    "vendorId" TEXT,
    "agentId" TEXT,
    "categoryId" TEXT,
    "ratePercent" DECIMAL(9,4) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "endedById" TEXT,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_commission_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_bonus_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "public"."AgentBonusScope" NOT NULL,
    "metric" "public"."AgentBonusMetric" NOT NULL,
    "threshold" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "recurrence" "public"."AgentBonusRecurrence" NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_bonus_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_bonus_awards" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "vendorKey" TEXT NOT NULL DEFAULT '',
    "periodKey" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "ruleSnapshot" JSONB NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_bonus_awards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_commissions" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "vendorOrderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "baseAmount" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "rateSource" "public"."AgentRateSource" NOT NULL,
    "rateRefId" TEXT,
    "ratePercent" DECIMAL(9,4) NOT NULL,
    "levelId" TEXT,
    "levelName" TEXT,
    "holdDays" INTEGER NOT NULL,
    "durationMonths" INTEGER,
    "ruleSnapshot" JSONB NOT NULL,
    "reversedQty" INTEGER NOT NULL DEFAULT 0,
    "reversedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "public"."AgentCommissionStatus" NOT NULL DEFAULT 'PENDING_CLEARANCE',
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_commission_reversals" (
    "id" TEXT NOT NULL,
    "commissionId" TEXT NOT NULL,
    "vendorReturnId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_commission_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_wallets" (
    "agentId" TEXT NOT NULL,
    "available" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "pendingClearance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "onHold" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalEarned" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalWithdrawn" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_wallets_pkey" PRIMARY KEY ("agentId")
);

-- CreateTable
CREATE TABLE "public"."agent_wallet_transactions" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "public"."AgentWalletTxType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "balanceAfter" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_payout_methods" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "public"."AgentPayoutMethodType" NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankName" TEXT,
    "branch" TEXT,
    "routingNumber" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_payout_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_withdrawals" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "fee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(18,2) NOT NULL,
    "payoutMethodId" TEXT,
    "methodSnapshot" JSONB NOT NULL,
    "settingsSnapshot" JSONB NOT NULL,
    "status" "public"."AgentWithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "clientRequestId" TEXT NOT NULL,
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3),
    "transactionRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_training_resources" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT,
    "url" TEXT,
    "coverImage" TEXT,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_training_resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_agentCode_key" ON "public"."agents"("agentCode");

-- CreateIndex
CREATE UNIQUE INDEX "agents_email_key" ON "public"."agents"("email");

-- CreateIndex
CREATE UNIQUE INDEX "agents_phone_key" ON "public"."agents"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "agents_referralCode_key" ON "public"."agents"("referralCode");

-- CreateIndex
CREATE INDEX "agents_status_idx" ON "public"."agents"("status");

-- CreateIndex
CREATE INDEX "agents_levelId_idx" ON "public"."agents"("levelId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_sessions_refreshTokenHash_key" ON "public"."agent_sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "agent_sessions_agentId_revokedAt_idx" ON "public"."agent_sessions"("agentId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_password_resets_tokenHash_key" ON "public"."agent_password_resets"("tokenHash");

-- CreateIndex
CREATE INDEX "agent_password_resets_agentId_idx" ON "public"."agent_password_resets"("agentId");

-- CreateIndex
CREATE INDEX "agent_vendor_links_agentId_endedAt_idx" ON "public"."agent_vendor_links"("agentId", "endedAt");

-- CreateIndex
CREATE INDEX "agent_vendor_links_vendorId_idx" ON "public"."agent_vendor_links"("vendorId");

-- CreateIndex
CREATE INDEX "agent_config_audits_entity_entityId_createdAt_idx" ON "public"."agent_config_audits"("entity", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_config_audits_createdAt_idx" ON "public"."agent_config_audits"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_levels_name_key" ON "public"."agent_levels"("name");

-- CreateIndex
CREATE UNIQUE INDEX "agent_levels_rank_key" ON "public"."agent_levels"("rank");

-- CreateIndex
CREATE INDEX "agent_levels_isActive_rank_idx" ON "public"."agent_levels"("isActive", "rank");

-- CreateIndex
CREATE INDEX "agent_commission_overrides_scope_isActive_idx" ON "public"."agent_commission_overrides"("scope", "isActive");

-- CreateIndex
CREATE INDEX "agent_commission_overrides_vendorId_idx" ON "public"."agent_commission_overrides"("vendorId");

-- CreateIndex
CREATE INDEX "agent_commission_overrides_agentId_idx" ON "public"."agent_commission_overrides"("agentId");

-- CreateIndex
CREATE INDEX "agent_commission_overrides_categoryId_idx" ON "public"."agent_commission_overrides"("categoryId");

-- CreateIndex
CREATE INDEX "agent_bonus_rules_isActive_idx" ON "public"."agent_bonus_rules"("isActive");

-- CreateIndex
CREATE INDEX "agent_bonus_awards_agentId_idx" ON "public"."agent_bonus_awards"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_bonus_awards_ruleId_agentId_vendorKey_periodKey_key" ON "public"."agent_bonus_awards"("ruleId", "agentId", "vendorKey", "periodKey");

-- CreateIndex
CREATE INDEX "agent_commissions_agentId_status_idx" ON "public"."agent_commissions"("agentId", "status");

-- CreateIndex
CREATE INDEX "agent_commissions_agentId_earnedAt_idx" ON "public"."agent_commissions"("agentId", "earnedAt");

-- CreateIndex
CREATE INDEX "agent_commissions_vendorId_idx" ON "public"."agent_commissions"("vendorId");

-- CreateIndex
CREATE INDEX "agent_commissions_orderId_idx" ON "public"."agent_commissions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_commissions_deliveryId_orderItemId_key" ON "public"."agent_commissions"("deliveryId", "orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_commission_reversals_commissionId_vendorReturnId_key" ON "public"."agent_commission_reversals"("commissionId", "vendorReturnId");

-- CreateIndex
CREATE INDEX "agent_wallet_transactions_agentId_createdAt_idx" ON "public"."agent_wallet_transactions"("agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_wallet_transactions_type_refType_refId_key" ON "public"."agent_wallet_transactions"("type", "refType", "refId");

-- CreateIndex
CREATE INDEX "agent_payout_methods_agentId_idx" ON "public"."agent_payout_methods"("agentId");

-- CreateIndex
CREATE INDEX "agent_withdrawals_status_createdAt_idx" ON "public"."agent_withdrawals"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_withdrawals_agentId_clientRequestId_key" ON "public"."agent_withdrawals"("agentId", "clientRequestId");

-- CreateIndex
CREATE INDEX "agent_training_resources_isPublished_category_idx" ON "public"."agent_training_resources"("isPublished", "category");

-- AddForeignKey
ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "public"."agent_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_sessions" ADD CONSTRAINT "agent_sessions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_password_resets" ADD CONSTRAINT "agent_password_resets_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_vendor_links" ADD CONSTRAINT "agent_vendor_links_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_vendor_links" ADD CONSTRAINT "agent_vendor_links_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_commission_overrides" ADD CONSTRAINT "agent_commission_overrides_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_commission_overrides" ADD CONSTRAINT "agent_commission_overrides_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_commission_overrides" ADD CONSTRAINT "agent_commission_overrides_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_bonus_awards" ADD CONSTRAINT "agent_bonus_awards_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "public"."agent_bonus_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_bonus_awards" ADD CONSTRAINT "agent_bonus_awards_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_commissions" ADD CONSTRAINT "agent_commissions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_commission_reversals" ADD CONSTRAINT "agent_commission_reversals_commissionId_fkey" FOREIGN KEY ("commissionId") REFERENCES "public"."agent_commissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_wallets" ADD CONSTRAINT "agent_wallets_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_wallet_transactions" ADD CONSTRAINT "agent_wallet_transactions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_payout_methods" ADD CONSTRAINT "agent_payout_methods_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_withdrawals" ADD CONSTRAINT "agent_withdrawals_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_withdrawals" ADD CONSTRAINT "agent_withdrawals_payoutMethodId_fkey" FOREIGN KEY ("payoutMethodId") REFERENCES "public"."agent_payout_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────
-- Constraints Prisma cannot express (raw SQL, same technique as
-- 20261008020000_platform_courier_credential_unique).
-- ─────────────────────────────────────────────────────────────────────────

-- One OPEN agent link per vendor (history rows have endedAt set).
CREATE UNIQUE INDEX "agent_vendor_links_one_open_per_vendor"
  ON "public"."agent_vendor_links" ("vendorId") WHERE "endedAt" IS NULL;
ALTER TABLE "public"."agent_vendor_links"
  ADD CONSTRAINT "agent_vendor_links_period_chk" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");

-- One ACTIVE override per target, and the target must match the scope.
CREATE UNIQUE INDEX "agent_overrides_one_active_vendor"
  ON "public"."agent_commission_overrides" ("vendorId") WHERE "scope" = 'VENDOR' AND "isActive";
CREATE UNIQUE INDEX "agent_overrides_one_active_agent"
  ON "public"."agent_commission_overrides" ("agentId") WHERE "scope" = 'AGENT' AND "isActive";
CREATE UNIQUE INDEX "agent_overrides_one_active_category"
  ON "public"."agent_commission_overrides" ("categoryId") WHERE "scope" = 'CATEGORY' AND "isActive";
ALTER TABLE "public"."agent_commission_overrides"
  ADD CONSTRAINT "agent_overrides_target_chk" CHECK (
    ("scope" = 'VENDOR'   AND "vendorId"   IS NOT NULL AND "agentId" IS NULL  AND "categoryId" IS NULL) OR
    ("scope" = 'AGENT'    AND "agentId"    IS NOT NULL AND "vendorId" IS NULL AND "categoryId" IS NULL) OR
    ("scope" = 'CATEGORY' AND "categoryId" IS NOT NULL AND "vendorId" IS NULL AND "agentId"    IS NULL)
  ),
  ADD CONSTRAINT "agent_overrides_rate_chk" CHECK ("ratePercent" >= 0 AND "ratePercent" <= 100),
  ADD CONSTRAINT "agent_overrides_period_chk" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- Identity hygiene.
ALTER TABLE "public"."agents"
  ADD CONSTRAINT "agents_email_lower_chk" CHECK ("email" = lower(btrim("email"))),
  ADD CONSTRAINT "agents_token_version_chk" CHECK ("tokenVersion" >= 0);

-- Levels.
ALTER TABLE "public"."agent_levels"
  ADD CONSTRAINT "agent_levels_values_chk" CHECK (
    "minActiveVendors" >= 0 AND "minDeliveredSales" >= 0 AND
    ("minPerformanceScore" IS NULL OR ("minPerformanceScore" >= 0 AND "minPerformanceScore" <= 100)) AND
    ("commissionPercent" IS NULL OR ("commissionPercent" >= 0 AND "commissionPercent" <= 100)) AND
    ("bonusAmount" IS NULL OR "bonusAmount" >= 0)
  );

-- Bonus rules and awards.
ALTER TABLE "public"."agent_bonus_rules"
  ADD CONSTRAINT "agent_bonus_rules_values_chk" CHECK ("threshold" > 0 AND "amount" > 0),
  ADD CONSTRAINT "agent_bonus_rules_period_chk" CHECK ("validTo" IS NULL OR "validTo" > "validFrom"),
  ADD CONSTRAINT "agent_bonus_rules_scope_metric_chk" CHECK (
    "scope" = 'PER_AGENT' OR "metric" IN ('DELIVERED_ORDERS', 'DELIVERED_SALES')
  );
ALTER TABLE "public"."agent_bonus_awards"
  ADD CONSTRAINT "agent_bonus_awards_amount_chk" CHECK ("amount" > 0);

-- Commission ledger.
ALTER TABLE "public"."agent_commissions"
  ADD CONSTRAINT "agent_commissions_values_chk" CHECK (
    "quantity" > 0 AND "baseAmount" >= 0 AND "amount" >= 0 AND
    "ratePercent" >= 0 AND "ratePercent" <= 100 AND
    "holdDays" >= 0 AND ("durationMonths" IS NULL OR "durationMonths" > 0) AND
    "reversedQty" >= 0 AND "reversedQty" <= "quantity" AND
    "reversedAmount" >= 0 AND "reversedAmount" <= "amount" AND
    "availableAt" >= "earnedAt"
  );
ALTER TABLE "public"."agent_commission_reversals"
  ADD CONSTRAINT "agent_commission_reversals_values_chk" CHECK ("quantity" > 0 AND "amount" >= 0);

-- Wallet. "available" may go negative only if a reversal lands after a
-- withdrawal (business decision C5) — so it is deliberately not constrained.
ALTER TABLE "public"."agent_wallets"
  ADD CONSTRAINT "agent_wallets_values_chk" CHECK (
    "pendingClearance" >= 0 AND "onHold" >= 0 AND "totalEarned" >= 0 AND "totalWithdrawn" >= 0
  );
ALTER TABLE "public"."agent_wallet_transactions"
  ADD CONSTRAINT "agent_wallet_transactions_amount_chk" CHECK ("amount" <> 0);

-- Withdrawals.
ALTER TABLE "public"."agent_withdrawals"
  ADD CONSTRAINT "agent_withdrawals_values_chk" CHECK (
    "amount" > 0 AND "fee" >= 0 AND "netAmount" = "amount" - "fee" AND "netAmount" > 0
  ),
  ADD CONSTRAINT "agent_withdrawals_paid_chk" CHECK (
    "status" <> 'PAID' OR ("paidAt" IS NOT NULL AND "transactionRef" IS NOT NULL)
  );
