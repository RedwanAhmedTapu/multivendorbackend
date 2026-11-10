// tests/marketing-vendor-campaign.test.ts
//
// Marketing Center Phase 3 — vendor campaign registration (service level,
// in-memory fake database; DB-free):
//   - pure helpers: registration window, maximum campaign price (consistent
//     with the admin's evaluateRegistration at every boundary);
//   - list: only PUBLISHED programmes of campaigns that have not ended; page
//     title/hero/dates; "x/y" counts of THIS vendor only; deadline order;
//   - detail: only this vendor's variants, each judged by the admin rules;
//   - register: PENDING rows, selling-price snapshot, audit per row, ONE
//     admin-side notification per recipient per submission (FinixMart);
//     idempotent retry (also under a concurrent unique-key race); duplicate
//     → 409; every rule → 422 with nothing written; another vendor's
//     variant → 404;
//   - edit (PENDING only, window open), withdraw (PENDING/APPROVED, before
//     live), re-submit after withdraw, "my registrations" (own only, with
//     the rejection reason).
//   npx tsx --test tests/marketing-vendor-campaign.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";
import { createCampaignService, MarketingError, AUDIT } from "../src/modules/marketing/campaign.service.ts";
import { createVendorCampaignService } from "../src/modules/marketing/vendor-campaign.service.ts";
import { evaluateRegistration, maxCampaignPrice, registrationWindowViolation } from "../src/modules/marketing/campaign.rules.ts";
import { createFakeMarketingDb, seedWorld } from "./support/fake-marketing-db.ts";

const NOW = new Date("2026-10-15T10:00:00Z"); // admin creates + publishes
const OPEN = new Date("2026-10-17T10:00:00Z"); // registration window 10-16 → 10-20
const ADMIN = { userId: "U_ADMIN" };
const VENDOR = { userId: "U_VENDOR1" };
const input = (over: Record<string, unknown> = {}) => ({
  registrationStartAt: new Date("2026-10-16T00:00:00Z"),
  registrationEndAt: new Date("2026-10-20T00:00:00Z"),
  minDiscountPercent: 10,
  minStock: 5,
  maxProductsPerVendor: 2,
  categoryIds: ["cat-root"],
  ...over,
}) as any;

/** PG1 "Mega Sale" (live 10-21 → 10-25) with a PUBLISHED programme; vendor clock at OPEN. */
async function world(over: Record<string, unknown> = {}) {
  const db = createFakeMarketingDb(seedWorld());
  const admin = createCampaignService(db, { now: () => NOW });
  const p = await admin.createProgramme(ADMIN, "PG1", input(over));
  await admin.publishProgramme(ADMIN, p.id);
  let t = OPEN;
  const vendor = createVendorCampaignService(db, { now: () => t });
  const s = () => db.store();
  return { db, admin, vendor, p, s, at: (iso: string) => (t = new Date(iso)), adminAt: (iso: string) => createCampaignService(db, { now: () => new Date(iso) }) };
}

const item = (variantId: string, campaignPrice: string, committedStock = 10) => ({ variantId, campaignPrice, committedStock });

async function rejects(p: Promise<unknown>, status: number, check?: RegExp | ((e: MarketingError) => boolean)) {
  await assert.rejects(p, (e: any) => {
    assert.ok(e instanceof MarketingError, `expected MarketingError, got ${e?.message}`);
    assert.equal(e.statusCode, status, e.message);
    if (check instanceof RegExp) assert.match(e.message, check);
    else if (check) assert.ok(check(e), JSON.stringify(e.details));
    return true;
  });
}
const rulesOfError = (e: MarketingError) => ((e.details as any)?.items ?? []).flatMap((i: any) => i.violations.map((v: any) => `${i.variantId}:${v.rule}`));

// ── pure helpers ────────────────────────────────────────────────────────────

