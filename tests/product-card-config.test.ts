// tests/product-card-config.test.ts
//
// PHASE B0: global product card configuration — schema, defaults that mirror
// today's homepage card, the shared versioned-setting workflow (draft /
// publish / discard / reset / restore, rollback, optimistic concurrency),
// isolation from the homepage config (keys + advisory lock), and ADMIN-only
// routes. DB-free: Prisma's `setting` delegate and prismaDirect.$transaction
// are replaced with an in-memory store that restores a snapshot on failure.
//   npx tsx --test tests/product-card-config.test.ts   (or: node --test …)

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma, prismaDirect } from "../src/config/prisma.ts";
import themeRoutes from "../src/routes/theme.routes.ts";
import { authenticateUser } from "../src/middlewares/auth.middleware.ts";
import {
  productCardConfigService,
  PRODUCT_CARD_CONFIG_KEYS,
  PRODUCT_CARD_CONFIG_LOCK_ID,
} from "../src/services/product-card-config.service.ts";
import { homepageConfigService, HOMEPAGE_CONFIG_KEYS, HOMEPAGE_CONFIG_LOCK_ID } from "../src/services/homepage-config.service.ts";
import { VersionedSettingError } from "../src/services/versioned-setting.service.ts";
import { productCardConfigController } from "../src/controllers/product-card-config.controller.ts";
import { getDefaultProductCardConfig } from "../src/constants/product-card.defaults.ts";
import { validateProductCardConfig } from "../src/validators/product-card.validator.ts";

// ── in-memory settings table (same approach as the Phase 1 tests) ──────────

type Row = { key: string; value: unknown; updatedAt: Date };

function fakeSettings(opts: { failUpsertKey?: string } = {}) {
  const rows = new Map<string, Row>();
  const log: string[] = [];
  const lockIds: unknown[] = [];
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
      const row: Row = { key: where.key, value: structuredClone(existing ? update.value : create.value), updatedAt: new Date((clock += 1000)) };
      rows.set(where.key, row);
      return { updatedAt: row.updatedAt };
    },
  };
  const s = prisma as any;
  const d = prismaDirect as any;
  const original = { setting: s.setting, $transaction: s.$transaction, direct$transaction: d.$transaction };
  const tx = {
    setting: delegate,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      log.push(`lock:${strings.join("?")}`);
      lockIds.push(...values);
      return [{ locked: 1 }];
    },
  };
  Object.defineProperty(s, "setting", { value: delegate, configurable: true, writable: true });
  s.$transaction = async () => assert.fail("product card writes must use prismaDirect.$transaction");
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
    lockIds,
    seed: (key: string, value: unknown) => rows.set(key, { key, value: structuredClone(value), updatedAt: new Date((clock += 1000)) }),
    restore: () => {
      Object.defineProperty(s, "setting", { value: original.setting, configurable: true, writable: true });
      s.$transaction = original.$transaction;
      d.$transaction = original.direct$transaction;
    },
  };
}

const cfg = () => getDefaultProductCardConfig();
const withRadius = (radius: number) => {
  const c = cfg();
  c.card.radius = radius;
  return c;
};
const radiusOf = (rows: Map<string, Row>, key: string) => (rows.get(key)!.value as any).card.radius;

