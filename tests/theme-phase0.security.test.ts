// tests/theme-phase0.security.test.ts
//
// PHASE 0 (homepage layouts): theme write routes are ADMIN-only, layout
// activation runs in one locked transaction, and the active layout can never
// be deactivated/toggled off. DB-free (spies on the Prisma client). Run with:
//   npx tsx --test tests/theme-phase0.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma, prismaDirect } from "../src/config/prisma.ts";
import themeRoutes from "../src/routes/theme.routes.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";
import { themeService, ACTIVE_LAYOUT_LOCKED } from "../src/services/theme.service.ts";
import { themeController } from "../src/controllers/theme.controller.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function routeLayer(method: string, path: string) {
  const layer = (themeRoutes as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.map((s: any) => s.handle);
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

const WRITE_ROUTES: [string, string][] = [
  ["post", "/"],
  ["post", "/initialize"],
  ["post", "/:layoutType/activate"],
  ["post", "/:layoutType/deactivate"],
  ["post", "/:layoutType/toggle"],
];

type Row = { id: string; layoutType: string; status: string };

/** Runs $transaction callbacks against an in-memory theme table and records calls. */
function fakeDb(rows: Row[], opts: { failOnActivate?: boolean } = {}) {
  const log: string[] = [];
  // Locked writes must run on the direct client (config/prisma.ts); the
  // pooled client's $transaction fails the test if it is ever used.
  const original = (prismaDirect as any).$transaction;
  const originalPooled = (prisma as any).$transaction;
  (prisma as any).$transaction = async () => assert.fail("theme writes must use prismaDirect.$transaction");
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => { log.push(`lock:${strings.join("?")}`); return []; },
    theme: {
      findUnique: async ({ where }: any) => rows.find((r) => r.layoutType === where.layoutType) ?? null,
      updateMany: async ({ where, data }: any) => {
        log.push(`updateMany:not=${where.id.not}:${data.status}`);
        rows.filter((r) => r.id !== where.id.not).forEach((r) => (r.status = data.status));
        return { count: rows.length - 1 };
      },
      update: async ({ where, data }: any) => {
        log.push(`update:${where.id}:${data.status}`);
        if (opts.failOnActivate) throw new Error("simulated DB failure");
        const r = rows.find((x) => x.id === where.id)!;
        r.status = data.status;
        return { ...r };
      },
    },
  };
  (prismaDirect as any).$transaction = async (fn: any) => {
    log.push("tx:begin");
    // Simulate rollback: restore a snapshot if the callback throws.
    const snapshot = rows.map((r) => ({ ...r }));
    try {
      const out = await fn(tx);
      log.push("tx:commit");
      return out;
    } catch (e) {
      rows.splice(0, rows.length, ...snapshot);
      log.push("tx:rollback");
      throw e;
    }
  };
  return {
    log,
    restore: () => {
      (prismaDirect as any).$transaction = original;
      (prisma as any).$transaction = originalPooled;
    },
  };
}

const seed = (): Row[] => [
  { id: "t1", layoutType: "layout_1", status: "active" },
  { id: "t2", layoutType: "layout_2", status: "inactive" },
  { id: "t3", layoutType: "layout_3", status: "inactive" },
];
const active = (rows: Row[]) => rows.filter((r) => r.status === "active").map((r) => r.layoutType);

// ── authorization ───────────────────────────────────────────────────────────

test("every theme write route runs authenticateUser then an ADMIN-only role check before the controller", () => {
  for (const [method, path] of WRITE_ROUTES) {
    const handles = routeLayer(method, path);
    assert.equal(handles.length, 3, `${path}: expected auth, role check, controller`);
    assert.equal(handles[0], authenticateUser, `${path}: first handler must be authenticateUser`);
  }
});

test("role check: ADMIN passes; VENDOR, EMPLOYEE and CUSTOMER get 403; missing user gets 401", () => {
  for (const [method, path] of WRITE_ROUTES) {
    const roleCheck = routeLayer(method, path)[1];
    for (const [role, expected] of [["ADMIN", "next"], ["VENDOR", 403], ["EMPLOYEE", 403], ["CUSTOMER", 403]] as const) {
      const res = fakeRes();
      let nextCalled = false;
      roleCheck({ user: { id: "u", role } }, res, () => { nextCalled = true; });
      if (expected === "next") assert.ok(nextCalled, `${path}: ADMIN should pass`);
      else {
        assert.equal(nextCalled, false, `${path}: ${role} must not reach the controller`);
        assert.equal(res.statusCode, expected, `${path}: ${role}`);
      }
    }
    const res = fakeRes();
    roleCheck({}, res, () => assert.fail("no user must not pass"));
    assert.equal(res.statusCode, 401);
  }
});

