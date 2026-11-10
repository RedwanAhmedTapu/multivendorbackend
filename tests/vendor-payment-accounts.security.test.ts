// tests/vendor-payment-accounts.security.test.ts
//
// S-5 REGRESSION (2026-11-07): vendor payout-account routes.
//
// Two things were fixed:
//   1. src/routes/bankAccount.routes.ts (NOT mounted — server.ts never imports
//      it; the frontend bankApi endpoints that target it are unused) had
//      authenticateUser ONLY on its vendor routes: if it were ever mounted,
//      any logged-in user could read/add/set-default ANY vendor's payout
//      accounts (IDOR / payout diversion). It now mirrors the live
//      vendor.routes.ts guards: authorizeRoles + requireOwnVendorParam.
//   2. Live functional bug — vendor.controller.ts setDefaultBankAccount read
//      `params.paymentAccountId` while the route declares `:bankAccountId`,
//      so set-default always failed. It now reads `bankAccountId`.
//
// This suite exercises BOTH routers through the REAL middleware:
//   - live router  (/api/vendormanagement → src/routes/vendor.routes.ts)
//   - legacy router (src/routes/bankAccount.routes.ts, kept secured)
// plus the controller param regression.
//
// DB-free: authenticateUser / requireOwnVendorParam lookups are stubbed on the
// shared Prisma client; tokens are signed with the test process's
// ACCESS_TOKEN_SECRET. Run with:
//   ACCESS_TOKEN_SECRET=test-only-secret npx tsx --test tests/vendor-payment-accounts.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { prisma } from "../src/config/prisma.ts";
import vendorRoutes from "../src/routes/vendor.routes.ts";
import bankAccountRoutes from "../src/routes/bankAccount.routes.ts";
import { VendorController } from "../src/controllers/vendor.controller.ts";
import { BankAccountService } from "../src/services/bankAccountService.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, ended: false };
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

// ── identities ──────────────────────────────────────────────────────────────

const PEOPLE = {
  ADMIN: { user: { id: "U_ADMIN", role: "ADMIN", vendorId: null }, employee: { id: "EMP_ADMIN", vendorId: null } },
  VENDOR: { user: { id: "U_VENDOR", role: "VENDOR", vendorId: "V1" }, employee: null },
  VENDOR_EMPLOYEE: {
    user: { id: "U_VEMP", role: "EMPLOYEE", vendorId: null },
    employee: { id: "EMP_V", vendorId: "V1", permissions: { inventoryManagement: true }, isActive: true },
  },
  VENDOR_EMPLOYEE_NOPERM: {
    user: { id: "U_VEMP2", role: "EMPLOYEE", vendorId: null },
    employee: { id: "EMP_V2", vendorId: "V1", permissions: {}, isActive: true },
  },
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
  const byEmpId = new Map(Object.values(PEOPLE).map((p) => [p.employee?.id, p.employee]));
  set(prisma.user, "findUnique", async ({ where }: any) => {
    const p = byUserId.get(where.id);
    return p ? { id: p.user.id, name: "n", email: null, role: p.user.role, isActive: true, vendorId: p.user.vendorId } : null;
  });
  set(prisma.vendor, "findUnique", async ({ where }: any) => (where.id === "V1" ? { id: "V1", storeName: "Store", email: null } : null));
  set(prisma.employee, "findFirst", async ({ where }: any) => byUserId.get(where.userId)?.employee ?? null);
  // requireOwnVendorParam re-loads the employee for the permission check
  set(prisma.employee, "findUnique", async ({ where }: any) => byEmpId.get(where.id) ?? null);
  return () => restores.reverse().forEach((r) => r());
}

