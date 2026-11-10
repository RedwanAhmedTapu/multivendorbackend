// tests/homepage-config.test.ts
//
// PHASE 1: homepage configuration backend — schema validation, defaults,
// draft / publish / discard / reset / restore-previous, transaction rollback,
// fixed settings keys, and ADMIN-only routes. DB-free: the Prisma `setting`
// delegate and $transaction are replaced with an in-memory store that
// snapshots/restores on failure (like a rolled-back transaction). Run with:
//   npx tsx --test tests/homepage-config.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma, prismaDirect } from "../src/config/prisma.ts";
import themeRoutes from "../src/routes/theme.routes.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";
import {
  homepageConfigService,
  HOMEPAGE_CONFIG_KEYS,
  HomepageConfigError,
} from "../src/services/homepage-config.service.ts";
import { homepageConfigController } from "../src/controllers/homepage-config.controller.ts";
import { getDefaultHomepageConfig } from "../src/constants/homepage-config.defaults.ts";
import { validateHomepageConfig } from "../src/validators/homepage-config.validator.ts";

// ── in-memory settings table ────────────────────────────────────────────────

type Row = { key: string; value: unknown; updatedAt: Date };

function fakeSettings(opts: { failUpsertKey?: string } = {}) {
  const rows = new Map<string, Row>();
  const log: string[] = [];
  let clock = Date.UTC(2026, 9, 10);
  const delegate = {
    findUnique: async ({ where }: any) => {
      const r = rows.get(where.key);
      return r ? { value: structuredClone(r.value), updatedAt: r.updatedAt } : null;
    },
    upsert: async ({ where, create, update }: any) => {
      log.push(`upsert:${where.key}`);
      if (opts.failUpsertKey === where.key) throw new Error(`simulated failure writing ${where.key}`);
      const existing = rows.get(where.key);
      const row: Row = {
        key: where.key,
        value: structuredClone(existing ? update.value : create.value),
        updatedAt: new Date((clock += 1000)),
      };
      rows.set(where.key, row);
      return { updatedAt: row.updatedAt };
    },
  };
  // Reads go through the pooled client; locked writes through prismaDirect.
  const s = prisma as any;
  const d = prismaDirect as any;
  const original = { setting: s.setting, $transaction: s.$transaction, direct$transaction: d.$transaction };
  const tx = {
    setting: delegate,
    $queryRaw: async (strings: TemplateStringsArray) => { log.push(`lock:${strings.join("?")}`); return [{ locked: 1 }]; },
  };
  Object.defineProperty(s, "setting", { value: delegate, configurable: true, writable: true });
  s.$transaction = async () => assert.fail("homepage config writes must use prismaDirect.$transaction");
  d.$transaction = async (fn: any) => {
    log.push("tx:begin");
    const snapshot = new Map([...rows].map(([k, v]) => [k, { ...v, value: structuredClone(v.value) }]));
    try {
      const out = await fn(tx);
      log.push("tx:commit");
      return out;
    } catch (e) {
      rows.clear();
      snapshot.forEach((v, k) => rows.set(k, v));
      log.push("tx:rollback");
      throw e;
    }
  };
  return {
    rows,
    log,
    seed: (key: string, value: unknown) => rows.set(key, { key, value: structuredClone(value), updatedAt: new Date((clock += 1000)) }),
    restore: () => {
      Object.defineProperty(s, "setting", { value: original.setting, configurable: true, writable: true });
      s.$transaction = original.$transaction;
      d.$transaction = original.direct$transaction;
    },
  };
}

/** Any accidental access to the themes table fails the test. */
function forbidThemeTable() {
  const t = prisma.theme as any;
  const names = ["findMany", "findFirst", "findUnique", "update", "updateMany", "create", "count"];
  const orig = Object.fromEntries(names.map((n) => [n, t[n]]));
  names.forEach((n) => (t[n] = async () => assert.fail(`homepage config must not touch themes.${n}`)));
  return () => Object.assign(t, orig);
}

const cfg = () => getDefaultHomepageConfig();
const withTitle = (title: string) => {
  const c = cfg();
  (c.layouts.layout_1.sections[3] as any).settings.title = title;
  return c;
};

async function rejectsWith(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (e: any) => {
    assert.ok(e instanceof HomepageConfigError, `expected HomepageConfigError, got ${e}`);
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });
}

// ── 1–4. validation ────────────────────────────────────────────────────────

