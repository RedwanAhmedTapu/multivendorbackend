// tests/theme-palette-routes.security.test.ts
//
// PART 2 (theme management) route security: the /api/themes palette, vendor
// and customer endpoints exercised through the REAL middleware stacks.
// Matrix (mirrors accounting-routes.security.test.ts conventions):
//   A (19) themeAdmin  — authenticateUser + authorizeRoles('ADMIN','EMPLOYEE')
//                        + blockVendorEmployees + requirePermission('themeManagement')
//   V (5)  vendorTheme — authenticateUser + requireVendorOwnerScope (vendor
//                        OWNER only — Part 2 review decision, option a; vendor
//                        staff denied regardless of grants); vendorScope comes
//                        from the session only
//   C (3)  customer    — authenticateUser only (own preference)
//   P (1)  public      — GET /palette/active (no middleware)
// DB-free: user/vendor/employee lookups stubbed on the shared Prisma client;
// tokens signed with the test process's ACCESS_TOKEN_SECRET. Run with:
//   ACCESS_TOKEN_SECRET=test-only-secret npx tsx --test tests/theme-palette-routes.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { prisma } from "../src/config/prisma.ts";
import themeRoutes from "../src/routes/theme.routes.ts";
import { blockVendorEmployees } from "../src/middlewares/permission.middleware.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, ended: false };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; res.ended = true; res.onEnd?.(); return res; };
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

