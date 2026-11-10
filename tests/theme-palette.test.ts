// tests/theme-palette.test.ts
//
// PART 2 (theme management): token validator rules and the palette service
// lifecycle — publish version bumps, append-only history, rollback exactness,
// draft-only editing, optimistic concurrency, assignment scope rules, vendor
// whitelist stripping and the public reader's never-serve-drafts contract.
// DB-free: prisma delegates are stubbed in memory. Run with:
//   npx tsx --test tests/theme-palette.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma, prismaDirect } from "../src/config/prisma.ts";
import {
  ALL_TOKENS,
  CORE_TOKENS,
  isValidColorValue,
  stripToWhitelistedTokens,
  validatePaletteTokens,
  validateVendorThemePolicy,
} from "../src/validators/theme-palette.validator.ts";
import { NEUTRAL_PRESET } from "../src/constants/theme-palette.defaults.ts";
import * as service from "../src/services/theme-palette.service.ts";
import { vendorThemePolicyService } from "../src/services/theme-vendor-policy.service.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

const validTokens = () =>
  Object.fromEntries(CORE_TOKENS.map((t, i) => [t, i % 2 === 0 ? "#112233" : "oklch(0.5 0.1 240)"]));

type PaletteRow = {
  id: string; name: string; description: string | null; kind: string; status: string;
  tokens: any; darkTokens: any; version: number; createdById: string | null;
  publishedAt: Date | null; createdAt: Date; updatedAt: Date;
};
type VersionRow = { id: string; paletteId: string; version: number; tokens: any; darkTokens: any; note: string | null; publishedById: string | null; publishedAt: Date };
type AssignmentRow = { id: string; scope: string; scopeId: string; paletteId: string; overrides: any; updatedById: string | null; updatedAt: Date };

interface FakeState {
  palettes: PaletteRow[];
  versions: VersionRow[];
  assignments: AssignmentRow[];
  audits: any[];
  seq: number;
}

function makeState(): FakeState {
  return { palettes: [], versions: [], assignments: [], audits: [], seq: 0 };
}

const stamp = () => new Date("2026-11-09T00:00:00.000Z");
const nextId = (s: FakeState, p: string) => `${p}_${++s.seq}`;

function paletteRow(s: FakeState, over: Partial<PaletteRow>): PaletteRow {
  return {
    id: nextId(s, "pal"), name: "P", description: null, kind: "CUSTOM", status: "DRAFT",
    tokens: validTokens(), darkTokens: null, version: 0, createdById: null,
    publishedAt: null, createdAt: stamp(), updatedAt: stamp(), ...over,
  };
}

/** Stubs prismaDirect.$transaction with an in-memory tx + pooled reads. */
function fakeDb(state: FakeState) {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };

  const tx: any = {
    $queryRaw: async () => [{ locked: 1 }],
    themePalette: {
      findUnique: async ({ where, include }: any) => {
        const row = state.palettes.find((p) => p.id === where.id || p.name === where.name) ?? null;
        if (row && include?._count) {
          return {
            ...row,
            _count: {
              assignments: state.assignments.filter((a) => a.paletteId === row.id).length,
              versions: state.versions.filter((v) => v.paletteId === row.id).length,
            },
          };
        }
        return row;
      },
      create: async ({ data }: any) => {
        const row = paletteRow(state, { ...data, id: nextId(state, "pal") });
        state.palettes.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = state.palettes.find((p) => p.id === where.id)!;
        Object.assign(row, data, { updatedAt: new Date("2026-11-09T01:00:00.000Z") });
        return row;
      },
      delete: async ({ where }: any) => {
        const i = state.palettes.findIndex((p) => p.id === where.id);
        return state.palettes.splice(i, 1)[0];
      },
    },
    themePaletteVersion: {
      create: async ({ data }: any) => {
        const row: VersionRow = { id: nextId(state, "ver"), publishedAt: stamp(), publishedById: null, note: null, darkTokens: null, ...data };
        state.versions.push(row);
        return row;
      },
      findUnique: async ({ where }: any) =>
        state.versions.find(
          (v) => v.paletteId === where.paletteId_version.paletteId && v.version === where.paletteId_version.version,
        ) ?? null,
    },
    themeAssignment: {
      findUnique: async ({ where }: any) =>
        state.assignments.find(
          (a) => a.scope === where.scope_scopeId.scope && a.scopeId === where.scope_scopeId.scopeId,
        ) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = state.assignments.find(
          (a) => a.scope === where.scope_scopeId.scope && a.scopeId === where.scope_scopeId.scopeId,
        );
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date("2026-11-09T01:00:00.000Z") });
          return existing;
        }
        const row: AssignmentRow = { id: nextId(state, "asg"), overrides: null, updatedById: null, updatedAt: stamp(), ...create };
        state.assignments.push(row);
        return row;
      },
      delete: async ({ where }: any) => {
        const i = state.assignments.findIndex((a) => a.id === where.id);
        return state.assignments.splice(i, 1)[0];
      },
    },
    auditLog: { create: async ({ data }: any) => { state.audits.push(data); return data; } },
  };

  set(prismaDirect as any, "$transaction", async (fn: any) => fn(tx));
  // Reads used by public/vendor/customer paths run on the pooled client.
  // getActivePalette uses `include: { palette: true }`, so resolve it here.
  set((prisma as any).themeAssignment, "findUnique", async (args: any) => {
    const row = await tx.themeAssignment.findUnique(args);
    if (!row) return null;
    return { ...row, palette: state.palettes.find((p) => p.id === row.paletteId) ?? null };
  });
  set((prisma as any).themePalette, "findUnique", tx.themePalette.findUnique);
  return () => restores.reverse().forEach((r) => r());
}