test("1. built-in defaults are valid and mirror the current homepage order for all three layouts", () => {
  const v = validateHomepageConfig(cfg());
  assert.ok(v.ok, JSON.stringify(!v.ok && v.issues));
  const types = (id: "layout_1" | "layout_2" | "layout_3") =>
    cfg().layouts[id].sections.filter((s) => s.enabled).map((s) => s.type === "productCollection" ? `products:${(s as any).settings.source}` : s.type);
  const products = ["products:flashSale", "products:featured", "products:newArrivals"];
  assert.deepEqual(types("layout_1"), ["hero", "benefits", "categoryCircles", ...products, "footer"]);
  assert.deepEqual(types("layout_2"), ["horizontalCategoryNav", "hero", "benefits", "categoryCircles", ...products, "footer"]);
  assert.deepEqual(types("layout_3"), ["categoryGrid", "benefits", "categoryCircles", ...products, "footer"]);
  // layout_3's category grid is `hidden md:flex` in the component → not visible on mobile.
  assert.deepEqual(cfg().layouts.layout_3.sections[0].visibility, { mobile: false, tablet: true, desktop: true });
  // Disabled-but-available collections, including the existing best-selling endpoint.
  const disabled = cfg().layouts.layout_1.sections.filter((s) => !s.enabled).map((s) => (s as any).settings.source);
  assert.deepEqual(disabled, ["trending", "bestSelling", "discounted"]);
  const flash = cfg().layouts.layout_1.sections[3] as any;
  assert.deepEqual(flash.settings.columns, { mobile: 2, tablet: 5, desktop: 6 });
  assert.equal(flash.settings.limit, 12);
});

test("2. unknown section type is rejected", () => {
  const c: any = cfg();
  c.layouts.layout_1.sections.push({ id: "x", type: "customHtml", enabled: true, visibility: { mobile: true, tablet: true, desktop: true } });
  const v = validateHomepageConfig(c);
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, "INVALID_CONFIG");
});

test("3. invalid colors, out-of-range numbers, markup text and unknown keys are rejected", () => {
  const cases: [string, (c: any) => void][] = [
    ["color name", (c) => (c.theme.colors = { primary: "red" })],
    ["css injection in color", (c) => (c.theme.colors = { primary: "#fff; background:url(x)" })],
    ["3-digit hex", (c) => (c.theme.colors = { heading: "#fff" })],
    ["limit too high", (c) => (c.layouts.layout_1.sections[3].settings.limit = 500)],
    ["columns zero", (c) => (c.layouts.layout_1.sections[3].settings.columns.mobile = 0)],
    ["non-integer", (c) => (c.layouts.layout_1.sections[3].settings.limit = 4.5)],
    ["productCard block (moved to the global product card setting)", (c) => (c.productCard = { preset: "current" })],
    ["html in title", (c) => (c.layouts.layout_1.sections[3].settings.title = "<script>x</script>")],
    ["unknown source", (c) => (c.layouts.layout_1.sections[3].settings.source = "bestSellers")],
    ["raw className", (c) => (c.layouts.layout_1.sections[0].className = "bg-red-500")],
    ["unknown root key", (c) => (c.customCss = "body{}")],
    ["duplicate section id", (c) => c.layouts.layout_1.sections.push({ ...c.layouts.layout_1.sections[0] })],
    ["two heroes", (c) => c.layouts.layout_1.sections.push({ ...c.layouts.layout_1.sections[0], id: "hero-2" })],
    ["missing layout", (c) => delete c.layouts.layout_3],
    ["unknown layout id", (c) => (c.layouts.layout_4 = { sections: [] })],
  ];
  for (const [name, mutate] of cases) {
    const c: any = cfg();
    mutate(c);
    assert.equal(validateHomepageConfig(c).ok, false, name);
  }
  const ok: any = cfg();
  ok.theme.colors = { primary: "#0D9488" };
  const v = validateHomepageConfig(ok);
  assert.ok(v.ok);
  assert.equal(v.ok && v.config.theme.colors?.primary, "#0d9488", "colors are normalized to lowercase");
});

test("4. unsupported or missing schemaVersion is rejected with its own code", () => {
  for (const version of [2, 0, "1", undefined]) {
    const c: any = cfg();
    c.schemaVersion = version;
    const v = validateHomepageConfig(c);
    assert.equal(!v.ok && v.code, "UNSUPPORTED_SCHEMA_VERSION", `version ${String(version)}`);
  }
  assert.equal(validateHomepageConfig(null).ok, false);
  assert.equal(validateHomepageConfig([]).ok, false);
});

