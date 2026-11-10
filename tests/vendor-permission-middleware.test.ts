// tests/vendor-permission-middleware.test.ts
//
// Phase 1 S5: requireVendorPermission(key) — the vendor-scoped gate.
//   VENDOR (with vendorId)                          → pass, vendorScope = own vendor
//   EMPLOYEE, vendorId set, permissions[key] === true → pass, vendorScope = own vendor
//   EMPLOYEE without the key / not exactly true     → 403
//   EMPLOYEE with vendorId null (admin side)        → 403 even holding the key
//   EMPLOYEE whose row is inactive / of another vendor → 403
//   ADMIN, CUSTOMER                                 → 403;  no user → 401
// A vendorId in body/query/params never changes the scope, and
// requirePermission() keeps its old behaviour (ADMIN/VENDOR pass).
// DB-free: prisma.employee.findUnique is stubbed.
//   npx tsx --test tests/vendor-permission-middleware.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { requirePermission, requireVendorPermission } from "../src/middlewares/permission.middleware.ts";
import { fakeRes, run } from "./support/phase1-auth.ts";

type Row = { permissions: unknown; isActive: boolean; vendorId: string | null } | null;

async function gate(mw: any, user: any, row: Row = null, extra: any = {}) {
  const e = prisma.employee as any;
  const orig = e.findUnique;
  const reads: any[] = [];
  e.findUnique = async (args: any) => (reads.push(args), row);
  try {
    const req: any = { user, body: extra.body ?? {}, query: extra.query ?? {}, params: extra.params ?? {} };
    const res = fakeRes();
    const r = await run(mw, req, res);
    return { passed: r === "next", status: r === "next" ? 200 : res.statusCode, scope: req.vendorScope, reads };
  } finally {
    e.findUnique = orig;
  }
}

const vendor = { id: "V1", rawId: "U1", role: "VENDOR", vendorId: "V1", employeeId: null };
const vStaff = { id: "E1", rawId: "U2", role: "EMPLOYEE", vendorId: "V1", employeeId: "E1" };
const aStaff = { id: "E2", rawId: "U3", role: "EMPLOYEE", vendorId: null, employeeId: "E2" };
const admin = { id: "E3", rawId: "U4", role: "ADMIN", vendorId: null, employeeId: "E3" };
const customer = { id: "U5", rawId: "U5", role: "CUSTOMER", vendorId: null, employeeId: null };

const gateAd = requireVendorPermission("adManagement");

test("VENDOR passes with its own vendor scope (no employee read)", async () => {
  const r = await gate(gateAd, vendor);
  assert.deepEqual([r.passed, r.scope, r.reads.length], [true, "V1", 0]);
});

test("VENDOR without a vendorId is refused", async () => {
  const r = await gate(gateAd, { ...vendor, vendorId: null });
  assert.deepEqual([r.passed, r.status], [false, 403]);
});

test("vendor staff with the key === true passes, scoped to its vendor; the row is re-read", async () => {
  const r = await gate(gateAd, vStaff, { permissions: { adManagement: true }, isActive: true, vendorId: "V1" });
  assert.deepEqual([r.passed, r.scope], [true, "V1"]);
  assert.equal(r.reads[0].where.id, "E1");
});

test("vendor staff without the key, or with a non-true value, is refused", async () => {
  for (const permissions of [{}, { offerManagement: true }, { adManagement: false }, { adManagement: "true" }, { adManagement: 1 }, null, []]) {
    const r = await gate(gateAd, vStaff, { permissions, isActive: true, vendorId: "V1" });
    assert.deepEqual([r.passed, r.status], [false, 403], JSON.stringify(permissions));
  }
});

test("admin-side staff (vendorId null) is refused even when holding the key", async () => {
  const r = await gate(gateAd, aStaff, { permissions: { adManagement: true }, isActive: true, vendorId: null });
  assert.deepEqual([r.passed, r.status, r.reads.length], [false, 403, 0]);
});

test("inactive, missing, or other-vendor employee rows are refused", async () => {
  for (const row of [
    { permissions: { adManagement: true }, isActive: false, vendorId: "V1" },
    null,
    { permissions: { adManagement: true }, isActive: true, vendorId: "V2" },
  ] as Row[]) {
    const r = await gate(gateAd, vStaff, row);
    assert.deepEqual([r.passed, r.status], [false, 403], JSON.stringify(row));
  }
});

test("ADMIN and CUSTOMER are refused; no user → 401", async () => {
  assert.equal((await gate(gateAd, admin, { permissions: { adManagement: true }, isActive: true, vendorId: null })).status, 403);
  assert.equal((await gate(gateAd, customer)).status, 403);
  assert.equal((await gate(gateAd, undefined)).status, 401);
});

test("a request-supplied vendorId never changes the scope", async () => {
  const forged = { body: { vendorId: "V2" }, query: { vendorId: "V2" }, params: { vendorId: "V2" } };
  assert.equal((await gate(gateAd, vendor, null, forged)).scope, "V1");
  const r = await gate(gateAd, vStaff, { permissions: { adManagement: true }, isActive: true, vendorId: "V1" }, forged);
  assert.equal(r.scope, "V1");
});

test("requirePermission() is unchanged: ADMIN and VENDOR still pass, staff need the flag", async () => {
  const gateP = requirePermission("productManagement");
  assert.equal((await gate(gateP, admin)).passed, true);
  assert.equal((await gate(gateP, vendor)).passed, true);
  assert.equal((await gate(gateP, aStaff, { permissions: { productManagement: true }, isActive: true, vendorId: null })).passed, true);
  assert.equal((await gate(gateP, aStaff, { permissions: {}, isActive: true, vendorId: null })).status, 403);
  // Unchanged (not vendor-scoped): vendor staff holding the flag still pass requirePermission.
  assert.equal((await gate(gateP, vStaff, { permissions: { productManagement: true }, isActive: true, vendorId: "V1" })).passed, true);
});