function stubPolicy(config: { allowedPaletteIds: string[]; overridableTokens: string[] }) {
  const orig = vendorThemePolicyService.getPublished;
  (vendorThemePolicyService as any).getPublished = async () => ({ config, source: "published", updatedAt: null });
  return () => { (vendorThemePolicyService as any).getPublished = orig; };
}

// ── validator ───────────────────────────────────────────────────────────────

test("validator: every Part-1 token name is mirrored server-side", () => {
  assert.equal(CORE_TOKENS.length, 20);
  assert.equal(ALL_TOKENS.length, 43);
  for (const t of ["primary", "primaryHover", "surface", "borderStrong", "focusRing"]) {
    assert.ok(CORE_TOKENS.includes(t as any), t);
  }
});

test("validator: the Neutral preset passes structural validation", () => {
  const v = validatePaletteTokens(NEUTRAL_PRESET.tokens);
  assert.ok(v.ok, JSON.stringify(v));
  const d = validatePaletteTokens({ ...NEUTRAL_PRESET.tokens, ...NEUTRAL_PRESET.darkTokens });
  assert.ok(d.ok, JSON.stringify(d));
});

test("validator: missing required core tokens are all reported", () => {
  const v = validatePaletteTokens({ primary: "#112233" });
  assert.equal(v.ok, false);
  if (v.ok) return;
  const missing = v.issues.filter((i) => i.message.startsWith("Missing required"));
  assert.equal(missing.length, CORE_TOKENS.length - 1);
});

test("validator: unknown token keys are rejected", () => {
  const v = validatePaletteTokens({ ...validTokens(), evil: "#000000" });
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.issues.some((i) => i.token === "evil" && i.message.includes("Unknown token")));
});

test("validator: CSS injection payloads are rejected as colors", () => {
  for (const payload of [
    "red; } body { display:none",
    "url(https://evil.example/x.css)",
    "var(--secret)",
    "expression(alert(1))",
    "red /* comment",
    "rgb(1,2,3); background: url(x)",
    '"quoted"',
    "<script>",
    "oklch(0.5 0.1 240) } * { color: red",
  ]) {
    assert.equal(isValidColorValue(payload), false, payload);
    const v = validatePaletteTokens({ ...validTokens(), primary: payload });
    assert.equal(v.ok, false, payload);
  }
});

test("validator: legitimate color grammars are accepted", () => {
  for (const ok of ["#fff", "#FFFF", "#112233", "#11223380", "rgb(1, 2, 3)", "rgba(1,2,3,0.5)", "hsl(210 50% 40%)", "oklch(0.7 0.15 180 / 80%)", "oklch(1 0 0 / 10%)", "color(display-p3 1 0.5 0)"]) {
    assert.equal(isValidColorValue(ok), true, ok);
  }
});

test("vendor policy validator: dedupes, caps, and rejects unknown tokens", () => {
  const ok = validateVendorThemePolicy({ allowedPaletteIds: ["a", "a", "b"], overridableTokens: ["primary", "primary"] });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.config.allowedPaletteIds, ["a", "b"]);
    assert.deepEqual(ok.config.overridableTokens, ["primary"]);
  }
  const bad = validateVendorThemePolicy({ allowedPaletteIds: [], overridableTokens: ["not-a-token"] });
  assert.equal(bad.ok, false);
});

test("stripToWhitelistedTokens drops non-whitelisted, unknown and non-string entries", () => {
  const out = stripToWhitelistedTokens(
    { primary: "#111111", danger: "#FF0000", bogus: "#000000", accent: 42 },
    ["primary", "bogus2"],
  );
  assert.deepEqual(out, { primary: "#111111" });
});