// ── public read ────────────────────────────────────────────────────────────

test("public read: defaults when nothing is stored, defaults when stored value is invalid, no writes either way", async () => {
  const db = fakeSettings();
  try {
    let r = await homepageConfigService.getPublished();
    assert.equal(r.source, "default");
    assert.deepEqual(r.config, cfg());
    db.seed(HOMEPAGE_CONFIG_KEYS.published, { schemaVersion: 99, junk: true });
    r = await homepageConfigService.getPublished();
    assert.equal(r.source, "fallback", "invalid stored config is reported as a fallback, not as 'nothing published'");
    assert.deepEqual(r.config, cfg());
    assert.ok(!db.log.some((l) => l.startsWith("upsert") || l.startsWith("tx")), "reads must not write");
  } finally { db.restore(); }
});

test("public read: a DB error still returns defaults with 200 (homepage never breaks)", async () => {
  const s = prisma as any;
  const original = s.setting;
  Object.defineProperty(s, "setting", { value: { findUnique: async () => { throw new Error("db down"); } }, configurable: true, writable: true });
  const origError = console.error;
  console.error = () => {};
  try {
    const res = fakeRes();
    await homepageConfigController.getPublished({} as any, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.source, "fallback");
  } finally {
    console.error = origError;
    Object.defineProperty(s, "setting", { value: original, configurable: true, writable: true });
  }
});

// ── 5–6. drafts ────────────────────────────────────────────────────────────

test("5. saving a draft never modifies the published config", async () => {
  const db = fakeSettings();
  try {
    db.seed(HOMEPAGE_CONFIG_KEYS.published, withTitle("Published Title"));
    const before = structuredClone(db.rows.get(HOMEPAGE_CONFIG_KEYS.published));
    await homepageConfigService.saveDraft({ config: withTitle("Draft Title") });
    assert.deepEqual(db.rows.get(HOMEPAGE_CONFIG_KEYS.published), before);
    assert.equal((db.rows.get(HOMEPAGE_CONFIG_KEYS.draft)!.value as any).layouts.layout_1.sections[3].settings.title, "Draft Title");
    assert.deepEqual(db.log.filter((l) => l.startsWith("upsert")), [`upsert:${HOMEPAGE_CONFIG_KEYS.draft}`]);
    assert.ok(db.log.some((l) => l.includes("pg_advisory_xact_lock")), "writes take the advisory lock");
  } finally { db.restore(); }
});

test("6. an invalid draft (or bad body / extra keys) cannot overwrite the last valid draft", async () => {
  const db = fakeSettings();
  try {
    await homepageConfigService.saveDraft({ config: withTitle("Good") });
    const good = structuredClone(db.rows.get(HOMEPAGE_CONFIG_KEYS.draft));
    const bad: any = withTitle("Bad");
    bad.layouts.layout_1.sections[3].settings.limit = 9999;
    await rejectsWith(homepageConfigService.saveDraft({ config: bad }), 422, "INVALID_CONFIG");
    await rejectsWith(homepageConfigService.saveDraft({ config: { ...cfg(), schemaVersion: 2 } }), 400, "UNSUPPORTED_SCHEMA_VERSION");
    await rejectsWith(homepageConfigService.saveDraft({ config: cfg(), key: "payment.secret" }), 400, "INVALID_BODY");
    await rejectsWith(homepageConfigService.saveDraft(cfg()), 400, "INVALID_BODY");
    assert.deepEqual(db.rows.get(HOMEPAGE_CONFIG_KEYS.draft), good);
  } finally { db.restore(); }
});

test("draft read: falls back to published, then defaults; reading writes nothing", async () => {
  const db = fakeSettings();
  try {
    assert.equal((await homepageConfigService.getDraft()).source, "default");
    db.seed(HOMEPAGE_CONFIG_KEYS.published, withTitle("Pub"));
    const d = await homepageConfigService.getDraft();
    assert.equal(d.source, "published");
    assert.equal(d.meta.hasUnpublishedChanges, false);
    await homepageConfigService.saveDraft({ config: withTitle("Draft") });
    const d2 = await homepageConfigService.getDraft();
    assert.equal(d2.source, "draft");
    assert.equal(d2.meta.hasUnpublishedChanges, true);
    assert.equal(db.log.filter((l) => l.startsWith("upsert")).length, 1, "only the explicit save wrote");
  } finally { db.restore(); }
});

