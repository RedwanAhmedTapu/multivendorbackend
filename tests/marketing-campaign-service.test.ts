// tests/marketing-campaign-service.test.ts
//
// Marketing Center — vendor programme of a campaign landing page, against an
// in-memory database (tests/support/fake-marketing-db.ts; transactions roll
// back on error). Covers:
//   - programme lifecycle: create (page must have dates; one per page),
//     update / publish / cancel with server-side date checks; no loosening
//     after registration; tightening needs an acknowledgement;
//   - page rules: landing-page-only pages unchanged; DRAFT programme keeps the
//     page dates consistent; PUBLISHED programme freezes the start and allows
//     only EXTENDING the end (audit-logged, registered vendors notified);
//     delete blocked when registrations exist;
//   - approve/reject re-check rules now, notifications, audit (old/new, actor);
//   - bulk preview → confirm; list for staff with programme counts.
//   npx tsx --test tests/marketing-campaign-service.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";
import { createCampaignService, MarketingError, AUDIT } from "../src/modules/marketing/campaign.service.ts";
import { createFakeMarketingDb, seedWorld } from "./support/fake-marketing-db.ts";

const NOW = new Date("2026-10-15T10:00:00Z");
const ADMIN = { userId: "U_ADMIN" };
const input = (over: Record<string, unknown> = {}) => ({
  registrationStartAt: new Date("2026-10-16T00:00:00Z"),
  registrationEndAt: new Date("2026-10-20T00:00:00Z"),
  minDiscountPercent: 10,
  minStock: 5,
  maxProductsPerVendor: 2,
  categoryIds: ["cat-root"],
  ...over,
}) as any;

function setup() {
  const db = createFakeMarketingDb(seedWorld());
  const svc = createCampaignService(db, { now: () => NOW });
  return { db, svc, s: () => db.store() };
}

let regSeq = 0;
function addRegistration(db: ReturnType<typeof createFakeMarketingDb>, campaignId: string, over: Record<string, unknown> = {}) {
  const r = {
    id: `REG${++regSeq}`, campaignId, vendorId: "V1", productId: "P1", variantId: "VAR1",
    campaignPrice: new Decimal("850"), originalPrice: new Decimal("1000"), committedStock: 10, status: "PENDING",
    rejectionReason: null, reviewedById: null, reviewedAt: null, createdAt: new Date(NOW.getTime() + regSeq), updatedAt: NOW,
    ...over,
  };
  db.store().registrations.push(r);
  return r;
}

async function published(svc: ReturnType<typeof createCampaignService>, pageId = "PG1", over = {}) {
  const p = await svc.createProgramme(ADMIN, pageId, input(over));
  await svc.publishProgramme(ADMIN, p.id);
  return p;
}

async function rejects(p: Promise<unknown>, status: number, re?: RegExp) {
  await assert.rejects(p, (e: any) => e instanceof MarketingError && e.statusCode === status && (!re || re.test(e.message)));
}

// ── create / publish / update / cancel ──────────────────────────────────────

test("create: a DRAFT programme for the page, categories saved, audit with new data and the admin as actor", async () => {
  const { svc, s } = setup();
  const p = await svc.createProgramme(ADMIN, "PG1", input());
  assert.deepEqual([p.status, p.campaignPageId, p.campaignPage.title], ["DRAFT", "PG1", "Mega Sale"]);
  assert.deepEqual(s().campaignCategories.filter((x) => x.campaignId === p.id).map((x) => x.categoryId), ["cat-root"]);
  const audit = s().audit.filter((x) => x.entityId === p.id);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].action, audit[0].userId, audit[0].oldData], [AUDIT.create, "U_ADMIN", undefined]);
  assert.equal(audit[0].newData.minDiscountPercent, "10", "Decimal snapshotted as a string");
  assert.equal(p.createdById, "U_ADMIN");
});

test("create: one programme per page; the page must exist and have both dates; nothing written on refusal", async () => {
  const { svc, s } = setup();
  await svc.createProgramme(ADMIN, "PG1", input());
  await rejects(svc.createProgramme(ADMIN, "PG1", input()), 409, /already has a vendor programme/);
  await rejects(svc.createProgramme(ADMIN, "missing", input()), 404);
  await rejects(svc.createProgramme(ADMIN, "PG_NODATES", input()), 422, /start and end dates/);
  assert.deepEqual([s().campaigns.length, s().audit.length], [1, 1]);
});

