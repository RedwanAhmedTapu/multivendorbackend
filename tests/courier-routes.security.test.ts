// tests/courier-routes.security.test.ts
//
// PHASE 0: /api/courier access groups, exercised through the REAL middleware
// (the router-level authenticateUser + role guard and each route's own stack):
//   A. admin only (33)        — vendor staff 403
//   B. vendor staff allowed (6) — /admin/warehouse-pickups/*, /orders/create
//   C. vendor routes (3)      — vendor staff only, scoped to their own vendor
//   D. webhooks (2)           — no JWT guard; provider verification first
// plus bulk-order 410, client vendorId ignored, and the createCourierOrder
// request reduced to the intent id.
//
// DB-free: the user/vendor/employee lookups made by authenticateUser are
// stubbed on the shared Prisma client, tokens are signed with the test
// process's ACCESS_TOKEN_SECRET, and controllers are never invoked for the
// matrix (reaching the controller is the "allowed" outcome). Run with:
//   npx tsx --test tests/courier-routes.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { prisma } from "../src/config/prisma.ts";
import courierRoutes from "../src/routes/courier.routes.ts";
import courierController from "../src/controllers/courier.controller.ts";
import courierService, { courierServiceDb } from "../src/services/courier.service.ts";
import warehouseCourierPickupService from "../src/services/warehouse-courier-pickup.service.ts";
import { blockVendorEmployees, requireVendorScope } from "../src/middlewares/permission.middleware.ts";
import { verifyPathaoSignature, verifyRedxToken } from "../src/middlewares/webhook.middleware.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string>, ended: false };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    res.ended = true;
    res.onEnd?.();
    return res;
  };
  res.setHeader = (k: string, v: string) => {
    res.headers[k.toLowerCase()] = v;
  };
  return res;
}

/** Runs one middleware; resolves "next" or "ended". */
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

type Group = "A" | "B" | "C" | "D";
const ROUTES: [string, string, Group][] = [
  ["get", "/admin/providers", "A"],
  ["get", "/admin/providers/:providerId", "A"],
  ["post", "/admin/providers", "A"],
  ["put", "/admin/providers/:providerId", "A"],
  ["delete", "/admin/providers/:providerId", "A"],
  ["patch", "/admin/providers/:providerId/toggle", "A"],
  ["get", "/admin/credentials", "A"],
  ["get", "/admin/credentials/:credentialId", "A"],
  ["post", "/admin/credentials", "A"],
  ["put", "/admin/credentials/:credentialId", "A"],
  ["delete", "/admin/credentials/:credentialId", "A"],
  ["post", "/admin/credentials/:credentialId/test", "A"],
  ["patch", "/admin/credentials/:credentialId/toggle", "A"],
  ["post", "/admin/credentials/:credentialId/refresh-token", "A"],
  ["post", "/admin/serviceable-areas/sync", "A"],
  ["get", "/admin/serviceable-areas", "A"],
  ["delete", "/admin/serviceable-areas/:areaId", "A"],
  ["get", "/admin/pricing-rules", "A"],
  ["post", "/admin/pricing-rules", "A"],
  ["put", "/admin/pricing-rules/:id", "A"],
  ["patch", "/admin/pricing-rules/:id/toggle", "A"],
  ["delete", "/admin/pricing-rules/:id", "A"],
  ["get", "/admin/pathao/cities", "A"],
  ["get", "/admin/pathao/cities/:cityId/zones", "A"],
  ["get", "/admin/pathao/zones/:zoneId/areas", "A"],
  ["get", "/admin/pathao/stores", "A"],
  ["post", "/admin/pathao/stores", "A"],
  ["get", "/admin/redx/areas", "A"],
  ["get", "/admin/redx/stores", "A"],
  ["post", "/admin/redx/stores", "A"],
  ["get", "/admin/warehouse-pickups", "B"],
  ["post", "/admin/warehouse-pickups/link", "B"],
  ["get", "/admin/warehouse-pickups/:mappingId", "B"],
  ["post", "/admin/warehouse-pickups/:mappingId/activate", "B"],
  ["post", "/admin/warehouse-pickups/:mappingId/deactivate", "B"],
  ["get", "/admin/steadfast/status", "A"],
  ["get", "/admin/steadfast/balance", "A"],
  ["post", "/admin/steadfast/bulk-order", "A"],
  ["post", "/orders/create", "B"],
  ["post", "/quote", "A"],
  ["post", "/vendor/orders/:orderId/ready", "C"],
  ["get", "/vendor/orders/:orderId/label", "C"],
  ["get", "/vendor/orders", "C"],
  ["get", "/track/:trackingId", "A"],
  ["get", "/orders/:orderId", "A"],
  ["get", "/orders/pathao/:consignmentId", "A"],
  ["get", "/orders/redx/:trackingId/track", "A"],
  ["post", "/webhook/pathao", "D"],
  ["post", "/webhook/redx", "D"],
];

