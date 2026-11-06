// tests/subscription-platform.test.ts
//
// Dynamic subscription platform (DB-free):
//   pure rules — states and grace, pricing with promo / discount / offers,
//   feature decisions and limits, periods, usage keys, settings;
//   service — plan builder (publish rules, duplicate, archive), payment
//   recording (amount check, idempotency, renewal), offers (vendor pricing,
//   hidden plans, revoke), entitlement + monitor mode, usage limits, vendor
//   isolation, jobs (expiry after grace, offer expiry never charges);
//   middleware — requireFeature 402 / 429 / monitor, owner-only billing guard,
//   additive POS fallback; migration is additive only.
//   npx tsx --test tests/subscription-platform.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addMonths,
  decideFeature,
  evaluateSubscription,
  mergeLimits,
  parseSubsSettings,
  periodFor,
  quote,
  usagePeriodKey,
  validateLimitConfig,
  validateLimitDefs,
  validateSubsSettings,
  type OfferRow,
} from "../src/modules/subscriptions/subscription.rules.ts";
import { createSubscriptionService, SubscriptionError } from "../src/modules/subscriptions/subscription.service.ts";
import { requireFeature } from "../src/modules/subscriptions/require-feature.middleware.ts";
import { requireVendorOwner } from "../src/modules/subscriptions/http.ts";
import { planGrantsPos } from "../src/middlewares/pos-entitlement.middleware.ts";
import { createFakeBillingDb } from "./support/fake-billing-db.ts";

const NOW = new Date("2026-11-06T06:00:00Z");
const D = (s: string) => new Date(s);
const ADMIN = { userId: "U_ADMIN", name: "Admin" };

// ─── pure rules ─────────────────────────────────────────────────────────────

test("subscription state: legacy rows are NONE; ACTIVE → GRACE → EXPIRED at exact boundaries; suspended/cancelled/pending never operate", () => {
  assert.equal(evaluateSubscription(null, NOW, 3).state, "NONE");
  assert.equal(evaluateSubscription({ status: null, packageId: null, expiresAt: null, graceDays: null }, NOW, 3).state, "NONE", "legacy planType-only row");
  const end = D("2026-11-06T06:00:00Z");
  const row = (status: string, expiresAt: Date | null, graceDays: number | null = null) => ({ status, packageId: "P", expiresAt, graceDays });
  assert.equal(evaluateSubscription(row("ACTIVE", end), new Date(end.getTime() - 1), 3).state, "ACTIVE");
  assert.equal(evaluateSubscription(row("ACTIVE", end), end, 3).state, "GRACE");
  assert.equal(evaluateSubscription(row("ACTIVE", end), new Date(end.getTime() + 3 * 86_400_000 - 1), 3).state, "GRACE");
  assert.equal(evaluateSubscription(row("ACTIVE", end), new Date(end.getTime() + 3 * 86_400_000), 3).state, "EXPIRED");
  assert.equal(evaluateSubscription(row("ACTIVE", end, 0), end, 3).state, "EXPIRED", "per-row grace overrides the default");
  assert.equal(evaluateSubscription(row("ACTIVE", null), NOW, 3).state, "ACTIVE", "open-ended complimentary");
  for (const s of ["SUSPENDED", "CANCELLED", "PENDING", "EXPIRED"]) assert.equal(evaluateSubscription(row(s, D("2030-01-01")), NOW, 3).state, s);
});

const offer = (o: Partial<OfferRow>): OfferRow => ({ id: "O1", kind: "PERCENT_DISCOUNT", status: "ACTIVE", packageId: "P", cycleId: null, featureId: null, value: "10", startsAt: D("2026-11-01"), endsAt: D("2026-12-01"), ...o });

