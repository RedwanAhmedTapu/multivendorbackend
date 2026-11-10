// tests/vendor-order-routes.security.test.ts
//
// /api/vendor-orders authorization: router-level
//   authenticateUser → requireVendorPermission("orderManagement")
//   VENDOR owner                                      → controller
//   vendor staff (active, own vendor) WITH orderManagement → controller
//   vendor staff WITHOUT orderManagement / inactive  → 403
//   ADMIN, admin-side staff (even with orderManagement), CUSTOMER → 403
//   anonymous                                        → 401
// Staff act only for their OWN vendor: the controller scopes by the
// authenticated identity's vendorId, never by a query/body value.
// DB-free; run with ACCESS_TOKEN_SECRET set:
//   npx tsx --test tests/vendor-order-routes.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { prisma } from "../src/config/prisma.ts";
import vendorOrderRoutes from "../src/routes/vendor.order.routes.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";
import { VendorOrderService } from "../src/services/vendor.order.service.ts";

const ROUTES: [string, string][] = [
  ["get", "/statistics"],
  ["get", "/revenue"],
  ["get", "/"],
  ["get", "/:vendorOrderId"],
  ["patch", "/:vendorOrderId/status"],
  ["patch", "/:vendorOrderId/mark-for-delivery"],
  ["patch", "/:vendorOrderId/confirm-cod"],
  ["patch", "/:vendorOrderId/confirm-return-receipt"],
  ["get", "/:vendorOrderId/shipping-label"],
  ["get", "/:vendorOrderId/tracking"],
  ["get", "/:vendorOrderId/items"],
];

type Person = { user: { id: string; role: string; vendorId: string | null }; employee: { id: string; vendorId: string | null; permissions: Record<string, unknown>; isActive: boolean } | null };
const PEOPLE: Record<string, Person> = {
  VENDOR: { user: { id: "U_VENDOR", role: "VENDOR", vendorId: "V1" }, employee: null },
  STAFF_ORDERS: { user: { id: "U_S1", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_S1", vendorId: "V1", permissions: { orderManagement: true }, isActive: true } },
  STAFF_NO_ORDERS: { user: { id: "U_S2", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_S2", vendorId: "V1", permissions: { productManagement: true, offerManagement: true }, isActive: true } },
  STAFF_TRUTHY_STRING: { user: { id: "U_S3", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_S3", vendorId: "V1", permissions: { orderManagement: "true" }, isActive: true } },
  STAFF_INACTIVE: { user: { id: "U_S4", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_S4", vendorId: "V1", permissions: { orderManagement: true }, isActive: false } },
  ADMIN: { user: { id: "U_ADMIN", role: "ADMIN", vendorId: null }, employee: { id: "E_ADMIN", vendorId: null, permissions: {}, isActive: true } },
  ADMIN_STAFF_ORDERS: { user: { id: "U_A1", role: "EMPLOYEE", vendorId: null }, employee: { id: "E_A1", vendorId: null, permissions: { orderManagement: true }, isActive: true } },
  CUSTOMER: { user: { id: "U_C", role: "CUSTOMER", vendorId: null }, employee: null },
};
type Who = keyof typeof PEOPLE | "ANONYMOUS";
const WHO: Who[] = [...Object.keys(PEOPLE), "ANONYMOUS"];
const ALLOWED = new Set<Who>(["VENDOR", "STAFF_ORDERS"]);
const expected = (who: Who) => (ALLOWED.has(who) ? "controller" : who === "ANONYMOUS" ? "401" : "403");

function stubAuth() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const byUser = new Map(Object.values(PEOPLE).map((p) => [p.user.id, p]));
  const byEmp = new Map(Object.values(PEOPLE).filter((p) => p.employee).map((p) => [p.employee!.id, p.employee!]));
  set(prisma.user, "findUnique", async ({ where }: any) => {
    const p = byUser.get(where.id);
    return p ? { id: p.user.id, name: "n", email: null, role: p.user.role, isActive: true, vendorId: p.user.vendorId } : null;
  });
  set(prisma.vendor, "findUnique", async ({ where }: any) => (where.id === "V1" ? { id: "V1", storeName: "Store", email: null } : null));
  set(prisma.employee, "findFirst", async ({ where }: any) => {
    const e = byUser.get(where.userId)?.employee;
    return e ? { id: e.id, vendorId: e.vendorId } : null;
  });
  set(prisma.employee, "findUnique", async ({ where }: any) => {
    const e = byEmp.get(where.id);
    return e ? { permissions: e.permissions, isActive: e.isActive, vendorId: e.vendorId } : null;
  });
  return { set, restore: () => restores.reverse().forEach((r) => r()) };
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res.onEnd?.(), res);
  res.setHeader = () => res;
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
function request(who: Who, extra: { params?: any; query?: any; body?: any } = {}) {
  const headers: Record<string, string> = {};
  if (who !== "ANONYMOUS") {
    const p = PEOPLE[who];
    headers.authorization = `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
  }
  return { headers, params: extra.params ?? {}, query: extra.query ?? {}, body: extra.body ?? {} } as any;
}
const stack = () => (vendorOrderRoutes as any).stack as any[];
const routeHandles = (method: string, path: string) => {
  const layer = stack().find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.map((s: any) => s.handle);
};
async function outcome(who: Who, method: string, path: string) {
  const req = request(who);
  const res = fakeRes();
  for (const l of stack().filter((x) => !x.route)) if ((await run(l.handle, req, res)) === "ended") return String(res.statusCode);
  for (const h of routeHandles(method, path).slice(0, -1)) if ((await run(h, req, res)) === "ended") return String(res.statusCode);
  return "controller";
}

test("exactly the 11 vendor-order routes are mounted, after the two router-level guards", () => {
  const mounted = stack().filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`)).sort();
  assert.deepEqual(mounted, ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  assert.equal(stack()[0].handle, authenticateUser);
  assert.ok(stack().slice(0, 2).every((l) => !l.route), "two router-level guards");
  assert.equal(stack().findIndex((l) => l.route), 2);
});

test("access matrix: owner and staff WITH orderManagement only; everyone else refused", async () => {
  const env = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const [m, p] of ROUTES) {
      for (const who of WHO) {
        const got = await outcome(who, m, p);
        if (got !== expected(who)) mismatches.push(`${m.toUpperCase()} ${p} as ${who}: expected ${expected(who)}, got ${got}`);
      }
    }
    assert.deepEqual(mismatches, []);
  } finally {
    env.restore();
  }
});

test("staff act for their OWN vendor only — a query/body vendorId is never used", async () => {
  const env = stubAuth();
  const seen: string[] = [];
  env.set(VendorOrderService, "getById", async (_id: string, vendorId: string) => (seen.push(vendorId), { id: "VO1", vendorId }));
  try {
    for (const who of ["VENDOR", "STAFF_ORDERS"] as Who[]) {
      const req = request(who, { params: { vendorOrderId: "VO1" }, query: { vendorId: "V2" }, body: { vendorId: "V2" } });
      const res = fakeRes();
      for (const l of stack().filter((x) => !x.route)) assert.equal(await run(l.handle, req, res), "next", who);
      for (const h of routeHandles("get", "/:vendorOrderId")) await run(h, req, res);
      assert.equal(res.statusCode, 200, `${who}: ${JSON.stringify(res.body)}`);
    }
    assert.deepEqual(seen, ["V1", "V1"], "the service always receives the authenticated vendor");
  } finally {
    env.restore();
  }
});