const routeLayers = () => (courierRoutes as any).stack.filter((l: any) => l.route);
function routeHandles(method: string, path: string) {
  const layer = routeLayers().find((l: any) => l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.map((s: any) => s.handle);
}
const guard = () => (courierRoutes as any).stack[0].handle;

// ── identities (authenticateUser's DB lookups stubbed) ──────────────────────

const PEOPLE = {
  ADMIN: { user: { id: "U_ADMIN", role: "ADMIN", vendorId: null }, employee: { id: "EMP_ADMIN", vendorId: null } },
  ADMIN_SIDE_EMPLOYEE: { user: { id: "U_AEMP", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_A", vendorId: null } },
  VENDOR_EMPLOYEE: { user: { id: "U_VEMP", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_V", vendorId: "V1" } },
  VENDOR: { user: { id: "U_VENDOR", role: "VENDOR", vendorId: "V1" }, employee: null },
  CUSTOMER: { user: { id: "U_CUST", role: "CUSTOMER", vendorId: null }, employee: null },
} as const;
type Who = keyof typeof PEOPLE | "ANONYMOUS";

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
  return () => restores.reverse().forEach((r) => r());
}

function requestFor(who: Who, method: string, path: string) {
  const concrete = path.replace(/:[A-Za-z]+/g, "x");
  const headers: Record<string, string> = {};
  if (who !== "ANONYMOUS") {
    const p = PEOPLE[who];
    headers.authorization = `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
  }
  return { method: method.toUpperCase(), path: concrete, url: concrete, headers, body: {}, query: {}, params: {} };
}

/** Runs the real guard + the route's middleware (never the controller). */
async function outcome(who: Who, method: string, path: string): Promise<string> {
  const req = requestFor(who, method, path);
  const res = fakeRes();
  if ((await run(guard(), req, res)) === "ended") return String(res.statusCode);
  const handles = routeHandles(method, path);
  for (const h of handles.slice(0, -1)) {
    if ((await run(h, req, res)) === "ended") return String(res.statusCode);
  }
  return "controller";
}

const EXPECTED: Record<Exclude<Group, "D">, Record<Who, string>> = {
  A: { ADMIN: "controller", ADMIN_SIDE_EMPLOYEE: "controller", VENDOR_EMPLOYEE: "403", VENDOR: "403", CUSTOMER: "403", ANONYMOUS: "401" },
  B: { ADMIN: "controller", ADMIN_SIDE_EMPLOYEE: "controller", VENDOR_EMPLOYEE: "controller", VENDOR: "403", CUSTOMER: "403", ANONYMOUS: "401" },
  C: { ADMIN: "403", ADMIN_SIDE_EMPLOYEE: "403", VENDOR_EMPLOYEE: "controller", VENDOR: "403", CUSTOMER: "403", ANONYMOUS: "401" },
};
const WHO: Who[] = ["ADMIN", "ADMIN_SIDE_EMPLOYEE", "VENDOR_EMPLOYEE", "VENDOR", "CUSTOMER", "ANONYMOUS"];

// ── inventory ───────────────────────────────────────────────────────────────

test("exactly the 49 known routes are mounted (38 A / 6 B / 3 C / 2 D)", () => {
  const mounted = routeLayers().flatMap((l: any) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`)).sort();
  assert.deepEqual(mounted, ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  const count = (g: Group) => ROUTES.filter((r) => r[2] === g).length;
  assert.deepEqual([count("A"), count("B"), count("C"), count("D")], [38, 6, 3, 2]);
});

test("route stacks: A has blockVendorEmployees, B has neither guard, C has requireVendorScope", () => {
  for (const [method, path, group] of ROUTES) {
    const handles = routeHandles(method, path);
    if (group === "A") assert.ok(handles.includes(blockVendorEmployees), `${path}: missing blockVendorEmployees`);
    if (group === "B") {
      assert.ok(!handles.includes(blockVendorEmployees) && !handles.includes(requireVendorScope), `${path}: unexpected guard`);
    }
    if (group === "C") assert.equal(handles[0], requireVendorScope, `${path}: requireVendorScope must run first`);
  }
});

// ── 44 × 6 access matrix through the real middleware ────────────────────────

test("access matrix: 42 guarded routes × 6 identities match the Phase 0 groups", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const [method, path, group] of ROUTES) {
      if (group === "D") continue;
      for (const who of WHO) {
        let expected = EXPECTED[group][who];
        if (path === "/admin/steadfast/bulk-order" && expected === "controller") expected = "410";
        const got = await outcome(who, method, path);
        if (got !== expected) mismatches.push(`${method.toUpperCase()} ${path} as ${who}: expected ${expected}, got ${got}`);
      }
    }
    assert.deepEqual(mismatches, []);
  } finally {
    restore();
  }
});