async function rejectsWith(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (e: any) => {
    assert.ok(e instanceof VersionedSettingError, `expected VersionedSettingError, got ${e}`);
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

// ── schema & defaults ───────────────────────────────────────────────────────

test("defaults are valid and mirror today's homepage card, with compact mobile spacing only", () => {
  const v = validateProductCardConfig(cfg());
  assert.ok(v.ok, JSON.stringify(!v.ok && v.issues));
  const c = cfg();
  assert.equal(c.preset, "finixmartDefault");
  // Tablet/desktop = today's card (h-44, gap-6, px-4, text-sm title, text-xl price, rounded-lg).
  assert.deepEqual(c.image.height, { mobile: 150, tablet: 176, desktop: 176 });
  assert.deepEqual(c.card.imageGap, { mobile: 6, tablet: 24, desktop: 24 });
  assert.deepEqual(c.card.contentPaddingX, { mobile: 8, tablet: 16, desktop: 16 });
  assert.deepEqual(c.title.size, { mobile: 14, tablet: 14, desktop: 14 });
  assert.deepEqual(c.price.size, { mobile: 20, tablet: 20, desktop: 20 });
  assert.equal(c.image.sizing, "fixed");
  assert.equal(c.image.fit, "contain");
  assert.equal(c.card.radius, 10, "rounded-lg with --radius 0.625rem");
  assert.equal(c.discountBadge.position, "besidePrice");
  // Not shown today / not available yet.
  assert.equal(c.show.stockLabel, false);
  assert.equal(c.show.reviewCount, false, "today's card shows only the average rating");
  assert.equal(c.show.addToCart, false);
  // Colors default to the built-in palette.
  assert.equal(c.card.background, null);
  assert.equal(c.price.color, null);
});

test("Add to Cart can be enabled (off by default) with a validated label; Wishlist / Quick View do not exist", () => {
  assert.equal(cfg().show.addToCart, false, "off by default");
  const c: any = cfg();
  c.show.addToCart = true;
  assert.equal(validateProductCardConfig(c).ok, true);
  c.addToCart.label = "  কার্টে যোগ করুন  ";
  const v = validateProductCardConfig(c);
  assert.ok(v.ok);
  assert.equal(v.ok && v.config.addToCart.label, "কার্টে যোগ করুন", "trimmed, any script");
  for (const bad of ["", "   ", "<b>Buy</b>", 'Buy "now"', "Buy {x}", "a/b", "x".repeat(25), 42]) {
    const x: any = cfg();
    x.addToCart.label = bad;
    assert.equal(validateProductCardConfig(x).ok, false, JSON.stringify(bad));
  }
  for (const key of ["wishlist", "quickView"]) {
    const x: any = cfg();
    x.show[key] = true;
    assert.equal(validateProductCardConfig(x).ok, false, key);
  }
});

test("grid block is optional (older configs stay valid); columns, gaps and keys are bounded", () => {
  assert.equal("grid" in cfg(), false, "no grid by default = listing pages keep their built-in grid");
  const ok: any = cfg();
  ok.grid = { columns: { mobile: 1, tablet: 4, desktop: 6 }, gapX: { mobile: 0, tablet: 12, desktop: 24 }, gapY: { mobile: 4, tablet: 8, desktop: 8 } };
  assert.ok(validateProductCardConfig(ok).ok);
  const mutations: Array<(g: any) => void> = [
    (g) => (g.columns.mobile = 3),
    (g) => (g.columns.mobile = 0),
    (g) => (g.columns.tablet = 1),
    (g) => (g.columns.tablet = 5),
    (g) => (g.columns.desktop = 2),
    (g) => (g.columns.desktop = 7),
    (g) => (g.columns.desktop = 4.5),
    (g) => (g.gapX.tablet = 25),
    (g) => (g.gapY.mobile = -1),
    (g) => (g.className = "grid-cols-12"),
    (g) => delete g.gapY,
  ];
  for (const m of mutations) {
    const x = structuredClone(ok);
    m(x.grid);
    assert.equal(validateProductCardConfig(x).ok, false, m.toString());
  }
});

test("invalid colors, out-of-range sizes, unknown enums/keys and wrong versions are rejected", () => {
  const cases: [string, (c: any) => void][] = [
    ["color name", (c) => (c.card.background = "white")],
    ["css in color", (c) => (c.price.color = "#fff; position:fixed")],
    ["3-digit hex", (c) => (c.title.color = "#fff")],
    ["image too tall", (c) => (c.image.height.mobile = 1000)],
    ["negative gap", (c) => (c.card.imageGap.tablet = -1)],
    ["non-integer", (c) => (c.card.radius = 4.5)],
    ["string number", (c) => (c.title.size.mobile = "14")],
    ["unknown preset", (c) => (c.preset = "neon")],
    ["unknown sizing", (c) => (c.image.sizing = "16:9")],
    ["unknown badge position", (c) => (c.discountBadge.position = "floating")],
    ["className", (c) => (c.card.className = "fixed inset-0")],
    ["root css", (c) => (c.customCss = "body{}")],
    ["missing show flag", (c) => delete c.show.rating],
    ["too many title lines", (c) => (c.title.lines = 5)],
  ];
  for (const [name, mutate] of cases) {
    const c: any = cfg();
    mutate(c);
    assert.equal(validateProductCardConfig(c).ok, false, name);
  }
  for (const version of [2, 0, "1", undefined]) {
    const c: any = cfg();
    c.schemaVersion = version;
    const v = validateProductCardConfig(c);
    assert.equal(!v.ok && v.code, "UNSUPPORTED_SCHEMA_VERSION", String(version));
  }
  const ok: any = cfg();
  ok.card.borderColor = "#E5E7EB";
  const v = validateProductCardConfig(ok);
  assert.ok(v.ok);
  assert.equal(v.ok && v.config.card.borderColor, "#e5e7eb", "colors normalized to lowercase");
});

// ── workflow (shared versioned-setting service) ─────────────────────────────

test("public read: 'default' when nothing is stored, 'fallback' when the stored value is invalid; never writes", async () => {
  const db = fakeSettings();
  try {
    let r = await productCardConfigService.getPublished();
    assert.equal(r.source, "default");
    assert.deepEqual(r.config, cfg());
    db.seed(PRODUCT_CARD_CONFIG_KEYS.published, { schemaVersion: 1, show: { addToCart: true } });
    const warn = console.warn;
    console.warn = () => {};
    try {
      r = await productCardConfigService.getPublished();
    } finally {
      console.warn = warn;
    }
    assert.equal(r.source, "fallback");
    assert.deepEqual(r.config, cfg());
    assert.ok(!db.log.some((l) => l.startsWith("upsert") || l.startsWith("tx")));
  } finally { db.restore(); }
});

test("draft → publish → publish → restore works, with its own advisory lock id", async () => {
  const db = fakeSettings();
  try {
    await rejectsWith(productCardConfigService.publish(), 409, "NO_DRAFT");
    await productCardConfigService.saveDraft({ config: withRadius(4) });
    assert.equal(db.rows.has(PRODUCT_CARD_CONFIG_KEYS.published), false, "saving a draft never publishes");
    await productCardConfigService.publish();
    await productCardConfigService.saveDraft({ config: withRadius(12) });
    const p = await productCardConfigService.publish();
    assert.equal(p.previousSaved, true);
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.published), 12);
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.previous), 4);
    const r = await productCardConfigService.restorePrevious();
    assert.equal(r.reversible, true);
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.published), 4);
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.previous), 12);
    assert.ok(db.lockIds.length > 0 && db.lockIds.every((id) => id === PRODUCT_CARD_CONFIG_LOCK_ID));
    assert.notEqual(PRODUCT_CARD_CONFIG_LOCK_ID, HOMEPAGE_CONFIG_LOCK_ID);
  } finally { db.restore(); }
});

