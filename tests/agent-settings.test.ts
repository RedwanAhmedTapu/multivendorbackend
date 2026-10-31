// tests/agent-settings.test.ts
//
// Admin-controlled agent settings: nothing seeded, server-side validation
// (per field + cross-field on the merged state), audit row per changed key
// written in the same transaction, unchanged keys skipped, cache with
// invalidation, defensive re-validation of stored values.
//
//   npx tsx --test tests/agent-settings.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const settings = await import("../src/modules/agent/services/agent-settings.service.ts");
const { installAgentFakeDb } = await import("./support/agent-fake-db.ts");

let fake: ReturnType<typeof installAgentFakeDb>;
const actor = { userId: "U_ADMIN", name: "Admin", ip: "10.0.0.1", userAgent: "jest" };

beforeEach(() => {
  settings.invalidateAgentSettingsCache();
  fake = installAgentFakeDb();
});
afterEach(() => fake.restore());

const fieldErrors = (e: any) => e?.details?.errors ?? {};

test("nothing is seeded: every key reads as not configured", async () => {
  const snap = await settings.getAgentSettings();
  assert.deepEqual(snap.missing.sort(), [...settings.SETTING_KEYS].sort());
  assert.ok(Object.values(snap.values).every((v) => v === null));
});

test("a feature that needs unconfigured keys refuses with 409 listing them", async () => {
  const snap = await settings.getAgentSettings();
  assert.throws(
    () => settings.requireConfigured(snap, ["minWithdrawalAmount", "withdrawalFee"], "Withdrawals"),
    (e: any) => e.statusCode === 409 && e.code === "SETTINGS_NOT_CONFIGURED" && e.details.missing.length === 2,
  );
});

test("registration approval fails safe to TRUE when never saved", async () => {
  assert.equal(await settings.registrationRequiresApproval(), true);
});

test("valid values are normalized (exact decimals) and saved with one audit row each", async () => {
  const { snapshot, changed } = await settings.updateAgentSettings(
    {
      defaultCommissionPercent: "5.5",
      minWithdrawalAmount: 500,
      maxWithdrawalAmount: "50000.5",
      holdDays: 7,
      commissionDurationMonths: null,
      withdrawalFee: { type: "FLAT", amount: 10 },
      enabledPayoutMethods: ["BKASH", "NAGAD", "BANK"],
      autoApproveWithdrawalLimit: 0,
      registrationRequiresApproval: true,
      ratePrecedence: ["VENDOR", "AGENT", "LEVEL", "GLOBAL"],
    },
    actor,
  );
  assert.equal(changed.length, 10);
  assert.equal(snapshot.values.defaultCommissionPercent, "5.5000");
  assert.equal(snapshot.values.minWithdrawalAmount, "500.00");
  assert.equal(snapshot.values.maxWithdrawalAmount, "50000.50");
  assert.deepEqual(snapshot.values.withdrawalFee, { type: "FLAT", amount: "10.00" });
  assert.equal(snapshot.values.commissionDurationMonths, null);
  assert.ok(!snapshot.missing.includes("commissionDurationMonths"), "a saved null is configured (= lifetime)");
  assert.equal(snapshot.missing.length, 0);

  const audits = fake.db.agentConfigAudit.rows;
  assert.equal(audits.length, 10);
  const pct = audits.find((a: any) => a.entityId === "defaultCommissionPercent");
  assert.equal(pct.entity, "SETTING");
  assert.equal(pct.action, "CREATE");
  assert.equal(pct.actorUserId, "U_ADMIN");
  assert.equal(pct.actorName, "Admin");
  assert.equal(pct.ip, "10.0.0.1");
  assert.deepEqual(pct.newValue, { value: "5.5000" });
  assert.ok(fake.db.agentSetting.rows.every((r: any) => r.updatedById === "U_ADMIN"));
});

test("an update records old and new values; unchanged values write nothing", async () => {
  await settings.updateAgentSettings({ holdDays: 7, defaultCommissionPercent: 5 }, actor);
  const before = fake.db.agentConfigAudit.rows.length;
  const { changed } = await settings.updateAgentSettings({ holdDays: 10, defaultCommissionPercent: "5.0000" }, { ...actor, userId: "U2" });
  assert.deepEqual(changed, ["holdDays"]);
  const rows = fake.db.agentConfigAudit.rows.slice(before);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "UPDATE");
  assert.deepEqual(rows[0].oldValue, { value: 7 });
  assert.deepEqual(rows[0].newValue, { value: 10 });
  assert.equal(rows[0].actorUserId, "U2");
});

test("per-field validation: every bad value is reported, nothing is written", async () => {
  const bad = {
    defaultCommissionPercent: 101,
    minWithdrawalAmount: "12.345",
    maxWithdrawalAmount: 0,
    holdDays: 2.5,
    commissionDurationMonths: 0,
    withdrawalFee: { type: "PERCENT", percent: -1 },
    enabledPayoutMethods: [],
    autoApproveWithdrawalLimit: "abc",
    registrationRequiresApproval: "yes",
    ratePrecedence: ["GLOBAL", "VENDOR", "AGENT", "LEVEL"],
    somethingElse: 1,
  };
  await assert.rejects(settings.updateAgentSettings(bad, actor), (e: any) => {
    const errs = fieldErrors(e);
    assert.equal(e.statusCode, 400);
    for (const key of Object.keys(bad)) assert.ok(errs[key], `error for ${key}`);
    assert.equal(errs.somethingElse, "Unknown setting");
    return true;
  });
  assert.equal(fake.db.agentSetting.rows.length, 0);
  assert.equal(fake.db.agentConfigAudit.rows.length, 0);
});

