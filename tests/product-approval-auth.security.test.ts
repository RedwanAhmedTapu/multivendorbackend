// tests/product-approval-auth.security.test.ts
//
// Phase 1 S1/P1: every /api/products/admin/* route runs
//   authenticateUser → authorizeRoles("ADMIN","EMPLOYEE") → blockVendorEmployees
//   → requirePermission("productManagement") → controller
// so only ADMIN, or an admin-side EMPLOYEE holding productManagement, reaches a
// controller — including the five approval paths (approve, reject, bulk
// approve, bulk reject, /:id/status). Vendor staff are refused even when they
// hold the flag; VENDOR is refused before requirePermission (which would
// otherwise wave VENDOR through). DELETE stays ADMIN-only.
//
// DB-free: see tests/support/phase1-auth.ts. Run with ACCESS_TOKEN_SECRET set:
//   npx tsx --test tests/product-approval-auth.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import productRoutes from "../src/modules/product-module/routes/product.routes.ts";
import { AdminProductController } from "../src/modules/product-module/controllers/product.controller.admin.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";
import { blockVendorEmployees } from "../src/middlewares/permission.middleware.ts";
import { WHO, outcome, routeHandles, stubAuth, type Who } from "./support/phase1-auth.ts";

const ADMIN_ROUTES: [string, string, unknown][] = [
  ["get", "/admin/all", AdminProductController.getAll],
  ["get", "/admin/pending", AdminProductController.getPendingApproval],
  ["get", "/admin/statistics", AdminProductController.getStatistics],
  ["post", "/admin/filter", AdminProductController.filter],
  ["get", "/admin/vendor/:vendorId", AdminProductController.getByVendorId],
  ["patch", "/admin/:id/approve", AdminProductController.approveProduct],
  ["patch", "/admin/:id/reject", AdminProductController.rejectProduct],
  ["post", "/admin/bulk-approve", AdminProductController.bulkApprove],
  ["post", "/admin/bulk-reject", AdminProductController.bulkReject],
  ["patch", "/admin/:id/status", AdminProductController.updateStatus],
  ["patch", "/admin/:id/restore", AdminProductController.restore],
  ["get", "/admin/:id", AdminProductController.getById],
  ["put", "/admin/:id", AdminProductController.update],
];
const APPROVAL_PATHS = ["/admin/:id/approve", "/admin/:id/reject", "/admin/bulk-approve", "/admin/bulk-reject", "/admin/:id/status"];

function expected(who: Who): string {
  switch (who) {
    case "ADMIN":
    case "ADMIN_EMP_WITH":
      return "controller";
    case "ANONYMOUS":
      return "401";
    default:
      return "403";
  }
}

test("every /admin/* product route is in the inventory (nothing unguarded is added silently)", () => {
  const mounted = ((productRoutes as any).stack as any[])
    .filter((l) => l.route && l.route.path.startsWith("/admin"))
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`))
    .sort();
  assert.deepEqual(mounted, [...ADMIN_ROUTES.map(([m, p]) => `${m} ${p}`), "delete /admin/:id"].sort());
});

test("guard order on each admin route: authenticate → role → block vendor staff → productManagement → controller", () => {
  for (const [method, path, controller] of ADMIN_ROUTES) {
    const h = routeHandles(productRoutes, method, path);
    assert.equal(h.length, 5, `${method} ${path}: 4 guards + controller`);
    assert.equal(h[0], authenticateUser, `${method} ${path}: authenticateUser first`);
    assert.equal(h[2], blockVendorEmployees, `${method} ${path}: blockVendorEmployees before the permission check`);
    assert.equal(h[4], controller, `${method} ${path}: the expected controller`);
  }
});

test("access matrix: 13 admin routes × 8 identities through the real middleware", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const [method, path] of ADMIN_ROUTES) {
      for (const who of WHO) {
        const got = await outcome(productRoutes, who, method, path);
        if (got !== expected(who)) mismatches.push(`${method.toUpperCase()} ${path} as ${who}: expected ${expected(who)}, got ${got}`);
      }
    }
    assert.deepEqual(mismatches, []);
  } finally {
    restore();
  }
});

test("the five approval paths refuse vendor staff holding productManagement, VENDOR and admin staff without it", async () => {
  const restore = stubAuth();
  try {
    for (const path of APPROVAL_PATHS) {
      const method = path.includes("bulk") ? "post" : "patch";
      assert.equal(await outcome(productRoutes, "VENDOR_EMP_WITH", method, path), "403", `${path}: vendor staff with the flag`);
      assert.equal(await outcome(productRoutes, "VENDOR", method, path), "403", `${path}: vendor owner`);
      assert.equal(await outcome(productRoutes, "ADMIN_EMP_WITHOUT", method, path), "403", `${path}: admin staff without the flag`);
      assert.equal(await outcome(productRoutes, "ADMIN_EMP_WITH", method, path), "controller", `${path}: admin staff with the flag`);
    }
  } finally {
    restore();
  }
});

test("DELETE /admin/:id stays ADMIN-only (not broadened)", async () => {
  const restore = stubAuth();
  try {
    assert.equal(await outcome(productRoutes, "ADMIN", "delete", "/admin/:id"), "controller");
    for (const who of WHO.filter((w) => w !== "ADMIN")) {
      assert.equal(await outcome(productRoutes, who, "delete", "/admin/:id"), who === "ANONYMOUS" ? "401" : "403", who);
    }
  } finally {
    restore();
  }
});