const routeLayers = () => (themeRoutes as any).stack.filter((l: any) => l.route);
function routeHandles(method: string, path: string) {
  const layer = routeLayers().find((l: any) => l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.map((s: any) => s.handle);
}

type Group = "A" | "V" | "C" | "P";
const ROUTES: [string, string, Group][] = [
  ["get", "/palette/active", "P"],
  ["get", "/palettes", "A"],
  ["post", "/palettes", "A"],
  ["get", "/palettes/:id", "A"],
  ["patch", "/palettes/:id", "A"],
  ["delete", "/palettes/:id", "A"],
  ["post", "/palettes/:id/duplicate", "A"],
  ["post", "/palettes/:id/publish", "A"],
  ["post", "/palettes/:id/archive", "A"],
  ["post", "/palettes/:id/rollback", "A"],
  ["post", "/palettes/:id/restore-default", "A"],
  ["get", "/palettes/:id/versions", "A"],
  ["get", "/assignments", "A"],
  ["put", "/assignments", "A"],
  ["get", "/vendor-policy", "A"],
  ["get", "/vendor-policy/draft", "A"],
  ["put", "/vendor-policy/draft", "A"],
  ["post", "/vendor-policy/draft/discard", "A"],
  ["post", "/vendor-policy/publish", "A"],
  ["post", "/vendor-policy/restore-previous", "A"],
  ["get", "/vendor/palettes", "V"],
  ["get", "/vendor/storefront-palette", "V"],
  ["put", "/vendor/storefront-palette", "V"],
  ["post", "/vendor/storefront-palette/reset", "V"],
  ["get", "/vendor/preview", "V"],
  ["get", "/me/preference", "C"],
  ["put", "/me/preference", "C"],
  ["delete", "/me/preference", "C"],
];

// ── identities ──────────────────────────────────────────────────────────────

const PEOPLE = {
  ADMIN: { user: { id: "U_ADMIN", role: "ADMIN", vendorId: null }, employee: { id: "EMP_ADMIN", vendorId: null, permissions: {} } },
  AEMP_GRANTED: { user: { id: "U_AEMP_G", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_AG", vendorId: null, permissions: { themeManagement: true } } },
  AEMP: { user: { id: "U_AEMP", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_A", vendorId: null, permissions: {} } },
  VEMP_GRANTED: { user: { id: "U_VEMP_G", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_VG", vendorId: "V1", permissions: { themeManagement: true, productManagement: true } } },
  VEMP: { user: { id: "U_VEMP", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_V", vendorId: "V1", permissions: {} } },
  VENDOR: { user: { id: "U_VENDOR", role: "VENDOR", vendorId: "V1" }, employee: null },
  CUSTOMER: { user: { id: "U_CUST", role: "CUSTOMER", vendorId: null }, employee: null },
} as const;
type Who = keyof typeof PEOPLE | "ANONYMOUS";
const WHO: Who[] = ["ADMIN", "AEMP_GRANTED", "AEMP", "VEMP_GRANTED", "VEMP", "VENDOR", "CUSTOMER", "ANONYMOUS"];

function stubAuth() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const byUserId = new Map(Object.values(PEOPLE).map((p) => [p.user.id, p]));
  const byEmpId = new Map(Object.values(PEOPLE).map((p) => [p.employee?.id, p]));
  set(prisma.user, "findUnique", async ({ where }: any) => {
    const p = byUserId.get(where.id);
    return p ? { id: p.user.id, name: "n", email: null, role: p.user.role, isActive: true, vendorId: p.user.vendorId } : null;
  });
  set(prisma.vendor, "findUnique", async ({ where }: any) => (where.id === "V1" ? { id: "V1", storeName: "Store", email: null } : null));
  // authenticateUser (findFirst) + requirePermission / requireVendorPermission (findUnique)
  set(prisma.employee, "findFirst", async ({ where }: any) => {
    const p = byUserId.get(where.userId);
    return p?.employee ? { id: p.employee.id, vendorId: p.employee.vendorId } : null;
  });
  set(prisma.employee, "findUnique", async ({ where }: any) => {
    const p = byEmpId.get(where.id);
    return p?.employee ? { permissions: p.employee.permissions, isActive: true, vendorId: p.employee.vendorId } : null;
  });
  return () => restores.reverse().forEach((r) => r());
}

function requestFor(who: Who, method: string, path: string, extras: { query?: any; body?: any } = {}) {
  const concrete = path.replace(/:[A-Za-z]+/g, "x");
  const headers: Record<string, string> = {};
  if (who !== "ANONYMOUS") {
    const p = PEOPLE[who];
    headers.authorization = `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
  }
  return { method: method.toUpperCase(), path: concrete, url: concrete, headers, body: extras.body ?? {}, query: extras.query ?? {}, params: {} };
}

async function outcome(who: Who, method: string, path: string, extras?: { query?: any; body?: any }) {
  const req = requestFor(who, method, path, extras);
  const res = fakeRes();
  const handles = routeHandles(method, path);
  for (const h of handles.slice(0, -1)) {
    if ((await run(h, req, res)) === "ended") return { out: String(res.statusCode), req, res };
  }
  return { out: "controller", req, res };
}

const EXPECTED: Record<Exclude<Group, "P">, Record<Who, string>> = {
  A: { ADMIN: "controller", AEMP_GRANTED: "controller", AEMP: "403", VEMP_GRANTED: "403", VEMP: "403", VENDOR: "403", CUSTOMER: "403", ANONYMOUS: "401" },
  V: { ADMIN: "403", AEMP_GRANTED: "403", AEMP: "403", VEMP_GRANTED: "403", VEMP: "403", VENDOR: "controller", CUSTOMER: "403", ANONYMOUS: "401" },
  C: { ADMIN: "controller", AEMP_GRANTED: "controller", AEMP: "controller", VEMP_GRANTED: "controller", VEMP: "controller", VENDOR: "controller", CUSTOMER: "controller", ANONYMOUS: "401" },
};

// ── inventory & structure ───────────────────────────────────────────────────

test("all 28 Part-2 routes are mounted (19 A / 5 V / 3 C / 1 P)", () => {
  for (const [method, path] of ROUTES) {
    routeHandles(method, path); // throws when missing
  }
  const count = (g: Group) => ROUTES.filter((r) => r[2] === g).length;
  assert.deepEqual([count("A"), count("V"), count("C"), count("P")], [19, 5, 3, 1]);
});

test("admin stacks: authenticateUser first, then role check, blockVendorEmployees, permission gate", () => {
  for (const [method, path, group] of ROUTES) {
    const handles = routeHandles(method, path);
    if (group === "A") {
      assert.equal(handles[0], authenticateUser, `${path}: authenticateUser must run first`);
      assert.ok(handles.includes(blockVendorEmployees), `${path}: missing blockVendorEmployees`);
      assert.equal(handles.length, 5, `${path}: auth + roles + vendor-block + permission + controller`);
    }
    if (group === "V") {
      assert.equal(handles[0], authenticateUser, `${path}: authenticateUser must run first`);
      assert.equal(handles.length, 3, `${path}: auth + vendor permission + controller`);
    }
    if (group === "C") {
      assert.equal(handles[0], authenticateUser, `${path}: authenticateUser must run first`);
      assert.equal(handles.length, 2, `${path}: auth + controller only`);
    }
    if (group === "P") {
      assert.equal(handles.length, 1, `${path}: public route must have no middleware`);
    }
  }
});

// ── access matrix through the real middleware ───────────────────────────────

test("access matrix: 27 guarded routes × 8 identities", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const [method, path, group] of ROUTES) {
      if (group === "P") continue;
      for (const who of WHO) {
        const { out } = await outcome(who, method, path);
        const expected = EXPECTED[group][who];
        if (out !== expected) mismatches.push(`${method.toUpperCase()} ${path} as ${who}: expected ${expected}, got ${out}`);
      }
    }
    assert.deepEqual(mismatches, []);
  } finally {
    restore();
  }
});

// ── vendor isolation ────────────────────────────────────────────────────────

test("vendor routes: vendorScope is derived from the session, never from query/body", async () => {
  const restore = stubAuth();
  try {
    const { out, req } = await outcome("VENDOR", "put", "/vendor/storefront-palette", {
      query: { vendorId: "V2" },
      body: { paletteId: "p1", vendorId: "V2" },
    });
    assert.equal(out, "controller");
    assert.equal((req as any).vendorScope, "V1", "scope must be the session vendor");
  } finally {
    restore();
  }
});

test("vendor owner passes every vendor theme route; scope is always the session vendor", async () => {
  const restore = stubAuth();
  try {
    for (const [method, path] of ROUTES.filter((r) => r[2] === "V")) {
      const { out, req } = await outcome("VENDOR", method, path);
      assert.equal(out, "controller", `${method.toUpperCase()} ${path}`);
      assert.equal((req as any).vendorScope, "V1", `${method.toUpperCase()} ${path}: scope`);
    }
  } finally {
    restore();
  }
});

test("vendor employees are denied on every vendor theme route — even with productManagement (owner-only decision)", async () => {
  const restore = stubAuth();
  try {
    for (const [method, path] of ROUTES.filter((r) => r[2] === "V")) {
      for (const who of ["VEMP_GRANTED", "VEMP"] as const) {
        const { out } = await outcome(who, method, path);
        assert.equal(out, "403", `${method.toUpperCase()} ${path} as ${who}`);
      }
    }
  } finally {
    restore();
  }
});

test("vendor employees are blocked from admin palette routes even with the grant (S-1 pattern)", async () => {
  const restore = stubAuth();
  try {
    for (const [method, path] of [["get", "/palettes"], ["post", "/palettes/:id/publish"], ["put", "/assignments"]] as const) {
      const { out } = await outcome("VEMP_GRANTED", method, path);
      assert.equal(out, "403", `${method.toUpperCase()} ${path}`);
    }
  } finally {
    restore();
  }
});

test("admin-side employee without the themeManagement grant gets 403 on every admin route", async () => {
  const restore = stubAuth();
  try {
    for (const [method, path] of ROUTES.filter((r) => r[2] === "A")) {
      const { out } = await outcome("AEMP", method, path);
      assert.equal(out, "403", `${method.toUpperCase()} ${path}`);
    }
  } finally {
    restore();
  }
});

test("public palette endpoint is reachable anonymously and drafts are never exposed by route design", async () => {
  const restore = stubAuth();
  try {
    // No auth header: the single handler IS the controller; reaching it is success.
    const { out } = await outcome("ANONYMOUS", "get", "/palette/active");
    assert.equal(out, "controller");
  } finally {
    restore();
  }
});