test("invalid drafts never overwrite the last valid draft; stale saves get 409", async () => {
  const db = fakeSettings();
  try {
    const first = await productCardConfigService.saveDraft({ config: withRadius(6), expectedUpdatedAt: null });
    const good = structuredClone(db.rows.get(PRODUCT_CARD_CONFIG_KEYS.draft));
    const bad: any = withRadius(6);
    bad.addToCart.label = "<script>";
    await rejectsWith(productCardConfigService.saveDraft({ config: bad }), 422, "INVALID_CONFIG");
    await rejectsWith(productCardConfigService.saveDraft({ config: { ...cfg(), schemaVersion: 9 } }), 400, "UNSUPPORTED_SCHEMA_VERSION");
    await rejectsWith(productCardConfigService.saveDraft({ config: cfg(), key: "homepage.published" }), 400, "INVALID_BODY");
    assert.deepEqual(db.rows.get(PRODUCT_CARD_CONFIG_KEYS.draft), good);
    await productCardConfigService.saveDraft({ config: withRadius(10), expectedUpdatedAt: first.updatedAt.toISOString() });
    await rejectsWith(
      productCardConfigService.saveDraft({ config: withRadius(2), expectedUpdatedAt: first.updatedAt.toISOString() }),
      409,
      "DRAFT_CONFLICT",
    );
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.draft), 10);
  } finally { db.restore(); }
});

