-- Agent Commission System — Phase 7 (wallet and withdrawals).
-- docs/agent-system-plan.md §2, §10.
--
-- ADDITIVE ONLY: two nullable columns, two indexes and three enum values.
-- No existing column, row, index or constraint is changed or dropped.
--
-- agent_commissions.walletCreditedAt         set once, when the commission's
--   amount is credited to the agent's wallet ledger (after holdDays).
-- agent_commission_reversals.walletPostedAt  set once, when the reversal is
--   debited from the wallet ledger (only after its commission was credited).
-- Both are lifecycle markers, NOT snapshot columns. Existing rows start NULL
-- and are picked up by the wallet sync, which posts each exactly once
-- (agent_wallet_transactions @@unique([type, refType, refId])).
--
-- ALTER TYPE … ADD VALUE is allowed inside a transaction on PostgreSQL 12+
-- as long as the new value is not used in the same transaction (it isn't).

ALTER TYPE "public"."AgentConfigEntity" ADD VALUE IF NOT EXISTS 'WITHDRAWAL';
ALTER TYPE "public"."AgentConfigEntity" ADD VALUE IF NOT EXISTS 'COMMISSION';
ALTER TYPE "public"."AgentConfigAction" ADD VALUE IF NOT EXISTS 'RERUN';

ALTER TABLE "public"."agent_commissions" ADD COLUMN "walletCreditedAt" TIMESTAMP(3);
ALTER TABLE "public"."agent_commission_reversals" ADD COLUMN "walletPostedAt" TIMESTAMP(3);

CREATE INDEX "agent_commissions_agentId_walletCreditedAt_availableAt_idx"
  ON "public"."agent_commissions"("agentId", "walletCreditedAt", "availableAt");
CREATE INDEX "agent_commission_reversals_walletPostedAt_idx"
  ON "public"."agent_commission_reversals"("walletPostedAt");