test("registrationWindowViolation: closed before the start and from the end on", () => {
  const w = { registrationStartAt: new Date("2026-10-16T00:00:00Z"), registrationEndAt: new Date("2026-10-20T00:00:00Z") };
  assert.match(registrationWindowViolation(w, new Date("2026-10-15T23:59:59Z"))!.message, /not opened/);
  assert.equal(registrationWindowViolation(w, new Date("2026-10-16T00:00:00Z")), null, "opens exactly at the start");
  assert.equal(registrationWindowViolation(w, new Date("2026-10-19T23:59:59Z")), null);
  assert.match(registrationWindowViolation(w, new Date("2026-10-20T00:00:00Z"))!.message, /closed/, "closed exactly at the end");
});

test("maxCampaignPrice: the highest price that passes the admin rule; one paisa more fails", () => {
  const judge = (selling: string, pct: string, price: string) =>
    evaluateRegistration({
      campaign: { minDiscountPercent: pct, minStock: 0, maxProductsPerVendor: null, categoryIds: [], status: "PUBLISHED", endAt: new Date("2099-01-01") },
      registration: { campaignPrice: price, committedStock: 1 },
      current: { sellingPrice: selling, stock: 10, productApproved: true, productDeleted: false, vendorActive: true, categoryChain: [], approvedForVendor: 0 },
      now: new Date("2026-01-01"),
    }).map((v) => v.rule);
  assert.equal(maxCampaignPrice("1000", "10")!.toString(), "900");
  assert.equal(maxCampaignPrice("999.99", "12.5")!.toString(), "874.99");
  assert.equal(maxCampaignPrice("1000", "0")!.toString(), "999.99", "strictly below the selling price");
  assert.equal(maxCampaignPrice("0.01", "50"), null, "too cheap to discount");
  for (const [selling, pct] of [["1000", "10"], ["999.99", "12.5"], ["1000.0050", "10"], ["1234.5678", "33.33"], ["1000", "0"], ["19.99", "5"]]) {
    const max = maxCampaignPrice(selling, pct)!;
    assert.deepEqual(judge(selling, pct, max.toString()), [], `${selling}@${pct}% max ${max} passes`);
    assert.notDeepEqual(judge(selling, pct, max.plus("0.01").toString()), [], `${selling}@${pct}% max+0.01 fails`);
  }
});

// ── list / detail ───────────────────────────────────────────────────────────

test("list: only PUBLISHED, not-ended campaigns, with the page's title/hero/dates and THIS vendor's x/y", async () => {
  const { vendor, admin, p, s } = await world();
  // A DRAFT programme on PG2 is invisible; a landing-only page is invisible.
  await admin.createProgramme(ADMIN, "PG2", input({ registrationEndAt: new Date("2026-10-30T00:00:00Z") }));
  s().pages.find((x) => x.id === "PG1")!.heroImage = "https://cdn.example/mega.jpg";
  await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850")]);
  // Another vendor's registration never counts for V1.
  s().registrations.push({ id: "R_V3", campaignId: p.id, vendorId: "V3", productId: "P5", variantId: "VAR5", campaignPrice: new Decimal(1000), originalPrice: new Decimal(1500), committedStock: 10, status: "PENDING", createdAt: OPEN, updatedAt: OPEN });

  const r = await vendor.listCampaigns("V1", {});
  assert.equal(r.items.length, 1);
  const c = r.items[0];
  assert.deepEqual([c.id, c.title, c.slug, c.heroImage], [p.id, "Mega Sale", "mega-sale", "https://cdn.example/mega.jpg"]);
  assert.deepEqual([c.startAt.toISOString(), c.endAt.toISOString(), c.registrationEndAt.toISOString()], ["2026-10-21T00:00:00.000Z", "2026-10-25T00:00:00.000Z", "2026-10-20T00:00:00.000Z"]);
  assert.deepEqual([c.phase, c.registrationOpen], ["REGISTRATION_OPEN", true]);
  assert.deepEqual(c.registered, { count: 1, limit: 2 }, "x/y counts only V1's active registrations");
  assert.deepEqual(c.rules, { minDiscountPercent: "10", minStock: 5, maxProductsPerVendor: 2, categories: [{ id: "cat-root", name: "Electronics" }] });
  assert.equal(r.earliestEndAt!.toISOString(), "2026-10-25T00:00:00.000Z");

  const v3 = await vendor.listCampaigns("V3", {});
  assert.deepEqual(v3.items[0].registered, { count: 1, limit: 2 }, "V3 sees only its own count");
  assert.deepEqual(v3.items[0].myCounts, { pending: 1, approved: 0, rejected: 0, withdrawn: 0 });
});

