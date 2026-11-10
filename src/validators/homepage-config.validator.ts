// src/validators/homepage-config.validator.ts
//
// Versioned, allow-listed schema for the platform homepage configuration
// (stored as JSON in the `settings` table — see homepage-config.service.ts).
//
// Safety rules enforced here:
//   - every object is strict (unknown keys are rejected, not ignored);
//   - section types, sources, presets and sizes are fixed enums;
//   - numbers are bounded integers; colors are #rrggbb only;
//   - text is short plain text — no markup characters, no control characters;
//   - nothing in the config is ever executed or injected as HTML/CSS/classes.
//
// `null` / omitted appearance values mean "keep the current built-in style",
// so a minimal config renders exactly like today's homepage.
import { z } from 'zod';
import { saveDraftBodySchema, type SettingValidation } from './versioned-setting.validator.ts';

// Product card design is NOT part of the homepage config: it is one global
// setting for every listing (validators/product-card.validator.ts).
export { saveDraftBodySchema };

export const HOMEPAGE_CONFIG_SCHEMA_VERSION = 1 as const;

export const LAYOUT_IDS = ['layout_1', 'layout_2', 'layout_3'] as const;

export const SECTION_TYPES = [
  'hero',                   // HeroSlider (HOMEPAGE sliders)
  'horizontalCategoryNav',  // CategoryLayout_2
  'categoryGrid',           // CategoryLayout_3
  'benefits',               // BenefitsSection
  'categoryCircles',        // CategorySection
  'productCollection',      // ProductSection fed by an existing product endpoint
  'footer',                 // Footer (homepage-only today)
] as const;

/** Existing product endpoints only (lib/api-utils get*Server). */
export const PRODUCT_SOURCES = ['flashSale', 'featured', 'newArrivals', 'trending', 'bestSelling', 'discounted'] as const;

/** Max occurrences of each section type within one layout. */
export const SECTION_TYPE_LIMITS: Record<(typeof SECTION_TYPES)[number], number> = {
  hero: 1,
  horizontalCategoryNav: 1,
  categoryGrid: 1,
  benefits: 1,
  categoryCircles: 1,
  productCollection: 10,
  footer: 1,
};

// ── primitives ──────────────────────────────────────────────────────────────

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a #rrggbb hex value')
  .transform((v) => v.toLowerCase());

/** Optional color: omitted or null = keep the built-in color. */
const optColor = hexColor.nullable().optional();

/** Short plain text: no markup or control characters. */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^<>{}\u0000-\u001F\u007F]*$/, 'Text cannot contain markup or control characters');

const int = (min: number, max: number) => z.number().int().min(min).max(max);

const responsive = (min: number, max: number) =>
  z.strictObject({ mobile: int(min, max), tablet: int(min, max), desktop: int(min, max) });

const visibility = z.strictObject({
  mobile: z.boolean(),
  tablet: z.boolean(),
  desktop: z.boolean(),
});

const sectionId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Section id must be 1–40 chars: lowercase letters, digits, "-" or "_"');

const spacingStep = z.enum(['none', 'sm', 'md', 'lg']).nullable().optional();

/** Shared, optional per-section appearance. Omitted/null = current style. */
const sectionAppearance = z
  .strictObject({
    background: optColor,
    textColor: optColor,
    align: z.enum(['left', 'center']).nullable().optional(),
    containerWidth: z.enum(['contained', 'full']).nullable().optional(),
    /** Vertical section spacing per breakpoint (mobile <768, tablet 768–1023, desktop ≥1024). */
    spacing: z
      .strictObject({ mobile: spacingStep, tablet: spacingStep, desktop: spacingStep })
      .nullable()
      .optional(),
  })
  .optional();

const sectionBase = {
  id: sectionId,
  enabled: z.boolean(),
  visibility,
  appearance: sectionAppearance,
};

// ── sections (discriminated by `type`) ──────────────────────────────────────

const emptySettings = z.strictObject({}).optional();

