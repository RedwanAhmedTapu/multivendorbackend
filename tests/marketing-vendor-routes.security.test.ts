// tests/marketing-vendor-routes.security.test.ts
//
// Marketing Center Phase 3 — vendor API authorization (/api/marketing/vendor).
// Router-level chain on every route:
//   authenticateUser → requireVendorPermission("offerManagement")
// 1. Matrix through the REAL middleware (controllers not run): vendor owner
//    and vendor staff WITH offerManagement pass; vendor staff without it,
//    ADMIN, admin-side staff (even with offerManagement) and customers → 403;
//    anonymous → 401.
// 2. End-to-end through the controller with a fake database: the vendor id
//    comes from the token only — a vendorId in the query is ignored and one
//    in the body is refused; staff act for their own vendor and are the
//    audited actor; refused staff write nothing.
// DB-free; run with ACCESS_TOKEN_SECRET set:
//   npx tsx --test tests/marketing-vendor-routes.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarketingVendorRouter } from "../src/modules/marketing/vendor-campaign.routes.ts";
import { createCampaignService } from "../src/modules/marketing/campaign.service.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";
import { createFakeMarketingDb, seedWorld } from "./support/fake-marketing-db.ts";
import { WHO, fakeRes, outcome, requestFor, routeHandles, run, stubAuth, type Who } from "./support/phase1-auth.ts";

const ROUTES: [string, string][] = [
  ["get", "/campaigns"],
  ["get", "/campaigns/:id"],
  ["post", "/campaigns/:id/registrations"],
  ["get", "/registrations"],
  ["patch", "/registrations/:id"],
  ["post", "/registrations/:id/withdraw"],
];

const expected = (who: Who) => (who === "VENDOR" || who === "VENDOR_EMP_WITH" ? "controller" : who === "ANONYMOUS" ? "401" : "403");

