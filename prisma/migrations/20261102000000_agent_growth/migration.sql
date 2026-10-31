-- Agent Commission System — Phase 9 (growth features) and the P8–9 extras.
-- docs/agent-system-plan.md §10.
--
-- ADDITIVE ONLY: three audit-entity enum values. No table, column, index or
-- constraint is changed or dropped. Levels, bonus rules/awards and training
-- resources already exist (Phase 1); the new admin settings
-- (performanceWeights, vendorAlertRules) are rows in agent_settings.
--
--   TRAINING     training resource create / update / delete
--   WALLET       admin wallet adjustment (ledger ADJUSTMENT)
--   BONUS_AWARD  automatic bonus award (milestone rule or level-up bonus)
--
-- ALTER TYPE … ADD VALUE is allowed inside a transaction on PostgreSQL 12+
-- as long as the new value is not used in the same transaction (it isn't).

ALTER TYPE "public"."AgentConfigEntity" ADD VALUE IF NOT EXISTS 'TRAINING';
ALTER TYPE "public"."AgentConfigEntity" ADD VALUE IF NOT EXISTS 'WALLET';
ALTER TYPE "public"."AgentConfigEntity" ADD VALUE IF NOT EXISTS 'BONUS_AWARD';
