// tests/offer-permissions-route.security.test.ts
//
// Phase 1 S2:
//   GET /api/offers/admin/vendor-permissions/:vendorId — ADMIN only (it used
//     to be authenticateUser-only, so any logged-in user could read any
//     vendor's offer permissions by id).
//   GET /api/offers/vendor/permissions — the vendor's own permissions, vendor
//     taken from the session: VENDOR, or vendor staff with offerManagement
//     (vendor employees can open the vendor offer screens).
//
// DB-free: see tests/support/phase1-auth.ts. Run with ACCESS_TOKEN_SECRET set:
//   npx tsx --test tests/offer-permissions-route.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import offerRoutes from "../src/routes/offers.routes.ts";
import { WHO, outcome, stubAuth, type Who } from "./support/phase1-auth.ts";

test("admin single-vendor permissions: ADMIN only", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const who of WHO) {
      const want = who === "ADMIN" ? "controller" : who === "ANONYMOUS" ? "401" : "403";
      const got = await outcome(offerRoutes, who, "get", "/admin/vendor-permissions/:vendorId");
      if (got !== want) mismatches.push(`${who}: expected ${want}, got ${got}`);
    }
    assert.deepEqual(mismatches, []);
  } finally {
    restore();
  }
});

test("vendor permissions info: VENDOR and vendor staff with offerManagement only", async () => {
  const allowed: Who[] = ["VENDOR", "VENDOR_EMP_WITH"];
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const who of WHO) {
      const want = allowed.includes(who) ? "controller" : who === "ANONYMOUS" ? "401" : "403";
      const got = await outcome(offerRoutes, who, "get", "/vendor/permissions");
      if (got !== want) mismatches.push(`${who}: expected ${want}, got ${got}`);
    }
    assert.deepEqual(mismatches, []);
  } finally {
    restore();
  }
});