test("publish version check: a stale expectedDraftUpdatedAt gets 409 and publishes nothing; a matching one publishes", async () => {
  const db = fakeSettings();
  try {
    const mine = await productCardConfigService.saveDraft({ config: withRadius(4), expectedUpdatedAt: null });
    // Another admin saves a newer draft after we loaded ours.
    await productCardConfigService.saveDraft({ config: withRadius(20) });
    await rejectsWith(
      productCardConfigService.publish({ expectedDraftUpdatedAt: mine.updatedAt.toISOString() }),
      409,
      "DRAFT_CONFLICT",
    );
    assert.equal(db.rows.has(PRODUCT_CARD_CONFIG_KEYS.published), false, "conflict publishes nothing");
    assert.equal(db.rows.has(PRODUCT_CARD_CONFIG_KEYS.previous), false);
    // "I saw no draft" while one exists is also a conflict.
    await rejectsWith(productCardConfigService.publish({ expectedDraftUpdatedAt: null }), 409, "DRAFT_CONFLICT");

    const current = db.rows.get(PRODUCT_CARD_CONFIG_KEYS.draft)!.updatedAt.toISOString();
    const p = await productCardConfigService.publish({ expectedDraftUpdatedAt: current });
    assert.equal(p.unchanged, false);
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.published), 20);
  } finally { db.restore(); }
});

test("publish stays backward compatible: no body / empty body publish as before; a bad body is 400 and writes nothing", async () => {
  const db = fakeSettings();
  try {
    await productCardConfigService.saveDraft({ config: withRadius(8) });
    await rejectsWith(productCardConfigService.publish({ expectedDraftUpdatedAt: "yesterday" }), 400, "INVALID_BODY");
    await rejectsWith(productCardConfigService.publish({ key: "homepage.published" }), 400, "INVALID_BODY");
    assert.equal(db.rows.has(PRODUCT_CARD_CONFIG_KEYS.published), false);
    await productCardConfigService.publish();
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.published), 8);
    await productCardConfigService.saveDraft({ config: withRadius(9) });
    await productCardConfigService.publish({});
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.published), 9);

    // Controller: express.json leaves req.body undefined for a bodiless POST.
    await productCardConfigService.saveDraft({ config: withRadius(11) });
    let res = fakeRes();
    await productCardConfigController.publish({ body: undefined } as any, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.published), 11);
    // Controller maps the conflict to 409 with its code.
    await productCardConfigService.saveDraft({ config: withRadius(12) });
    res = fakeRes();
    await productCardConfigController.publish({ body: { expectedDraftUpdatedAt: new Date(0).toISOString() } } as any, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "DRAFT_CONFLICT");
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.published), 11, "published unchanged after conflict");
  } finally { db.restore(); }
});

test("a failure while publishing rolls back — published and previous stay as they were", async () => {
  const db = fakeSettings({ failUpsertKey: PRODUCT_CARD_CONFIG_KEYS.published });
  try {
    db.seed(PRODUCT_CARD_CONFIG_KEYS.published, withRadius(8));
    db.seed(PRODUCT_CARD_CONFIG_KEYS.previous, withRadius(2));
    db.seed(PRODUCT_CARD_CONFIG_KEYS.draft, withRadius(16));
    const before = structuredClone([...db.rows.entries()]);
    await assert.rejects(productCardConfigService.publish(), /simulated failure/);
    assert.equal(db.log.at(-1), "tx:rollback");
    assert.deepEqual([...db.rows.entries()], before);
  } finally { db.restore(); }
});

test("discard / reset only touch the card draft; restore with no previous is a safe 404", async () => {
  const db = fakeSettings();
  try {
    db.seed(PRODUCT_CARD_CONFIG_KEYS.published, withRadius(12));
    await productCardConfigService.saveDraft({ config: withRadius(3) });
    let r = await productCardConfigService.discardDraft();
    assert.equal(r.source, "published");
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.draft), 12);
    await productCardConfigService.resetDraftToDefaults();
    assert.deepEqual(db.rows.get(PRODUCT_CARD_CONFIG_KEYS.draft)!.value, cfg());
    assert.equal(radiusOf(db.rows, PRODUCT_CARD_CONFIG_KEYS.published), 12, "published untouched");
    await rejectsWith(productCardConfigService.restorePrevious(), 404, "NO_PREVIOUS");
  } finally { db.restore(); }
});

