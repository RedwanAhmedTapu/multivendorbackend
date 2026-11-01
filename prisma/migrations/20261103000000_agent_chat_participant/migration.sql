-- Agent chat inside the existing chat module (P10, Stage 3).
-- docs/agent-system-plan.md §10, docs/agent-messaging-plan.md.
--
-- ADDITIVE ONLY. No existing column, index, constraint or enum value changes
-- meaning; existing rows are untouched (all new columns are NULL for them).
--
--   ParticipantType.AGENT           an agent (agents table — never a User/Vendor/Employee row)
--   ConversationType.AGENT_SUPPORT  agent ↔ FinixMart staff (shared staff inbox per agent)
--   ConversationType.AGENT_VENDOR   agent ↔ one currently linked vendor
--   conversation_participants.agentId   the agent's participant row
--   messages.senderAgentId               the agent as sender
--   conversations.agentLinkId            AGENT_VENDOR only: the agent_vendor_links row the
--                                        conversation belongs to (a new link ⇒ a new conversation)
--
-- ON DELETE RESTRICT for both agent FKs: agents are never hard-deleted (status
-- only), and the existing chat's CASCADE rule would silently erase the other
-- side's history (audit §2 #12). Existing FKs keep their CASCADE.
--
-- The existing @@unique([conversationId, userId, vendorId, employeeId,
-- deliveryPersonId]) never fires for NULLs; agent rows get their own partial
-- unique index instead: one row per (conversation, agent).
--
-- ALTER TYPE … ADD VALUE: PostgreSQL 12+ allows it in a transaction as long as
-- the new value is not used in the same transaction (it isn't).

ALTER TYPE "public"."ParticipantType" ADD VALUE IF NOT EXISTS 'AGENT';
ALTER TYPE "public"."ConversationType" ADD VALUE IF NOT EXISTS 'AGENT_SUPPORT';
ALTER TYPE "public"."ConversationType" ADD VALUE IF NOT EXISTS 'AGENT_VENDOR';

ALTER TABLE "public"."conversation_participants" ADD COLUMN "agentId" TEXT;
ALTER TABLE "public"."messages" ADD COLUMN "senderAgentId" TEXT;
ALTER TABLE "public"."conversations" ADD COLUMN "agentLinkId" TEXT;

ALTER TABLE "public"."conversation_participants"
  ADD CONSTRAINT "conversation_participants_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."messages"
  ADD CONSTRAINT "messages_senderAgentId_fkey"
  FOREIGN KEY ("senderAgentId") REFERENCES "public"."agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "conversation_participants_agentId_isMuted_idx" ON "public"."conversation_participants"("agentId", "isMuted");
CREATE INDEX "messages_senderAgentId_createdAt_idx" ON "public"."messages"("senderAgentId", "createdAt");
CREATE INDEX "conversations_agentLinkId_idx" ON "public"."conversations"("agentLinkId");

-- Raw-SQL guarantee Prisma can't express (never accept a generated DROP of it):
CREATE UNIQUE INDEX "conversation_participants_one_row_per_agent"
  ON "public"."conversation_participants"("conversationId", "agentId")
  WHERE "agentId" IS NOT NULL;