test("optimistic concurrency: a stale expectedUpdatedAt gets 409 and keeps the newer draft", async () => {
  const db = fakeSettings();
  try {
    const first = await homepageConfigService.saveDraft({ config: withTitle("A"), expectedUpdatedAt: null });
    await homepageConfigService.saveDraft({ config: withTitle("B"), expectedUpdatedAt: first.updatedAt.toISOString() });
    await rejectsWith(
      homepageConfigService.saveDraft({ config: withTitle("C"), expectedUpdatedAt: first.updatedAt.toISOString() }),
      409,
      "DRAFT_CONFLICT",
    );
    assert.equal((db.rows.get(HOMEPAGE_CONFIG_KEYS.draft)!.value as any).layouts.layout_1.sections[3].settings.title, "B");
  } finally { db.restore(); }
});

// ── 7–8. publish ───────────────────────────────────────────────────────────

test("7. publish promotes the draft and moves the old published config to previous", async () => {
  const db = fakeSettings();
  try {
    await rejectsWith(homepageConfigService.publish(), 409, "NO_DRAFT");
    await homepageConfigService.saveDraft({ config: withTitle("V1") });
    const p1 = await homepageConfigService.publish();
    assert.equal(p1.previousSaved, false, "first publish has nothing to keep");
    await homepageConfigService.saveDraft({ config: withTitle("V2") });
    const p2 = await homepageConfigService.publish();
    assert.equal(p2.previousSaved, true);
    const title = (k: string) => (db.rows.get(k)!.value as any).layouts.layout_1.sections[3].settings.title;
    assert.equal(title(HOMEPAGE_CONFIG_KEYS.published), "V2");
    assert.equal(title(HOMEPAGE_CONFIG_KEYS.previous), "V1");
    // Re-publishing an identical draft is a no-op and keeps the rollback target.
    const p3 = await homepageConfigService.publish();
    assert.equal(p3.unchanged, true);
    assert.equal(title(HOMEPAGE_CONFIG_KEYS.previous), "V1");
  } finally { db.restore(); }
});

test("7b. an invalid stored draft is re-validated at publish time and blocks publishing", async () => {
  const db = fakeSettings();
  try {
    db.seed(HOMEPAGE_CONFIG_KEYS.published, withTitle("Live"));
    db.seed(HOMEPAGE_CONFIG_KEYS.draft, { schemaVersion: 1, layouts: {} });
    const before = structuredClone(db.rows.get(HOMEPAGE_CONFIG_KEYS.published));
    await rejectsWith(homepageConfigService.publish(), 422, "INVALID_DRAFT");
    assert.deepEqual(db.rows.get(HOMEPAGE_CONFIG_KEYS.published), before);
    assert.equal(db.rows.has(HOMEPAGE_CONFIG_KEYS.previous), false);
  } finally { db.restore(); }
});

test("8. a failure while publishing rolls back — published and previous stay exactly as they were", async () => {
  const db = fakeSettings({ failUpsertKey: HOMEPAGE_CONFIG_KEYS.published });
  try {
    db.seed(HOMEPAGE_CONFIG_KEYS.published, withTitle("Live"));
    db.seed(HOMEPAGE_CONFIG_KEYS.previous, withTitle("Older"));
    db.seed(HOMEPAGE_CONFIG_KEYS.draft, withTitle("New"));
    const before = structuredClone([...db.rows.entries()]);
    await assert.rejects(homepageConfigService.publish(), /simulated failure/);
    assert.ok(db.log.includes(`upsert:${HOMEPAGE_CONFIG_KEYS.previous}`), "previous was written before the failure");
    assert.equal(db.log.at(-1), "tx:rollback");
    assert.deepEqual([...db.rows.entries()], before, "everything rolled back");
  } finally { db.restore(); }
});

// ── 9–10. restore previous ─────────────────────────────────────────────────