function requestFor(who: Who, method: string, path: string, paramValues: Record<string, string> = {}) {
  const params: Record<string, string> = {};
  const concrete = path.replace(/:([A-Za-z]+)/g, (_m, name) => {
    params[name] = paramValues[name] ?? "x";
    return params[name];
  });
  const headers: Record<string, string> = {};
  if (who !== "ANONYMOUS") {
    const p = PEOPLE[who];
    headers.authorization = `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
  }
  return { method: method.toUpperCase(), path: concrete, url: concrete, headers, body: {}, query: {}, params };
}

function routeHandles(router: any, method: string, path: string) {
  const layer = (router as any).stack.filter((l: any) => l.route).find((l: any) => l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.map((s: any) => s.handle);
}

/** Runs (optional router-level guard) + the route's real middleware. */
async function outcome(router: any, withRouterGuard: boolean, who: Who, method: string, path: string, paramValues?: Record<string, string>) {
  const req = requestFor(who, method, path, paramValues);
  const res = fakeRes();
  if (withRouterGuard) {
    const guard = (router as any).stack[0].handle;
    if ((await run(guard, req, res)) === "ended") return String(res.statusCode);
  }
  for (const h of routeHandles(router, method, path).slice(0, -1)) {
    if ((await run(h, req, res)) === "ended") return String(res.statusCode);
  }
  return "controller";
}

// ── live router: /api/vendormanagement/:id/payment-accounts ─────────────────

const LIVE: [string, string][] = [
  ["post", "/:id/payment-accounts"],
  ["get", "/:id/payment-accounts"],
  ["patch", "/:id/payment-accounts/:bankAccountId/default"],
];

test("live router: exactly the 3 payment-account routes exist with the expected stacks", () => {
  for (const [method, path] of LIVE) {
    const handles = routeHandles(vendorRoutes, method, path);
    assert.ok(handles.length >= 2, `${method.toUpperCase()} ${path}: guarded`);
  }
});

test("live router matrix: ownership is enforced (foreign vendor → 404, not 403 — no enumeration)", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    const check = async (method: string, path: string, who: Who, id: string, expected: string) => {
      const got = await outcome(vendorRoutes, true, who, method, path, { id });
      if (got !== expected) mismatches.push(`${method.toUpperCase()} ${path} as ${who} (id=${id}): expected ${expected}, got ${got}`);
    };
    for (const [method, path] of LIVE) {
      await check(method, path, "ADMIN", "V2", "controller"); // admin may manage any vendor
      await check(method, path, "VENDOR", "V1", "controller"); // own account
      await check(method, path, "VENDOR", "V2", "404"); // foreign → not found
      await check(method, path, "CUSTOMER", "V1", "403");
      await check(method, path, "ANONYMOUS", "V1", "401");
      if (method === "get") {
        await check(method, path, "VENDOR_EMPLOYEE", "V1", "controller"); // own + permission
        await check(method, path, "VENDOR_EMPLOYEE", "V2", "404"); // foreign → not found
        await check(method, path, "VENDOR_EMPLOYEE_NOPERM", "V1", "403"); // no permission
      } else {
        await check(method, path, "VENDOR_EMPLOYEE", "V1", "403"); // writes are ADMIN/VENDOR only
      }
    }
    assert.deepEqual(mismatches, []);
  } finally {
    restore();
  }
});

// ── legacy router (unmounted, kept secured) ─────────────────────────────────

test("legacy bankAccount.routes: all 4 routes are guarded — it can never be mounted unsafely", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    const check = async (method: string, path: string, who: Who, vendorId: string, expected: string) => {
      const got = await outcome(bankAccountRoutes, false, who, method, path, { vendorId, bankAccountId: "BA1" });
      if (got !== expected) mismatches.push(`${method.toUpperCase()} ${path} as ${who}: expected ${expected}, got ${got}`);
    };

    const vendorRoutesLegacy: [string, string][] = [
      ["post", "/vendor/:vendorId/bank-accounts"],
      ["get", "/vendor/:vendorId/bank-accounts"],
      ["patch", "/vendor/:vendorId/bank-accounts/:bankAccountId/default"],
    ];
    for (const [method, path] of vendorRoutesLegacy) {
      await check(method, path, "ADMIN", "V2", "controller");
      await check(method, path, "VENDOR", "V1", "controller");
      await check(method, path, "VENDOR", "V2", "404");
      await check(method, path, "CUSTOMER", "V1", "403");
      await check(method, path, "ANONYMOUS", "V1", "401");
      if (method === "get") {
        await check(method, path, "VENDOR_EMPLOYEE", "V1", "controller");
        await check(method, path, "VENDOR_EMPLOYEE_NOPERM", "V1", "403");
      } else {
        await check(method, path, "VENDOR_EMPLOYEE", "V1", "403");
      }
    }

    await check("post", "/admin/bank-accounts", "ADMIN", "x", "controller");
    await check("post", "/admin/bank-accounts", "VENDOR", "x", "403");
    await check("post", "/admin/bank-accounts", "VENDOR_EMPLOYEE", "x", "403");
    await check("post", "/admin/bank-accounts", "CUSTOMER", "x", "403");
    await check("post", "/admin/bank-accounts", "ANONYMOUS", "x", "401");

    assert.deepEqual(mismatches, []);
  } finally {
    restore();
  }
});

// ── controller param regression (the live bug) ─────────────────────────────

test("setDefaultBankAccount passes params.bankAccountId (not the undefined paymentAccountId) to the service", async () => {
  const orig = BankAccountService.setDefaultVendorPaymentAccount;
  const got: any[] = [];
  (BankAccountService as any).setDefaultVendorPaymentAccount = async (...a: any[]) => {
    got.push(a);
    return { id: "BA1", isDefault: true };
  };
  try {
    const controller = new VendorController();
    const res = fakeRes();
    await controller.setDefaultBankAccount({ params: { id: "V1", bankAccountId: "BA1" }, body: {}, query: {} } as any, res as any);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(got, [["V1", "BA1"]]);
  } finally {
    (BankAccountService as any).setDefaultVendorPaymentAccount = orig;
  }
});
