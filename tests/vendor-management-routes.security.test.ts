// tests/vendor-management-routes.security.test.ts
//
// Vendor-management security remediation: /api/vendormanagement had NO
// authentication. Now every route runs router-level authenticateUser, then:
//   adminOnly  (25 routes) — ADMIN only
//   ownVendor  (17 routes) — ADMIN, or the VENDOR whose own id is in the URL;
//                            another vendor's id → 404
//   GET /:id/payment-accounts — as ownVendor, plus that vendor's staff with
//                            inventoryManagement (vendor purchase screens)
//   GET /      — ADMIN, or admin-side staff with orderManagement (admin orders
//                filter)
//   DELETE /documents/:documentId — ADMIN or VENDOR; the controller scopes a
//                vendor to its own documents (another vendor's → 404)
// Plus: no route is shadowed (POST /bulk/charges used to be swallowed by
// POST /:id/charges), profile updates cannot change vendor status, the
// verification approver comes from the session, and document deletion is
// owner-scoped.
//
// DB-free: authenticateUser's lookups and the employee permission re-read are
// stubbed on the shared Prisma client; vendor-service delegates are stubbed in
// place (vendorServiceDb). Controllers never run in the matrix. Run with
// ACCESS_TOKEN_SECRET set:
//   npx tsx --test tests/vendor-management-routes.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { prisma } from "../src/config/prisma.ts";
import vendorRoutes from "../src/routes/vendor.routes.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";
import { VendorController } from "../src/controllers/vendor.controller.ts";
import { vendorServiceDb } from "../src/services/vendor.service.ts";
import { fakeRes, run, routeHandles } from "./support/phase1-auth.ts";

// ── route inventory ─────────────────────────────────────────────────────────

type Group = "admin" | "own" | "ownStaffInventory" | "list" | "document";
const ROUTES: [string, string, Group][] = [
  ["post", "/", "admin"],
  ["get", "/", "list"],
  ["get", "/:id", "own"],
  ["patch", "/:id/profile", "own"],
  ["patch", "/:id/active", "admin"],
  ["patch", "/:id/suspended", "admin"],
  ["patch", "/:id/deactivated", "admin"],
  ["delete", "/:id", "admin"],
  ["patch", "/:id/verification/under-review", "admin"],
  ["patch", "/:id/verification/verify", "admin"],
  ["patch", "/:id/verification/reject", "admin"],
  ["patch", "/:id/verification/suspend", "admin"],
  ["post", "/:id/verification/request-reverification", "own"],
  ["post", "/:id/commission", "admin"],
  ["get", "/:id/commission/history", "own"],
  ["post", "/set/bulk/commission", "admin"],
  ["post", "/:id/payouts", "admin"],
  ["patch", "/payouts/:payoutId/status", "admin"],
  ["get", "/:id/payouts", "admin"],
  ["get", "/:id/payouts/summary", "admin"],
  ["post", "/bulk/charges", "admin"],
  ["post", "/:id/charges", "admin"],
  ["get", "/:id/charges", "admin"],
  ["get", "/:id/performance", "admin"],
  ["post", "/:id/performance/update", "admin"],
  ["get", "/:id/fraud-detection", "admin"],
  ["post", "/:id/flags", "admin"],
  ["get", "/:id/flags", "admin"],
  ["put", "/:id/personal-info", "own"],
  ["get", "/:id/personal-info", "own"],
  ["get", "/:vendorId/complete-profile", "own"],
  ["put", "/:id/address", "own"],
  ["get", "/:id/address", "own"],
  ["post", "/:id/payment-accounts", "own"],
  ["get", "/:id/payment-accounts", "ownStaffInventory"],
  ["patch", "/:id/payment-accounts/:bankAccountId/default", "own"],
  ["post", "/:id/documents", "own"],
  ["get", "/:id/documents", "own"],
  ["delete", "/documents/:documentId", "document"],
  ["put", "/:id/subscription", "admin"],
  ["get", "/:id/subscription", "own"],
  ["get", "/:id/onboarding-status", "own"],
  ["get", "/:id/settings", "own"],
  ["patch", "/:id/settings", "own"],
  ["get", "/export/list", "admin"],
];