test("9. restore-previous swaps published and previous, so it can be undone", async () => {
  const db = fakeSettings();
  try {
    db.seed(HOMEPAGE_CONFIG_KEYS.published, withTitle("Current"));
    db.seed(HOMEPAGE_CONFIG_KEYS.previous, withTitle("Old"));
    db.seed(HOMEPAGE_CONFIG_KEYS.draft, withTitle("WIP"));
    const r = await homepageConfigService.restorePrevious();
    assert.equal(r.reversible, true);
    const title = (k: string) => (db.rows.get(k)!.value as any).layouts.layout_1.sections[3].settings.title;
    assert.equal(title(HOMEPAGE_CONFIG_KEYS.published), "Old");
    assert.equal(title(HOMEPAGE_CONFIG_KEYS.previous), "Current");
    assert.equal(title(HOMEPAGE_CONFIG_KEYS.draft), "WIP", "draft is untouched");
    await homepageConfigService.restorePrevious();
    assert.equal(title(HOMEPAGE_CONFIG_KEYS.published), "Current", "restore is reversible");
  } finally { db.restore(); }
});

test("10. restore-previous with no or invalid previous returns a safe error and changes nothing", async () => {
  const db = fakeSettings();
  try {
    db.seed(HOMEPAGE_CONFIG_KEYS.published, withTitle("Current"));
    const before = structuredClone(db.rows.get(HOMEPAGE_CONFIG_KEYS.published));
    await rejectsWith(homepageConfigService.restorePrevious(), 404, "NO_PREVIOUS");
    db.seed(HOMEPAGE_CONFIG_KEYS.previous, { schemaVersion: 1, broken: true });
    await rejectsWith(homepageConfigService.restorePrevious(), 422, "INVALID_PREVIOUS");
    assert.deepEqual(db.rows.get(HOMEPAGE_CONFIG_KEYS.published), before);

    const res = fakeRes();
    await homepageConfigController.restorePrevious({} as any, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, "INVALID_PREVIOUS");
  } finally { db.restore(); }
});

test("restore-previous failure mid-way rolls back", async () => {
  const db = fakeSettings({ failUpsertKey: HOMEPAGE_CONFIG_KEYS.previous });
  try {
    db.seed(HOMEPAGE_CONFIG_KEYS.published, withTitle("Current"));
    db.seed(HOMEPAGE_CONFIG_KEYS.previous, withTitle("Old"));
    const before = structuredClone([...db.rows.entries()]);
    await assert.rejects(homepageConfigService.restorePrevious(), /simulated failure/);
    assert.deepEqual([...db.rows.entries()], before);
  } finally { db.restore(); }
});

// ── discard / reset ────────────────────────────────────────────────────────

test("discard replaces the draft with published (or defaults); reset-defaults replaces it with defaults; published untouched", async () => {
  const db = fakeSettings();
  try {
    let r = await homepageConfigService.discardDraft();
    assert.equal(r.source, "default");
    db.seed(HOMEPAGE_CONFIG_KEYS.published, withTitle("Live"));
    await homepageConfigService.saveDraft({ config: withTitle("WIP") });
    const pub = structuredClone(db.rows.get(HOMEPAGE_CONFIG_KEYS.published));
    r = await homepageConfigService.discardDraft();
    assert.equal(r.source, "published");
    assert.deepEqual(db.rows.get(HOMEPAGE_CONFIG_KEYS.draft)!.value, pub!.value);
    await homepageConfigService.resetDraftToDefaults();
    assert.deepEqual(db.rows.get(HOMEPAGE_CONFIG_KEYS.draft)!.value, cfg());
    assert.deepEqual(db.rows.get(HOMEPAGE_CONFIG_KEYS.published), pub);
  } finally { db.restore(); }
});

test("only the three fixed homepage keys are ever written, and the themes table is never touched", async () => {
  const db = fakeSettings();
  const restoreThemes = forbidThemeTable();
  try {
    await homepageConfigService.saveDraft({ config: withTitle("A") });
    await homepageConfigService.publish();
    await homepageConfigService.saveDraft({ config: withTitle("B") });
    await homepageConfigService.publish();
    await homepageConfigService.restorePrevious();
    await homepageConfigService.discardDraft();
    await homepageConfigService.resetDraftToDefaults();
    await homepageConfigService.getDraft();
    await homepageConfigService.getPublished();
    const allowed = new Set(Object.values(HOMEPAGE_CONFIG_KEYS));
    for (const k of db.rows.keys()) assert.ok(allowed.has(k as any), `unexpected key ${k}`);
  } finally { restoreThemes(); db.restore(); }
});

// ── 11–12. authorization ───────────────────────────────────────────────────