test("webhooks skip the JWT guard and start with provider verification", async () => {
  for (const [method, path, verifier] of [
    ["post", "/webhook/pathao", verifyPathaoSignature],
    ["post", "/webhook/redx", verifyRedxToken],
  ] as const) {
    const res = fakeRes();
    assert.equal(await run(guard(), requestFor("ANONYMOUS", method, path), res), "next");
    assert.equal(routeHandles(method, path)[0], verifier);
  }
});

// ── bulk-order 410 ──────────────────────────────────────────────────────────

test("bulk-order answers 410 BULK_BOOKING_DISABLED; the handler and courier client are never called", async () => {
  const calls: string[] = [];
  const origSvc = (courierService as any).steadfastBulkCreateOrder;
  (courierService as any).steadfastBulkCreateOrder = async () => calls.push("steadfastBulkCreateOrder");
  try {
    const handles = routeHandles("post", "/admin/steadfast/bulk-order");
    const req = { user: { role: "ADMIN" }, body: { courierProviderId: "P", orders: [{}] }, query: {}, params: {} };
    const res = fakeRes();
    let reachedHandler = false;
    for (const h of handles.slice(0, -1)) if ((await run(h, req, res)) === "ended") break;
    if (!res.ended) reachedHandler = true;
    assert.equal(reachedHandler, false);
    assert.equal(res.statusCode, 410);
    assert.equal(res.body.code, "BULK_BOOKING_DISABLED");
    assert.deepEqual(calls, []);
  } finally {
    (courierService as any).steadfastBulkCreateOrder = origSvc;
  }
});

// ── requireVendorScope ──────────────────────────────────────────────────────

test("requireVendorScope: only vendor staff pass, and the scope is their own vendor", () => {
  const cases: [any, string][] = [
    [{ role: "EMPLOYEE", vendorId: "V1" }, "next"],
    [{ role: "EMPLOYEE", vendorId: null }, "403"],
    [{ role: "ADMIN", vendorId: null }, "403"],
    [{ role: "VENDOR", vendorId: "V1" }, "403"],
    [{ role: "CUSTOMER", vendorId: null }, "403"],
    [undefined, "401"],
  ];
  for (const [user, expected] of cases) {
    const req: any = { user, body: { vendorId: "V2" }, query: { vendorId: "V2" } };
    const res = fakeRes();
    let passed = false;
    requireVendorScope(req, res, () => (passed = true));
    assert.equal(passed ? "next" : String(res.statusCode), expected, JSON.stringify(user));
    if (passed) assert.equal(req.vendorScope, "V1", "scope comes from the identity, never the body/query");
  }
});

// ── Group C controllers ignore client vendorIds ─────────────────────────────

function silenceWarn<T>(fn: () => Promise<T>) {
  const orig = console.warn;
  const lines: string[] = [];
  console.warn = (...a: unknown[]) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  return fn().finally(() => (console.warn = orig)).then((v) => ({ v, lines }));
}

test("label: the lookup is filtered by the scoped vendor, never the query vendorId; Deprecation header set", async () => {
  const db = courierServiceDb as any;
  const orig = db.courierOrder.findFirst;
  const wheres: any[] = [];
  db.courierOrder.findFirst = async ({ where }: any) => {
    wheres.push(where);
    return null;
  };
  try {
    const res = fakeRes();
    let forwarded: any;
    const { lines } = await silenceWarn(() =>
      courierController.getShippingLabel({ params: { orderId: "12" }, query: { vendorId: "V2" }, body: {}, vendorScope: "V1" } as any, res, (e: any) => (forwarded = e)),
    );
    assert.equal(wheres.length, 1);
    assert.equal(wheres[0].vendorId, "V1");
    assert.equal(res.headers["deprecation"], "true");
    assert.ok(lines.some((l) => l.includes("courier.vendor_route.scope_mismatch")), "mismatch logged");
    assert.ok(forwarded instanceof Error, "not found → error middleware");
  } finally {
    db.courierOrder.findFirst = orig;
  }
});

test("ready: the service receives the scoped vendor, never the body vendorId", async () => {
  const orig = (courierService as any).vendorMarkReadyForPickup;
  const got: any[] = [];
  (courierService as any).vendorMarkReadyForPickup = async (...a: any[]) => got.push(a);
  try {
    const res = fakeRes();
    await silenceWarn(() =>
      courierController.vendorMarkReadyForPickup({ params: { orderId: "12" }, body: { vendorId: "V2" }, query: {}, vendorScope: "V1" } as any, res, () => {}),
    );
    assert.equal(got.length, 1);
    assert.equal(got[0][0], "V1");
    assert.equal(res.headers["deprecation"], "true");
  } finally {
    (courierService as any).vendorMarkReadyForPickup = orig;
  }
});