test("pricing: promo price, discount %, vendor offers (never below 0), cheapest live offer wins, cycle-specific offers, FREE_PLAN is not a price", () => {
  assert.equal(quote({ price: "1000" }, [], "P", "C", NOW).finalPrice, "1000.00");
  assert.equal(quote({ price: "1000", promoPrice: "799" }, [], "P", "C", NOW).basePrice, "799.00");
  assert.equal(quote({ price: "1000", discountPercent: "15" }, [], "P", "C", NOW).basePrice, "850.00");
  assert.equal(quote({ price: "999.99", discountPercent: "33.33" }, [], "P", "C", NOW).basePrice, "666.69", "rounded half-up to 2 dp");
  const q = quote({ price: "1000", promoPrice: "800" }, [offer({ value: "10" })], "P", "C", NOW);
  assert.deepEqual([q.listPrice, q.basePrice, q.finalPrice, q.savings, q.offerId], ["1000.00", "800.00", "720.00", "280.00", "O1"], "% applies to the promo price");
  assert.equal(quote({ price: "1000" }, [offer({ kind: "FIXED_DISCOUNT", value: "5000" })], "P", "C", NOW).finalPrice, "0.00", "never below 0");
  assert.equal(quote({ price: "1000" }, [offer({ kind: "PRICE_OVERRIDE", value: "450" })], "P", "C", NOW).finalPrice, "450.00");
  const best = quote({ price: "1000" }, [offer({ id: "A", value: "10" }), offer({ id: "B", kind: "FIXED_DISCOUNT", value: "300" })], "P", "C", NOW);
  assert.equal(best.offerId, "B");
  assert.equal(quote({ price: "1000" }, [offer({ cycleId: "OTHER" })], "P", "C", NOW).finalPrice, "1000.00", "offer for another cycle");
  assert.equal(quote({ price: "1000" }, [offer({ packageId: "OTHER" })], "P", "C", NOW).finalPrice, "1000.00", "offer for another plan");
  for (const o of [offer({ status: "PAUSED" }), offer({ status: "REVOKED" }), offer({ endsAt: NOW }), offer({ startsAt: D("2026-11-07") })])
    assert.equal(quote({ price: "1000" }, [o], "P", "C", NOW).finalPrice, "1000.00", `${o.status} / window`);
  assert.equal(quote({ price: "1000" }, [offer({ kind: "FREE_PLAN", value: null })], "P", "C", NOW).finalPrice, "1000.00", "free access is an overlay, never a free paid period");
});

const feat = (over = {}) => ({ id: "F", key: "accounting", isActive: true, enforced: true, limitDefs: [{ key: "users", label: "Users", type: "number" as const }, { key: "export", label: "Export", type: "boolean" as const }], ...over });

test("feature decision: plan grant, inactive subscription, not in plan, offers, unenforced (allowed, not granted), deactivated feature, unknown feature", () => {
  const base = { feature: feat(), subState: "ACTIVE" as const, planAssignment: { enabled: true, config: { users: 3, export: false } }, freePlanAssignments: [], freeFeatureOfferIds: [] };
  const ok = decideFeature(base);
  assert.deepEqual([ok.allowed, ok.granted, ok.sources, ok.limits], [true, true, ["PLAN"], { users: 3, export: false }]);
  assert.equal(decideFeature({ ...base, subState: "GRACE" }).granted, true);
  const expired = decideFeature({ ...base, subState: "EXPIRED" });
  assert.deepEqual([expired.allowed, expired.reason], [false, "SUBSCRIPTION_INACTIVE"]);
  assert.equal(decideFeature({ ...base, subState: "NONE", planAssignment: null }).reason, "SUBSCRIPTION_INACTIVE");
  assert.equal(decideFeature({ ...base, planAssignment: { enabled: false, config: {} } }).reason, "FEATURE_NOT_IN_PLAN");
  const viaOffer = decideFeature({ ...base, subState: "NONE", planAssignment: null, freeFeatureOfferIds: ["O9"] });
  assert.deepEqual([viaOffer.granted, viaOffer.sources, viaOffer.offerIds, viaOffer.limits], [true, ["OFFER_FREE_FEATURE"], ["O9"], { users: null, export: null }]);
  const generous = decideFeature({ ...base, freePlanAssignments: [{ offerId: "O2", enabled: true, config: { users: 10, export: true } }] });
  assert.deepEqual(generous.limits, { users: 10, export: true }, "the most generous source wins");
  const monitor = decideFeature({ ...base, feature: feat({ enforced: false }), subState: "NONE", planAssignment: null });
  assert.deepEqual([monitor.allowed, monitor.granted], [true, false]);
  assert.deepEqual(decideFeature({ ...base, feature: feat({ isActive: false }), subState: "NONE", planAssignment: null }).sources, ["UNGATED"]);
  assert.equal(decideFeature({ ...base, feature: null }).allowed, false);
  assert.deepEqual(mergeLimits(feat().limitDefs, [{ users: 5 }, {}]), { users: null, export: null }, "missing = unlimited");
});

