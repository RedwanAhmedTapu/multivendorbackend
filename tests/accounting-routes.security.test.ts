// tests/accounting-routes.security.test.ts
//
// S-1 REGRESSION (2026-11-07): /api/accounting route access, exercised through
// the REAL middleware (each route's own authenticateUser + guard stack).
// Before the fix, `adminOnly = authorizeRoles('ADMIN','EMPLOYEE')` and
// `entityAccess` treated ANY employee as admin-side — but vendor staff
// authenticate as EMPLOYEE **with a vendorId**, so every vendor employee
// could seed the platform COA, post/reverse vouchers on any entity, and read
// every entity's reports. The fix:
//   - adminOnly now includes blockVendorEmployees (same guard as courier routes)
//   - entityAccess routes EMPLOYEE-with-vendorId through the VENDOR branch
//   - vendorOwnEntityScope clamps vendor staff exactly like vendors, and now
//     clamps req.body as well as req.query
//   - /vouchers/manual/vendor, /accounting-periods (GET) and /statistics
//     gained vendorOwnEntityScope (they previously let even role VENDOR pass
//     entityType=ADMIN straight through)
//
// Groups:
//   A (26) adminOnly        — vendor staff 403, vendors/customers 403, anon 401
//   S (9)  entity-scoped    — entityAccess + vendorOwnEntityScope; vendors and
//                             vendor staff reach the controller HARD-SCOPED to
//                             their own entity
//   E (3)  entityAccess only— same pass/fail as S (by-id reads keep their
//                             pre-existing entity-filter gap — tracked as S-6)
//   V (4)  vendorOnly       — role VENDOR only; vendor staff stay 403
//   D (2)  disabled webhooks— 410 stubs, no guard by design
//   P (1)  /health          — public
//
// DB-free: the user/vendor/employee lookups made by authenticateUser and
// requireOwnVendorParam are stubbed on the shared Prisma client; tokens are
// signed with the test process's ACCESS_TOKEN_SECRET. Run with:
//   ACCESS_TOKEN_SECRET=test-only-secret npx tsx --test tests/accounting-routes.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { prisma } from "../src/config/prisma.ts";
import accountingRoutes, { vendorOwnEntityScope } from "../src/routes/accounting.routes.ts";
import { AccountingController } from "../src/controllers/accounting.controller.ts";
import { AccountingService } from "../src/services/accounting.services.ts";
import { blockVendorEmployees } from "../src/middlewares/permission.middleware.ts";

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

type Group = "A" | "S" | "E" | "V" | "D" | "P";
const ROUTES: [string, string, Group][] = [
  ["post", "/chart-of-accounts/seed/platform", "A"],
  ["post", "/chart-of-accounts/seed/vendor/:vendorId", "A"],
  ["post", "/chart-of-accounts", "A"],
  ["put", "/chart-of-accounts/:id", "A"],
  ["delete", "/chart-of-accounts/:id", "A"],
  ["get", "/chart-of-accounts", "S"],
  ["get", "/chart-of-accounts/:id", "E"],
  ["post", "/vouchers/manual", "A"],
  ["post", "/vouchers/manual/vendor", "S"],
  ["get", "/vouchers/:id", "E"],
  ["get", "/vouchers", "S"],
  ["post", "/vouchers/:id/post", "A"],
  ["post", "/vouchers/:id/lock", "A"],
  ["post", "/vouchers/:id/reverse", "A"],
  ["post", "/vouchers/:id/cancel", "A"],
  ["post", "/vouchers/:id/approve", "A"],
  ["post", "/vouchers/:id/reject", "A"],
  ["post", "/auto-voucher/:eventType", "A"],
  ["post", "/webhooks/purchase-created", "D"],
  ["post", "/webhooks/purchase-payment", "D"],
  ["post", "/webhooks/stock-movement", "A"],
  ["post", "/webhooks/order-confirmed", "A"],
  ["post", "/webhooks/payment-received", "A"],
  ["get", "/reports/trial-balance", "S"],
  ["get", "/reports/profit-loss", "S"],
  ["get", "/reports/balance-sheet", "S"],
  ["get", "/reports/ledger", "S"],
  ["get", "/reports/vendor-payables", "A"],
  ["get", "/reports/account-ledger/:accountId", "S"],
  ["post", "/accounting-periods", "A"],
  ["post", "/accounting-periods/:id/close", "A"],
  ["get", "/accounting-periods", "S"],
  ["get", "/audit-logs", "A"],
  ["get", "/reconciliation/drift", "A"],
  ["get", "/reconciliation/orphaned-vouchers", "A"],
  ["get", "/reconciliation/unreversed-refunds", "A"],
  ["get", "/vendor/dashboard", "V"],
  ["get", "/vendor/sales-summary", "V"],
  ["get", "/vendor/payables", "V"],
  ["get", "/vendor/commissions", "V"],
  ["get", "/admin/dashboard", "A"],
  ["get", "/admin/vendor-payables/detailed", "A"],
  ["get", "/admin/settlements", "A"],
  ["get", "/health", "P"],
  ["get", "/statistics", "S"],
];

