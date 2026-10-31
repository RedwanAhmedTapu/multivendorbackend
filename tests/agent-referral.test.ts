// tests/agent-referral.test.ts
//
// Phase 8 referral attribution, DB-free: code normalization, attach rules
// (unknown / inactive / already linked never link, never throw), the
// never-blocking signup hook, and the agent's referral stats and list.
//
//   npx tsx --test tests/agent-referral.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { installAgentFakeDb, makeTable } = await import("./support/agent-fake-db.ts");
const { aggregates } = await import("./support/agent-wallet-fake.ts");
const ref = await import("../src/modules/agent/services/agent-referral.service.ts");

let fake: ReturnType<typeof installAgentFakeDb>;
const NOW = new Date("2026-11-10T06:00:00Z");

beforeEach(async () => {
  fake = installAgentFakeDb();
  const db = fake.db;
  db.agentCommission = makeTable("commission", { defaults: () => ({ reversedAmount: "0.00" }) });
  aggregates(db.agentCommission);
  // groupBy over several vendor ids, keyed by vendorId
  db.agentVendorLink = makeTable("link", {
    defaults: () => ({ endedAt: null, startedAt: new Date() }),
    relations: { vendor: () => (row: any, select: any) => {
      const v = db.vendor.rows.find((x: any) => x.id === row.vendorId);
      return v ? Object.fromEntries(Object.keys(select).map((k) => [k, v[k]])) : null;
    } },
  });
  await db.agent.create({ data: { id: "A1", agentCode: "AG-AAAAAA", referralCode: "REF-ABCD1234", name: "Rahim", email: "a1@x.com", passwordHash: "x", status: "ACTIVE" } });
  await db.agent.create({ data: { id: "A2", agentCode: "AG-BBBBBB", referralCode: "REF-SUSP0001", name: "Karim", email: "a2@x.com", passwordHash: "x", status: "SUSPENDED" } });
  await db.vendor.create({ data: { id: "V1", storeName: "Dhaka Fashion", status: "PENDING" } });
  await db.vendor.create({ data: { id: "V2", storeName: "Chittagong Tea", status: "ACTIVE" } });
});
afterEach(() => fake.restore());

const links = () => fake.db.agentVendorLink.rows as any[];

test("normalizeReferralCode accepts REF- codes in any case, rejects everything else", () => {
  assert.equal(ref.normalizeReferralCode(" ref-abcd1234 "), "REF-ABCD1234");
  for (const bad of [null, undefined, 42, "", "ABCD1234", "REF-", "REF-ab cd", "REF-<script>", "REF-" + "A".repeat(17)]) {
    assert.equal(ref.normalizeReferralCode(bad), null, String(bad));
  }
});

test("a valid code links the new vendor to the agent (REFERRAL_CODE), audited as the system", async () => {
  const r = await ref.attachVendorToAgentByCode("V1", "ref-abcd1234", NOW);
  assert.equal(r.status, "LINKED");
  assert.equal(links().length, 1);
  assert.equal(links()[0].source, "REFERRAL_CODE");
  assert.equal(links()[0].agentId, "A1");
  assert.equal(links()[0].startedAt.getTime(), NOW.getTime());
  const audit = fake.db.agentConfigAudit.rows[0];
  assert.equal(audit.entity, "VENDOR_LINK");
  assert.equal(audit.actorUserId, "system:referral-signup");
});

test("invalid, unknown and inactive-agent codes and already-linked vendors never link", async () => {
  assert.deepEqual(await ref.attachVendorToAgentByCode("V1", ""), { status: "SKIPPED", reason: "NO_CODE" });
  assert.deepEqual(await ref.attachVendorToAgentByCode("V1", "nope"), { status: "SKIPPED", reason: "INVALID_CODE" });
  assert.deepEqual(await ref.attachVendorToAgentByCode("V1", "REF-ZZZZ9999"), { status: "SKIPPED", reason: "UNKNOWN_CODE" });
  assert.deepEqual(await ref.attachVendorToAgentByCode("V1", "REF-SUSP0001"), { status: "SKIPPED", reason: "AGENT_NOT_ACTIVE" });
  assert.deepEqual(await ref.attachVendorToAgentByCode("V9", "REF-ABCD1234"), { status: "SKIPPED", reason: "VENDOR_NOT_FOUND" });
  await fake.db.agentVendorLink.create({ data: { agentId: "A2", vendorId: "V1", source: "ADMIN_ASSIGNED", startedAt: NOW } });
  assert.deepEqual(await ref.attachVendorToAgentByCode("V1", "REF-ABCD1234"), { status: "SKIPPED", reason: "ALREADY_LINKED" }, "one open link per vendor");
  assert.equal(links().length, 1);
});

