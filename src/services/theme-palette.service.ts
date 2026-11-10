// src/services/theme-palette.service.ts
//
// Part 2 — semantic theme palettes (THEME_MANAGEMENT_ARCHITECTURE.md §2.3/2.6).
//
// Palettes are unlimited entities with append-only publish history, so they
// get dedicated models instead of the settings table. Concurrency reuses the
// VersionedSettingService PATTERNS (validate-before-write, optimistic 409,
// transaction-scoped advisory lock) rather than the class itself, which only
// handles single-config settings — a second version engine would conflict
// with ThemePaletteVersion history by design.
//
// Guarantees:
//   - every mutating operation runs in ONE transaction on the direct client
//     behind a single advisory lock (palette writes are rare and serialized);
//   - tokens are re-validated on every write AND on every publish/rollback;
//   - publish history is append-only — rollback publishes the old tokens as a
//     NEW version, so every published state stays reproducible;
//   - the public reader never throws and never serves DRAFT data: any problem
//     falls back to the built-in Neutral preset (== today's production CSS).
import { Prisma } from '@prisma/client';
import { prisma, prismaDirect } from '../config/prisma.ts';
import { NEUTRAL_PRESET, PALETTE_PRESET_DEFAULTS } from '../constants/theme-palette.defaults.ts';
import {
  isValidColorValue,
  stripToWhitelistedTokens,
  validatePaletteTokens,
  type PaletteTokens,
} from '../validators/theme-palette.validator.ts';
import { vendorThemePolicyService } from './theme-vendor-policy.service.ts';

/** Arbitrary constant identifying "theme palette writes" for pg_advisory_xact_lock. */
export const THEME_PALETTE_LOCK_ID = 4206004;

const THEME_SCOPES = ['PLATFORM_WEBSITE', 'ADMIN_DASHBOARD', 'VENDOR_DASHBOARD', 'VENDOR_STOREFRONT', 'CUSTOMER_DEFAULT'] as const;
type ThemeScopeValue = (typeof THEME_SCOPES)[number];

export interface Actor {
  userId?: string | null;
}

// Explicit fields (no TS parameter properties): the dev server runs on Node's
// native type stripping, which rejects parameter properties.
export class ThemePaletteError extends Error {
  status: number;
  code: string;
  issues?: unknown[];