const heroSection = z.strictObject({ ...sectionBase, type: z.literal('hero'), settings: emptySettings });
const horizontalCategoryNavSection = z.strictObject({
  ...sectionBase,
  type: z.literal('horizontalCategoryNav'),
  settings: emptySettings,
});
const categoryGridSection = z.strictObject({ ...sectionBase, type: z.literal('categoryGrid'), settings: emptySettings });
const benefitsSection = z.strictObject({ ...sectionBase, type: z.literal('benefits'), settings: emptySettings });
const footerSection = z.strictObject({ ...sectionBase, type: z.literal('footer'), settings: emptySettings });

const categoryCirclesSection = z.strictObject({
  ...sectionBase,
  type: z.literal('categoryCircles'),
  settings: z
    .strictObject({
      title: plainText(80).nullable().optional(),
      subtitle: plainText(160).nullable().optional(),
      /** null = current behavior (all categories the component shows today). */
      maxItems: int(4, 48).nullable().optional(),
    })
    .optional(),
});

const productCollectionSection = z.strictObject({
  ...sectionBase,
  type: z.literal('productCollection'),
  settings: z.strictObject({
    source: z.enum(PRODUCT_SOURCES),
    title: plainText(80).min(1),
    subtitle: plainText(160).nullable().optional(),
    limit: int(1, 24),
    columns: responsive(1, 8),
    showSeeAll: z.boolean(),
  }),
});

export const sectionSchema = z.discriminatedUnion('type', [
  heroSection,
  horizontalCategoryNavSection,
  categoryGridSection,
  benefitsSection,
  categoryCirclesSection,
  productCollectionSection,
  footerSection,
]);

const layoutSchema = z
  .strictObject({ sections: z.array(sectionSchema).max(20) })
  .superRefine((layout, ctx) => {
    const seen = new Set<string>();
    const counts: Record<string, number> = {};
    layout.sections.forEach((s, i) => {
      if (seen.has(s.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate section id "${s.id}"`, path: ['sections', i, 'id'] });
      }
      seen.add(s.id);
      counts[s.type] = (counts[s.type] ?? 0) + 1;
      if (counts[s.type] > SECTION_TYPE_LIMITS[s.type]) {
        ctx.addIssue({
          code: 'custom',
          message: `At most ${SECTION_TYPE_LIMITS[s.type]} "${s.type}" section(s) per layout`,
          path: ['sections', i, 'type'],
        });
      }
    });
  });

// ── theme (homepage-scoped colors) ─────────────────────────────────────────

export const THEME_PRESETS = ['finixmartDefault'] as const;

const themeSchema = z.strictObject({
  preset: z.enum(THEME_PRESETS),
  colors: z
    .strictObject({
      primary: optColor,
      secondary: optColor,
      accent: optColor,
      pageBackground: optColor,
      surface: optColor,
      heading: optColor,
      body: optColor,
      muted: optColor,
      border: optColor,
      buttonBackground: optColor,
      buttonText: optColor,
      badgeBackground: optColor,
      badgeText: optColor,
    })
    .optional(),
});

// ── root ───────────────────────────────────────────────────────────────────

export const homepageConfigSchema = z.strictObject({
  schemaVersion: z.literal(HOMEPAGE_CONFIG_SCHEMA_VERSION),
  layouts: z.strictObject({
    layout_1: layoutSchema,
    layout_2: layoutSchema,
    layout_3: layoutSchema,
  }),
  theme: themeSchema,
});

export type HomepageConfig = z.infer<typeof homepageConfigSchema>;
export type HomepageSection = z.infer<typeof sectionSchema>;

export type HomepageConfigValidation = SettingValidation<HomepageConfig>;

/**
 * Validates a raw (client- or DB-supplied) value. Unsupported versions get a
 * distinct code so clients can tell "too new/old" from "malformed".
 */
export function validateHomepageConfig(raw: unknown): HomepageConfigValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'INVALID_CONFIG', message: 'Configuration must be a JSON object' };
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version !== HOMEPAGE_CONFIG_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      message: `Unsupported schemaVersion ${JSON.stringify(version ?? null)}; expected ${HOMEPAGE_CONFIG_SCHEMA_VERSION}`,
    };
  }
  const parsed = homepageConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'INVALID_CONFIG',
      message: 'Homepage configuration is invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  return { ok: true, config: parsed.data };
}