// ── service lifecycle ───────────────────────────────────────────────────────

test("create: validates tokens, creates DRAFT, audits", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  try {
    const row = await service.createPalette({ name: "Brand", tokens: validTokens() }, { userId: "U1" });
    assert.equal(row.status, "DRAFT");
    assert.equal(row.version, 0);
    assert.equal(s.audits[0]?.action, "THEME_PALETTE_CREATED");
    await assert.rejects(
      service.createPalette({ name: "Bad", tokens: { primary: "#112233" } }, {}),
      (e: any) => e.code === "INVALID_TOKENS" && e.status === 422,
    );
    assert.equal(s.palettes.length, 1, "invalid create must not persist");
  } finally { restore(); }
});

test("create: duplicate name is a 409, not an overwrite", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  try {
    await service.createPalette({ name: "Brand", tokens: validTokens() }, {});
    await assert.rejects(
      service.createPalette({ name: "Brand", tokens: validTokens() }, {}),
      (e: any) => e.code === "NAME_TAKEN" && e.status === 409,
    );
  } finally { restore(); }
});

test("publish: bumps version and appends immutable history in the same tx", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  try {
    const draft = await service.createPalette({ name: "Brand", tokens: validTokens() }, {});
    const published = await service.publishPalette(draft.id, { note: "go live" }, { userId: "U1" });
    assert.equal(published.status, "PUBLISHED");
    assert.equal(published.version, 1);
    assert.equal(s.versions.length, 1);
    assert.deepEqual(s.versions[0].tokens, draft.tokens);
    assert.equal(s.versions[0].note, "go live");

    // republish keeps history append-only
    const again = await service.publishPalette(draft.id, {}, { userId: "U1" });
    assert.equal(again.version, 2);
    assert.equal(s.versions.length, 2);
  } finally { restore(); }
});

test("update: published palettes are frozen; stale expectedUpdatedAt conflicts", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  try {
    const draft = await service.createPalette({ name: "Brand", tokens: validTokens() }, {});
    await service.publishPalette(draft.id, {}, {});
    await assert.rejects(
      service.updatePalette(draft.id, { name: "New name" }, {}),
      (e: any) => e.code === "NOT_EDITABLE" && e.status === 409,
    );

    const other = await service.createPalette({ name: "Other", tokens: validTokens() }, {});
    const stale = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await assert.rejects(
      service.updatePalette(other.id, { name: "X", expectedUpdatedAt: stale }, {}),
      (e: any) => e.code === "DRAFT_CONFLICT" && e.status === 409,
    );
    const okRow = await service.updatePalette(
      other.id,
      { name: "X", expectedUpdatedAt: other.updatedAt.toISOString() },
      {},
    );
    assert.equal(okRow.name, "X");
  } finally { restore(); }
});

test("rollback: republishes an old version's exact tokens as a NEW version", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  try {
    const draft = await service.createPalette({ name: "Brand", tokens: validTokens() }, {});
    await service.publishPalette(draft.id, { note: "v1" }, {});
    const v1tokens = s.versions[0].tokens;

    // simulate a second generation with different tokens
    const row = s.palettes.find((p) => p.id === draft.id)!;
    row.tokens = { ...validTokens(), primary: "#FF0000" };
    await service.publishPalette(draft.id, { note: "v2" }, {});
    assert.equal(s.versions.length, 2);

    const restored = await service.rollbackPalette(draft.id, { version: 1 }, { userId: "U9" });
    assert.equal(restored.version, 3, "rollback must be a new version, not a rewrite");
    assert.equal(s.versions.length, 3);
    assert.deepEqual(restored.tokens, v1tokens, "restored tokens must equal version 1 exactly");
    assert.equal(s.versions[2].note, "Rollback to version 1.");
    assert.equal(s.versions[2].publishedById, "U9");

    await assert.rejects(
      service.rollbackPalette(draft.id, { version: 99 }, {}),
      (e: any) => e.code === "VERSION_NOT_FOUND" && e.status === 404,
    );
  } finally { restore(); }
});