test("vendor courier-orders list: still the empty stub, scoped, Deprecation header set", async () => {
  const res = fakeRes();
  await silenceWarn(() =>
    courierController.getVendorCourierOrders({ query: { vendorId: "V2" }, body: {}, params: {}, vendorScope: "V1" } as any, res, () => {}),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data, []);
  assert.equal(res.headers["deprecation"], "true");
});

// ── Group B: /orders/create and pickup ownership ────────────────────────────

test("/orders/create: a vendor employee booking for ANOTHER vendor gets 403; the service is never called", async () => {
  const orig = (courierService as any).createCourierOrderForVendor;
  const calls: any[] = [];
  (courierService as any).createCourierOrderForVendor = async (...a: any[]) => calls.push(a);
  try {
    const res = fakeRes();
    await courierController.createCourierOrder(
      { user: { role: "EMPLOYEE", vendorId: "V1" }, body: { orderId: "O1", vendorId: "V2", orderDetails: { intentId: "INT1" } } } as any,
      res,
      () => {},
    );
    assert.equal(res.statusCode, 403);
    assert.equal(calls.length, 0);
  } finally {
    (courierService as any).createCourierOrderForVendor = orig;
  }
});

test("/orders/create: only the intent id reaches the service; other client fields are ignored (keys logged, values never)", async () => {
  const orig = (courierService as any).createCourierOrderForVendor;
  const calls: any[] = [];
  (courierService as any).createCourierOrderForVendor = async (...a: any[]) => {
    calls.push(a);
    return { success: true };
  };
  try {
    const res = fakeRes();
    const { lines } = await silenceWarn(() =>
      courierController.createCourierOrder(
        {
          user: { role: "EMPLOYEE", vendorId: "V1" },
          body: {
            orderId: "O1",
            vendorId: "V1",
            orderDetails: { intentId: "INT1", recipientName: "Forged Name", codAmount: 1, preselectedCourier: { courierProviderId: "X" } },
          },
        } as any,
        res,
        () => {},
      ),
    );
    assert.equal(res.statusCode, 201);
    assert.deepEqual(calls, [["O1", "V1", { intentId: "INT1" }]]);
    assert.ok(lines.some((l) => l.includes("recipientName") && l.includes("preselectedCourier")));
    assert.ok(!lines.some((l) => l.includes("Forged Name")), "field values are never logged");
  } finally {
    (courierService as any).createCourierOrderForVendor = orig;
  }
});

test("/orders/create: missing intent id → 400; unresolved outcomes → 409", async () => {
  const orig = (courierService as any).createCourierOrderForVendor;
  try {
    const res400 = fakeRes();
    await courierController.createCourierOrder({ user: { role: "ADMIN" }, body: { orderId: "O1", vendorId: "V1", orderDetails: {} } } as any, res400, () => {});
    assert.equal(res400.statusCode, 400);

    for (const [outcome, code] of [
      ["NOT_CLAIMED", "BOOKING_NOT_CLAIMABLE"],
      ["UNKNOWN", "RECONCILIATION_REQUIRED"],
      ["CONFIRM_FAILED", "RECONCILIATION_REQUIRED"],
      ["STALE", "RECONCILIATION_REQUIRED"],
    ] as const) {
      (courierService as any).createCourierOrderForVendor = async () => {
        throw Object.assign(new Error(`outcome ${outcome}`), { courierBookingOutcome: outcome });
      };
      const res = fakeRes();
      await courierController.createCourierOrder({ user: { role: "ADMIN" }, body: { orderId: "O1", vendorId: "V1", orderDetails: { intentId: "INT1" } } } as any, res, () => {});
      assert.equal(res.statusCode, 409, outcome);
      assert.equal(res.body.code, code, outcome);
    }
  } finally {
    (courierService as any).createCourierOrderForVendor = orig;
  }
});

test("warehouse pickups: the controller passes the TOKEN's vendor as the actor (query vendorId cannot widen it)", async () => {
  const orig = (warehouseCourierPickupService as any).list;
  const got: any[] = [];
  (warehouseCourierPickupService as any).list = async (filters: any, actor: any) => {
    got.push({ filters, actor });
    return [];
  };
  try {
    const res = fakeRes();
    await courierController.listWarehousePickups(
      { user: { id: "EMP_V", rawId: "U_VEMP", role: "EMPLOYEE", vendorId: "V1" }, query: { vendorId: "V2" } } as any,
      res,
      () => {},
    );
    assert.equal(got[0].actor.vendorId, "V1");
    assert.equal(got[0].actor.role, "EMPLOYEE");
  } finally {
    (warehouseCourierPickupService as any).list = orig;
  }
});
