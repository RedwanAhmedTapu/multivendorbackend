// tests/admin-orders-routes.security.test.ts
//
// PHASE 1 (C2): vendor employees are blocked from the ENTIRE /api/admin-orders
// router. Every one of the 23 routes is exercised through the REAL middleware
// stack (router-level authenticateUser → authorizeRoles("ADMIN","EMPLOYEE") →
// blockVendorEmployees, then each route's own middleware) for six identities:
//   ADMIN                     → reaches the controller (courier-webhook-test included)
//   admin-side EMPLOYEE with orderManagement → reaches the controller, except
//                               courier-webhook-test (ADMIN only)
//   admin-side EMPLOYEE WITHOUT orderManagement → 403 at the router level
//                               (router-level requirePermission("orderManagement"))
//   vendor EMPLOYEE           → 403 at the router level, before any route handler
//   VENDOR, CUSTOMER          → 403
//   unauthenticated           → 401
//
// DB-free: authenticateUser's user/vendor/employee lookups are stubbed on the
// shared Prisma client; tokens are signed with the test process's
// ACCESS_TOKEN_SECRET; controllers are never invoked. Run with:
//   npx tsx --test tests/admin-orders-routes.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { prisma } from "../src/config/prisma.ts";
import adminOrderRoutes from "../src/routes/admin.order.routes.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";
import { blockVendorEmployees } from "../src/middlewares/permission.middleware.ts";

const ROUTES: [string, string][] = [
  ["get", "/statistics"],
  ["get", "/analytics"],
  ["get", "/"],
  ["get", "/fraud-review"],
  ["get", "/payment-reconciliation"], // Phase 5: verified payments that could not be applied
  ["get", "/refunds"],
  ["get", "/refunds/summary/:orderId"],
  ["get", "/refunds/:refundId"],
  ["get", "/vendor/:vendorId"],
  ["get", "/:id"],
  ["patch", "/:id/confirm"],
  ["patch", "/:id/approve"],
  ["patch", "/:id/reject"],
  ["patch", "/:id/cancel"],
  ["patch", "/:id/status"],
  ["patch", "/:id/vendor-orders/:vendorOrderId/status"],
  ["post", "/:id/refund"],
  ["patch", "/refunds/:refundId/approve"],
  ["patch", "/refunds/:refundId/reject"],
  ["post", "/courier-webhook-test/:courierOrderId"],
  ["post", "/seed-platform-coa"],
  ["post", "/seed-vendor-coa/:vendorId"],
  ["post", "/reservations/release-stale"],
];
const ADMIN_ONLY_ROUTE = "/courier-webhook-test/:courierOrderId";

const stack = () => (adminOrderRoutes as any).stack as any[];
const routerLayers = () => stack().filter((l) => !l.route);
const routeHandles = (method: string, path: string) => {
  const layer = stack().find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.map((s: any) => s.handle);
};

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, ended: false };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => {
    res.body = b;
    res.ended = true;
    res.onEnd?.();
    return res;
  };
  return res;
}