// ── identities (V1 is the vendor whose id is in every URL) ──────────────────

const PEOPLE = {
  ADMIN: { user: { id: "U_ADMIN", role: "ADMIN", vendorId: null }, employee: { id: "E_ADMIN", vendorId: null, permissions: {} } },
  ADMIN_STAFF_ORDERS: { user: { id: "U_AS1", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_AS1", vendorId: null, permissions: { orderManagement: true } } },
  ADMIN_STAFF_OTHER: { user: { id: "U_AS2", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_AS2", vendorId: null, permissions: { productManagement: true, inventoryManagement: true } } },
  VENDOR_OWN: { user: { id: "U_V1", role: "VENDOR", vendorId: "V1" }, employee: null },
  VENDOR_OTHER: { user: { id: "U_V2", role: "VENDOR", vendorId: "V2" }, employee: null },
  VENDOR_STAFF_INVENTORY: { user: { id: "U_VS1", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_VS1", vendorId: "V1", permissions: { inventoryManagement: true } } },
  VENDOR_STAFF_OTHER: { user: { id: "U_VS2", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_VS2", vendorId: "V1", permissions: { orderManagement: true, productManagement: true } } },
  CUSTOMER: { user: { id: "U_C", role: "CUSTOMER", vendorId: null }, employee: null },
} as const;
type Who = keyof typeof PEOPLE | "ANONYMOUS";
const WHO: Who[] = [...(Object.keys(PEOPLE) as (keyof typeof PEOPLE)[]), "ANONYMOUS"];

function stubAuth() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const people = Object.values(PEOPLE) as any[];
  const byUser = new Map(people.map((p) => [p.user.id, p]));
  const byEmployee = new Map(people.filter((p) => p.employee).map((p) => [p.employee.id, p.employee]));
  set(prisma.user, "findUnique", async ({ where }: any) => {
    const p = byUser.get(where.id);
    return p ? { id: p.user.id, name: "n", email: null, role: p.user.role, isActive: true, vendorId: p.user.vendorId } : null;
  });
  set(prisma.vendor, "findUnique", async ({ where }: any) => (["V1", "V2"].includes(where.id) ? { id: where.id, storeName: "S", email: null } : null));
  set(prisma.employee, "findFirst", async ({ where }: any) => {
    const e = byUser.get(where.userId)?.employee;
    return e ? { id: e.id, vendorId: e.vendorId } : null;
  });
  set(prisma.employee, "findUnique", async ({ where }: any) => {
    const e = byEmployee.get(where.id);
    return e ? { permissions: e.permissions, isActive: true, vendorId: e.vendorId } : null;
  });
  return () => restores.reverse().forEach((r) => r());
}

function requestFor(who: Who, params: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (who !== "ANONYMOUS") {
    const p = PEOPLE[who];
    headers.authorization = `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
  }
  return { headers, params, body: {}, query: {} } as any;
}

const PARAMS = { id: "V1", vendorId: "V1", payoutId: "P1", bankAccountId: "B1", documentId: "D1" };

/** "controller" when every middleware passed, otherwise the status code. Skips multer/validate (body-shape only). */
async function outcome(who: Who, method: string, path: string): Promise<string> {
  const req = requestFor(who, { ...PARAMS });
  const res = fakeRes();
  for (const layer of ((vendorRoutes as any).stack as any[]).filter((l) => !l.route)) {
    if ((await run(layer.handle, req, res)) === "ended") return String(res.statusCode);
  }
  for (const h of routeHandles(vendorRoutes, method, path).slice(0, -1)) {
    if (h.name === "multerMiddleware" || h.length === 3 && /schema\.parseAsync/.test(String(h))) continue;
    if ((await run(h, req, res)) === "ended") return String(res.statusCode);
  }
  return "controller";
}

function expected(who: Who, group: Group): string {
  if (who === "ANONYMOUS") return "401";
  if (who === "ADMIN") return "controller";
  switch (group) {
    case "admin":
      return "403";
    case "list":
      return who === "ADMIN_STAFF_ORDERS" ? "controller" : "403";
    case "own":
      return who === "VENDOR_OWN" ? "controller" : who === "VENDOR_OTHER" ? "404" : "403";
    case "ownStaffInventory":
      return who === "VENDOR_OWN" || who === "VENDOR_STAFF_INVENTORY" ? "controller" : who === "VENDOR_OTHER" ? "404" : "403";
    case "document":
      return who === "VENDOR_OWN" || who === "VENDOR_OTHER" ? "controller" : "403"; // owner scoping is in the controller (tested below)
  }
}

// ── structure ───────────────────────────────────────────────────────────────

test("exactly the 45 known routes are mounted", () => {
  const mounted = ((vendorRoutes as any).stack as any[])
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`))
    .sort();
  assert.deepEqual(mounted, ROUTES.map(([m, p]) => `${m} ${p}`).sort());
});

test("authenticateUser is router-level and runs before every route", () => {
  const stack = (vendorRoutes as any).stack as any[];
  assert.equal(stack[0].handle, authenticateUser);
  assert.equal(stack[0].route, undefined);
  assert.ok(stack.findIndex((l) => l.route) > 0, "routes are registered after the authentication layer");
});

test("no route is shadowed: a concrete URL for every route dispatches to that route (POST /bulk/charges fixed)", () => {
  const stack = ((vendorRoutes as any).stack as any[]).filter((l) => l.route);
  const sample = (p: string) => p.replace(/:(\w+)/g, (_m, k) => (PARAMS as any)[k] ?? "X1");
  const wrong: string[] = [];
  for (const [method, path] of ROUTES) {
    const url = sample(path);
    const first = stack.find((l) => l.route.methods[method] && l.match(url));
    if (first?.route.path !== path) wrong.push(`${method.toUpperCase()} ${url} → ${first?.route.path}`);
  }
  assert.deepEqual(wrong, []);
});

// ── access matrix ───────────────────────────────────────────────────────────

test("access matrix: 45 routes × 9 identities through the real middleware", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const [method, path, group] of ROUTES) {
      for (const who of WHO) {
        const got = await outcome(who, method, path);
        const want = expected(who, group);
        if (got !== want) mismatches.push(`${method.toUpperCase()} ${path} as ${who}: expected ${want}, got ${got}`);
      }
    }
    assert.deepEqual(mismatches, []);
  } finally {
    restore();
  }
});

test("the sensitive operations are ADMIN-only: status, delete, payouts, commissions, charges, bank accounts of others", async () => {
  const restore = stubAuth();
  try {
    const sensitive: [string, string][] = [
      ["patch", "/:id/active"], ["patch", "/:id/suspended"], ["patch", "/:id/deactivated"], ["delete", "/:id"],
      ["patch", "/:id/verification/verify"], ["patch", "/:id/verification/suspend"],
      ["patch", "/payouts/:payoutId/status"], ["post", "/:id/payouts"], ["post", "/:id/commission"],
      ["post", "/set/bulk/commission"], ["post", "/bulk/charges"], ["post", "/", ], ["get", "/export/list"],
    ];
    for (const [m, p] of sensitive) {
      assert.equal(await outcome("ANONYMOUS", m, p), "401", `${p} anonymous`);
      assert.equal(await outcome("VENDOR_OWN", m, p), "403", `${p} the vendor itself`);
      assert.equal(await outcome("ADMIN_STAFF_ORDERS", m, p), "403", `${p} admin staff`);
    }
    // payout redirection: another vendor cannot add or default a bank account on V1
    assert.equal(await outcome("VENDOR_OTHER", "post", "/:id/payment-accounts"), "404");
    assert.equal(await outcome("VENDOR_OTHER", "patch", "/:id/payment-accounts/:bankAccountId/default"), "404");
    assert.equal(await outcome("VENDOR_STAFF_INVENTORY", "post", "/:id/payment-accounts"), "403", "staff may only read");
  } finally {
    restore();
  }
});

test("ownership comes from the session: a URL id other than the caller's vendor never passes", async () => {
  const restore = stubAuth();
  try {
    const req = requestFor("VENDOR_OWN", { id: "V2" });
    const res = fakeRes();
    for (const layer of ((vendorRoutes as any).stack as any[]).filter((l) => !l.route)) await run(layer.handle, req, res);
    let ended = false;
    for (const h of routeHandles(vendorRoutes, "get", "/:id").slice(0, -1)) {
      if ((await run(h, req, res)) === "ended") {
        ended = true;
        break;
      }
    }
    assert.ok(ended, "a vendor id other than the session's must be refused before the controller");
    assert.equal(res.statusCode, 404);
  } finally {
    restore();
  }
});

// ── controller fixes ────────────────────────────────────────────────────────

const ctrl = new VendorController();
const svc = (ctrl as any).vendorService;

test("profile update never forwards `status` (a vendor cannot self-reactivate); other fields pass through", async () => {
  const orig = { get: svc.getVendorById, upd: svc.updateVendorProfile };
  let forwarded: any;
  svc.getVendorById = async () => ({ id: "V1", avatar: null, status: "SUSPENDED" });
  svc.updateVendorProfile = async (_id: string, data: any) => ((forwarded = data), { id: "V1" });
  try {
    const res = fakeRes();
    await ctrl.updateVendorProfile({ params: { id: "V1" }, body: { status: "ACTIVE", storeName: "New name", phone: "017" }, user: { role: "VENDOR", vendorId: "V1" } } as any, res);
    assert.equal(res.statusCode, 200);
    assert.equal("status" in forwarded, false);
    assert.equal(forwarded.storeName, "New name");
    assert.equal(forwarded.phone, "017");
  } finally {
    svc.getVendorById = orig.get;
    svc.updateVendorProfile = orig.upd;
  }
});

test("verification approver is the authenticated admin's User id, not a body value", async () => {
  const orig = svc.verifyVendor;
  let approvedBy: unknown;
  svc.verifyVendor = async (_id: string, by: unknown) => ((approvedBy = by), { id: "V1" });
  try {
    const res = fakeRes();
    await ctrl.verifyVendor({ params: { id: "V1" }, body: { approvedBy: "FORGED" }, user: { role: "ADMIN", rawId: "U_ADMIN", id: "E_ADMIN" } } as any, res);
    assert.equal(approvedBy, "U_ADMIN");
  } finally {
    svc.verifyVendor = orig;
  }
});

function stubDocuments(doc: { id: string; vendorId: string; filePath: string } | null) {
  const db = vendorServiceDb as any;
  const deleted: string[] = [];
  const orig = db.$transaction;
  db.$transaction = async (fn: any) =>
    fn({
      vendorDocument: {
        findUnique: async () => doc,
        delete: async ({ where }: any) => (deleted.push(where.id), doc),
      },
    });
  return { deleted, restore: () => (db.$transaction = orig) };
}

async function deleteAs(user: any) {
  const res = fakeRes();
  const err = console.error;
  console.error = () => {};
  try {
    await ctrl.deleteDocument({ params: { documentId: "D1" }, body: {}, user } as any, res);
  } finally {
    console.error = err;
  }
  return res;
}

test("document delete: a vendor deletes only its own document; another vendor's → 404 and nothing is deleted", async () => {
  const s = stubDocuments({ id: "D1", vendorId: "V1", filePath: "" });
  try {
    const other = await deleteAs({ role: "VENDOR", vendorId: "V2" });
    assert.equal(other.statusCode, 404);
    assert.deepEqual(s.deleted, []);
    const own = await deleteAs({ role: "VENDOR", vendorId: "V1" });
    assert.equal(own.statusCode, 200);
    assert.deepEqual(s.deleted, ["D1"]);
  } finally {
    s.restore();
  }
});

test("document delete: ADMIN may delete any document; a missing document is 404", async () => {
  const s = stubDocuments({ id: "D1", vendorId: "V9", filePath: "" });
  try {
    assert.equal((await deleteAs({ role: "ADMIN" })).statusCode, 200);
    assert.deepEqual(s.deleted, ["D1"]);
  } finally {
    s.restore();
  }
  const missing = stubDocuments(null);
  try {
    assert.equal((await deleteAs({ role: "ADMIN" })).statusCode, 404);
  } finally {
    missing.restore();
  }
});
