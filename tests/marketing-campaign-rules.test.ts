// tests/marketing-campaign-rules.test.ts
//
// Marketing Center Phase 2 — pure campaign rules (no I/O):
// date windows, campaign phase, loosening vs tightening of rules, and the
// registration rule check used at approval time (Decimal math, no floats).
//   npx tsx --test tests/marketing-campaign-rules.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";
import {
  campaignPhase,
  classifyRuleChanges,
  evaluateRegistration,
  slugifyCampaignName,
  validateCampaignWindows,
  type RegistrationFacts,
} from "../src/modules/marketing/campaign.rules.ts";

const d = (s: string) => new Date(s);
const NOW = d("2026-10-15T10:00:00Z");
const W = {
  registrationStartAt: d("2026-10-16T00:00:00Z"),
  registrationEndAt: d("2026-10-20T00:00:00Z"),
  startAt: d("2026-10-21T00:00:00Z"),
  endAt: d("2026-10-25T00:00:00Z"),
};

// ── dates ───────────────────────────────────────────────────────────────────

test("valid windows: registration closes before the campaign starts; end after start", () => {
  assert.deepEqual(validateCampaignWindows(W, NOW, { requireFuture: true }), {});
  assert.deepEqual(validateCampaignWindows({ ...W, registrationEndAt: W.startAt }, NOW), {}, "registration may close exactly when the campaign starts");
});

test("invalid windows are reported per field", () => {
  assert.equal(validateCampaignWindows({ ...W, registrationEndAt: W.registrationStartAt }, NOW).registrationEndAt, "Registration must end after it starts");
  assert.equal(validateCampaignWindows({ ...W, registrationEndAt: d("2026-10-22T00:00:00Z") }, NOW).startAt, "The campaign must start after registration closes");
  assert.equal(validateCampaignWindows({ ...W, endAt: W.startAt }, NOW).endAt, "The campaign must end after it starts");
  assert.equal(validateCampaignWindows({ ...W, startAt: new Date("nope") }, NOW).startAt, "Must be a valid date");
});

test("requireFuture: registration and campaign must still be ahead", () => {
  const past = { registrationStartAt: d("2026-10-01T00:00:00Z"), registrationEndAt: d("2026-10-02T00:00:00Z"), startAt: d("2026-10-03T00:00:00Z"), endAt: d("2026-10-04T00:00:00Z") };
  const e = validateCampaignWindows(past, NOW, { requireFuture: true });
  assert.deepEqual(Object.keys(e).sort(), ["endAt", "registrationEndAt"]);
  assert.deepEqual(validateCampaignWindows(past, NOW), {}, "without requireFuture only ordering is checked");
});

test("campaignPhase follows the windows for a published campaign", () => {
  const c = { ...W, status: "PUBLISHED" as const };
  assert.equal(campaignPhase(c, NOW), "UPCOMING");
  assert.equal(campaignPhase(c, d("2026-10-17T00:00:00Z")), "REGISTRATION_OPEN");
  assert.equal(campaignPhase(c, d("2026-10-20T12:00:00Z")), "REGISTRATION_CLOSED");
  assert.equal(campaignPhase(c, d("2026-10-22T00:00:00Z")), "LIVE");
  assert.equal(campaignPhase(c, d("2026-10-25T00:00:00Z")), "ENDED");
  assert.equal(campaignPhase({ ...W, status: "DRAFT" }, NOW), "DRAFT");
  assert.equal(campaignPhase({ ...W, status: "CANCELLED" }, d("2026-10-22T00:00:00Z")), "CANCELLED");
});

// ── loosen vs tighten ───────────────────────────────────────────────────────

const R = { minDiscountPercent: new Decimal("10"), minStock: 5, maxProductsPerVendor: 3 as number | null, categoryIds: ["a", "b"] };

test("classifyRuleChanges: harder to qualify = tightened, easier = loosened", () => {
  assert.deepEqual(classifyRuleChanges(R, { ...R }), { loosened: [], tightened: [] });
  assert.deepEqual(classifyRuleChanges(R, { ...R, minDiscountPercent: 15 }), { loosened: [], tightened: ["minDiscountPercent"] });
  assert.deepEqual(classifyRuleChanges(R, { ...R, minDiscountPercent: "9.99" }), { loosened: ["minDiscountPercent"], tightened: [] });
  assert.deepEqual(classifyRuleChanges(R, { ...R, minStock: 10 }), { loosened: [], tightened: ["minStock"] });
  assert.deepEqual(classifyRuleChanges(R, { ...R, minStock: 1 }), { loosened: ["minStock"], tightened: [] });
  assert.deepEqual(classifyRuleChanges(R, { ...R, maxProductsPerVendor: 2 }).tightened, ["maxProductsPerVendor"]);
  assert.deepEqual(classifyRuleChanges(R, { ...R, maxProductsPerVendor: 4 }).loosened, ["maxProductsPerVendor"]);
  assert.deepEqual(classifyRuleChanges(R, { ...R, maxProductsPerVendor: null }).loosened, ["maxProductsPerVendor"], "no limit = looser");
  assert.deepEqual(classifyRuleChanges({ ...R, maxProductsPerVendor: null }, R).tightened, ["maxProductsPerVendor"]);
});