  constructor(status: number, code: string, message: string, issues?: unknown[]) {
    super(message);
    this.name = 'ThemePaletteError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type Db = Prisma.TransactionClient;

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function invalidTokens(issues: unknown[]): ThemePaletteError {
  return new ThemePaletteError(422, 'INVALID_TOKENS', 'Palette tokens failed validation.', issues);
}

/** Advisory-locked transaction for every palette/assignment write. */
function withLock<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
  return prismaDirect.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${THEME_PALETTE_LOCK_ID}::bigint)`;
    return fn(tx);
  });
}

async function audit(
  tx: Db,
  entry: { action: string; entityId: string; oldData?: unknown; newData?: unknown; userId?: string | null },
) {
  await tx.auditLog.create({
    data: {
      action: entry.action,
      entity: 'ThemePalette',
      entityId: entry.entityId,
      oldData: entry.oldData === undefined ? undefined : asJson(entry.oldData),
      newData: entry.newData === undefined ? undefined : asJson(entry.newData),
      userId: entry.userId ?? null,
    },
  });
}

// ── preset seeding (lazy, idempotent) ────────────────────────────────────────

/**
 * Ensures the three built-in presets exist as PUBLISHED rows (with an initial
 * version-1 history entry). Idempotent: matched by unique name. Called from
 * admin reads so the management UI always has the preset baseline; failures
 * are non-fatal (the public endpoint falls back to constants anyway).
 */
export async function ensurePresetPalettes(): Promise<void> {
  try {
    for (const preset of PALETTE_PRESET_DEFAULTS) {
      const existing = await prisma.themePalette.findUnique({ where: { name: preset.name } });
      if (existing) continue;
      await prisma.themePalette.create({
        data: {
          name: preset.name,
          description: preset.description,
          kind: 'PRESET',
          status: 'PUBLISHED',
          tokens: asJson(preset.tokens),
          darkTokens: preset.darkTokens ? asJson(preset.darkTokens) : undefined,
          version: 1,
          publishedAt: new Date(),
          versions: {
            create: {
              version: 1,
              tokens: asJson(preset.tokens),
              darkTokens: preset.darkTokens ? asJson(preset.darkTokens) : undefined,
              note: 'Seeded built-in preset.',
            },
          },
        },
      });
    }
  } catch (err) {
    // Non-fatal by design: before the Part-2 migration is applied the tables
    // do not exist; the public endpoint still serves the Neutral constants.
    console.warn('[theme-palette] preset seed skipped:', (err as Error).message);
  }
}

// ── admin reads ──────────────────────────────────────────────────────────────

export async function listPalettes() {
  await ensurePresetPalettes();
  const rows = await prisma.themePalette.findMany({
    orderBy: [{ kind: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { assignments: true, versions: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind,
    status: r.status,
    version: r.version,
    publishedAt: r.publishedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    assignmentCount: r._count.assignments,
    versionCount: r._count.versions,
  }));
}

export async function getPalette(id: string) {
  const row = await prisma.themePalette.findUnique({
    where: { id },
    include: { assignments: true, _count: { select: { versions: true } } },
  });
  if (!row) throw new ThemePaletteError(404, 'NOT_FOUND', 'Palette not found.');
  return row;
}

export async function listVersions(id: string) {
  const palette = await prisma.themePalette.findUnique({ where: { id }, select: { id: true } });
  if (!palette) throw new ThemePaletteError(404, 'NOT_FOUND', 'Palette not found.');
  return prisma.themePaletteVersion.findMany({
    where: { paletteId: id },
    orderBy: { version: 'desc' },
  });
}

// ── admin writes ─────────────────────────────────────────────────────────────

export async function createPalette(
  input: { name: string; description?: string; tokens: unknown; darkTokens?: unknown },
  actor: Actor,
) {
  const v = validatePaletteTokens(input.tokens);
  if (!v.ok) throw invalidTokens(v.issues);
  let dark: PaletteTokens | null = null;
  if (input.darkTokens !== undefined && input.darkTokens !== null) {
    const dv = validatePaletteTokens({ ...v.tokens, ...(input.darkTokens as object) });
    // darkTokens are a partial map: validate each value + unknown keys only.
    // Reusing validatePaletteTokens on the merge guarantees dark overrides
    // cannot smuggle unknown keys or invalid colors.
    if (!dv.ok) throw invalidTokens(dv.issues.filter((i) => !(i.message.startsWith('Missing required') && !(i.token in (input.darkTokens as object)))));
    dark = input.darkTokens as PaletteTokens;
  }

  return withLock(async (tx) => {
    const clash = await tx.themePalette.findUnique({ where: { name: input.name }, select: { id: true } });
    if (clash) throw new ThemePaletteError(409, 'NAME_TAKEN', `A palette named '${input.name}' already exists.`);
    const row = await tx.themePalette.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        kind: 'CUSTOM',
        status: 'DRAFT',
        tokens: asJson(v.tokens),
        darkTokens: dark ? asJson(dark) : undefined,
        createdById: actor.userId ?? null,
      },
    });
    await audit(tx, { action: 'THEME_PALETTE_CREATED', entityId: row.id, newData: { name: row.name }, userId: actor.userId });
    return row;
  });
}

/**
 * Edits a DRAFT palette only. Published palettes are frozen — duplicate one
 * to iterate — so live data never changes without a version bump.
 * `expectedUpdatedAt` (the updatedAt the editor loaded) rejects stale saves
 * with 409, the same convention as VersionedSettingService.
 */
export async function updatePalette(
  id: string,
  input: { name?: string; description?: string | null; tokens?: unknown; darkTokens?: unknown; expectedUpdatedAt?: string },
  actor: Actor,
) {
  return withLock(async (tx) => {
    const row = await tx.themePalette.findUnique({ where: { id } });
    if (!row) throw new ThemePaletteError(404, 'NOT_FOUND', 'Palette not found.');
    if (row.status !== 'DRAFT') {
      throw new ThemePaletteError(409, 'NOT_EDITABLE', 'Only DRAFT palettes can be edited. Duplicate the palette to iterate on a published one.');
    }
    if (input.expectedUpdatedAt !== undefined) {
      const expectedIso = new Date(input.expectedUpdatedAt).toISOString();
      if (row.updatedAt.toISOString() !== expectedIso) {
        throw new ThemePaletteError(409, 'DRAFT_CONFLICT', 'The palette was changed since you loaded it. Reload before saving.');
      }
    }

    const data: Prisma.ThemePaletteUpdateInput = {};
    if (input.name !== undefined) {
      const clash = await tx.themePalette.findUnique({ where: { name: input.name }, select: { id: true } });
      if (clash && clash.id !== id) {
        throw new ThemePaletteError(409, 'NAME_TAKEN', `A palette named '${input.name}' already exists.`);
      }
      data.name = input.name;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.tokens !== undefined) {
      const v = validatePaletteTokens(input.tokens);
      if (!v.ok) throw invalidTokens(v.issues);
      data.tokens = asJson(v.tokens);
    }
    if (input.darkTokens !== undefined) {
      if (input.darkTokens === null) {
        data.darkTokens = Prisma.DbNull;
      } else {
        const dv = validatePaletteTokens({ ...(row.tokens as object), ...(input.darkTokens as object) });
        if (!dv.ok) throw invalidTokens(dv.issues);
        data.darkTokens = asJson(input.darkTokens);
      }
    }

    const saved = await tx.themePalette.update({ where: { id }, data });
    await audit(tx, {
      action: 'THEME_PALETTE_UPDATED',
      entityId: id,
      oldData: { name: row.name, status: row.status },
      newData: { name: saved.name },
      userId: actor.userId,
    });
    return saved;
  });
}

export async function duplicatePalette(id: string, actor: Actor) {
  return withLock(async (tx) => {
    const source = await tx.themePalette.findUnique({ where: { id } });
    if (!source) throw new ThemePaletteError(404, 'NOT_FOUND', 'Palette not found.');

    let name = `${source.name} copy`;
    for (let i = 2; await tx.themePalette.findUnique({ where: { name }, select: { id: true } }); i += 1) {
      name = `${source.name} copy ${i}`;
    }
    const row = await tx.themePalette.create({
      data: {
        name,
        description: source.description,
        kind: 'CUSTOM',
        status: 'DRAFT',
        tokens: asJson(source.tokens),
        darkTokens: source.darkTokens === null ? undefined : asJson(source.darkTokens),
        createdById: actor.userId ?? null,
      },
    });
    await audit(tx, {
      action: 'THEME_PALETTE_DUPLICATED',
      entityId: row.id,
      newData: { from: id, name },
      userId: actor.userId,
    });
    return row;
  });
}

/**
 * Freezes the current tokens as the next published version. Re-validates
 * inside the transaction; history append is atomic with the status flip, so
 * readers never observe a PUBLISHED palette without its version row.
 */
export async function publishPalette(id: string, input: { note?: string }, actor: Actor) {
  return withLock(async (tx) => {
    const row = await tx.themePalette.findUnique({ where: { id } });
    if (!row) throw new ThemePaletteError(404, 'NOT_FOUND', 'Palette not found.');
    if (row.status === 'ARCHIVED') {
      throw new ThemePaletteError(409, 'ARCHIVED', 'Archived palettes cannot be published. Duplicate it or roll back a live version instead.');
    }
    const v = validatePaletteTokens(row.tokens);
    if (!v.ok) throw invalidTokens(v.issues);

    const nextVersion = row.version + 1;
    const [saved] = await Promise.all([
      tx.themePalette.update({
        where: { id },
        data: { status: 'PUBLISHED', version: nextVersion, publishedAt: new Date() },
      }),
      tx.themePaletteVersion.create({
        data: {
          paletteId: id,
          version: nextVersion,
          tokens: asJson(row.tokens),
          darkTokens: row.darkTokens === null ? undefined : asJson(row.darkTokens),
          note: input.note ?? null,
          publishedById: actor.userId ?? null,
        },
      }),
    ]);
    await audit(tx, {
      action: 'THEME_PALETTE_PUBLISHED',
      entityId: id,
      oldData: { status: row.status, version: row.version },
      newData: { status: 'PUBLISHED', version: nextVersion, note: input.note ?? null },
      userId: actor.userId,
    });
    return saved;
  });
}

/** Archive is blocked while any scope assignment still references the palette. */
export async function archivePalette(id: string, actor: Actor) {
  return withLock(async (tx) => {
    const row = await tx.themePalette.findUnique({ where: { id }, include: { _count: { select: { assignments: true } } } });
    if (!row) throw new ThemePaletteError(404, 'NOT_FOUND', 'Palette not found.');
    if (row._count.assignments > 0) {
      throw new ThemePaletteError(409, 'IN_USE', 'The palette is still assigned to one or more scopes. Reassign them first.');
    }
    if (row.status === 'ARCHIVED') return row;
    const saved = await tx.themePalette.update({ where: { id }, data: { status: 'ARCHIVED' } });
    await audit(tx, {
      action: 'THEME_PALETTE_ARCHIVED',
      entityId: id,
      oldData: { status: row.status },
      newData: { status: 'ARCHIVED' },
      userId: actor.userId,
    });
    return saved;
  });
}

/** Deletes only never-published CUSTOM palettes with no assignments. */
export async function deletePalette(id: string, actor: Actor) {
  return withLock(async (tx) => {
    const row = await tx.themePalette.findUnique({ where: { id }, include: { _count: { select: { assignments: true, versions: true } } } });
    if (!row) throw new ThemePaletteError(404, 'NOT_FOUND', 'Palette not found.');
    if (row.kind === 'PRESET') throw new ThemePaletteError(409, 'PRESET', 'Built-in presets cannot be deleted.');
    if (row._count.assignments > 0) throw new ThemePaletteError(409, 'IN_USE', 'The palette is still assigned to one or more scopes.');
    if (row._count.versions > 0) {
      throw new ThemePaletteError(409, 'HAS_HISTORY', 'A palette with publish history cannot be deleted. Archive it instead.');
    }
    await tx.themePalette.delete({ where: { id } });
    await audit(tx, { action: 'THEME_PALETTE_DELETED', entityId: id, oldData: { name: row.name }, userId: actor.userId });
    return { deleted: true };
  });
}

/**
 * Append-only rollback: republishes an old version's tokens as a NEW version.
 * Allowed from PUBLISHED and ARCHIVED (rollback un-archives); DRAFT palettes
 * have no history. The replaced state stays in history, so rollback is itself
 * reversible.
 */
export async function rollbackPalette(id: string, input: { version: number; note?: string }, actor: Actor) {
  return withLock(async (tx) => {
    const row = await tx.themePalette.findUnique({ where: { id } });
    if (!row) throw new ThemePaletteError(404, 'NOT_FOUND', 'Palette not found.');
    if (row.status === 'DRAFT') throw new ThemePaletteError(409, 'NO_HISTORY', 'A never-published palette has no version to roll back to.');

    const target = await tx.themePaletteVersion.findUnique({
      where: { paletteId_version: { paletteId: id, version: input.version } },
    });
    if (!target) throw new ThemePaletteError(404, 'VERSION_NOT_FOUND', `Version ${input.version} does not exist for this palette.`);
    const v = validatePaletteTokens(target.tokens);
    if (!v.ok) {
      throw new ThemePaletteError(422, 'INVALID_VERSION', `Stored version ${input.version} is invalid and cannot be restored.`, v.issues);
    }

    const nextVersion = row.version + 1;
    const note = input.note ?? `Rollback to version ${input.version}.`;
    const [saved] = await Promise.all([
      tx.themePalette.update({
        where: { id },
        data: {
          tokens: asJson(target.tokens),
          darkTokens: target.darkTokens === null ? Prisma.DbNull : asJson(target.darkTokens),
          status: 'PUBLISHED',
          version: nextVersion,
          publishedAt: new Date(),
        },
      }),
      tx.themePaletteVersion.create({
        data: {
          paletteId: id,
          version: nextVersion,
          tokens: asJson(target.tokens),
          darkTokens: target.darkTokens === null ? undefined : asJson(target.darkTokens),
          note,
          publishedById: actor.userId ?? null,
        },
      }),
    ]);
    await audit(tx, {
      action: 'THEME_PALETTE_ROLLBACK',
      entityId: id,
      oldData: { status: row.status, version: row.version },
      newData: { status: 'PUBLISHED', version: nextVersion, restoredFrom: input.version },
      userId: actor.userId,
    });
    return saved;
  });
}

/**
 * Resets a PRESET palette's tokens to the built-in map (matched by name).
 * DRAFT presets are replaced in place; PUBLISHED presets go through the
 * version-bump machinery so history stays complete. Archived → 409.
 */
export async function restorePresetDefault(id: string, actor: Actor) {
  return withLock(async (tx) => {
    const row = await tx.themePalette.findUnique({ where: { id } });
    if (!row) throw new ThemePaletteError(404, 'NOT_FOUND', 'Palette not found.');
    if (row.kind !== 'PRESET') throw new ThemePaletteError(409, 'NOT_PRESET', 'Only built-in presets can be restored to defaults.');
    const preset = PALETTE_PRESET_DEFAULTS.find((p) => p.name.toLowerCase() === row.name.toLowerCase());
    if (!preset) throw new ThemePaletteError(404, 'PRESET_NOT_FOUND', `No built-in preset matches the name '${row.name}'.`);
    if (row.status === 'ARCHIVED') throw new ThemePaletteError(409, 'ARCHIVED', 'Archived palettes cannot be restored.');

    const tokens = asJson(preset.tokens);
    // Update payload uses DbNull to clear; create payload omits the field.
    const darkUpdate = preset.darkTokens ? asJson(preset.darkTokens) : Prisma.DbNull;
    const darkCreate = preset.darkTokens ? asJson(preset.darkTokens) : undefined;

    if (row.status === 'DRAFT') {
      const saved = await tx.themePalette.update({ where: { id }, data: { tokens, darkTokens: darkUpdate } });
      await audit(tx, { action: 'THEME_PALETTE_RESTORE_DEFAULT', entityId: id, newData: { preset: preset.id, draft: true }, userId: actor.userId });
      return saved;
    }

    const nextVersion = row.version + 1;
    const [saved] = await Promise.all([
      tx.themePalette.update({
        where: { id },
        data: { tokens, darkTokens: darkUpdate, version: nextVersion, publishedAt: new Date() },
      }),
      tx.themePaletteVersion.create({
        data: {
          paletteId: id,
          version: nextVersion,
          tokens,
          darkTokens: darkCreate,
          note: 'Restored built-in defaults.',
          publishedById: actor.userId ?? null,
        },
      }),
    ]);
    await audit(tx, {
      action: 'THEME_PALETTE_RESTORE_DEFAULT',
      entityId: id,
      newData: { preset: preset.id, version: nextVersion },
      userId: actor.userId,
    });
    return saved;
  });
}

// ── assignments ──────────────────────────────────────────────────────────────

export async function listAssignments() {
  const rows = await prisma.themeAssignment.findMany({
    include: { palette: { select: { id: true, name: true, status: true, version: true } } },
    orderBy: [{ scope: 'asc' }, { scopeId: 'asc' }],
  });
  return rows;
}

export async function upsertAssignment(
  input: { scope: string; scopeId?: string; paletteId: string },
  actor: Actor,
) {
  if (!THEME_SCOPES.includes(input.scope as ThemeScopeValue)) {
    throw new ThemePaletteError(400, 'INVALID_SCOPE', `Scope must be one of ${THEME_SCOPES.join(', ')}.`);
  }
  const scope = input.scope as ThemeScopeValue;
  // VENDOR_STOREFRONT is the only per-tenant scope; every other scope is
  // global and its scopeId is forced to "" so a client can never create a
  // shadow assignment for an arbitrary id.
  const scopeId = scope === 'VENDOR_STOREFRONT' ? (input.scopeId ?? '').trim() : '';
  if (scope === 'VENDOR_STOREFRONT' && scopeId.length === 0) {
    throw new ThemePaletteError(400, 'SCOPE_ID_REQUIRED', 'VENDOR_STOREFRONT assignments require a vendor scopeId.');
  }

  return withLock(async (tx) => {
    const palette = await tx.themePalette.findUnique({ where: { id: input.paletteId }, select: { id: true, status: true } });
    if (!palette) throw new ThemePaletteError(404, 'PALETTE_NOT_FOUND', 'Palette not found.');
    if (palette.status !== 'PUBLISHED') {
      throw new ThemePaletteError(409, 'NOT_PUBLISHED', 'Only PUBLISHED palettes can be assigned to a scope.');
    }
    const row = await tx.themeAssignment.upsert({
      where: { scope_scopeId: { scope, scopeId } },
      create: { scope, scopeId, paletteId: input.paletteId, updatedById: actor.userId ?? null },
      update: { paletteId: input.paletteId, overrides: Prisma.DbNull, updatedById: actor.userId ?? null },
    });
    await audit(tx, {
      action: 'THEME_ASSIGNMENT_UPSERTED',
      entityId: row.id,
      newData: { scope, scopeId, paletteId: input.paletteId },
      userId: actor.userId,
    });
    return row;
  });
}

// ── public resolution (never throws, never serves drafts) ───────────────────

export interface ActivePaletteResult {
  scope: string;
  scopeId: string;
  name: string;
  version: number;
  tokens: PaletteTokens;
  darkTokens: PaletteTokens | null;
  updatedAt: Date | null;
  source: 'published' | 'default' | 'fallback';
}

function neutralFallback(scope: string, scopeId: string, source: 'default' | 'fallback'): ActivePaletteResult {
  return {
    scope,
    scopeId,
    name: NEUTRAL_PRESET.name,
    version: 0,
    tokens: { ...NEUTRAL_PRESET.tokens },
    darkTokens: NEUTRAL_PRESET.darkTokens ? { ...NEUTRAL_PRESET.darkTokens } : null,
    updatedAt: null,
    source,
  };
}

/**
 * Resolves the live palette for a scope. Public-reader contract: never
 * throws, never mutates, never returns DRAFT/ARCHIVED or invalid data — any
 * problem falls back to the built-in Neutral preset (the exact production
 * values), so the customer site can depend on this unconditionally.
 */
export async function getActivePalette(scope: string, scopeId?: string): Promise<ActivePaletteResult> {
  const sid = scope === 'VENDOR_STOREFRONT' ? (scopeId ?? '') : '';
  try {
    const assignment = await prisma.themeAssignment.findUnique({
      where: { scope_scopeId: { scope: scope as never, scopeId: sid } },
      include: { palette: true },
    });
    if (!assignment || assignment.palette.status !== 'PUBLISHED') {
      return neutralFallback(scope, sid, 'default');
    }
    const v = validatePaletteTokens(assignment.palette.tokens);
    if (!v.ok) {
      console.warn(`[theme-palette] published palette ${assignment.palette.id} is invalid — serving defaults`);
      return neutralFallback(scope, sid, 'fallback');
    }
    let tokens: PaletteTokens = v.tokens;
    let darkTokens: PaletteTokens | null = null;
    if (assignment.palette.darkTokens) {
      darkTokens = assignment.palette.darkTokens as PaletteTokens;
    }
    // Vendor storefront overrides: re-filtered against the CURRENT policy so
    // a tightened policy instantly stops serving removed override keys.
    if (scope === 'VENDOR_STOREFRONT' && assignment.overrides) {
      const policy = await vendorThemePolicyService.getPublished();
      const allowed = stripToWhitelistedTokens(assignment.overrides, policy.config.overridableTokens);
      tokens = { ...tokens, ...allowed };
    }
    return {
      scope,
      scopeId: sid,
      name: assignment.palette.name,
      version: assignment.palette.version,
      tokens,
      darkTokens,
      updatedAt: assignment.palette.updatedAt,
      source: 'published',
    };
  } catch (err) {
    console.error('[theme-palette] failed to resolve active palette — serving defaults:', err);
    return neutralFallback(scope, sid, 'fallback');
  }
}

// ── vendor storefront (server-side vendor scope only) ───────────────────────

/** Policy-approved, PUBLISHED palettes a vendor may choose from. */
export async function listVendorPalettes() {
  const policy = await vendorThemePolicyService.getPublished();
  if (policy.config.allowedPaletteIds.length === 0) return [];
  const rows = await prisma.themePalette.findMany({
    where: { id: { in: policy.config.allowedPaletteIds }, status: 'PUBLISHED' },
    select: { id: true, name: true, description: true, version: true, updatedAt: true },
    orderBy: { name: 'asc' },
  });
  return rows;
}

/** Effective storefront theme for a vendor: assignment palette + whitelisted overrides. */
export async function getVendorStorefrontTheme(vendorId: string) {
  const active = await getActivePalette('VENDOR_STOREFRONT', vendorId);
  const assignment = await prisma.themeAssignment
    .findUnique({
      where: { scope_scopeId: { scope: 'VENDOR_STOREFRONT', scopeId: vendorId } },
      select: { paletteId: true, overrides: true, updatedAt: true },
    })
    .catch(() => null);
  const policy = await vendorThemePolicyService.getPublished();
  return {
    paletteId: assignment?.paletteId ?? null,
    overrides: assignment?.overrides ?? null,
    tokens: active.tokens,
    darkTokens: active.darkTokens,
    source: active.source,
    policy: { overridableTokens: policy.config.overridableTokens },
  };
}

/**
 * Sets a vendor's own storefront palette + whitelisted token overrides.
 * `vendorId` comes ONLY from the authenticated session (requireVendorScope);
 * the palette must be policy-approved and PUBLISHED; overrides are stripped
 * to the policy whitelist and every value re-validated, so a vendor can
 * never inject CSS or affect any other scope.
 */
export async function upsertVendorStorefrontTheme(
  vendorId: string,
  input: { paletteId: string; overrides?: unknown },
  actor: Actor,
) {
  const policy = await vendorThemePolicyService.getPublished();
  if (!policy.config.allowedPaletteIds.includes(input.paletteId)) {
    throw new ThemePaletteError(403, 'NOT_ALLOWED', 'This palette is not approved for vendor storefronts.');
  }
  const stripped = stripToWhitelistedTokens(input.overrides, policy.config.overridableTokens);
  const badKeys = Object.entries(stripped).filter(([, value]) => !isValidColorValue(value)).map(([k]) => k);
  if (badKeys.length > 0) {
    throw new ThemePaletteError(
      422,
      'INVALID_OVERRIDES',
      'Override values must be valid CSS colors.',
      badKeys.map((token) => ({ token, message: 'Invalid or unsafe color value' })),
    );
  }

  return withLock(async (tx) => {
    const palette = await tx.themePalette.findUnique({ where: { id: input.paletteId }, select: { id: true, status: true } });
    if (!palette) throw new ThemePaletteError(404, 'PALETTE_NOT_FOUND', 'Palette not found.');
    if (palette.status !== 'PUBLISHED') {
      throw new ThemePaletteError(409, 'NOT_PUBLISHED', 'Only PUBLISHED palettes can be assigned to a storefront.');
    }
    const row = await tx.themeAssignment.upsert({
      where: { scope_scopeId: { scope: 'VENDOR_STOREFRONT', scopeId: vendorId } },
      create: {
        scope: 'VENDOR_STOREFRONT',
        scopeId: vendorId,
        paletteId: input.paletteId,
        overrides: Object.keys(stripped).length > 0 ? asJson(stripped) : undefined,
        updatedById: actor.userId ?? null,
      },
      update: {
        paletteId: input.paletteId,
        overrides: Object.keys(stripped).length > 0 ? asJson(stripped) : Prisma.DbNull,
        updatedById: actor.userId ?? null,
      },
    });
    await audit(tx, {
      action: 'THEME_VENDOR_STOREFRONT_SET',
      entityId: row.id,
      newData: { vendorId, paletteId: input.paletteId, overrideKeys: Object.keys(stripped) },
      userId: actor.userId,
    });
    return row;
  });
}

/** Removes a vendor's storefront assignment (falls back to platform default). */
export async function resetVendorStorefrontTheme(vendorId: string, actor: Actor) {
  return withLock(async (tx) => {
    const existing = await tx.themeAssignment.findUnique({
      where: { scope_scopeId: { scope: 'VENDOR_STOREFRONT', scopeId: vendorId } },
    });
    if (!existing) return { reset: false };
    await tx.themeAssignment.delete({ where: { id: existing.id } });
    await audit(tx, {
      action: 'THEME_VENDOR_STOREFRONT_RESET',
      entityId: existing.id,
      oldData: { vendorId, paletteId: existing.paletteId },
      userId: actor.userId,
    });
    return { reset: true };
  });
}

// ── customer preference ──────────────────────────────────────────────────────

export async function getCustomerPreference(userId: string) {
  const row = await prisma.userThemePreference.findUnique({ where: { userId } }).catch(() => null);
  return { mode: row?.mode ?? 'SYSTEM', paletteId: row?.paletteId ?? null };
}

/**
 * Saves a customer's own appearance preference. `paletteId`, when given, must
 * reference a PUBLISHED palette — the Part-2 definition of
 * "customer-exposable" (a dedicated flag can narrow this later without a
 * migration). Null clears the palette choice; the row keeps the mode.
 */
export async function upsertCustomerPreference(
  userId: string,
  input: { mode: 'LIGHT' | 'DARK' | 'SYSTEM'; paletteId?: string | null },
) {
  if (input.paletteId) {
    const palette = await prisma.themePalette.findUnique({
      where: { id: input.paletteId },
      select: { status: true },
    });
    if (!palette) throw new ThemePaletteError(404, 'PALETTE_NOT_FOUND', 'Palette not found.');
    if (palette.status !== 'PUBLISHED') {
      throw new ThemePaletteError(409, 'NOT_PUBLISHED', 'Only published palettes can be selected.');
    }
  }
  return prisma.userThemePreference.upsert({
    where: { userId },
    create: { userId, mode: input.mode, paletteId: input.paletteId ?? null },
    update: { mode: input.mode, paletteId: input.paletteId ?? null },
  });
}

export async function deleteCustomerPreference(userId: string) {
  const existing = await prisma.userThemePreference.findUnique({ where: { userId } });
  if (!existing) return { deleted: false };
  await prisma.userThemePreference.delete({ where: { userId } });
  return { deleted: true };
}
