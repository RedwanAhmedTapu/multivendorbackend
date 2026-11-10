// tests/marketing-admin-routes.security.test.ts
//
// Marketing Center Phase 2 — admin API authorization (/api/marketing/admin).
// Router-level chain on every route:
//   authenticateUser → authorizeRoles("ADMIN","EMPLOYEE") → blockVendorEmployees
//   → requirePermission("marketingManagement")
// Matrix through the REAL middleware; controllers never run. Also checks the
// new permission key: known, admin-only grant (a vendor owner cannot grant it).
// DB-free; run with ACCESS_TOKEN_SECRET set:
//   npx tsx --test tests/marketing-admin-routes.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { prisma } from "../src/config/prisma.ts";
import { createMarketingAdminRouter } from "../src/modules/marketing/admin-campaign.routes.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";
import { blockVendorEmployees, validatePermissionPatch, KNOWN_PERMISSION_KEYS, ADMIN_ONLY_PERMISSION_KEYS } from "../src/middlewares/permission.middleware.ts";
import { createFakeMarketingDb } from "./support/fake-marketing-db.ts";
import { fakeRes, run, routeHandles } from "./support/phase1-auth.ts";

const router = createMarketingAdminRouter(createFakeMarketingDb());

const ROUTES: [string, string][] = [
  ["get", "/campaign-pages"],
  ["get", "/campaign-pages/:pageId/programme"],
  ["post", "/campaign-pages/:pageId/programme"],
  ["patch", "/programmes/:id"],
  ["post", "/programmes/:id/publish"],
  ["post", "/programmes/:id/cancel"],
  ["get", "/programmes/:id/registrations"],
  ["post", "/programmes/:id/registrations/bulk-review"],
  ["post", "/registrations/:id/approve"],
  ["post", "/registrations/:id/reject"],
];

const PEOPLE = {
  ADMIN: { user: { id: "U_ADMIN", role: "ADMIN", vendorId: null }, employee: { id: "E_ADMIN", vendorId: null, permissions: {} } },
  ADMIN_STAFF_MKT: { user: { id: "U_AS1", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_AS1", vendorId: null, permissions: { marketingManagement: true } } },
  ADMIN_STAFF_OFFERS: { user: { id: "U_AS2", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_AS2", vendorId: null, permissions: { offerManagement: true, productManagement: true } } },
  VENDOR: { user: { id: "U_V1", role: "VENDOR", vendorId: "V1" }, employee: null },
  VENDOR_STAFF_MKT: { user: { id: "U_VS1", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_VS1", vendorId: "V1", permissions: { marketingManagement: true } } },
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
  const byEmp = new Map(people.filter((p) => p.employee).map((p) => [p.employee.id, p.employee]));
  set(prisma.user, "findUnique", async ({ where }: any) => {
    const p = byUser.get(where.id);
    return p ? { id: p.user.id, name: "n", email: null, role: p.user.role, isActive: true, vendorId: p.user.vendorId } : null;
  });
  set(prisma.vendor, "findUnique", async ({ where }: any) => (where.id === "V1" ? { id: "V1", storeName: "S", email: null } : null));
  set(prisma.employee, "findFirst", async ({ where }: any) => {
    const e = byUser.get(where.userId)?.employee;
    return e ? { id: e.id, vendorId: e.vendorId } : null;
  });
  set(prisma.employee, "findUnique", async ({ where }: any) => {
    const e = byEmp.get(where.id);
    return e ? { permissions: e.permissions, isActive: true, vendorId: e.vendorId } : null;
  });
  return () => restores.reverse().forEach((r) => r());
}

async function outcome(who: Who, method: string, path: string) {
  const headers: Record<string, string> = {};
  if (who !== "ANONYMOUS") {
    const p = PEOPLE[who];
    headers.authorization = `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
  }
  const req: any = { headers, params: { id: "X", pageId: "PG" }, body: {}, query: {} };
  const res = fakeRes();
  for (const layer of ((router as any).stack as any[]).filter((l) => !l.route)) {
    if ((await run(layer.handle, req, res)) === "ended") return String(res.statusCode);
  }
  for (const h of routeHandles(router, method, path).slice(0, -1)) {
    if ((await run(h, req, res)) === "ended") return String(res.statusCode);
  }
  return "controller";
}

const expected = (who: Who) => (who === "ADMIN" || who === "ADMIN_STAFF_MKT" ? "controller" : who === "ANONYMOUS" ? "401" : "403");

test("exactly the 10 admin marketing routes are mounted", () => {
  const mounted = ((router as any).stack as any[]).filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`)).sort();
  assert.deepEqual(mounted, ROUTES.map(([m, p]) => `${m} ${p}`).sort());
});

test("router-level guards run before every route, in order", () => {
  const stack = (router as any).stack as any[];
  assert.equal(stack[0].handle, authenticateUser);
  assert.equal(stack[2].handle, blockVendorEmployees);
  assert.ok(stack.slice(0, 4).every((l) => !l.route), "four router-level guards");
  assert.ok(stack.findIndex((l) => l.route) === 4, "routes come after the guards");
});

test("access matrix: 10 routes × 7 identities", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const [m, p] of ROUTES) {
      for (const who of WHO) {
        const got = await outcome(who, m, p);
        if (got !== expected(who)) mismatches.push(`${m.toUpperCase()} ${p} as ${who}: expected ${expected(who)}, got ${got}`);
      }
    }
    assert.equal(mismatches.length, 0, mismatches.join("\n"));
  } finally {
    restore();
  }
});

test("marketingManagement is a known key that only an admin may grant", () => {
  assert.ok(KNOWN_PERMISSION_KEYS.includes("marketingManagement"));
  // posSubscriptionManagement (POS subscription admin) is the other admin-only grant.
  // agentManagement (Agent Commission admin area) is the third.
  assert.deepEqual([...ADMIN_ONLY_PERMISSION_KEYS], ["marketingManagement", "posSubscriptionManagement", "agentManagement"]);
  assert.deepEqual(validatePermissionPatch({ marketingManagement: true }, "ADMIN"), { ok: true });
  const v = validatePermissionPatch({ marketingManagement: true }, "VENDOR");
  assert.equal(v.ok, false);
  assert.equal((v as any).status, 403);
  assert.deepEqual(validatePermissionPatch({ marketingManagement: false }, "VENDOR"), { ok: true }, "clearing it is harmless");
  assert.equal((validatePermissionPatch({ marketingManagement: "true" }, "ADMIN") as any).status, 400);
});