function run(fn: any, req: any, res: any): Promise<"next" | "ended"> {
  return new Promise((resolve, reject) => {
    res.onEnd = () => resolve("ended");
    try {
      const out = fn(req, res, (err?: unknown) => (err ? reject(err) : resolve("next")));
      if (out && typeof out.then === "function") out.catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

const PEOPLE = {
  ADMIN: { user: { id: "U_ADMIN", role: "ADMIN", vendorId: null }, employee: { id: "EMP_ADMIN", vendorId: null, permissions: {} } },
  ADMIN_SIDE_EMPLOYEE: { user: { id: "U_AEMP", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_A", vendorId: null, permissions: { orderManagement: true } } },
  ADMIN_SIDE_EMPLOYEE_NO_ORDERS: { user: { id: "U_AEMP2", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_A2", vendorId: null, permissions: { offerManagement: true, hrManagement: true } } },
  VENDOR_EMPLOYEE: { user: { id: "U_VEMP", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_V", vendorId: "V1", permissions: { orderManagement: true } } },
  VENDOR: { user: { id: "U_VENDOR", role: "VENDOR", vendorId: "V1" }, employee: null },
  CUSTOMER: { user: { id: "U_CUST", role: "CUSTOMER", vendorId: null }, employee: null },
} as const;
type Who = keyof typeof PEOPLE | "ANONYMOUS";
const WHO: Who[] = ["ADMIN", "ADMIN_SIDE_EMPLOYEE", "ADMIN_SIDE_EMPLOYEE_NO_ORDERS", "VENDOR_EMPLOYEE", "VENDOR", "CUSTOMER", "ANONYMOUS"];

function stubAuth() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const byUserId = new Map(Object.values(PEOPLE).map((p) => [p.user.id, p]));
  set(prisma.user, "findUnique", async ({ where }: any) => {
    const p = byUserId.get(where.id);
    return p ? { id: p.user.id, name: "n", email: null, role: p.user.role, isActive: true, vendorId: p.user.vendorId } : null;
  });
  set(prisma.vendor, "findUnique", async ({ where }: any) => (where.id === "V1" ? { id: "V1", storeName: "Store", email: null } : null));
  set(prisma.employee, "findFirst", async ({ where }: any) => byUserId.get(where.userId)?.employee ?? null);
  // requirePermission re-reads the Employee row (permissions, isActive).
  const byEmployeeId = new Map(Object.values(PEOPLE).filter((p) => p.employee).map((p) => [p.employee!.id, p.employee!]));
  set(prisma.employee, "findUnique", async ({ where }: any) => {
    const e = byEmployeeId.get(where.id);
    return e ? { permissions: e.permissions, isActive: true, vendorId: e.vendorId } : null;
  });
  return () => restores.reverse().forEach((r) => r());
}

function requestFor(who: Who) {
  const headers: Record<string, string> = {};
  if (who !== "ANONYMOUS") {
    const p = PEOPLE[who];
    headers.authorization = `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
  }
  return { headers, body: {}, query: {}, params: {} };
}

/** "controller" when every middleware passed; otherwise "<status>@router" or "<status>@route". */
async function outcome(who: Who, method: string, path: string): Promise<string> {
  const req = requestFor(who);
  const res = fakeRes();
  for (const layer of routerLayers()) {
    if ((await run(layer.handle, req, res)) === "ended") return `${res.statusCode}@router`;
  }
  for (const h of routeHandles(method, path).slice(0, -1)) {
    if ((await run(h, req, res)) === "ended") return `${res.statusCode}@route`;
  }
  return "controller";
}

function expected(who: Who, path: string): string {
  switch (who) {
    case "ADMIN":
      return "controller";
    case "ADMIN_SIDE_EMPLOYEE":
      return path === ADMIN_ONLY_ROUTE ? "403@route" : "controller";
    case "ADMIN_SIDE_EMPLOYEE_NO_ORDERS":
      return "403@router"; // no orderManagement
    case "VENDOR_EMPLOYEE":
    case "VENDOR":
    case "CUSTOMER":
      return "403@router";
    case "ANONYMOUS":
      return "401@router";
  }
}

// ── inventory and ordering ──────────────────────────────────────────────────

test("exactly the 23 known routes are mounted", () => {
  const mounted = stack()
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`))
    .sort();
  assert.deepEqual(mounted, ROUTES.map(([m, p]) => `${m} ${p}`).sort());
});

test("router-level guards run first: authenticateUser → role check → blockVendorEmployees → orderManagement, before every route", () => {
  const layers = stack();
  assert.equal(layers[0].handle, authenticateUser);
  assert.equal(layers[0].route, undefined);
  assert.equal(layers[1].route, undefined, "role check is router-level");
  assert.equal(layers[2].handle, blockVendorEmployees);
  assert.equal(layers[2].route, undefined);
  assert.equal(layers[3].route, undefined, "the orderManagement check is router-level");
  const firstRoute = layers.findIndex((l) => l.route);
  assert.ok(firstRoute > 3, "no route is registered before the permission check");
});

// ── 23 routes × 6 identities ────────────────────────────────────────────────

test("access matrix: 23 routes × 7 identities through the real middleware", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const [method, path] of ROUTES) {
      for (const who of WHO) {
        const got = await outcome(who, method, path);
        const want = expected(who, path);
        if (got !== want) mismatches.push(`${method.toUpperCase()} ${path} as ${who}: expected ${want}, got ${got}`);
      }
    }
    assert.deepEqual(mismatches, []);
  } finally {
    restore();
  }
});

test("a vendor employee is stopped by blockVendorEmployees itself, with the existing message", async () => {
  const restore = stubAuth();
  try {
    const req = requestFor("VENDOR_EMPLOYEE");
    const res = fakeRes();
    const [auth, role, block] = routerLayers().map((l) => l.handle);
    assert.equal(await run(auth, req, res), "next");
    assert.equal(await run(role, req, res), "next", "EMPLOYEE passes the role check (unchanged)");
    assert.equal(await run(block, req, res), "ended");
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { message: "Forbidden: admin access only" });
  } finally {
    restore();
  }
});