test("exactly the 6 vendor marketing routes are mounted, after the two router-level guards", () => {
  const router = createMarketingVendorRouter(createFakeMarketingDb());
  const stack = (router as any).stack as any[];
  const mounted = stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`)).sort();
  assert.deepEqual(mounted, ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  assert.equal(stack[0].handle, authenticateUser);
  assert.ok(stack.slice(0, 2).every((l) => !l.route), "two router-level guards");
  assert.equal(stack.findIndex((l) => l.route), 2, "routes come after the guards");
});

test("access matrix: 6 routes × 8 identities (vendor staff need offerManagement; admin side refused)", async () => {
  const router = createMarketingVendorRouter(createFakeMarketingDb());
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const [m, p] of ROUTES) {
      for (const who of WHO) {
        const got = await outcome(router, who, m, p);
        if (got !== expected(who)) mismatches.push(`${m.toUpperCase()} ${p} as ${who}: expected ${expected(who)}, got ${got}`);
      }
    }
    assert.equal(mismatches.length, 0, mismatches.join("\n"));
  } finally {
    restore();
  }
});

// ── end-to-end through the controller ───────────────────────────────────────

/** A published programme whose registration window contains the real clock (the router uses real time). */
async function liveWorld() {
  const db = createFakeMarketingDb(seedWorld());
  const t = Date.now();
  const page = db.store().pages.find((p) => p.id === "PG1")!;
  page.startDate = new Date(t + 2 * 86_400_000);
  page.endDate = new Date(t + 5 * 86_400_000);
  const admin = createCampaignService(db);
  const p = await admin.createProgramme({ userId: "U_ADMIN" }, "PG1", {
    registrationStartAt: new Date(t + 1_000),
    registrationEndAt: new Date(t + 86_400_000),
    minDiscountPercent: 10,
    minStock: 5,
    maxProductsPerVendor: null,
    categoryIds: [],
  });
  await admin.publishProgramme({ userId: "U_ADMIN" }, p.id);
  db.store().campaigns[0].registrationStartAt = new Date(t - 60_000); // open now
  return { db, p, router: createMarketingVendorRouter(db) };
}

async function call(router: any, who: Who, method: string, path: string, extra: { body?: any; query?: any; params?: any } = {}) {
  const req = requestFor(who, extra);
  const res = fakeRes();
  for (const layer of (router.stack as any[]).filter((l) => !l.route)) {
    if ((await run(layer.handle, req, res)) === "ended") return res;
  }
  for (const h of routeHandles(router, method, path)) {
    if ((await run(h, req, res)) === "ended") return res;
  }
  return res;
}

test("the vendor id comes from the token only: query vendorId ignored, body vendorId refused, staff act for their own vendor", async () => {
  const { db, p, router } = await liveWorld();
  const restore = stubAuth();
  try {
    // Another vendor (V3) already registered — V1 must never see it.
    db.store().registrations.push({ id: "R_V3", campaignId: p.id, vendorId: "V3", productId: "P5", variantId: "VAR5", campaignPrice: "1300", originalPrice: "1500", committedStock: 10, status: "PENDING", createdAt: new Date(), updatedAt: new Date() });

    const list = await call(router, "VENDOR", "get", "/registrations", { query: { vendorId: "V3" } });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.body.data, [], "?vendorId=V3 is ignored — V1 has none");

    const smuggled = await call(router, "VENDOR", "post", "/campaigns/:id/registrations", { params: { id: p.id }, body: { vendorId: "V3", items: [{ variantId: "VAR1", campaignPrice: "850", committedStock: 10 }] } });
    assert.equal(smuggled.statusCode, 400, "unknown body keys (vendorId) are refused");

    const theirs = await call(router, "VENDOR", "post", "/campaigns/:id/registrations", { params: { id: p.id }, body: { items: [{ variantId: "VAR5", campaignPrice: "1300", committedStock: 10 }] } });
    assert.equal(theirs.statusCode, 404, "another vendor's variant");

    const staff = await call(router, "VENDOR_EMP_WITH", "post", "/campaigns/:id/registrations", { params: { id: p.id }, body: { items: [{ variantId: "VAR1", campaignPrice: 850, committedStock: 10 }] } });
    assert.equal(staff.statusCode, 201, JSON.stringify(staff.body));
    const row = db.store().registrations.find((r) => r.variantId === "VAR1")!;
    assert.deepEqual([row.vendorId, row.status], ["V1", "PENDING"], "staff register for their own vendor");
    assert.equal(db.store().audit.at(-1)!.userId, "U_VEMP1", "the staff member is the audited actor");

    const retry = await call(router, "VENDOR", "post", "/campaigns/:id/registrations", { params: { id: p.id }, body: { items: [{ variantId: "VAR1", campaignPrice: "850.00", committedStock: 10 }] } });
    assert.deepEqual([retry.statusCode, retry.body.data.created.length, retry.body.data.unchanged.length], [200, 0, 1], "idempotent retry → 200, nothing created");

    const before = db.store().registrations.length;
    const refused = await call(router, "VENDOR_EMP_WITHOUT", "post", "/campaigns/:id/registrations", { params: { id: p.id }, body: { items: [{ variantId: "VAR3", campaignPrice: "1700", committedStock: 10 }] } });
    assert.equal(refused.statusCode, 403, "staff without offerManagement");
    assert.equal(db.store().registrations.length, before, "nothing written");

    const other = await call(router, "VENDOR", "patch", "/registrations/:id", { params: { id: "R_V3" }, body: { committedStock: 11 } });
    assert.equal(other.statusCode, 404, "another vendor's registration is not confirmed");
    const detail = await call(router, "VENDOR", "get", "/campaigns/:id", { params: { id: p.id } });
    assert.equal(detail.statusCode, 200);
    assert.ok(!detail.body.data.variants.some((v: any) => v.variantId === "VAR5"), "detail lists only own variants");
  } finally {
    restore();
  }
});