test("a concurrent link (partial unique index → P2002) is reported as ALREADY_LINKED", async () => {
  fake.db.agentVendorLink.create = async () => {
    const err: any = new Error("unique");
    err.code = "P2002";
    throw err;
  };
  assert.deepEqual(await ref.attachVendorToAgentByCode("V1", "REF-ABCD1234"), { status: "SKIPPED", reason: "ALREADY_LINKED" });
});

test("the signup hook never throws, even when the database fails", async () => {
  fake.db.agent.findUnique = async () => {
    throw new Error("connection reset");
  };
  assert.deepEqual(await ref.attachVendorToAgentByCodeSafe("V1", "REF-ABCD1234"), { status: "FAILED" });
  assert.deepEqual(await ref.attachVendorToAgentByCodeSafe(null, "REF-ABCD1234"), { status: "SKIPPED", reason: "VENDOR_NOT_FOUND" });
});

test("signup wiring: agentRef is optional, vendor-only, attached after the vendor exists, through the Safe hook", () => {
  const src = readFileSync(new URL("../src/modules/auth/controllers/auth.controller.ts", import.meta.url), "utf8");
  assert.match(src, /role === "VENDOR" \? normalizeReferralCode\(req\.body\?\.agentRef\) : null/);
  const verifyEmail = src.slice(src.indexOf("export const verifyEmail"), src.indexOf("export const verifyOtp"));
  const verifyOtp = src.slice(src.indexOf("export const verifyOtp"), src.indexOf("export const login"));
  for (const block of [verifyEmail, verifyOtp]) {
    const create = block.indexOf("authService.registerUser(");
    const hook = block.indexOf("attachVendorToAgentByCodeSafe(");
    assert.ok(create > 0 && hook > create, "hook runs after the user and vendor are created");
    assert.ok(!/attachVendorToAgentByCode\(/.test(block), "only the never-throwing wrapper is used");
  }
  const site = readFileSync(new URL("../../multivendorsite/src/components/vendorregistrationform/VendorRegistrationForm.tsx", import.meta.url), "utf8");
  assert.match(site, /searchParams\.get\("ref"\)|get\("ref"\)/, "the site vendor signup reads ?ref=");
  assert.match(site, /agentRef/);
});

test("agent referral stats and referred vendors: own links only, store names only, net commission", async () => {
  await ref.attachVendorToAgentByCode("V1", "REF-ABCD1234", NOW);
  await fake.db.agentVendorLink.create({ data: { agentId: "A1", vendorId: "V2", source: "ADMIN_ASSIGNED", startedAt: NOW } });
  await fake.db.agentCommission.create({ data: { agentId: "A1", vendorId: "V1", amount: "30.00", reversedAmount: "5.00" } });
  await fake.db.agentCommission.create({ data: { agentId: "A1", vendorId: "V2", amount: "99.00", reversedAmount: "0.00" } });
  const info = await ref.referralInfo("A1", NOW);
  assert.equal(info.code, "REF-ABCD1234");
  assert.match(info.link, /\/vendor-register\?ref=REF-ABCD1234$/);
  assert.deepEqual(info.stats, { totalReferred: 1, activeLinks: 1, thisMonth: 1, earningVendors: 1, commissionFromReferrals: "25.00" });
  const list = await ref.referredVendors("A1", { page: 1, limit: 20 });
  assert.equal(list.total, 1);
  assert.deepEqual(Object.keys(list.items[0]).sort(), ["active", "commissionEarned", "endedAt", "linkId", "linkedAt", "storeName", "vendorId", "vendorStatus"]);
  assert.equal(list.items[0].storeName, "Dhaka Fashion");
  assert.equal(list.items[0].commissionEarned, "25.00");
  assert.equal((await ref.referredVendors("A2", { page: 1, limit: 20 })).total, 0);
});