test("create: registration window must close before the page's live window starts; unknown categories refused", async () => {
  const { svc, s } = setup();
  await rejects(svc.createProgramme(ADMIN, "PG1", input({ registrationEndAt: new Date("2026-10-22T00:00:00Z") })), 422, /dates/);
  await rejects(svc.createProgramme(ADMIN, "PG1", input({ registrationStartAt: new Date("2026-10-20T00:00:00Z") })), 422);
  await rejects(svc.createProgramme(ADMIN, "PG1", input({ categoryIds: ["nope"] })), 422, /Unknown categories/);
  assert.deepEqual([s().campaigns.length, s().audit.length], [0, 0]);
});

test("publish: draft → published once; audit has old/new status; outdated dates refused", async () => {
  const { svc, s, db } = setup();
  const p = await svc.createProgramme(ADMIN, "PG1", input());
  await svc.publishProgramme(ADMIN, p.id);
  const audit = s().audit.find((x) => x.action === AUDIT.publish)!;
  assert.deepEqual([audit.oldData.status, audit.newData.status], ["DRAFT", "PUBLISHED"]);
  await rejects(svc.publishProgramme(ADMIN, p.id), 409);
  const other = await svc.createProgramme(ADMIN, "PG2", input({ registrationEndAt: new Date("2026-10-30T00:00:00Z") }));
  const late = createCampaignService(db, { now: () => new Date("2026-11-10T00:00:00Z") });
  await rejects(late.publishProgramme(ADMIN, other.id), 422, /Invalid campaign dates/);
});

test("update a draft: rules and registration window change (validated); audit keeps before/after", async () => {
  const { svc, s } = setup();
  const p = await svc.createProgramme(ADMIN, "PG1", input());
  await rejects(svc.updateProgramme(ADMIN, p.id, { registrationEndAt: new Date("2026-10-22T00:00:00Z") }), 422);
  const { programme } = await svc.updateProgramme(ADMIN, p.id, { registrationEndAt: new Date("2026-10-19T00:00:00Z"), minDiscountPercent: 5 });
  assert.equal(new Date(programme.registrationEndAt).toISOString(), "2026-10-19T00:00:00.000Z");
  const audit = s().audit.find((x) => x.action === AUDIT.update)!;
  assert.deepEqual([audit.oldData.minDiscountPercent, audit.newData.minDiscountPercent], ["10", "5"]);
});

test("published: the registration window is frozen", async () => {
  const { svc } = setup();
  const p = await published(svc);
  await rejects(svc.updateProgramme(ADMIN, p.id, { registrationEndAt: new Date("2026-10-19T00:00:00Z") }), 422, /registration window of a published programme/);
});

test("published + registrations: loosening is refused; nothing changes and nothing is audited", async () => {
  const { svc, db, s } = setup();
  const p = await published(svc);
  addRegistration(db, p.id);
  const auditBefore = s().audit.length;
  for (const patch of [{ minDiscountPercent: 5 }, { minStock: 1 }, { maxProductsPerVendor: null }, { categoryIds: ["cat-root", "cat-fashion"] }]) {
    await rejects(svc.updateProgramme(ADMIN, p.id, patch as any), 422, /cannot be loosened/);
  }
  assert.equal(s().audit.length, auditBefore);
  assert.equal(String(s().campaigns.find((x) => x.id === p.id)!.minDiscountPercent), "10");
});

test("published without registrations: rules may still be loosened", async () => {
  const { svc } = setup();
  const p = await published(svc);
  const { programme, warning } = await svc.updateProgramme(ADMIN, p.id, { minDiscountPercent: 5 });
  assert.equal(String(programme.minDiscountPercent), "5");
  assert.equal(warning, undefined);
});