test("unauthenticated request (no Bearer token) is rejected with 401 before any controller runs", async () => {
  const res = fakeRes();
  await authenticateUser({ headers: {} } as any, res, () => assert.fail("must not call next"));
  assert.equal(res.statusCode, 401);
});

test("read routes stay public (homepage SSR and Navbar read the active layout without a token)", () => {
  for (const path of ["/", "/active", "/layout-options", "/layout/:layoutType"]) {
    assert.equal(routeLayer("get", path).length, 1, `GET ${path} should have no auth middleware`);
  }
});

// ── activation safety ───────────────────────────────────────────────────────

test("activate: locks theme rows, deactivates others and activates the target in ONE transaction", async () => {
  const rows = seed();
  const db = fakeDb(rows);
  try {
    const t = await themeService.activateTheme("layout_2");
    assert.equal(t.layoutType, "layout_2");
    assert.deepEqual(active(rows), ["layout_2"]);
    assert.deepEqual(db.log, [
      "tx:begin",
      "lock:SELECT id FROM themes ORDER BY id FOR UPDATE",
      "updateMany:not=t2:inactive",
      "update:t2:active",
      "tx:commit",
    ]);
  } finally { db.restore(); }
});

test("activate: a failure mid-way rolls back — the previously active layout stays active", async () => {
  const rows = seed();
  const db = fakeDb(rows, { failOnActivate: true });
  try {
    await assert.rejects(themeService.activateTheme("layout_3"), /simulated DB failure/);
    assert.deepEqual(active(rows), ["layout_1"]);
    assert.equal(db.log.at(-1), "tx:rollback");
  } finally { db.restore(); }
});

test("activate: unknown layout throws 'Theme not found' without writing", async () => {
  const rows = seed().filter((r) => r.layoutType !== "layout_3");
  const db = fakeDb(rows);
  try {
    await assert.rejects(themeService.activateTheme("layout_3"), /Theme not found/);
    assert.ok(!db.log.some((l) => l.startsWith("update")));
    assert.deepEqual(active(rows), ["layout_1"]);
  } finally { db.restore(); }
});

test("toggle on the ACTIVE layout is refused and nothing changes", async () => {
  const rows = seed();
  const db = fakeDb(rows);
  try {
    await assert.rejects(themeService.toggleThemeStatus("layout_1"), (e: any) => e.message === ACTIVE_LAYOUT_LOCKED);
    assert.ok(!db.log.some((l) => l.startsWith("update")));
    assert.deepEqual(active(rows), ["layout_1"]);
  } finally { db.restore(); }
});

test("toggle on an INACTIVE layout activates it (existing Power-button workflow) and leaves exactly one active", async () => {
  const rows = seed();
  const db = fakeDb(rows);
  try {
    const t = await themeService.toggleThemeStatus("layout_3");
    assert.equal(t.status, "active");
    assert.deepEqual(active(rows), ["layout_3"]);
  } finally { db.restore(); }
});

test("deactivate on the ACTIVE layout is refused; on an inactive layout it is a no-op", async () => {
  const rows = seed();
  const db = fakeDb(rows);
  try {
    await assert.rejects(themeService.deactivateTheme("layout_1"), (e: any) => e.message === ACTIVE_LAYOUT_LOCKED);
    const t = await themeService.deactivateTheme("layout_2");
    assert.equal(t.status, "inactive");
    assert.ok(!db.log.some((l) => l.startsWith("update")));
    assert.deepEqual(active(rows), ["layout_1"]);
  } finally { db.restore(); }
});

test("controller maps the protected-active-layout error to 409 for toggle and deactivate", async () => {
  const rows = seed();
  const db = fakeDb(rows);
  try {
    for (const fn of ["toggleThemeStatus", "deactivateTheme"] as const) {
      const res = fakeRes();
      await (themeController as any)[fn]({ params: { layoutType: "layout_1" } }, res);
      assert.equal(res.statusCode, 409, fn);
      assert.equal(res.body.error, ACTIVE_LAYOUT_LOCKED);
    }
  } finally { db.restore(); }
});

test("initialize never creates a second active layout when one is already active", async () => {
  const t = prisma.theme as any;
  const orig = { count: t.count, findUnique: t.findUnique, create: t.create };
  const created: any[] = [];
  t.count = async () => 1; // layout_2 is active
  t.findUnique = async ({ where }: any) => (where.layoutType === "layout_1" ? null : { id: "x" });
  t.create = async ({ data }: any) => { created.push(data); return data; };
  try {
    await themeService.initializeThemes();
    assert.equal(created.length, 1);
    assert.equal(created[0].layoutType, "layout_1");
    assert.equal(created[0].status, "inactive");
  } finally { Object.assign(t, orig); }
});