test("limit definitions and plan limit values are validated; usage periods follow the Dhaka calendar month", () => {
  assert.equal(validateLimitDefs([{ key: "renders", label: "Renders", type: "number", period: "MONTH" }]).ok, true);
  for (const bad of [[{ key: "Bad", label: "x", type: "number" }], [{ key: "a1", label: "", type: "number" }], [{ key: "ok", label: "x", type: "text" }], [{ key: "ok", label: "x", type: "boolean", period: "MONTH" }], [{ key: "dup", label: "a", type: "number" }, { key: "dup", label: "b", type: "number" }]])
    assert.equal(validateLimitDefs(bad).ok, false, JSON.stringify(bad));
  const defs = feat().limitDefs;
  assert.deepEqual(validateLimitConfig(defs, { users: 5, export: true }), { ok: true, value: { users: 5, export: true } });
  assert.deepEqual(validateLimitConfig(defs, { users: null }), { ok: true, value: { users: null } });
  for (const bad of [{ users: -1 }, { users: 1.5 }, { export: "yes" }, { nope: 1 }]) assert.equal(validateLimitConfig(defs, bad).ok, false, JSON.stringify(bad));
  assert.equal(usagePeriodKey({ period: "MONTH" }, D("2026-11-30T18:30:00Z")), "2026-12", "00:30 on Dec 1 in Dhaka");
  assert.equal(usagePeriodKey({ period: "MONTH" }, D("2026-11-30T17:59:00Z")), "2026-11");
  assert.equal(usagePeriodKey({}, NOW), "ALL");
});

test("periods: calendar months clamp to month end; renewals stack on the current end; plan changes start now (or at the current end)", () => {
  assert.equal(addMonths(D("2026-01-31T10:00:00Z"), 1).toISOString(), "2026-02-28T10:00:00.000Z");
  assert.equal(addMonths(D("2026-11-06T06:00:00Z"), 12).toISOString(), "2027-11-06T06:00:00.000Z");
  const end = D("2026-12-01T00:00:00Z");
  assert.deepEqual(periodFor({ state: "ACTIVE", packageId: "P", expiresAt: end }, "P", 1, NOW), { start: end, end: D("2027-01-01T00:00:00Z"), kind: "RENEWAL" });
  assert.equal(periodFor({ state: "GRACE", packageId: "P", expiresAt: D("2026-11-05") }, "P", 1, NOW).kind, "NEW", "end already passed: a fresh period from now");
  const change = periodFor({ state: "ACTIVE", packageId: "P", expiresAt: end }, "Q", 6, NOW);
  assert.deepEqual([change.kind, change.start], ["CHANGE", NOW]);
  assert.equal(periodFor({ state: "ACTIVE", packageId: "P", expiresAt: end }, "Q", 6, NOW, "CURRENT_END").start, end);
  assert.deepEqual(periodFor(null, "P", 1, NOW).kind, "NEW");
});

test("settings: safe defaults for missing or broken values; strict validation on save", () => {
  assert.deepEqual(parseSubsSettings({}), { graceDays: 3, reminderDays: 7, changeStartsFrom: "NOW", enforcement: "enforce" });
  assert.deepEqual(parseSubsSettings({ graceDays: "x", enforcement: "monitor" }).enforcement, "monitor");
  assert.equal(validateSubsSettings({ graceDays: 5, reminderDays: 7, changeStartsFrom: "NOW", enforcement: "enforce" }).ok, true);
  assert.equal(validateSubsSettings({ graceDays: 61, reminderDays: 7, changeStartsFrom: "NOW", enforcement: "enforce" }).ok, false);
  assert.equal(validateSubsSettings({ graceDays: 5, reminderDays: 7, changeStartsFrom: "LATER", enforcement: "enforce" }).ok, false);
});

// ─── service ────────────────────────────────────────────────────────────────

function world() {
  const db = createFakeBillingDb({ vendor: [{ id: "V1", storeName: "Alpha" }, { id: "V2", storeName: "Beta" }] });
  let now = NOW;
  const svc = createSubscriptionService({ db, now: () => now });
  return { db, svc, setNow: (d: Date) => (now = d) };
}

async function catalogue(svc: ReturnType<typeof createSubscriptionService>) {
  const acc = await svc.createFeature({ key: "accounting", name: "Accounting", limitDefs: [{ key: "users", label: "Users", type: "number" }], enforced: true }, ADMIN);
  const pos = await svc.createFeature({ key: "pos", name: "POS", enforced: true }, ADMIN);
  const tryon = await svc.createFeature({ key: "virtual_try_on", name: "Virtual Try-On", limitDefs: [{ key: "renders", label: "Renders", type: "number", period: "MONTH" }], enforced: true }, ADMIN);
  const monthly = await svc.createCycle({ key: "monthly", name: "Monthly", months: 1 }, ADMIN);
  const yearly = await svc.createCycle({ key: "yearly", name: "Yearly", months: 12 }, ADMIN);
  const growth = await svc.createPackage({ name: "Growth", slug: "growth" }, ADMIN);
  await svc.setPackageFeatures(growth.id, [{ featureId: acc.id, config: { users: 2 } }, { featureId: tryon.id, config: { renders: 2 } }], ADMIN);
  await svc.setPackagePrices(growth.id, [{ cycleId: monthly.id, price: "1000" }, { cycleId: yearly.id, price: "10000", discountPercent: 20 }], ADMIN);
  await svc.setPackageStatus(growth.id, "PUBLISHED", ADMIN);
  return { acc, pos, tryon, monthly, yearly, growth };
}

