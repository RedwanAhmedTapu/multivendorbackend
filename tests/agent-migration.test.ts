// tests/agent-migration.test.ts
//
// The agent migration's raw-SQL guarantees that schema.prisma cannot express
// (partial unique indexes, CHECKs) must stay in the migration, flagged so a
// generated `prisma migrate dev` DROP is never accepted.
//   npx tsx --test tests/agent-migration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../prisma/migrations/20261031000000_agent_commission_system/migration.sql", import.meta.url), "utf8");
const code = sql.replace(/--[^\n]*/g, "");

test("the four partial unique indexes exist, with their WHERE clauses", () => {
  const want: Array<[string, RegExp]> = [
    ["agent_vendor_links_one_open_per_vendor", /ON "public"\."agent_vendor_links" \("vendorId"\) WHERE "endedAt" IS NULL/],
    ["agent_overrides_one_active_vendor", /\("vendorId"\) WHERE "scope" = 'VENDOR' AND "isActive"/],
    ["agent_overrides_one_active_agent", /\("agentId"\) WHERE "scope" = 'AGENT' AND "isActive"/],
    ["agent_overrides_one_active_category", /\("categoryId"\) WHERE "scope" = 'CATEGORY' AND "isActive"/],
  ];
  for (const [name, where] of want) {
    assert.ok(code.includes(`CREATE UNIQUE INDEX "${name}"`), `${name} created`);
    assert.match(code, where, `${name} is partial`);
  }
});

test("the migration warns that Prisma can't see them, and names each one", () => {
  assert.match(sql, /WARNING — INVISIBLE TO PRISMA/);
  const warning = sql.slice(sql.indexOf("WARNING — INVISIBLE TO PRISMA"), sql.indexOf("-- One OPEN agent link per vendor"));
  for (const name of ["agent_vendor_links_one_open_per_vendor", "agent_overrides_one_active_vendor", "agent_overrides_one_active_agent", "agent_overrides_one_active_category"]) {
    assert.ok(warning.includes(name), `${name} listed in the warning`);
  }
  assert.match(warning, /NEVER accept such a DROP/);
});

test("additive only: no DROP, no ALTER of a pre-existing table", () => {
  assert.doesNotMatch(code, /\bDROP\b/i);
  const altered = [...code.matchAll(/ALTER TABLE "public"\."([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(altered.length > 0);
  for (const t of altered) assert.ok(t === "agents" || t.startsWith("agent_"), `only new agent tables are altered (got ${t})`);
});