test("card and homepage settings are fully separate (keys and data)", async () => {
  const db = fakeSettings();
  try {
    await productCardConfigService.saveDraft({ config: withRadius(5) });
    await productCardConfigService.publish();
    await productCardConfigService.restorePrevious().catch(() => {});
    await productCardConfigService.discardDraft();
    await productCardConfigService.resetDraftToDefaults();
    const allowed = new Set<string>(Object.values(PRODUCT_CARD_CONFIG_KEYS));
    for (const k of db.rows.keys()) assert.ok(allowed.has(k), `unexpected key ${k}`);
    for (const k of Object.values(HOMEPAGE_CONFIG_KEYS)) assert.equal(db.rows.has(k), false);

    // …and the homepage config no longer carries card settings at all.
    const home = await homepageConfigService.getPublished();
    assert.equal("productCard" in home.config, false);
  } finally { db.restore(); }
});

test("public read returns ONLY the published config even when a different draft exists", async () => {
  const db = fakeSettings();
  try {
    db.seed(PRODUCT_CARD_CONFIG_KEYS.published, withRadius(12));
    db.seed(PRODUCT_CARD_CONFIG_KEYS.draft, withRadius(3));
    db.seed(PRODUCT_CARD_CONFIG_KEYS.previous, withRadius(20));

    const r = await productCardConfigService.getPublished();
    assert.equal(r.source, "published");
    assert.equal(r.config.card.radius, 12, "service returns the published value, not the draft (3) or previous (20)");

    const res = fakeRes();
    await productCardConfigController.getPublished({} as any, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.source, "published");
    assert.equal(res.body.data.config.card.radius, 12);
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('"radius":3') && !body.includes('"radius":20'), "draft/previous never appear in the public response");

    // With a draft but nothing published, the public read serves defaults — never the draft.
    db.rows.delete(PRODUCT_CARD_CONFIG_KEYS.published);
    const d = await productCardConfigService.getPublished();
    assert.equal(d.source, "default");
    assert.deepEqual(d.config, cfg());
    assert.ok(!db.log.some((l) => l.startsWith("upsert")), "reads never write");
  } finally { db.restore(); }
});

// ── routes & authorization ─────────────────────────────────────────────────

function routeHandles(method: string, path: string) {
  const layer = (themeRoutes as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.map((s: any) => s.handle);
}

const CARD_ADMIN_ROUTES: [string, string][] = [
  ["get", "/product-card/draft"],
  ["put", "/product-card/draft"],
  ["post", "/product-card/draft/discard"],
  ["post", "/product-card/draft/reset-defaults"],
  ["post", "/product-card/publish"],
  ["post", "/product-card/restore-previous"],
];

test("protected card routes: no/invalid token → 401, VENDOR/EMPLOYEE/CUSTOMER → 403, ADMIN passes", async () => {
  for (const [method, path] of CARD_ADMIN_ROUTES) {
    const handles = routeHandles(method, path);
    assert.equal(handles.length, 3, `${path}: auth, role check, controller`);
    assert.equal(handles[0], authenticateUser, `${path}: starts with authenticateUser`);
    for (const headers of [{}, { authorization: "Bearer forged" }]) {
      const res = fakeRes();
      await handles[0]({ headers } as any, res, () => assert.fail(`${path}: must not reach next`));
      assert.equal(res.statusCode, 401, path);
    }
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

test("public card route has no auth and returns only the card config", async () => {
  assert.equal(routeHandles("get", "/product-card").length, 1);
  const db = fakeSettings();
  try {
    const res = fakeRes();
    await productCardConfigController.getPublished({} as any, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body.data).sort(), ["config", "source", "updatedAt"]);
    assert.deepEqual(res.body.data.config, cfg());
  } finally { db.restore(); }
});

test("controller maps validation errors to 422 (with issues) and unknown versions to 400", async () => {
  const db = fakeSettings();
  try {
    const bad: any = cfg();
    bad.card.background = "javascript:alert(1)";
    let res = fakeRes();
    await productCardConfigController.saveDraft({ body: { config: bad } } as any, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, "INVALID_CONFIG");
    assert.ok(Array.isArray(res.body.issues) && res.body.issues.length > 0);
    res = fakeRes();
    await productCardConfigController.saveDraft({ body: { config: { ...cfg(), schemaVersion: 2 } } } as any, res);
    assert.equal(res.statusCode, 400);
  } finally { db.restore(); }
});