const routeLayers = () => (accountingRoutes as any).stack.filter((l: any) => l.route);
function routeHandles(method: string, path: string) {
  const layer = routeLayers().find((l: any) => l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.map((s: any) => s.handle);
}

// ── identities (authenticateUser's DB lookups stubbed) ──────────────────────

const PEOPLE = {
  ADMIN: { user: { id: "U_ADMIN", role: "ADMIN", vendorId: null }, employee: { id: "EMP_ADMIN", vendorId: null } },
  ADMIN_SIDE_EMPLOYEE: { user: { id: "U_AEMP", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_A", vendorId: null } },
  VENDOR_EMPLOYEE: { user: { id: "U_VEMP", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_V", vendorId: "V1" } },
  VENDOR: { user: { id: "U_VENDOR", role: "VENDOR", vendorId: "V1" }, employee: null },
  CUSTOMER: { user: { id: "U_CUST", role: "CUSTOMER", vendorId: null }, employee: null },
} as const;
type Who = keyof typeof PEOPLE | "ANONYMOUS";
const WHO: Who[] = ["ADMIN", "ADMIN_SIDE_EMPLOYEE", "VENDOR_EMPLOYEE", "VENDOR", "CUSTOMER", "ANONYMOUS"];

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

function requestFor(who: Who, method: string, path: string, extras: { query?: any; body?: any } = {}) {
  const concrete = path.replace(/:[A-Za-z]+/g, "x");
  const headers: Record<string, string> = {};
  if (who !== "ANONYMOUS") {
    const p = PEOPLE[who];
    headers.authorization = `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
  }
  return {
    method: method.toUpperCase(),
    path: concrete,
    url: concrete,
    headers,
    body: extras.body ?? {},
    query: extras.query ?? {},
    params: {},
  };
}

/** Runs the route's real middleware stack (never the controller). */
async function outcome(who: Who, method: string, path: string, extras?: { query?: any; body?: any }) {
  const req = requestFor(who, method, path, extras);
  const res = fakeRes();
  const handles = routeHandles(method, path);
  for (const h of handles.slice(0, -1)) {
    if ((await run(h, req, res)) === "ended") return { out: String(res.statusCode), req, res };
  }
  // For inline-handler routes the last handle IS the responder; for controller
  // routes reaching it means "allowed".
  return { out: "controller", req, res };
}

const EXPECTED: Record<Exclude<Group, "D" | "P">, Record<Who, string>> = {
  A: { ADMIN: "controller", ADMIN_SIDE_EMPLOYEE: "controller", VENDOR_EMPLOYEE: "403", VENDOR: "403", CUSTOMER: "403", ANONYMOUS: "401" },
  S: { ADMIN: "controller", ADMIN_SIDE_EMPLOYEE: "controller", VENDOR_EMPLOYEE: "controller", VENDOR: "controller", CUSTOMER: "403", ANONYMOUS: "401" },
  E: { ADMIN: "controller", ADMIN_SIDE_EMPLOYEE: "controller", VENDOR_EMPLOYEE: "controller", VENDOR: "controller", CUSTOMER: "403", ANONYMOUS: "401" },
  V: { ADMIN: "403", ADMIN_SIDE_EMPLOYEE: "403", VENDOR_EMPLOYEE: "403", VENDOR: "controller", CUSTOMER: "403", ANONYMOUS: "401" },
};

// ── inventory ───────────────────────────────────────────────────────────────

test("exactly the 45 known routes are mounted (26 A / 10 S / 2 E / 4 V / 2 D / 1 P)", () => {
  const mounted = routeLayers().flatMap((l: any) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`)).sort();
  assert.deepEqual(mounted, ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  const count = (g: Group) => ROUTES.filter((r) => r[2] === g).length;
  assert.deepEqual([count("A"), count("S"), count("E"), count("V"), count("D"), count("P")], [26, 10, 2, 4, 2, 1]);
});

test("route stacks: every admin route runs blockVendorEmployees after role check", () => {
  for (const [method, path, group] of ROUTES) {
    const handles = routeHandles(method, path);
    if (group === "A") {
      assert.ok(handles.includes(blockVendorEmployees), `${method.toUpperCase()} ${path}: missing blockVendorEmployees`);
    } else {
      assert.ok(!handles.includes(blockVendorEmployees), `${method.toUpperCase()} ${path}: unexpected blockVendorEmployees`);
    }
    if (group === "S") assert.ok(handles.includes(vendorOwnEntityScope), `${path}: missing vendorOwnEntityScope`);
  }
});

// ── access matrix through the real middleware ───────────────────────────────

test("access matrix: 42 guarded routes × 6 identities (vendor staff are NOT admin)", async () => {
  const restore = stubAuth();
  try {
    const mismatches: string[] = [];
    for (const [method, path, group] of ROUTES) {
      if (group === "D" || group === "P") continue;
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

// ── hard scoping of vendors AND vendor staff on entity-scoped routes ────────

test("S routes: vendor and vendor-staff requests are force-scoped to their own entity", async () => {
  const restore = stubAuth();
  try {
    for (const who of ["VENDOR", "VENDOR_EMPLOYEE"] as const) {
      const { out, req } = await outcome(who, "get", "/reports/trial-balance");
      assert.equal(out, "controller", who);
      assert.equal(req.query.entityType, "VENDOR", `${who}: entityType forced`);
      assert.equal(req.query.entityId, "V1", `${who}: entityId forced to own vendor`);

      // Explicit attempt to read the platform entity → 403 before the controller
      const attempt = await outcome(who, "get", "/reports/ledger", { query: { entityType: "ADMIN" } });
      assert.equal(attempt.out, "403", `${who}: entityType=ADMIN rejected`);

      // Foreign vendor entityId → entityAccess rejects
      const foreign = await outcome(who, "get", "/reports/profit-loss", { query: { entityType: "VENDOR", entityId: "V2" } });
      assert.equal(foreign.out, "403", `${who}: foreign entityId rejected`);
    }
  } finally {
    restore();
  }
});

test("POST /vouchers/manual/vendor: body is clamped too; entityType=ADMIN in the body is rejected", async () => {
  const restore = stubAuth();
  try {
    for (const who of ["VENDOR", "VENDOR_EMPLOYEE"] as const) {
      const forged = await outcome(who, "post", "/vouchers/manual/vendor", { body: { entityType: "ADMIN", entries: [] } });
      assert.equal(forged.out, "403", `${who}: forged body entityType rejected`);

      const legit = await outcome(who, "post", "/vouchers/manual/vendor", { body: { narration: "adjustment" } });
      assert.equal(legit.out, "controller", who);
      assert.equal(legit.req.body.entityType, "VENDOR", `${who}: body entityType forced`);
      assert.equal(legit.req.body.entityId, "V1", `${who}: body entityId forced to own vendor`);
    }
  } finally {
    restore();
  }
});

test("GET /accounting-periods and /statistics: vendor staff cannot read platform-wide numbers", async () => {
  const restore = stubAuth();
  try {
    for (const path of ["/accounting-periods", "/statistics"]) {
      const noScope = await outcome("VENDOR_EMPLOYEE", "get", path);
      assert.equal(noScope.out, "controller", path);
      assert.equal(noScope.req.query.entityType, "VENDOR", `${path}: scoped`);
      assert.equal(noScope.req.query.entityId, "V1", `${path}: scoped to own vendor`);

      const platform = await outcome("VENDOR_EMPLOYEE", "get", path, { query: { entityType: "ADMIN" } });
      assert.equal(platform.out, "403", `${path}: platform scope rejected`);
    }
  } finally {
    restore();
  }
});

// ── guard-free routes stay guard-free ───────────────────────────────────────

test("/health is public; the disabled purchase webhooks answer 410 without any auth guard", async () => {
  const health = await outcome("ANONYMOUS", "get", "/health");
  assert.equal(health.out, "controller");

  for (const path of ["/webhooks/purchase-created", "/webhooks/purchase-payment"]) {
    const handles = routeHandles("post", path);
    assert.equal(handles.length, 1, `${path}: exactly one handler (the 410 stub), no auth middleware`);
    const res = fakeRes();
    handles[0]({ body: {}, query: {}, params: {} }, res);
    assert.equal(res.statusCode, 410, path);
  }
});

// ── middleware units ────────────────────────────────────────────────────────

test("vendorOwnEntityScope: admin-side identities are never clamped", () => {
  for (const user of [{ role: "ADMIN", vendorId: null }, { role: "EMPLOYEE", vendorId: null }]) {
    const req: any = { user, query: { entityType: "ADMIN" }, body: {} };
    const res = fakeRes();
    let passed = false;
    vendorOwnEntityScope(req, res, () => (passed = true));
    assert.equal(passed, true, JSON.stringify(user));
    assert.equal(req.query.entityType, "ADMIN", "admin-side query untouched");
  }
});

// ── S-6: by-id reads are entity-isolated at the controller ──────────────────
//
// getVoucher had a D3-era guard for role VENDOR only; getChartOfAccountById
// had NO guard. Both now refuse vendor-side identities (VENDOR, or EMPLOYEE
// with a vendorId) when the row belongs to another entity.

const VENDOR_SIDE = [
  { role: "VENDOR", vendorId: "V1" },
  { role: "EMPLOYEE", vendorId: "V1" }, // vendor staff — the S-6 gap
] as const;

test("S-6: getVoucher refuses vendor-side identities for platform or foreign vouchers", async () => {
  const controller = new AccountingController();
  const orig = AccountingService.prototype.getVoucherById;
  try {
    for (const voucher of [{ id: "VCH1", vendorId: null }, { id: "VCH2", vendorId: "V2" }]) {
      AccountingService.prototype.getVoucherById = async () => voucher as any;
      for (const user of VENDOR_SIDE) {
        const res = fakeRes();
        await controller.getVoucher({ params: { id: voucher.id }, user, query: {}, body: {} } as any, res as any);
        assert.equal(res.statusCode, 403, `${JSON.stringify(user)} reading ${JSON.stringify(voucher)}`);
      }
      // admin-side reads stay allowed
      AccountingService.prototype.getVoucherById = async () => voucher as any;
      const res = fakeRes();
      await controller.getVoucher({ params: { id: voucher.id }, user: { role: "ADMIN", vendorId: null }, query: {}, body: {} } as any, res as any);
      assert.equal(res.statusCode, 200, "ADMIN reads any voucher");
    }
    // own voucher → allowed for both vendor-side identities
    AccountingService.prototype.getVoucherById = async () => ({ id: "VCH3", vendorId: "V1" }) as any;
    for (const user of VENDOR_SIDE) {
      const res = fakeRes();
      await controller.getVoucher({ params: { id: "VCH3" }, user, query: {}, body: {} } as any, res as any);
      assert.equal(res.statusCode, 200, `${JSON.stringify(user)} reading own voucher`);
    }
    // unknown id → 404 for everyone
    AccountingService.prototype.getVoucherById = async () => null;
    const res = fakeRes();
    await controller.getVoucher({ params: { id: "NOPE" }, user: VENDOR_SIDE[0], query: {}, body: {} } as any, res as any);
    assert.equal(res.statusCode, 404);
  } finally {
    AccountingService.prototype.getVoucherById = orig;
  }
});

test("S-6: getChartOfAccountById refuses vendor-side identities for platform or foreign accounts", async () => {
  const controller = new AccountingController();
  const orig = AccountingService.prototype.getChartOfAccountById;
  const platformAccount = { id: "A1", entityType: "ADMIN", entityId: null };
  const foreignAccount = { id: "A2", entityType: "VENDOR", entityId: "V2" };
  const ownAccount = { id: "A3", entityType: "VENDOR", entityId: "V1" };
  try {
    for (const account of [platformAccount, foreignAccount]) {
      AccountingService.prototype.getChartOfAccountById = async () => account as any;
      for (const user of VENDOR_SIDE) {
        const res = fakeRes();
        await controller.getChartOfAccountById({ params: { id: account.id }, user, query: {}, body: {} } as any, res as any);
        assert.equal(res.statusCode, 403, `${JSON.stringify(user)} reading ${JSON.stringify(account)}`);
      }
      const res = fakeRes();
      await controller.getChartOfAccountById({ params: { id: account.id }, user: { role: "ADMIN", vendorId: null }, query: {}, body: {} } as any, res as any);
      assert.equal(res.statusCode, 200, "ADMIN reads any account");
    }
    AccountingService.prototype.getChartOfAccountById = async () => ownAccount as any;
    for (const user of VENDOR_SIDE) {
      const res = fakeRes();
      await controller.getChartOfAccountById({ params: { id: "A3" }, user, query: {}, body: {} } as any, res as any);
      assert.equal(res.statusCode, 200, `${JSON.stringify(user)} reading own account`);
    }
    AccountingService.prototype.getChartOfAccountById = async () => null;
    const res = fakeRes();
    await controller.getChartOfAccountById({ params: { id: "NOPE" }, user: VENDOR_SIDE[0], query: {}, body: {} } as any, res as any);
    assert.equal(res.statusCode, 404);
  } finally {
    AccountingService.prototype.getChartOfAccountById = orig;
  }
});

test("S-6: GET /chart-of-accounts list is force-scoped for vendor-side identities", async () => {
  const restore = stubAuth();
  try {
    for (const who of ["VENDOR", "VENDOR_EMPLOYEE"] as const) {
      const platform = await outcome(who, "get", "/chart-of-accounts", { query: { entityType: "ADMIN" } });
      assert.equal(platform.out, "403", `${who}: platform COA list rejected`);

      const scoped = await outcome(who, "get", "/chart-of-accounts", { query: { entityType: "VENDOR" } });
      assert.equal(scoped.out, "controller", who);
      assert.equal(scoped.req.query.entityType, "VENDOR");
      assert.equal(scoped.req.query.entityId, "V1", `${who}: entityId forced to own vendor`);
    }
  } finally {
    restore();
  }
});