test("published + registrations: tightening needs acknowledgement; the warning counts affected registrations", async () => {
  const { svc, db, s } = setup();
  const p = await published(svc);
  addRegistration(db, p.id, { campaignPrice: new Decimal("850") }); // 15% — fails a 20% minimum
  addRegistration(db, p.id, { productId: "P3", variantId: "VAR3", campaignPrice: new Decimal("1500") }); // 25% — fine
  addRegistration(db, p.id, { status: "REJECTED", campaignPrice: new Decimal("990") }); // not counted
  await assert.rejects(svc.updateProgramme(ADMIN, p.id, { minDiscountPercent: 20 }), (e: any) => {
    assert.equal(e.statusCode, 409);
    assert.deepEqual(e.details, { tightened: ["minDiscountPercent"], affectedRegistrations: 1 });
    return true;
  });
  assert.equal(String(s().campaigns.find((x) => x.id === p.id)!.minDiscountPercent), "10", "not applied without acknowledgement");
  const { programme, warning } = await svc.updateProgramme(ADMIN, p.id, { minDiscountPercent: 20 }, { acknowledgeTightening: true });
  assert.equal(String(programme.minDiscountPercent), "20");
  assert.deepEqual(warning, { tightened: ["minDiscountPercent"], affectedRegistrations: 1 });
  assert.deepEqual(s().audit.filter((x) => x.action === AUDIT.update).at(-1)!.newData.tighteningAcknowledged, warning);
});

test("tightening categories or the vendor cap is counted too", async () => {
  const { svc, db } = setup();
  const p = await published(svc, "PG1", { categoryIds: [], maxProductsPerVendor: null });
  addRegistration(db, p.id, { productId: "P2", variantId: "VAR2", campaignPrice: new Decimal("300"), committedStock: 5 });
  addRegistration(db, p.id, { status: "APPROVED" });
  addRegistration(db, p.id, { status: "APPROVED", productId: "P3", variantId: "VAR3", campaignPrice: new Decimal("1500") });
  await assert.rejects(svc.updateProgramme(ADMIN, p.id, { categoryIds: ["cat-root"] }), (e: any) => e.statusCode === 409 && e.details.affectedRegistrations === 1);
  await assert.rejects(svc.updateProgramme(ADMIN, p.id, { maxProductsPerVendor: 1 }), (e: any) => e.statusCode === 409 && e.details.affectedRegistrations === 1);
});

test("cancel: reason required; vendors with registrations notified (page title); audit keeps the reason", async () => {
  const { svc, db, s } = setup();
  const p = await published(svc);
  addRegistration(db, p.id);
  addRegistration(db, p.id, { productId: "P3", variantId: "VAR3" });
  await rejects(svc.cancelProgramme(ADMIN, p.id, "  "), 400);
  await svc.cancelProgramme(ADMIN, p.id, "Budget cut");
  assert.equal(s().campaigns.find((x) => x.id === p.id)!.status, "CANCELLED");
  assert.equal(s().notifications.length, 1, "one notification per vendor");
  assert.deepEqual([s().notifications[0].targetType, s().notifications[0].targetId], ["VENDOR", "V1"]);
  assert.match(s().notifications[0].message, /"Mega Sale" was cancelled\. Reason: Budget cut/);
  const audit = s().audit.find((x) => x.action === AUDIT.cancel)!;
  assert.deepEqual([audit.oldData.status, audit.newData.status, audit.newData.reason], ["PUBLISHED", "CANCELLED", "Budget cut"]);
  await rejects(svc.cancelProgramme(ADMIN, p.id, "again"), 409);
  await rejects(svc.updateProgramme(ADMIN, p.id, { minStock: 1 }), 409);
});

// ── page rules (the existing Campaigns builder) ─────────────────────────────

test("landing-page-only campaign: page dates change exactly as before (no programme, no audit)", async () => {
  const { svc, s } = setup();
  const updated = await svc.updateCampaignPage(ADMIN, "PG2", { startDate: new Date("2026-12-01T00:00:00Z"), endDate: null, title: "Eid" });
  assert.deepEqual([updated.title, updated.endDate], ["Eid", null]);
  assert.equal(s().audit.length, 0);
  await svc.updateCampaignPage(null, "PG_NODATES", { heroTitle: "Hi" });
  assert.equal(s().pages.find((p) => p.id === "PG_NODATES")!.heroTitle, "Hi", "no actor needed when no rule applies");
});