test("archive is blocked while assignments reference the palette; delete keeps history", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  try {
    const draft = await service.createPalette({ name: "Brand", tokens: validTokens() }, {});
    await service.publishPalette(draft.id, {}, {});
    await service.upsertAssignment({ scope: "PLATFORM_WEBSITE", paletteId: draft.id }, {});
    await assert.rejects(service.archivePalette(draft.id, {}), (e: any) => e.code === "IN_USE");
    await assert.rejects(service.deletePalette(draft.id, {}), (e: any) => e.code === "IN_USE");

    s.assignments.length = 0;
    await assert.rejects(service.deletePalette(draft.id, {}), (e: any) => e.code === "HAS_HISTORY");
    const archived = await service.archivePalette(draft.id, {});
    assert.equal(archived.status, "ARCHIVED");

    const fresh = await service.createPalette({ name: "Temp", tokens: validTokens() }, {});
    const out = await service.deletePalette(fresh.id, {});
    assert.equal(out.deleted, true);
    assert.equal(s.palettes.some((p) => p.id === fresh.id), false);
  } finally { restore(); }
});

// ── assignments ─────────────────────────────────────────────────────────────

test("assignments: scope rules — vendor scope requires scopeId, global scopes force ''", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  try {
    const draft = await service.createPalette({ name: "Brand", tokens: validTokens() }, {});
    await assert.rejects(
      service.upsertAssignment({ scope: "PLATFORM_WEBSITE", paletteId: draft.id }, {}),
      (e: any) => e.code === "NOT_PUBLISHED",
    );
    await service.publishPalette(draft.id, {}, {});

    const a = await service.upsertAssignment({ scope: "PLATFORM_WEBSITE", scopeId: "sneaky", paletteId: draft.id }, {});
    assert.equal(a.scopeId, "", "global scopes must force scopeId ''");

    await assert.rejects(
      service.upsertAssignment({ scope: "VENDOR_STOREFRONT", paletteId: draft.id }, {}),
      (e: any) => e.code === "SCOPE_ID_REQUIRED",
    );

    await assert.rejects(
      service.upsertAssignment({ scope: "NOT_A_SCOPE" as any, paletteId: draft.id }, {}),
      (e: any) => e.code === "INVALID_SCOPE",
    );

    await assert.rejects(
      service.upsertAssignment({ scope: "PLATFORM_WEBSITE", paletteId: "missing" }, {}),
      (e: any) => e.code === "PALETTE_NOT_FOUND",
    );
  } finally { restore(); }
});

// ── vendor storefront ───────────────────────────────────────────────────────

test("vendor storefront: policy gates palette choice; overrides are whitelist-stripped and color-validated", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  const restorePolicy = stubPolicy({ allowedPaletteIds: [], overridableTokens: ["primary"] });
  try {
    const draft = await service.createPalette({ name: "Brand", tokens: validTokens() }, {});
    await service.publishPalette(draft.id, {}, {});

    // not policy-approved yet
    await assert.rejects(
      service.upsertVendorStorefrontTheme("V1", { paletteId: draft.id }, {}),
      (e: any) => e.code === "NOT_ALLOWED" && e.status === 403,
    );

    (vendorThemePolicyService as any).getPublished = async () => ({
      config: { allowedPaletteIds: [draft.id], overridableTokens: ["primary"] },
      source: "published", updatedAt: null,
    });

    const saved = await service.upsertVendorStorefrontTheme(
      "V1",
      { paletteId: draft.id, overrides: { primary: "#123456", danger: "#FF0000", evil: "x" } },
      { userId: "UV" },
    );
    assert.deepEqual(saved.overrides, { primary: "#123456" }, "non-whitelisted keys must be stripped");

    await assert.rejects(
      service.upsertVendorStorefrontTheme("V1", { paletteId: draft.id, overrides: { primary: "red; }" } }, {}),
      (e: any) => e.code === "INVALID_OVERRIDES" && e.status === 422,
    );

    // reset removes the assignment
    const reset = await service.resetVendorStorefrontTheme("V1", {});
    assert.equal(reset.reset, true);
    assert.equal(s.assignments.length, 0);
    assert.equal((await service.resetVendorStorefrontTheme("V1", {})).reset, false);
  } finally { restore(); restorePolicy(); }
});

// ── public reader ───────────────────────────────────────────────────────────

test("public getActivePalette: never serves DRAFT/ARCHIVED, falls back to Neutral constants", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  const restorePolicy = stubPolicy({ allowedPaletteIds: [], overridableTokens: [] });
  try {
    // no assignment at all → default Neutral
    const none = await service.getActivePalette("PLATFORM_WEBSITE");
    assert.equal(none.source, "default");
    assert.deepEqual(none.tokens, NEUTRAL_PRESET.tokens);
    assert.deepEqual(none.darkTokens, NEUTRAL_PRESET.darkTokens);

    // assignment pointing at a DRAFT palette → still default
    const draft = await service.createPalette({ name: "Brand", tokens: validTokens() }, {});
    s.assignments.push({ id: "a1", scope: "PLATFORM_WEBSITE", scopeId: "", paletteId: draft.id, overrides: null, updatedById: null, updatedAt: stamp() });
    const draftOut = await service.getActivePalette("PLATFORM_WEBSITE");
    assert.equal(draftOut.source, "default", "DRAFT palettes must never be public");
    assert.deepEqual(draftOut.tokens, NEUTRAL_PRESET.tokens);

    // published → served
    await service.publishPalette(draft.id, {}, {});
    const live = await service.getActivePalette("PLATFORM_WEBSITE");
    assert.equal(live.source, "published");
    assert.equal(live.version, 1);
    assert.deepEqual(live.tokens, validTokens());
  } finally { restore(); restorePolicy(); }
});