test("list: ended and cancelled campaigns disappear; order is by registration deadline", async () => {
  const { vendor, admin, p, at } = await world();
  const q = await admin.createProgramme(ADMIN, "PG2", input({ registrationEndAt: new Date("2026-10-18T00:00:00Z") }));
  await admin.publishProgramme(ADMIN, q.id);
  assert.deepEqual((await vendor.listCampaigns("V1", {})).items.map((c) => c.id), [q.id, p.id], "PG2 closes registration first");
  at("2026-10-25T00:00:00Z");
  assert.deepEqual((await vendor.listCampaigns("V1", {})).items.map((c) => c.id), [q.id], "PG1 ended at 10-25");
  await admin.cancelProgramme(ADMIN, q.id, "called off");
  assert.deepEqual((await vendor.listCampaigns("V1", {})).items, []);
});

test("detail: only this vendor's variants, each with current price, stock, the max campaign price and why it can't join", async () => {
  const { vendor, p } = await world();
  const d = await vendor.getCampaign("V1", p.id, {});
  const byId = Object.fromEntries(d.variants.map((v) => [v.variantId, v]));
  assert.deepEqual(Object.keys(byId).sort(), ["VAR1", "VAR1B", "VAR2", "VAR3", "VAR4"], "never V3's VAR5");
  assert.deepEqual([byId.VAR1.currentPrice, byId.VAR1.listPrice, byId.VAR1.stock, byId.VAR1.maxCampaignPrice, byId.VAR1.eligible], ["1000", "1000", 50, "900", true]);
  assert.deepEqual([byId.VAR1B.currentPrice, byId.VAR1B.listPrice, byId.VAR1B.maxCampaignPrice], ["1100", "1200", "990"], "special price is the current price");
  assert.deepEqual(byId.VAR1B.violations.map((v: any) => v.rule), ["stock"], "3 in stock, 5 required");
  assert.deepEqual(byId.VAR2.violations.map((v: any) => v.rule), ["category"]);
  assert.deepEqual(byId.VAR4.violations.map((v: any) => v.rule), ["productStatus"], "product not approved");
  assert.equal(byId.VAR1.registration, null);
  assert.deepEqual((await vendor.getCampaign("V1", p.id, { eligibleOnly: true })).variants.map((v) => v.variantId).sort(), ["VAR1", "VAR3"]);
  const v3 = await vendor.getCampaign("V3", p.id, {});
  assert.deepEqual(v3.variants.map((v) => v.variantId), ["VAR5"]);

  await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850")]);
  const after = (await vendor.getCampaign("V1", p.id, {})).variants.find((v) => v.variantId === "VAR1")!;
  assert.deepEqual([after.registration?.status, after.registration?.campaignPrice, after.registration?.committedStock], ["PENDING", "850", 10]);
});

test("detail / register: a DRAFT, cancelled or unknown programme is 404 for vendors", async () => {
  const { vendor, admin, p } = await world();
  const draft = await admin.createProgramme(ADMIN, "PG2", input({ registrationEndAt: new Date("2026-10-30T00:00:00Z") }));
  await rejects(vendor.getCampaign("V1", draft.id, {}), 404);
  await rejects(vendor.register(VENDOR, "V1", draft.id, [item("VAR1", "850")]), 404);
  await rejects(vendor.getCampaign("V1", "nope", {}), 404);
  await admin.cancelProgramme(ADMIN, p.id, "stop");
  await rejects(vendor.getCampaign("V1", p.id, {}), 404);
});