test("DRAFT programme: page dates may change only if the registration window still fits", async () => {
  const { svc, s } = setup();
  await svc.createProgramme(ADMIN, "PG1", input());
  await rejects(svc.updateCampaignPage(ADMIN, "PG1", { startDate: new Date("2026-10-19T00:00:00Z") }), 422);
  await rejects(svc.updateCampaignPage(ADMIN, "PG1", { endDate: null }), 422);
  const ok = await svc.updateCampaignPage(ADMIN, "PG1", { startDate: new Date("2026-10-22T00:00:00Z") });
  assert.equal(new Date(ok.startDate).toISOString(), "2026-10-22T00:00:00.000Z");
  assert.equal(s().audit.filter((a) => a.action === AUDIT.extend).length, 0);
});

test("PUBLISHED programme: start date frozen; end date only EXTENDED — never shortened, cleared or set in the past", async () => {
  const { svc, db, s } = setup();
  await published(svc);
  await rejects(svc.updateCampaignPage(ADMIN, "PG1", { startDate: new Date("2026-10-22T00:00:00Z") }), 409, /start date/);
  await rejects(svc.updateCampaignPage(ADMIN, "PG1", { endDate: new Date("2026-10-24T00:00:00Z") }), 409, /only be extended/);
  await rejects(svc.updateCampaignPage(ADMIN, "PG1", { endDate: null }), 409, /only be extended/);
  // Re-sending the same end date with other edits is fine (the Details form sends whole dates).
  const same = await svc.updateCampaignPage(ADMIN, "PG1", { title: "Mega Sale 2", endDate: new Date("2026-10-25T00:00:00Z") });
  assert.equal(same.title, "Mega Sale 2");
  assert.equal(new Date(s().pages.find((p) => p.id === "PG1")!.endDate).toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(s().audit.filter((a) => a.action === AUDIT.extend).length, 0);
  // After the campaign ended, an "extension" that still lies in the past is refused.
  const later = createCampaignService(db, { now: () => new Date("2026-10-27T00:00:00Z") });
  await rejects(later.updateCampaignPage(ADMIN, "PG1", { endDate: new Date("2026-10-26T00:00:00Z") }), 422, /future/);
  const reopened = await later.updateCampaignPage(ADMIN, "PG1", { endDate: new Date("2026-10-30T00:00:00Z") });
  assert.equal(new Date(reopened.endDate).toISOString(), "2026-10-30T00:00:00.000Z");
});

test("PUBLISHED programme: extending the end is audit-logged and notifies vendors with pending/approved registrations", async () => {
  const { svc, db, s } = setup();
  const p = await published(svc);
  addRegistration(db, p.id);
  addRegistration(db, p.id, { vendorId: "V2", status: "REJECTED" });
  const notesBefore = s().notifications.length;
  await svc.updateCampaignPage(ADMIN, "PG1", { endDate: new Date("2026-10-28T00:00:00Z") });
  const audit = s().audit.find((a) => a.action === AUDIT.extend)!;
  assert.deepEqual([audit.entity, audit.entityId, audit.userId], ["CampaignPage", "PG1", "U_ADMIN"]);
  assert.deepEqual([audit.oldData.endDate, audit.newData.endDate, audit.newData.programmeId], ["2026-10-25T00:00:00.000Z", "2026-10-28T00:00:00.000Z", p.id]);
  const notes = s().notifications.slice(notesBefore);
  assert.deepEqual(notes.map((n) => n.targetId), ["V1"], "only vendors still in the campaign");
  assert.match(notes[0].message, /^"Mega Sale" now ends on 2026-10-28 \(was 2026-10-25\)/, "names the page");
  await rejects(svc.updateCampaignPage(null, "PG1", { endDate: new Date("2026-10-30T00:00:00Z") }), 400, /authenticated user/);
});

test("cancelled programme: page dates are free again", async () => {
  const { svc } = setup();
  const p = await published(svc);
  await svc.cancelProgramme(ADMIN, p.id, "stop");
  const updated = await svc.updateCampaignPage(ADMIN, "PG1", { startDate: new Date("2026-12-01T00:00:00Z"), endDate: new Date("2026-12-05T00:00:00Z") });
  assert.equal(new Date(updated.startDate).toISOString(), "2026-12-01T00:00:00.000Z");
  // Even dates that would clash with the old registration window (closes 10-20) are allowed now.
  const early = await svc.updateCampaignPage(ADMIN, "PG1", { startDate: new Date("2026-10-17T00:00:00Z"), endDate: new Date("2026-10-18T00:00:00Z") });
  assert.equal(new Date(early.startDate).toISOString(), "2026-10-17T00:00:00.000Z");
});

test("delete page: landing-only deletes; a programme without registrations is removed with it; registrations block (409)", async () => {
  const { svc, db, s } = setup();
  await svc.deleteCampaignPage("PG2");
  assert.equal(s().pages.some((p) => p.id === "PG2"), false);
  await svc.createProgramme(ADMIN, "PG1", input());
  const withRegs = await svc.createProgramme(ADMIN, "PG_NODATES", input()).catch(() => null);
  assert.equal(withRegs, null, "(page without dates cannot get a programme)");
  const prog = s().campaigns[0];
  addRegistration(db, prog.id);
  await rejects(svc.deleteCampaignPage("PG1"), 409, /vendor registrations/);
  assert.ok(s().pages.some((p) => p.id === "PG1"), "nothing deleted");
  s().registrations = [];
  await svc.deleteCampaignPage("PG1");
  assert.deepEqual([s().pages.some((p) => p.id === "PG1"), s().campaigns.length, s().campaignCategories.length], [false, 0, 0]);
});

// ── approve / reject ────────────────────────────────────────────────────────

test("approve: rules re-checked now; approved with audit (old/new) and a vendor notification naming the page", async () => {
  const { svc, db, s } = setup();
  const p = await published(svc);
  const r = addRegistration(db, p.id);
  assert.deepEqual(await svc.approveRegistration(ADMIN, r.id), { id: r.id, status: "APPROVED" });
  const row = s().registrations.find((x) => x.id === r.id)!;
  assert.deepEqual([row.status, row.reviewedById], ["APPROVED", "U_ADMIN"]);
  const audit = s().audit.find((x) => x.action === AUDIT.approve)!;
  assert.deepEqual([audit.entity, audit.entityId, audit.oldData.status, audit.newData.status], ["CampaignRegistration", r.id, "PENDING", "APPROVED"]);
  const note = s().notifications.at(-1)!;
  assert.deepEqual([note.targetType, note.targetId, note.productId], ["VENDOR", "V1", "P1"]);
  assert.match(note.message, /"Phone X" was approved for "Mega Sale"/);
  await rejects(svc.approveRegistration(ADMIN, r.id), 409, /Only pending/);
});

test("approve: a registration that no longer meets the rules is refused with the violations; nothing is written", async () => {
  const { svc, db, s } = setup();
  const p = await published(svc);
  const r = addRegistration(db, p.id);
  s().variants.find((v) => v.id === "VAR1")!.specialPrice = new Decimal("900");
  s().variants.find((v) => v.id === "VAR1")!.stock = 3;
  const audits = s().audit.length;
  await assert.rejects(svc.approveRegistration(ADMIN, r.id), (e: any) => {
    assert.equal(e.statusCode, 422);
    assert.deepEqual(e.details.violations.map((v: any) => v.rule), ["minDiscountPercent", "stock"]);
    return true;
  });
  assert.equal(s().registrations.find((x) => x.id === r.id)!.status, "PENDING");
  assert.equal(s().audit.length, audits);
  assert.equal(s().notifications.length, 0);
});

test("approve: the campaign end comes from the page; suspended store, category and vendor cap enforced", async () => {
  const { svc, db } = setup();
  const p = await published(svc);
  const late = createCampaignService(db, { now: () => new Date("2026-10-26T00:00:00Z") });
  const r0 = addRegistration(db, p.id);
  await assert.rejects(late.approveRegistration(ADMIN, r0.id), (e: any) => e.details.violations.some((v: any) => v.rule === "campaignEnded"));
  const suspended = addRegistration(db, p.id, { vendorId: "V2" });
  const fashion = addRegistration(db, p.id, { productId: "P2", variantId: "VAR2", campaignPrice: new Decimal("300"), committedStock: 5 });
  await assert.rejects(svc.approveRegistration(ADMIN, suspended.id), (e: any) => e.details.violations.some((v: any) => v.rule === "vendorStatus"));
  await assert.rejects(svc.approveRegistration(ADMIN, fashion.id), (e: any) => e.details.violations.some((v: any) => v.rule === "category"));
  const b = addRegistration(db, p.id, { productId: "P3", variantId: "VAR3", campaignPrice: new Decimal("1500") });
  db.store().variants.push({ id: "VAR3x", productId: "P3", price: new Decimal("2000"), specialPrice: null, stock: 20 });
  const third = addRegistration(db, p.id, { productId: "P3", variantId: "VAR3x", campaignPrice: new Decimal("1500") });
  await svc.approveRegistration(ADMIN, r0.id);
  await svc.approveRegistration(ADMIN, b.id);
  await assert.rejects(svc.approveRegistration(ADMIN, third.id), (e: any) => e.details.violations.some((v: any) => v.rule === "maxProductsPerVendor"));
});

test("approve after the programme was cancelled is refused", async () => {
  const { svc, db } = setup();
  const p = await published(svc);
  const r = addRegistration(db, p.id);
  await svc.cancelProgramme(ADMIN, p.id, "stop");
  await assert.rejects(svc.approveRegistration(ADMIN, r.id), (e: any) => e.statusCode === 422 && e.details.violations[0].rule === "campaignStatus");
});

test("reject: reason required (trimmed, ≤500); stored, audited and sent to the vendor", async () => {
  const { svc, db, s } = setup();
  const p = await published(svc);
  const r = addRegistration(db, p.id);
  await rejects(svc.rejectRegistration(ADMIN, r.id, "   "), 400, /reason is required/);
  await rejects(svc.rejectRegistration(ADMIN, r.id, "x".repeat(501)), 400);
  await svc.rejectRegistration(ADMIN, r.id, "  Image quality too low ");
  const row = s().registrations.find((x) => x.id === r.id)!;
  assert.deepEqual([row.status, row.rejectionReason], ["REJECTED", "Image quality too low"]);
  const audit = s().audit.find((x) => x.action === AUDIT.reject)!;
  assert.deepEqual([audit.oldData.status, audit.newData.status, audit.newData.rejectionReason], ["PENDING", "REJECTED", "Image quality too low"]);
  assert.match(s().notifications.at(-1)!.message, /not accepted for "Mega Sale"\. Reason: Image quality too low/);
  await rejects(svc.rejectRegistration(ADMIN, r.id, "again"), 409);
});

// ── bulk ────────────────────────────────────────────────────────────────────

test("bulk approve: preview returns the count and rule check WITHOUT changing anything", async () => {
  const { svc, db, s } = setup();
  const p = await published(svc);
  addRegistration(db, p.id);
  const bad = addRegistration(db, p.id, { productId: "P3", variantId: "VAR3", campaignPrice: new Decimal("1950") });
  const audits = s().audit.length;
  const preview: any = await svc.bulkReview(ADMIN, p.id, { action: "approve" });
  assert.deepEqual([preview.confirmRequired, preview.count, preview.eligibleCount, preview.ineligible[0].id], [true, 2, 1, bad.id]);
  assert.deepEqual(s().registrations.map((r) => r.status), ["PENDING", "PENDING"]);
  assert.equal(s().audit.length, audits);
});

test("bulk confirm: wrong expectedCount → 409 and nothing applied; right count → eligible applied, others skipped", async () => {
  const { svc, db, s } = setup();
  const p = await published(svc);
  const ok = addRegistration(db, p.id);
  const bad = addRegistration(db, p.id, { productId: "P3", variantId: "VAR3", campaignPrice: new Decimal("1950") });
  await rejects(svc.bulkReview(ADMIN, p.id, { action: "approve", confirm: true, expectedCount: 3 }), 409, /selection changed/);
  assert.deepEqual(s().registrations.map((r) => r.status), ["PENDING", "PENDING"]);
  const res: any = await svc.bulkReview(ADMIN, p.id, { action: "approve", confirm: true, expectedCount: 2 });
  assert.deepEqual([res.count, res.appliedCount, res.applied], [2, 1, [ok.id]]);
  assert.deepEqual([res.skipped[0].id, res.skipped[0].status], [bad.id, 422]);
  assert.equal(s().audit.filter((x) => x.action === AUDIT.approve).length, 1);
});

test("bulk reject: needs a reason; preview is the count only; confirm rejects the selected ids", async () => {
  const { svc, db, s } = setup();
  const p = await published(svc);
  const a = addRegistration(db, p.id);
  const b = addRegistration(db, p.id, { productId: "P3", variantId: "VAR3" });
  await rejects(svc.bulkReview(ADMIN, p.id, { action: "reject" }), 400, /reason/);
  const preview: any = await svc.bulkReview(ADMIN, p.id, { action: "reject", reason: "Out of scope", registrationIds: [a.id] });
  assert.deepEqual([preview.confirmRequired, preview.count], [true, 1]);
  const res: any = await svc.bulkReview(ADMIN, p.id, { action: "reject", reason: "Out of scope", registrationIds: [a.id], confirm: true, expectedCount: 1 });
  assert.deepEqual(res.applied, [a.id]);
  assert.equal(s().registrations.find((x) => x.id === b.id)!.status, "PENDING");
});

// ── pages list / programme detail ───────────────────────────────────────────

test("listCampaignPages: every page with its programme summary (null for landing-page-only) and counts", async () => {
  const { svc, db } = setup();
  const p = await published(svc);
  addRegistration(db, p.id);
  addRegistration(db, p.id, { productId: "P3", variantId: "VAR3", status: "APPROVED" });
  addRegistration(db, p.id, { vendorId: "V2", status: "REJECTED" });
  const res = await svc.listCampaignPages({});
  assert.deepEqual(res.items.map((x: any) => x.id), ["PG2", "PG1", "PG_NODATES"]);
  const pg1 = res.items.find((x: any) => x.id === "PG1")!;
  assert.deepEqual(pg1.programme, { id: p.id, status: "PUBLISHED", counts: { pending: 1, approved: 1, rejected: 1, withdrawn: 0, total: 3, vendors: 2 } });
  assert.equal(res.items.find((x: any) => x.id === "PG2")!.programme, null);
  assert.deepEqual((await svc.listCampaignPages({ search: "eid" })).items.map((x: any) => x.id), ["PG2"]);
});

test("getProgrammeByPage: page + programme with phase from the page dates; null programme for landing-only", async () => {
  const { svc } = setup();
  const p = await published(svc);
  const res: any = await svc.getProgrammeByPage("PG1");
  assert.deepEqual([res.page.title, res.programme.id, res.programme.phase, res.programme.counts.total], ["Mega Sale", p.id, "UPCOMING", 0]);
  assert.equal(res.programme.categories[0].category.name, "Electronics");
  assert.deepEqual((await svc.getProgrammeByPage("PG2")).programme, null);
  await rejects(svc.getProgrammeByPage("missing"), 404);
});

test("every admin action writes exactly one audit row with the actor", async () => {
  const { svc, db, s } = setup();
  const p = await svc.createProgramme(ADMIN, "PG1", input());
  await svc.updateProgramme(ADMIN, p.id, { minStock: 6 });
  await svc.publishProgramme(ADMIN, p.id);
  const r1 = addRegistration(db, p.id);
  const r2 = addRegistration(db, p.id, { productId: "P3", variantId: "VAR3" });
  await svc.approveRegistration(ADMIN, r1.id);
  await svc.rejectRegistration(ADMIN, r2.id, "no");
  await svc.updateCampaignPage(ADMIN, "PG1", { endDate: new Date("2026-10-27T00:00:00Z") });
  await svc.cancelProgramme(ADMIN, p.id, "done");
  assert.deepEqual(s().audit.map((a) => a.action), [AUDIT.create, AUDIT.update, AUDIT.publish, AUDIT.approve, AUDIT.reject, AUDIT.extend, AUDIT.cancel]);
  assert.ok(s().audit.every((a) => a.userId === "U_ADMIN"));
});