test("classifyRuleChanges: categories — removing narrows, adding widens, empty means all", () => {
  assert.deepEqual(classifyRuleChanges(R, { ...R, categoryIds: ["a"] }), { loosened: [], tightened: ["categoryIds"] });
  assert.deepEqual(classifyRuleChanges(R, { ...R, categoryIds: ["a", "b", "c"] }), { loosened: ["categoryIds"], tightened: [] });
  assert.deepEqual(classifyRuleChanges(R, { ...R, categoryIds: ["a", "c"] }), { loosened: ["categoryIds"], tightened: ["categoryIds"] });
  assert.deepEqual(classifyRuleChanges(R, { ...R, categoryIds: [] }), { loosened: ["categoryIds"], tightened: [] });
  assert.deepEqual(classifyRuleChanges({ ...R, categoryIds: [] }, R), { loosened: [], tightened: ["categoryIds"] });
  assert.deepEqual(classifyRuleChanges(R, { ...R, categoryIds: ["b", "a"] }), { loosened: [], tightened: [] }, "order does not matter");
});

// ── registration evaluation ─────────────────────────────────────────────────

function facts(over: { campaign?: any; registration?: any; current?: any; now?: Date } = {}): RegistrationFacts {
  return {
    campaign: { status: "PUBLISHED", endAt: W.endAt, minDiscountPercent: new Decimal("10"), minStock: 5, maxProductsPerVendor: 2, categoryIds: ["cat-root"], ...over.campaign },
    registration: { campaignPrice: new Decimal("900"), committedStock: 10, ...over.registration },
    current: { sellingPrice: new Decimal("1000"), stock: 50, productApproved: true, productDeleted: false, vendorActive: true, categoryChain: ["cat-phones", "cat-root"], approvedForVendor: 0, ...over.current },
    now: over.now ?? NOW,
  };
}
const rules = (f: RegistrationFacts) => evaluateRegistration(f).map((v) => v.rule);

test("a registration meeting every rule has no violations", () => {
  assert.deepEqual(evaluateRegistration(facts()), []);
});

test("minimum discount uses exact Decimal math against the CURRENT selling price", () => {
  assert.deepEqual(rules(facts({ registration: { campaignPrice: "900.00" } })), [], "exactly 10% passes");
  assert.deepEqual(rules(facts({ registration: { campaignPrice: "900.01" } })), ["minDiscountPercent"], "9.999% fails");
  const v = evaluateRegistration(facts({ registration: { campaignPrice: "900.01" } }))[0];
  assert.match(v.message, /Discount is 9\.99% — the campaign requires at least 10%/, "rounded down, never overstated");
  // Price dropped since registration: 900 is now only 5% below 947.37 → fails.
  assert.deepEqual(rules(facts({ current: { sellingPrice: "947.37" } })), ["minDiscountPercent"]);
  // 0.1 + 0.2 style traps: 33.33...% of 3 — Decimal keeps it exact.
  assert.deepEqual(rules(facts({ campaign: { minDiscountPercent: "33.33" }, registration: { campaignPrice: "2" }, current: { sellingPrice: "3" } })), []);
});

test("campaign price must be positive and below the selling price", () => {
  assert.deepEqual(rules(facts({ registration: { campaignPrice: "0" } })), ["campaignPrice"]);
  assert.deepEqual(rules(facts({ registration: { campaignPrice: "1000" } })), ["campaignPrice"]);
  assert.deepEqual(rules(facts({ registration: { campaignPrice: "1200" } })), ["campaignPrice"]);
});

test("stock: committed ≥ max(1, minStock) and ≤ current stock", () => {
  assert.deepEqual(rules(facts({ registration: { committedStock: 4 } })), ["minStock"]);
  assert.deepEqual(rules(facts({ registration: { committedStock: 0 } })), ["committedStock"]);
  assert.deepEqual(rules(facts({ registration: { committedStock: 2.5 } })), ["committedStock"]);
  assert.deepEqual(rules(facts({ current: { stock: 9 } })), ["stock"], "stock fell below the commitment");
});

test("category: product category or any ancestor must be eligible; empty list = all", () => {
  assert.deepEqual(rules(facts({ current: { categoryChain: ["cat-fashion"] } })), ["category"]);
  assert.deepEqual(rules(facts({ campaign: { categoryIds: [] }, current: { categoryChain: ["cat-fashion"] } })), []);
  assert.deepEqual(rules(facts({ campaign: { categoryIds: ["cat-phones"] } })), [], "exact category");
});

test("status checks: campaign published and not ended; product approved; store active; vendor product limit", () => {
  assert.deepEqual(rules(facts({ campaign: { status: "DRAFT" } })), ["campaignStatus"]);
  assert.deepEqual(rules(facts({ now: W.endAt })), ["campaignEnded"]);
  assert.deepEqual(rules(facts({ current: { productApproved: false } })), ["productStatus"]);
  assert.deepEqual(rules(facts({ current: { productDeleted: true } })), ["productStatus"]);
  assert.deepEqual(rules(facts({ current: { vendorActive: false } })), ["vendorStatus"]);
  assert.deepEqual(rules(facts({ current: { approvedForVendor: 2 } })), ["maxProductsPerVendor"]);
  assert.deepEqual(rules(facts({ campaign: { maxProductsPerVendor: null }, current: { approvedForVendor: 99 } })), []);
});

test("several violations are all reported", () => {
  assert.deepEqual(rules(facts({ registration: { campaignPrice: "990", committedStock: 1 }, current: { vendorActive: false } })), ["vendorStatus", "minDiscountPercent", "minStock"]);
});

test("slugifyCampaignName keeps Bangla letters and digits", () => {
  assert.equal(slugifyCampaignName("  11.11 Mega Sale! "), "11-11-mega-sale");
  assert.equal(slugifyCampaignName("ঈদ মেগা সেল ২০২৬"), "ঈদ-মেগা-সেল-২০২৬");
  assert.equal(slugifyCampaignName("!!!"), "campaign");
});