test("public getActivePalette: DB failure falls back instead of throwing", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  const restorePolicy = stubPolicy({ allowedPaletteIds: [], overridableTokens: [] });
  const orig = (prisma as any).themeAssignment.findUnique;
  (prisma as any).themeAssignment.findUnique = async () => { throw new Error("relation does not exist"); };
  try {
    const out = await service.getActivePalette("PLATFORM_WEBSITE");
    assert.equal(out.source, "fallback");
    assert.deepEqual(out.tokens, NEUTRAL_PRESET.tokens);
  } finally {
    (prisma as any).themeAssignment.findUnique = orig;
    restore();
    restorePolicy();
  }
});

test("public getActivePalette: vendor overrides are re-filtered against the CURRENT policy", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  const restorePolicy = stubPolicy({ allowedPaletteIds: [], overridableTokens: [] }); // tightened: nothing overridable
  try {
    const draft = await service.createPalette({ name: "Brand", tokens: validTokens() }, {});
    await service.publishPalette(draft.id, {}, {});
    s.assignments.push({
      id: "a1", scope: "VENDOR_STOREFRONT", scopeId: "V1", paletteId: draft.id,
      overrides: { primary: "#123456" }, updatedById: null, updatedAt: stamp(),
    });
    const out = await service.getActivePalette("VENDOR_STOREFRONT", "V1");
    assert.equal(out.source, "published");
    assert.equal((out.tokens as any).primary, (validTokens() as any).primary, "stale override must not be served once policy removes the key");
  } finally { restore(); restorePolicy(); }
});

// ── customer preference ─────────────────────────────────────────────────────

test("customer preference: palette must exist and be PUBLISHED; null clears", async () => {
  const s = makeState();
  const restore = fakeDb(s);
  const prefRows: any[] = [];
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => { const o = obj[key]; obj[key] = value; restores.push(() => (obj[key] = o)); };
  set((prisma as any).userThemePreference, "findUnique", async ({ where }: any) => prefRows.find((r) => r.userId === where.userId) ?? null);
  set((prisma as any).userThemePreference, "upsert", async ({ where, create, update }: any) => {
    const i = prefRows.findIndex((r) => r.userId === where.userId);
    if (i >= 0) { Object.assign(prefRows[i], update); return prefRows[i]; }
    prefRows.push({ id: "p1", ...create });
    return prefRows.at(-1);
  });
  set((prisma as any).userThemePreference, "delete", async ({ where }: any) => {
    const i = prefRows.findIndex((r) => r.userId === where.userId);
    return prefRows.splice(i, 1)[0];
  });
  try {
    const draft = await service.createPalette({ name: "Brand", tokens: validTokens() }, {});
    await assert.rejects(
      service.upsertCustomerPreference("U1", { mode: "DARK", paletteId: draft.id }),
      (e: any) => e.code === "NOT_PUBLISHED",
    );
    await service.publishPalette(draft.id, {}, {});
    const saved = await service.upsertCustomerPreference("U1", { mode: "DARK", paletteId: draft.id });
    assert.equal(saved.mode, "DARK");
    assert.equal(saved.paletteId, draft.id);

    await assert.rejects(
      service.upsertCustomerPreference("U1", { mode: "LIGHT", paletteId: "missing" }),
      (e: any) => e.code === "PALETTE_NOT_FOUND",
    );

    const cleared = await service.upsertCustomerPreference("U1", { mode: "SYSTEM", paletteId: null });
    assert.equal(cleared.paletteId, null);

    const read = await service.getCustomerPreference("U1");
    assert.equal(read.mode, "SYSTEM");
    const deleted = await service.deleteCustomerPreference("U1");
    assert.equal(deleted.deleted, true);
    const anon = await service.getCustomerPreference("nobody");
    assert.deepEqual(anon, { mode: "SYSTEM", paletteId: null });
  } finally {
    restores.reverse().forEach((r) => r());
    restore();
  }
});