// ── register ────────────────────────────────────────────────────────────────

test("register: PENDING rows with the selling-price snapshot, one audit per row, ONE notification per admin-side recipient", async () => {
  const { vendor, p, s } = await world();
  const auditBefore = s().audit.length;
  const notesBefore = s().notifications.length;
  const r = await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850"), item("VAR3", "1700.50", 6)]);
  assert.equal(r.created.length, 2);
  assert.deepEqual(r.unchanged, []);
  const rows = s().registrations.filter((x) => x.campaignId === p.id);
  assert.deepEqual(rows.map((x) => [x.vendorId, x.productId, x.variantId, x.status, String(x.campaignPrice), String(x.originalPrice), x.committedStock]), [
    ["V1", "P1", "VAR1", "PENDING", "850", "1000", 10],
    ["V1", "P3", "VAR3", "PENDING", "1700.5", "2000", 6],
  ]);
  const audits = s().audit.slice(auditBefore);
  assert.deepEqual(audits.map((a) => [a.action, a.entity, a.userId]), [[AUDIT.vendorRegister, "CampaignRegistration", "U_VENDOR1"], [AUDIT.vendorRegister, "CampaignRegistration", "U_VENDOR1"]]);
  assert.equal(audits[0].newData.listPrice, "1000", "list price copied into the audit");
  assert.equal(audits[0].oldData, undefined, "nothing before a first registration");

  const notes = s().notifications.slice(notesBefore);
  assert.deepEqual(notes.map((n) => `${n.targetType}:${n.targetId}`).sort(), ["EMPLOYEE:E_MKT", "USER:U_ADMIN"], "active admins + admin-side marketing staff; never vendor staff, inactive or other staff");
  for (const n of notes) {
    assert.equal(n.message, 'Store One submitted 2 products for "Mega Sale" on FinixMart — waiting for review.');
    assert.doesNotMatch(n.message + n.title, /daraz/i);
    assert.deepEqual(n.meta.registrationIds, rows.map((x) => x.id));
  }
});

test("register: the snapshot is the SELLING price (special price), the list price is kept in the audit", async () => {
  const { vendor, p, s } = await world({ minStock: 1 });
  const [row] = (await vendor.register(VENDOR, "V1", p.id, [item("VAR1B", "990", 3)])).created; // list 1200, special 1100
  assert.equal(String(row.originalPrice), "1100");
  assert.equal(String(s().registrations[0].originalPrice), "1100");
  assert.equal(s().audit.at(-1)!.newData.listPrice, "1200");
});

test("register: an identical retry is a no-op (no rows, audit or notification); a different price for the same variant → 409", async () => {
  const { vendor, p, s } = await world();
  await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850"), item("VAR3", "1700")]);
  const counts = () => [s().registrations.length, s().audit.length, s().notifications.length];
  const before = counts();
  const again = await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850.00"), item("VAR3", "1700")]);
  assert.deepEqual([again.created.length, again.unchanged.length], [0, 2]);
  assert.deepEqual(counts(), before);
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR1", "800")]), 409, (e) => (e.details as any).duplicates[0].variantId === "VAR1");
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850", 11)]), 409);
  assert.deepEqual(counts(), before, "a refused duplicate writes nothing");
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850"), item("VAR1", "850")]), 400, /only once/);
});

test("register: a concurrent identical submission (unique key P2002) is retried and reads as a no-op", async () => {
  const { db, vendor, p, s } = await world();
  const realTx = db.$transaction.bind(db);
  const realCreate = db.campaignRegistration.create;
  let first = true;
  (db as any).$transaction = async (fn: any) => {
    if (!first) return realTx(fn);
    first = false;
    // The other request commits the same row just before ours inserts.
    db.campaignRegistration.create = async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    };
    try {
      return await realTx(fn);
    } finally {
      db.campaignRegistration.create = realCreate;
      s().registrations.push({ id: "R_OTHER", campaignId: p.id, vendorId: "V1", productId: "P1", variantId: "VAR1", campaignPrice: new Decimal("850"), originalPrice: new Decimal("1000"), committedStock: 10, status: "PENDING", createdAt: OPEN, updatedAt: OPEN });
    }
  };
  const r = await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850")]);
  assert.deepEqual([r.created.length, r.unchanged.map((x: any) => x.id)], [0, ["R_OTHER"]]);
  assert.equal(s().registrations.filter((x) => x.variantId === "VAR1").length, 1);
});