const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof SubscriptionError && e.statusCode === status && (!code || e.code === code));
};

test("plan builder: drafts need a sellable price to publish; duplicate copies features and prices as a DRAFT; archive keeps subscribers; keys are unique and immutable", async () => {
  const { svc } = world();
  const c = await catalogue(svc);
  const empty = await svc.createPackage({ name: "Empty", slug: "empty" }, ADMIN);
  await rejects(svc.setPackageStatus(empty.id, "PUBLISHED", ADMIN), 422, "NOT_SELLABLE");
  await rejects(svc.createPackage({ name: "X", slug: "growth" }, ADMIN), 409, "DUPLICATE");
  await rejects(svc.createFeature({ key: "pos", name: "Again" }, ADMIN), 409, "DUPLICATE");
  await rejects(svc.updateFeature(c.pos.id, { key: "pos2" }, ADMIN), 400);
  await rejects(svc.setPackagePrices(c.growth.id, [{ cycleId: c.monthly.id, price: "100", promoPrice: "200" }], ADMIN), 400);
  await rejects(svc.setPackagePrices(c.growth.id, [{ cycleId: c.monthly.id, price: "100", promoPrice: "50", discountPercent: 10 }], ADMIN), 400);
  await rejects(svc.setPackageFeatures(c.growth.id, [{ featureId: c.acc.id, config: { users: -2 } }], ADMIN), 400);
  const copy = await svc.duplicatePackage(c.growth.id, ADMIN);
  const full = await svc.getPackage(copy.id);
  assert.equal(full.status, "DRAFT");
  assert.equal(full.slug, "growth-copy");
  assert.equal(full.features.length, 2);
  assert.equal(full.prices.length, 2);
  assert.equal((await svc.duplicatePackage(c.growth.id, ADMIN)).slug, "growth-copy-2");
  // Removing a feature from a plan switches it off; nothing is deleted.
  await svc.setPackageFeatures(c.growth.id, [{ featureId: c.acc.id, config: { users: 2 } }], ADMIN);
  const after = await svc.getPackage(c.growth.id);
  assert.equal(after.features.length, 2);
  assert.equal(after.features.find((f: any) => f.featureId === c.tryon.id).enabled, false);
  await svc.setPackageStatus(c.growth.id, "ARCHIVED", ADMIN);
  assert.equal((await svc.vendorPlans("V1")).plans.length, 0, "archived plans aren't sold");
});

test("recording a payment: amount must match the vendor's price (or carry a reason); idempotent; renewals stack; every change is an event", async () => {
  const { db, svc } = world();
  const c = await catalogue(svc);
  const base = { packageId: c.growth.id, cycleId: c.monthly.id, method: "BKASH", reference: "TRX1", idempotencyKey: "k1" };
  await rejects(svc.recordPayment("V1", { ...base, amount: "900" }, ADMIN), 422, "AMOUNT_MISMATCH");
  const first = await svc.recordPayment("V1", { ...base, amount: "1000" }, ADMIN);
  assert.equal(first.duplicate, false);
  assert.equal(first.subscription.status, "ACTIVE");
  assert.equal(new Date(first.subscription.expiresAt).toISOString(), "2026-12-06T06:00:00.000Z");
  const again = await svc.recordPayment("V1", { ...base, amount: "1000" }, ADMIN);
  assert.equal(again.duplicate, true);
  assert.equal(db.tables.subscriptionPayment.length, 1, "no second payment");
  await rejects(svc.recordPayment("V2", { ...base, amount: "1000" }, ADMIN), 409, "DUPLICATE");
  const renewal = await svc.recordPayment("V1", { ...base, idempotencyKey: "k2", reference: "TRX2", amount: "8000", cycleId: c.yearly.id }, ADMIN);
  assert.equal(new Date(renewal.subscription.expiresAt).toISOString(), "2027-12-06T06:00:00.000Z", "yearly renewal stacks on the current end");
  const override = await svc.recordPayment("V2", { ...base, idempotencyKey: "k3", amount: "500", overrideReason: "Agreed by phone" }, ADMIN);
  assert.match(override.payment.note, /Amount override: Agreed by phone/);
  assert.deepEqual(db.tables.vendorSubscriptionEvent.filter((e: any) => e.vendorId === "V1").map((e: any) => e.kind), ["ACTIVATED", "RENEWED"]);
  assert.ok(db.tables.auditLog.some((a: any) => a.action === "SUBS_RENEWED"));
  assert.equal(db.tables.vendorPayable, undefined, "billing never touches vendor earnings");
});