function routeHandles(method: string, path: string) {
  const layer = (themeRoutes as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.map((s: any) => s.handle);
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

const ADMIN_ROUTES: [string, string][] = [
  ["get", "/homepage-config/draft"],
  ["put", "/homepage-config/draft"],
  ["post", "/homepage-config/draft/discard"],
  ["post", "/homepage-config/draft/reset-defaults"],
  ["post", "/homepage-config/publish"],
  ["post", "/homepage-config/restore-previous"],
];

test("11. unauthenticated requests to every protected homepage-config route get 401", async () => {
  for (const [method, path] of ADMIN_ROUTES) {
    const handles = routeHandles(method, path);
    assert.equal(handles[0], authenticateUser, `${path}: must start with authenticateUser`);
    const res = fakeRes();
    await handles[0]({ headers: {} } as any, res, () => assert.fail(`${path}: must not reach next`));
    assert.equal(res.statusCode, 401, path);
    const res2 = fakeRes();
    await handles[0]({ headers: { authorization: "Bearer not-a-token" } } as any, res2, () => assert.fail("bad token passed"));
    assert.equal(res2.statusCode, 401, `${path}: invalid token`);
  }
});

test("12. VENDOR / EMPLOYEE / CUSTOMER get 403 on every protected route; ADMIN passes", () => {
  for (const [method, path] of ADMIN_ROUTES) {
    const handles = routeHandles(method, path);
    assert.equal(handles.length, 3, `${path}: auth, role check, controller`);
    for (const role of ["VENDOR", "EMPLOYEE", "CUSTOMER"]) {
      const res = fakeRes();
      handles[1]({ user: { id: "u", role } }, res, () => assert.fail(`${role} passed ${path}`));
      assert.equal(res.statusCode, 403, `${role} ${path}`);
    }
    let passed = false;
    handles[1]({ user: { id: "a", role: "ADMIN" } }, fakeRes(), () => { passed = true; });
    assert.ok(passed, `ADMIN ${path}`);
  }
});

test("public published read has no auth middleware and returns only the homepage config", async () => {
  const handles = routeHandles("get", "/homepage-config");
  assert.equal(handles.length, 1);
  const db = fakeSettings();
  try {
    const res = fakeRes();
    await homepageConfigController.getPublished({} as any, res);
    assert.deepEqual(Object.keys(res.body.data).sort(), ["config", "source", "updatedAt"]);
    assert.deepEqual(Object.keys(res.body.data.config).sort(), ["layouts", "schemaVersion", "theme"]);
  } finally { db.restore(); }
});

test("controller maps validation errors to 422 with issues and version errors to 400", async () => {
  const db = fakeSettings();
  try {
    const bad: any = cfg();
    bad.theme.colors = { primary: "javascript:alert(1)" };
    let res = fakeRes();
    await homepageConfigController.saveDraft({ body: { config: bad } } as any, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, "INVALID_CONFIG");
    assert.ok(Array.isArray(res.body.issues) && res.body.issues.length > 0);
    res = fakeRes();
    await homepageConfigController.saveDraft({ body: { config: { ...cfg(), schemaVersion: 3 } } } as any, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "UNSUPPORTED_SCHEMA_VERSION");
  } finally { db.restore(); }
});

test("phase A additions: footer section, bestSelling source and per-breakpoint spacing validate; limits enforced", () => {
  const c: any = cfg();
  c.layouts.layout_1.sections[0].appearance = { spacing: { mobile: "sm", tablet: null, desktop: "lg" } };
  c.layouts.layout_1.sections[2].settings = { title: "Shop by Category", subtitle: "Browse everything" };
  assert.ok(validateHomepageConfig(c).ok);

  const twoFooters: any = cfg();
  twoFooters.layouts.layout_1.sections.push({ id: "footer-2", type: "footer", enabled: true, visibility: { mobile: true, tablet: true, desktop: true } });
  assert.equal(validateHomepageConfig(twoFooters).ok, false, "at most one footer");

  const badSpacing: any = cfg();
  badSpacing.layouts.layout_1.sections[0].appearance = { spacing: "lg" };
  assert.equal(validateHomepageConfig(badSpacing).ok, false, "spacing must be per-breakpoint");

  const footerSettings: any = cfg();
  footerSettings.layouts.layout_1.sections.at(-1).settings = { html: "<b>x</b>" };
  assert.equal(validateHomepageConfig(footerSettings).ok, false, "footer accepts no settings");
});