test("register: registration window closed (before and after) → 422, nothing written", async () => {
  const { vendor, p, s, at } = await world();
  at("2026-10-15T23:00:00Z");
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850")]), 422, /not opened/);
  at("2026-10-20T00:00:00Z");
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850")]), 422, (e) => (e.details as any).violations[0].rule === "registrationWindow");
  assert.equal(s().registrations.length, 0);
  assert.equal((await vendor.listCampaigns("V1", {})).items[0].registrationOpen, false);
});

test("register: campaign price above the allowed maximum, at/over the selling price, stock, category, unapproved product → 422 per item, all-or-nothing", async () => {
  const { vendor, p, s } = await world({ maxProductsPerVendor: null });
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR1", "900.01")]), 422, (e) => rulesOfError(e).join() === "VAR1:minDiscountPercent");
  await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "900")]).then((r) => assert.equal(r.created.length, 1, "exactly the maximum is accepted"));
  await rejects(
    vendor.register(VENDOR, "V1", p.id, [item("VAR3", "1700"), item("VAR1B", "990", 3), item("VAR2", "300", 5), item("VAR4", "800")]),
    422,
    (e) => rulesOfError(e).join() === "VAR1B:minStock,VAR2:category,VAR4:productStatus",
  );
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR3", "2000")]), 422, (e) => rulesOfError(e).join() === "VAR3:campaignPrice");
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR3", "1700", 21)]), 422, (e) => rulesOfError(e).join() === "VAR3:stock");
  assert.deepEqual(s().registrations.map((r) => r.variantId), ["VAR1"], "the valid VAR3 of the failed batch was not written");
});

test("register: max products per vendor counts pending + approved, inside one submission too", async () => {
  const { vendor, p } = await world({ maxProductsPerVendor: 1 });
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850"), item("VAR3", "1700")]), 422, (e) => rulesOfError(e).join() === "VAR3:maxProductsPerVendor" && /already has 1 products registered for this campaign \(limit 1\)/.test((e.details as any).items[0].violations[0].message));
  await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850")]);
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR3", "1700")]), 422, (e) => rulesOfError(e).join() === "VAR3:maxProductsPerVendor");
});

test("register: another vendor's variant (or an unknown one) → 404 and nothing is written", async () => {
  const { vendor, p, s } = await world();
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850"), item("VAR5", "1300")]), 404, (e) => (e.details as any).variantIds.join() === "VAR5");
  await rejects(vendor.register(VENDOR, "V1", p.id, [item("NOPE", "1")]), 404);
  assert.equal(s().registrations.length, 0);
});

// ── edit / withdraw / mine ──────────────────────────────────────────────────

