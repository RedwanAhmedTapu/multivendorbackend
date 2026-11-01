// tests/chat-agent-schema.test.ts
//
// P10 Stage 3: the agent-chat migration is additive only, and the schema
// matches it (enum values appended, nullable columns, Restrict FKs to agents,
// the partial unique index, existing cascades untouched).
//   npx tsx --test tests/chat-agent-schema.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sql = read("prisma/migrations/20261103000000_agent_chat_participant/migration.sql");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const schema = read("prisma/schema.prisma");
const block = (name: string) => schema.match(new RegExp(`\\n(model|enum) ${name} \\{[\\s\\S]*?\\n\\}`))![0];

test("migration is additive: no DROP, no column change, no data update", () => {
  for (const bad of [/\bDROP\b/i, /ALTER COLUMN/i, /\bRENAME\b/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /SET NOT NULL/i]) assert.doesNotMatch(code, bad, String(bad));
  for (const add of [
    `ALTER TYPE "public"."ParticipantType" ADD VALUE IF NOT EXISTS 'AGENT'`,
    `ALTER TYPE "public"."ConversationType" ADD VALUE IF NOT EXISTS 'AGENT_SUPPORT'`,
    `ALTER TYPE "public"."ConversationType" ADD VALUE IF NOT EXISTS 'AGENT_VENDOR'`,
    `ALTER TABLE "public"."conversation_participants" ADD COLUMN "agentId" TEXT`,
    `ALTER TABLE "public"."messages" ADD COLUMN "senderAgentId" TEXT`,
    `ALTER TABLE "public"."conversations" ADD COLUMN "agentLinkId" TEXT`,
  ]) assert.ok(code.includes(add), add);
  assert.match(code, /"conversation_participants_agentId_fkey"[\s\S]*?ON DELETE RESTRICT/);
  assert.match(code, /"messages_senderAgentId_fkey"[\s\S]*?ON DELETE RESTRICT/);
  assert.match(code, /CREATE UNIQUE INDEX "conversation_participants_one_row_per_agent"\s+ON "public"\."conversation_participants"\("conversationId", "agentId"\)\s+WHERE "agentId" IS NOT NULL/);
});

test("schema mirrors the migration; agent relations Restrict; existing identity relations still Cascade", () => {
  const p = block("ConversationParticipant");
  assert.match(p, /agentId\s+String\?/);
  assert.match(p, /agent\s+Agent\?\s+@relation\("AgentChatParticipants", fields: \[agentId\], references: \[id\], onDelete: Restrict\)/);
  for (const rel of ["user ", "vendor ", "employee ", "deliveryPerson "]) assert.match(p.split("\n").find((l) => l.trim().startsWith(rel))!, /onDelete: Cascade/);
  const m = block("Message");
  assert.match(m, /senderAgentId\s+String\?/);
  assert.match(m, /senderAgent\s+Agent\?\s+@relation\("AgentChatMessages", fields: \[senderAgentId\], references: \[id\], onDelete: Restrict\)/);
  assert.match(block("Conversation"), /agentLinkId\s+String\?/);
  assert.match(block("Agent"), /chatParticipants ConversationParticipant\[\] @relation\("AgentChatParticipants"\)/);
});