test("admin lifecycle: activate with a reason, extend, suspend blocks features, restore, cancel; optimistic version conflicts are 409", async () => {
  const { db, svc } = world();
  const c = await catalogue(svc);
  await rejects(svc.activate("V1", { packageId: c.growth.id, cycleId: c.monthly.id }, ADMIN), 400);
  await svc.activate("V1", { packageId: c.growth.id, cycleId: c.monthly.id, reason: "Launch partner", source: "COMPLIMENTARY" }, ADMIN);
  assert.equal((await svc.entitlementFor("V1", "accounting")).granted, true);
  const ext = await svc.extend("V1", { days: 10, reason: "Outage credit" }, ADMIN);
  assert.equal(new Date(ext.expiresAt).toISOString(), "2026-12-16T06:00:00.000Z");
  await svc.suspend("V1", { reason: "Chargeback review" }, ADMIN);
  const blocked = await svc.entitlementFor("V1", "accounting");
  assert.deepEqual([blocked.granted, blocked.allowed], [false, false]);
  await rejects(svc.suspend("V1", { reason: "again" }, ADMIN), 409);
  await svc.restore("V1", { reason: "Cleared" }, ADMIN);
  await svc.cancel("V1", { reason: "Vendor asked" }, ADMIN);
  assert.equal((await svc.entitlementFor("V1", "accounting")).granted, false);
  await rejects(svc.extend("V1", { days: 5, reason: "nope" }, ADMIN), 409);
  // A concurrent writer moved the version → the stale update is refused.
  const racing: any = new Proxy(db, {
    get: (t, p) =>
      p === "vendorSubscription" ? { ...t.vendorSubscription, updateMany: async () => ({ count: 0 }) }
      : p === "$transaction" ? (fn: any) => t.$transaction(() => fn(racing))
      : t[p as string],
  });
  const raced = createSubscriptionService({ db: racing, now: () => NOW });
  await rejects(raced.activate("V1", { packageId: c.growth.id, cycleId: c.monthly.id, reason: "retry" }, ADMIN), 409, "CONFLICT");
  assert.equal(db.tables.vendorSubscription[0].status, "CANCELLED");
  assert.equal(db.tables.vendorSubscriptionEvent.filter((e: any) => e.reason === "retry").length, 0, "no event for a refused write");
});

test("special offers: the vendor sees its own price; hidden plans appear only for the offered vendor; revoke restores the normal price; other vendors are unaffected", async () => {
  const { svc } = world();
  const c = await catalogue(svc);
  const vip = await svc.createPackage({ name: "VIP", slug: "vip", visibility: "HIDDEN" }, ADMIN);
  await svc.setPackagePrices(vip.id, [{ cycleId: c.monthly.id, price: "5000" }], ADMIN);
  await svc.setPackageStatus(vip.id, "PUBLISHED", ADMIN);
  assert.deepEqual((await svc.vendorPlans("V1")).plans.map((p: any) => p.slug), ["growth"]);
  const o = await svc.createOffer({ vendorId: "V1", kind: "PERCENT_DISCOUNT", packageId: c.growth.id, value: "25", endsAt: "2026-12-31T00:00:00Z", note: "Loyalty" }, ADMIN);
  await svc.createOffer({ vendorId: "V1", kind: "PRICE_OVERRIDE", packageId: vip.id, value: "2000", endsAt: "2026-12-31T00:00:00Z" }, ADMIN);
  const v1 = await svc.vendorPlans("V1");
  assert.deepEqual(v1.plans.map((p: any) => p.slug), ["growth", "vip"]);
  const monthly = v1.plans[0].prices.find((p: any) => p.cycleId === c.monthly.id);
  assert.deepEqual([monthly.listPrice, monthly.finalPrice, monthly.offerId], ["1000.00", "750.00", o.id]);
  assert.equal(v1.plans[1].prices[0].finalPrice, "2000.00");
  const v2 = await svc.vendorPlans("V2");
  assert.deepEqual([v2.plans.length, v2.plans[0].prices.find((p: any) => p.cycleId === c.monthly.id).finalPrice], [1, "1000.00"]);
  await rejects(svc.setOfferStatus(o.id, "revoke", "", ADMIN), 400);
  await svc.setOfferStatus(o.id, "pause", "Review", ADMIN);
  assert.equal((await svc.vendorPlans("V1")).plans[0].prices.find((p: any) => p.cycleId === c.monthly.id).finalPrice, "1000.00");
  await svc.setOfferStatus(o.id, "resume", "Review done", ADMIN);
  await svc.setOfferStatus(o.id, "revoke", "Ended early", ADMIN);
  await rejects(svc.setOfferStatus(o.id, "resume", "again", ADMIN), 409);
  assert.equal((await svc.vendorPlans("V1")).plans[0].prices.find((p: any) => p.cycleId === c.monthly.id).finalPrice, "1000.00");
  await rejects(svc.createOffer({ vendorId: "V1", kind: "PERCENT_DISCOUNT", packageId: c.growth.id, value: "120", endsAt: "2026-12-31" }, ADMIN), 400);
  await rejects(svc.createOffer({ vendorId: "V1", kind: "FREE_FEATURE", endsAt: "2026-12-31" }, ADMIN), 400);
  await rejects(svc.createOffer({ vendorId: "V1", kind: "FIXED_DISCOUNT", packageId: c.growth.id, value: "10", startsAt: "2026-12-31", endsAt: "2026-12-01" }, ADMIN), 400);
});