test("edit: a PENDING registration's price/stock while registration is open; rules re-checked; audited; no-op not audited", async () => {
  const { vendor, admin, p, s, at } = await world();
  const [reg] = (await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850"), item("VAR3", "1700")])).created;
  const audits = () => s().audit.filter((a) => a.action === AUDIT.vendorEdit);
  const edited = await vendor.editRegistration(VENDOR, "V1", reg.id, { campaignPrice: "800", committedStock: 12 });
  assert.deepEqual([String(edited.campaignPrice), edited.committedStock], ["800", 12]);
  assert.deepEqual([String(audits()[0].oldData.campaignPrice), String(audits()[0].newData.campaignPrice), audits()[0].userId], ["850", "800", "U_VENDOR1"]);
  await vendor.editRegistration(VENDOR, "V1", reg.id, { campaignPrice: "800.00" });
  assert.equal(audits().length, 1, "unchanged values write nothing");
  await rejects(vendor.editRegistration(VENDOR, "V1", reg.id, { campaignPrice: "950" }), 422, (e) => (e.details as any).violations[0].rule === "minDiscountPercent");
  assert.equal(String(s().registrations.find((r) => r.id === reg.id)!.campaignPrice), "800", "a refused edit changes nothing");

  await admin.approveRegistration(ADMIN, s().registrations[1].id); // VAR3 approved by the admin with the same rules
  await rejects(vendor.editRegistration(VENDOR, "V1", s().registrations[1].id, { committedStock: 7 }), 409, /pending/);
  at("2026-10-20T00:00:00Z");
  await rejects(vendor.editRegistration(VENDOR, "V1", reg.id, { committedStock: 7 }), 422, /closed/);
});

test("withdraw: PENDING or APPROVED before the campaign is live; never after; audited; re-submitting reuses the row", async () => {
  const { vendor, admin, p, s, at } = await world();
  const [a, b] = (await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850"), item("VAR3", "1700")])).created;
  await admin.approveRegistration(ADMIN, b.id);
  assert.equal((await vendor.withdrawRegistration(VENDOR, "V1", a.id, " changed my mind ")).status, "WITHDRAWN");
  const audit = s().audit.find((x) => x.action === AUDIT.vendorWithdraw)!;
  assert.deepEqual([audit.oldData.status, audit.newData.status, audit.newData.reason, audit.userId], ["PENDING", "WITHDRAWN", "changed my mind", "U_VENDOR1"]);
  await rejects(vendor.withdrawRegistration(VENDOR, "V1", a.id), 409, /pending or approved/);

  // Re-submit while registration is open: same row back to PENDING.
  const again = await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "820")]);
  assert.deepEqual([again.created[0].id, again.created[0].status], [a.id, "PENDING"]);
  assert.equal(s().registrations.filter((r) => r.variantId === "VAR1").length, 1);
  assert.equal(s().audit.filter((x) => x.action === AUDIT.vendorRegister).at(-1)!.newData.resubmitted, true);

  at("2026-10-21T00:00:00Z"); // live
  await rejects(vendor.withdrawRegistration(VENDOR, "V1", b.id), 409, /already live/);
  assert.equal(s().registrations.find((r) => r.id === b.id)!.status, "APPROVED");
  at("2026-10-20T23:59:59Z");
  assert.equal((await vendor.withdrawRegistration(VENDOR, "V1", b.id)).status, "WITHDRAWN", "an approved one may leave before live");
});

test("another vendor's registration is never visible or changeable (404), and 'my registrations' lists only my own with the rejection reason", async () => {
  const { vendor, admin, p, s } = await world();
  const [mine] = (await vendor.register(VENDOR, "V1", p.id, [item("VAR1", "850")])).created;
  const [theirs] = (await vendor.register({ userId: "U_V3" }, "V3", p.id, [item("VAR5", "1300")])).created;
  await rejects(vendor.editRegistration(VENDOR, "V1", theirs.id, { committedStock: 11 }), 404);
  await rejects(vendor.withdrawRegistration(VENDOR, "V1", theirs.id), 404);
  assert.equal(s().registrations.find((r) => r.id === theirs.id)!.status, "PENDING");

  await admin.rejectRegistration(ADMIN, mine.id, "Price too close to the regular price");
  const list = await vendor.listMyRegistrations("V1", {});
  assert.deepEqual(list.items.map((r) => [r.id, r.status, r.rejectionReason, r.campaign.title, r.product.name, r.variant.sku]), [[mine.id, "REJECTED", "Price too close to the regular price", "Mega Sale", "Phone X", "PX-1"]]);
  assert.deepEqual((await vendor.listMyRegistrations("V1", { status: "PENDING" })).items, []);
  assert.deepEqual((await vendor.listMyRegistrations("V3", {})).items.map((r) => r.id), [theirs.id]);
});