test("precedence rules: unique, required sources present, GLOBAL last; CATEGORY optional", () => {
  const parse = (v: unknown) => settings.parseSettingValue("ratePrecedence", v);
  assert.deepEqual(parse(["VENDOR", "AGENT", "LEVEL", "GLOBAL"]), ["VENDOR", "AGENT", "LEVEL", "GLOBAL"]);
  assert.deepEqual(parse(["VENDOR", "AGENT", "CATEGORY", "LEVEL", "GLOBAL"]).length, 5);
  assert.throws(() => parse(["VENDOR", "VENDOR", "LEVEL", "GLOBAL"]));
  assert.throws(() => parse(["VENDOR", "LEVEL", "GLOBAL", "CATEGORY"]));
  assert.throws(() => parse(["VENDOR", "AGENT", "GLOBAL", "LEVEL"]));
  assert.throws(() => parse(["VENDOR", "AGENT", "LEVEL", "GLOBAL", "OTHER"]));
});

test("cross-field rules are checked against the MERGED state", async () => {
  await settings.updateAgentSettings({ minWithdrawalAmount: 500, maxWithdrawalAmount: 50000 }, actor);
  await assert.rejects(settings.updateAgentSettings({ maxWithdrawalAmount: 499 }, actor), (e: any) => !!fieldErrors(e).maxWithdrawalAmount);
  await assert.rejects(settings.updateAgentSettings({ autoApproveWithdrawalLimit: 60000 }, actor), (e: any) => !!fieldErrors(e).autoApproveWithdrawalLimit);
  await assert.rejects(settings.updateAgentSettings({ withdrawalFee: { type: "FLAT", amount: 500 } }, actor), (e: any) => !!fieldErrors(e).withdrawalFee);
  // both sides changed together in one valid update is fine
  const ok = await settings.updateAgentSettings({ minWithdrawalAmount: 100, maxWithdrawalAmount: 200, withdrawalFee: { type: "FLAT", amount: 20 } }, actor);
  assert.equal(ok.snapshot.values.maxWithdrawalAmount, "200.00");
});

test("unknown keys and non-object bodies are rejected", async () => {
  await assert.rejects(settings.updateAgentSettings([], actor), (e: any) => e.statusCode === 400);
  await assert.rejects(settings.updateAgentSettings({}, actor), (e: any) => e.statusCode === 400);
  await assert.rejects(settings.updateAgentSettings({ __proto__x: 1 }, actor), (e: any) => fieldErrors(e).__proto__x === "Unknown setting");
});

test("cache: served within the TTL, invalidated on save, bypassed with fresh", async () => {
  let reads = 0;
  const orig = fake.db.agentSetting.findMany;
  fake.db.agentSetting.findMany = async (args: any) => {
    reads++;
    return orig(args);
  };
  await settings.getAgentSettings();
  await settings.getAgentSettings();
  assert.equal(reads, 1, "second read from cache");
  await settings.getAgentSettings({ fresh: true });
  assert.equal(reads, 2, "fresh bypasses the cache");
  await settings.updateAgentSettings({ holdDays: 3 }, actor);
  const after = reads;
  const snap = await settings.getAgentSettings();
  assert.equal(snap.values.holdDays, 3, "save invalidated the cache");
  assert.equal(reads, after, "the post-save fresh read refilled the cache");
});

test("a hand-edited invalid stored value is treated as not configured", async () => {
  await fake.db.agentSetting.create({ data: { key: "defaultCommissionPercent", value: { value: "150" }, updatedById: null } });
  await fake.db.agentSetting.create({ data: { key: "holdDays", value: 5, updatedById: null } }); // not boxed
  await fake.db.agentSetting.create({ data: { key: "legacyKey", value: { value: 1 }, updatedById: null } });
  const snap = await settings.getAgentSettings({ fresh: true });
  assert.equal(snap.values.defaultCommissionPercent, null);
  assert.ok(snap.missing.includes("defaultCommissionPercent"));
  assert.ok(snap.missing.includes("holdDays"), "malformed (unboxed) value ignored");
});

test("withdrawal fee arithmetic is exact (half-up to paisa)", () => {
  assert.equal(settings.withdrawalFeeFor("1000.00", null), "0.00");
  assert.equal(settings.withdrawalFeeFor("1000.00", { type: "NONE" }), "0.00");
  assert.equal(settings.withdrawalFeeFor("1000.00", { type: "FLAT", amount: "15.00" }), "15.00");
  assert.equal(settings.withdrawalFeeFor("333.33", { type: "PERCENT", percent: "1.5000" }), "5.00");
  assert.equal(settings.withdrawalFeeFor("100.10", { type: "PERCENT", percent: "2.5000" }), "2.50");
});

test("a failed save rolls back: no setting and no audit row", async () => {
  const origCreate = fake.db.agentConfigAudit.create;
  fake.db.$transaction = async (fn: any) => {
    // simulate an atomic transaction: snapshot, run, restore on error
    const snapshot = { s: [...fake.db.agentSetting.rows], a: [...fake.db.agentConfigAudit.rows] };
    try {
      return await fn(fake.db);
    } catch (e) {
      fake.db.agentSetting.rows.splice(0, Infinity, ...snapshot.s);
      fake.db.agentConfigAudit.rows.splice(0, Infinity, ...snapshot.a);
      throw e;
    }
  };
  fake.db.agentConfigAudit.create = async () => {
    throw new Error("audit write failed");
  };
  await assert.rejects(settings.updateAgentSettings({ holdDays: 5 }, actor));
  assert.equal(fake.db.agentSetting.rows.length, 0);
  fake.db.agentConfigAudit.create = origCreate;
});