test("entitlement: no plan → denied when enforced; free-feature and free-plan offers grant access without touching the subscription; platform monitor mode never blocks", async () => {
  const { db, svc } = world();
  const c = await catalogue(svc);
  const none = await svc.entitlementFor("V1", "accounting");
  assert.deepEqual([none.allowed, none.reason], [false, "SUBSCRIPTION_INACTIVE"]);
  assert.equal((await svc.entitlementFor("V1", "nope")).reason, "FEATURE_UNKNOWN");
  await svc.createOffer({ vendorId: "V1", kind: "FREE_FEATURE", featureId: c.pos.id, endsAt: "2026-12-01T00:00:00Z", afterExpiry: "DISABLE_FEATURE" }, ADMIN);
  assert.deepEqual((await svc.entitlementFor("V1", "pos")).sources, ["OFFER_FREE_FEATURE"]);
  await svc.createOffer({ vendorId: "V1", kind: "FREE_PLAN", packageId: c.growth.id, endsAt: "2026-12-01T00:00:00Z" }, ADMIN);
  assert.deepEqual((await svc.entitlementFor("V1", "accounting")).sources, ["OFFER_FREE_PLAN"]);
  assert.equal((db.tables.vendorSubscription ?? []).length, 0, "offers never write the vendor's subscription");
  assert.equal((await svc.entitlementFor("V2", "accounting")).granted, false, "offers are per vendor");
  await svc.setSettings({ graceDays: 3, reminderDays: 7, changeStartsFrom: "NOW", enforcement: "monitor" }, ADMIN);
  const mon = await svc.entitlementFor("V2", "accounting");
  assert.deepEqual([mon.allowed, mon.granted, mon.monitor], [true, false, true]);
  const all = await svc.entitlementsFor("V1");
  assert.deepEqual(all.map((e: any) => e.key), ["accounting", "pos", "virtual_try_on"]);
});

test("usage limits: consumed atomically up to the cap, per Dhaka month; unlimited still counts; no plan = no quota", async () => {
  const { svc, setNow } = world();
  const c = await catalogue(svc);
  await svc.recordPayment("V1", { packageId: c.growth.id, cycleId: c.monthly.id, amount: "1000", method: "CASH", reference: "R1", idempotencyKey: "u1" }, ADMIN);
  assert.equal((await svc.consumeUsage("V1", "virtual_try_on", "renders")).ok, true);
  assert.equal((await svc.consumeUsage("V1", "virtual_try_on", "renders")).ok, true);
  const third = await svc.consumeUsage("V1", "virtual_try_on", "renders");
  assert.deepEqual([third.ok, third.used, third.cap], [false, 2, 2]);
  setNow(D("2026-11-30T18:30:00Z")); // December in Dhaka
  assert.equal((await svc.consumeUsage("V1", "virtual_try_on", "renders")).ok, true, "a new month resets the counter");
  assert.equal((await svc.consumeUsage("V2", "virtual_try_on", "renders")).ok, false, "no plan, enforced → 0");
  await assert.rejects(svc.consumeUsage("V1", "virtual_try_on", "nope"), /Unknown usage limit/);
});

