// src/validators/theme-palette.validator.ts
//
// Part 2 — server-side mirror of the Part-1 semantic token schema
// (multivendorsite/src/lib/palette/tokens.ts). The backend cannot import
// frontend files; the two implementations are kept in lockstep by matching
// test fixtures. Rules are identical:
//   - 20 required core tokens; companion tokens optional (derivation happens
//     client-side; the API stores what the author supplied).
//   - values are concrete CSS colors only (hex / functional color grammar);
//     anything with structural characters is rejected so a stored palette
//     can never inject CSS.
//   - unknown token keys are rejected.
import { z } from 'zod';
import type { SettingValidation } from './versioned-setting.validator.ts';

// ── token names (mirror of frontend tokens.ts) ──────────────────────────────

export const CORE_TOKENS = [
  'primary',
  'primaryHover',
  'primaryActive',
  'primaryTint',
  'primaryDark',
  'secondary',
  'accent',
  'background',
  'surface',
  'card',
  'text',
  'textSecondary',
  'muted',
  'border',
  'borderStrong',
  'success',
  'warning',
  'danger',
  'info',
  'focusRing',
] as const;

export const COMPANION_TOKENS = [
  'primaryForeground',
  'secondaryForeground',
  'accentForeground',
  'cardForeground',
  'surfaceForeground',
  'input',
  'successForeground',
  'warningForeground',
  'dangerForeground',
  'infoForeground',
  'chart1',
  'chart2',
  'chart3',
  'chart4',
  'chart5',
  'sidebar',
  'sidebarForeground',
  'sidebarPrimary',
  'sidebarPrimaryForeground',
  'sidebarAccent',
  'sidebarAccentForeground',
  'sidebarBorder',
  'sidebarRing',
] as const;

export type SemanticToken = (typeof CORE_TOKENS)[number] | (typeof COMPANION_TOKENS)[number];
export const ALL_TOKENS: readonly SemanticToken[] = [...CORE_TOKENS, ...COMPANION_TOKENS];
const KNOWN_TOKENS = new Set<string>(ALL_TOKENS);

export type PaletteTokens = Partial<Record<SemanticToken, string>>;

// ── color validation (also the CSS-injection guard) ─────────────────────────

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTION_COLOR = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(([\d\s.,%+\-/a-zA-Z]*)\)$/;
const UNSAFE_CHARS = /[;{}<>@\\"']|url\s*\(|expression\s*\(|var\s*\(|\/\*/i;

export function isValidColorValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return false;
  if (UNSAFE_CHARS.test(v)) return false;
  if (HEX_COLOR.test(v)) return true;
  const fn = FUNCTION_COLOR.exec(v);
  if (!fn) return false;
  return /\d/.test(fn[1]);
}

// ── structural validation ───────────────────────────────────────────────────

export interface PaletteValidationIssue {
  token: string;
  message: string;
}

export type PaletteValidation =
  | { ok: true; tokens: PaletteTokens }
  | { ok: false; issues: PaletteValidationIssue[] };

/**
 * Structural validation only: unknown keys, missing required core tokens and
 * invalid/unsafe color values are reported together. Companion derivation is
 * a frontend concern; the backend stores the author's map as supplied.
 */
export function validatePaletteTokens(input: unknown): PaletteValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ token: '(root)', message: 'Palette tokens must be a plain object' }] };
  }
  const issues: PaletteValidationIssue[] = [];
  const entries = Object.entries(input as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (!KNOWN_TOKENS.has(key)) {
      issues.push({ token: key, message: `Unknown token '${key}'` });
      continue;
    }
    if (!isValidColorValue(value)) {
      issues.push({ token: key, message: 'Invalid or unsafe color value' });
    }
  }
  for (const required of CORE_TOKENS) {
    if (!(required in (input as object))) {
      issues.push({ token: required, message: `Missing required token '${required}'` });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, tokens: input as PaletteTokens };
}

/** Validate the optional dark-token map (same grammar; all keys optional). */
export function validateDarkTokens(input: unknown): PaletteValidation {
  if (input === undefined || input === null) return { ok: true, tokens: {} };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ token: '(darkTokens)', message: 'Dark tokens must be a plain object' }] };
  }
  const issues: PaletteValidationIssue[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!KNOWN_TOKENS.has(key)) {
      issues.push({ token: key, message: `Unknown token '${key}'` });
    } else if (!isValidColorValue(value)) {
      issues.push({ token: key, message: 'Invalid or unsafe color value' });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, tokens: input as PaletteTokens };
}

// ── vendor theme policy (VersionedSettingService config) ────────────────────

export interface VendorThemePolicy {
  /** Palette ids vendors may select for their storefront. */
  allowedPaletteIds: string[];
  /** Token names vendors may override on their own storefront assignment. */
  overridableTokens: SemanticToken[];
}

export const DEFAULT_VENDOR_THEME_POLICY: VendorThemePolicy = {
  allowedPaletteIds: [],
  overridableTokens: [],
};

const policySchema = z.strictObject({
  allowedPaletteIds: z.array(z.string().min(1).max(64)).max(200),
  overridableTokens: z.array(z.enum(ALL_TOKENS as [SemanticToken, ...SemanticToken[]])).max(ALL_TOKENS.length),
});

export function validateVendorThemePolicy(raw: unknown): SettingValidation<VendorThemePolicy> {
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'INVALID_CONFIG',
      message: 'Vendor theme policy must be { allowedPaletteIds: string[], overridableTokens: known-token[] }',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  // de-duplicate while preserving order
  return {
    ok: true,
    config: {
      allowedPaletteIds: [...new Set(parsed.data.allowedPaletteIds)],
      overridableTokens: [...new Set(parsed.data.overridableTokens)],
    },
  };
}

/**
 * Strip any token not on the policy whitelist from a vendor-supplied
 * override map. Unknown keys are dropped silently (defense in depth on top of
 * validation); whitelisted keys still have to pass color validation — the
 * caller validates the stripped result.
 */
export function stripToWhitelistedTokens(input: unknown, whitelist: readonly string[]): PaletteTokens {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const allowed = new Set(whitelist);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (allowed.has(key) && KNOWN_TOKENS.has(key) && typeof value === 'string') {
      out[key] = value;
    }
  }
  return out as PaletteTokens;
}

// ── API body schemas ─────────────────────────────────────────────────────────

export const createPaletteBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  tokens: z.unknown(),
  darkTokens: z.unknown().optional(),
});

export const updatePaletteBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  tokens: z.unknown().optional(),
  darkTokens: z.unknown().nullable().optional(),
  expectedUpdatedAt: z.string().datetime().optional(),
});

export const publishPaletteBodySchema = z
  .strictObject({
    note: z.string().trim().max(500).optional(),
  })
  .optional();

export const rollbackBodySchema = z.strictObject({
  version: z.number().int().min(1),
  note: z.string().trim().max(500).optional(),
});

export const upsertAssignmentBodySchema = z.strictObject({
  scope: z.enum(['PLATFORM_WEBSITE', 'ADMIN_DASHBOARD', 'VENDOR_DASHBOARD', 'VENDOR_STOREFRONT', 'CUSTOMER_DEFAULT']),
  scopeId: z.string().trim().max(64).optional(),
  paletteId: z.string().min(1).max(64),
});

export const vendorStorefrontPaletteBodySchema = z.strictObject({
  paletteId: z.string().min(1).max(64),
  overrides: z.unknown().optional(),
});

export const customerPreferenceBodySchema = z.strictObject({
  mode: z.enum(['LIGHT', 'DARK', 'SYSTEM']),
  paletteId: z.string().min(1).max(64).nullable().optional(),
});