test("vendor requests: one pending request per plan + cycle; ৳0 starts at once; a vendor can only withdraw its own; admin confirms exactly once", async () => {
  const { db, svc } = world();
  const c = await catalogue(svc);
  const r1 = await svc.vendorRequestPlan("V1", { packageId: c.growth.id, cycleId: c.monthly.id });
  assert.equal(r1.status, "PENDING");
  assert.equal((await svc.vendorRequestPlan("V1", { packageId: c.growth.id, cycleId: c.monthly.id })).payment.id, r1.payment.id);
  await rejects(svc.vendorCancelRequest("V2", r1.payment.id), 404);
  const draft = await svc.createPackage({ name: "Draft", slug: "draft" }, ADMIN);
  await rejects(svc.vendorRequestPlan("V1", { packageId: draft.id, cycleId: c.monthly.id }), 422, "PLAN_UNAVAILABLE");
  const confirmed = await svc.confirmPayment(r1.payment.id, { reference: "BANK-77" }, ADMIN);
  assert.equal(confirmed.subscription.status, "ACTIVE");
  await rejects(svc.confirmPayment(r1.payment.id, { reference: "BANK-77" }, ADMIN), 409, "ALREADY_PROCESSED");
  await svc.createOffer({ vendorId: "V2", kind: "PERCENT_DISCOUNT", packageId: c.growth.id, value: "100", endsAt: "2026-12-31" }, ADMIN);
  const free = await svc.vendorRequestPlan("V2", { packageId: c.growth.id, cycleId: c.monthly.id });
  assert.equal(free.status, "ACTIVE");
  const mine = await svc.vendorPayments("V1");
  assert.ok(mine.every((p: any) => db.tables.subscriptionPayment.find((x: any) => x.id === p.id).vendorId === "V1"));
});

test("jobs: expiry only after grace; offer expiry with SWITCH_PLAN opens a pending request and never charges or changes the plan; one reminder per end date", async () => {
  const { db, svc, setNow } = world();
  const c = await catalogue(svc);
  await svc.recordPayment("V1", { packageId: c.growth.id, cycleId: c.monthly.id, amount: "1000", method: "CASH", reference: "R1", idempotencyKey: "j1" }, ADMIN);
  assert.equal(await svc.runRenewalReminders(D("2026-12-01T00:00:00Z")), 1);
  assert.equal(await svc.runRenewalReminders(D("2026-12-02T00:00:00Z")), 0, "same end date → no second reminder");
  assert.equal(await svc.runExpirySweep(D("2026-12-08T00:00:00Z")), 0, "inside the 3-day grace");
  assert.equal(await svc.runExpirySweep(D("2026-12-09T07:00:00Z")), 1);
  assert.equal(db.tables.vendorSubscription[0].status, "EXPIRED");
  await svc.createOffer({ vendorId: "V2", kind: "FREE_PLAN", packageId: c.growth.id, endsAt: "2026-11-20T00:00:00Z", afterExpiry: "SWITCH_PLAN", afterExpiryPackageId: c.growth.id }, ADMIN);
  setNow(D("2026-11-21T00:00:00Z"));
  assert.equal(await svc.runOfferExpiry(), 1);
  assert.equal(await svc.runOfferExpiry(), 0, "idempotent");
  const pending = db.tables.subscriptionPayment.filter((p: any) => p.vendorId === "V2");
  assert.deepEqual(pending.map((p: any) => [p.status, p.amount]), [["PENDING", "1000.00"]]);
  assert.equal(db.tables.vendorSubscription.some((s: any) => s.vendorId === "V2"), false, "plan not changed");
  assert.ok(db.tables.notification.some((n: any) => n.targetId === "V2" && /Nothing is charged/.test(n.message)));
});

// ─── middleware ─────────────────────────────────────────────────────────────

function res() {
  const r: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: unknown) => ((r.body = b), r);
  r.setHeader = (k: string, v: string) => (r.headers[k] = v);
  return r;
}
const stub = (ent: any, usage?: any) => () => ({ entitlementFor: async () => ent, consumeUsage: async () => usage }) as any;
const run = async (mw: any, req: any) => {
  const r = res();
  let nexted = false;
  await mw(req, r, () => (nexted = true));
  return { r, nexted };
};

test("requireFeature: 402 with a stable code, 429 at the limit, monitor passes with a header, unknown feature fails closed, vendor id only from the session", async () => {
  const vendorReq = { user: { role: "VENDOR", vendorId: "V1" } };
  const deny = { granted: false, allowed: false, reason: "FEATURE_NOT_IN_PLAN", enforced: true, monitor: false, limits: {}, subscription: { state: "ACTIVE" } };
  let out = await run(requireFeature("accounting", {}, stub(deny)), vendorReq);
  assert.deepEqual([out.r.statusCode, out.r.body.code, out.nexted], [402, "FEATURE_NOT_IN_PLAN", false]);
  out = await run(requireFeature("accounting", {}, stub({ ...deny, allowed: true, enforced: false })), vendorReq);
  assert.deepEqual([out.nexted, out.r.headers["X-Subscription-Entitlement"]], [true, "would-deny:FEATURE_NOT_IN_PLAN"]);
  out = await run(requireFeature("x", {}, stub({ ...deny, reason: "FEATURE_UNKNOWN" })), vendorReq);
  assert.equal(out.r.statusCode, 500);
  const grant = { granted: true, allowed: true, reason: null, enforced: true, monitor: false, limits: { renders: 2 } };
  out = await run(requireFeature("virtual_try_on", { limitKey: "renders", consume: 1 }, stub(grant, { ok: false, used: 2, cap: 2 })), vendorReq);
  assert.deepEqual([out.r.statusCode, out.r.body.code, out.r.body.cap], [429, "USAGE_LIMIT_REACHED", 2]);
  out = await run(requireFeature("virtual_try_on", { limitKey: "renders", consume: 1 }, stub(grant, { ok: true, used: 1, cap: 2 })), vendorReq);
  assert.equal(out.nexted, true);
  out = await run(requireFeature("accounting", {}, stub(grant)), { user: { role: "ADMIN", vendorId: null }, body: { vendorId: "V1" }, query: { vendorId: "V1" } });
  assert.equal(out.r.statusCode, 403, "a vendor id in the request is never used");
  let asked = "";
  await run(requireFeature("accounting", {}, () => ({ entitlementFor: async (v: string) => ((asked = v), grant) }) as any), { user: { role: "EMPLOYEE", vendorId: "V9" }, vendorScope: "V2" });
  assert.equal(asked, "V2", "vendorScope from the permission guard wins");
});

test("billing pages are owner-only: vendor staff, admins and anonymous users are refused", async () => {
  for (const [user, code] of [[undefined, 401], [{ role: "EMPLOYEE", vendorId: "V1" }, 403], [{ role: "ADMIN", vendorId: null }, 403], [{ role: "VENDOR", vendorId: null }, 403]] as const) {
    const out = await run(requireVendorOwner, { user });
    assert.equal(out.r.statusCode, code);
  }
  const req: any = { user: { role: "VENDOR", vendorId: "V1" } };
  const ok = await run(requireVendorOwner, req);
  assert.deepEqual([ok.nexted, req.vendorScope], [true, "V1"]);
});

test("POS gate fallback is additive: only a granted 'pos' feature opens POS, and any failure keeps the POS-only decision", async () => {
  assert.equal(await planGrantsPos("V1", () => ({ entitlementFor: async () => ({ granted: true }) }) as any), true);
  assert.equal(await planGrantsPos("V1", () => ({ entitlementFor: async () => ({ granted: false, allowed: true }) }) as any), false, "monitor-allowed is not a grant");
  assert.equal(await planGrantsPos("V1", () => ({ entitlementFor: async () => { throw new Error("relation does not exist"); } }) as any), false);
  const src = readFileSync(new URL("../src/middlewares/pos-entitlement.middleware.ts", import.meta.url), "utf8");
  assert.match(src, /if \(entitlement\.canOperate\) \{/, "the POS subscription decision runs first, unchanged");
  assert.match(src, /entitlement\.state !== "SUSPENDED" && \(await planGrantsPos\(vendorId\)\)/, "an explicit POS suspension still wins");
});

test("migration is additive only and not tied to existing data", () => {
  const sql = readFileSync(new URL("../prisma/migrations/20261106000000_subscription_payout_platform/migration.sql", import.meta.url), "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const bad of [/\bDROP\b/i, /ALTER\s+COLUMN/i, /\bRENAME\b/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /\bUPDATE\s+"/i]) assert.ok(!bad.test(code), `found ${bad}`);
  const alters = code.match(/ALTER TABLE "public"\."vendor_subscriptions"[^;]*;/g) ?? [];
  assert.ok(alters.length > 0);
  for (const a of alters) assert.ok(!/NOT NULL(?! DEFAULT)/.test(a.replace(/NOT NULL DEFAULT/g, "")), "new columns are nullable or defaulted");
});
