// src/validators/product-card.validator.ts
//
// Versioned, allow-listed schema for the GLOBAL product card design — one
// configuration for every customer-facing product listing (homepage,
// /products, category, campaign, related products, storefront "All Products").
// Store Decoration modules are not driven by it.
//
// Safety rules (same as the homepage config):
//   - every object is strict (unknown keys are rejected);
//   - presets, weights, ratios, positions and shadows are fixed enums;
//   - sizes are bounded integers (px), per breakpoint where it matters:
//     mobile <768px, tablet 768–1023px (md), desktop ≥1024px (lg);
//   - colors are #rrggbb only; null/omitted = the built-in color;
//   - nothing is ever turned into HTML, CSS text or class names.
//
// Wishlist and Quick View are intentionally absent (no working card actions
// exist). Add to Cart (opt-in, off by default) uses the real cart flow.
//
// Optional blocks/fields (absent in older saved configs, which stay valid —
// schemaVersion is unchanged): `grid` (absent = the listing pages keep their
// built-in grid) and `addToCart.label` (absent = "Add to Cart").
import { z } from 'zod';
import type { SettingValidation } from './versioned-setting.validator.ts';

export const PRODUCT_CARD_SCHEMA_VERSION = 1 as const;

export const PRODUCT_CARD_PRESETS = [
  'finixmartDefault',
  'compactMarketplace',
  'cleanMinimal',
  'imageFocused',
  'premiumStorefront',
] as const;

/** The opt-in Add to Cart button exists on the shared card (off by default). */
export const ADD_TO_CART_AVAILABLE = true;

/**
 * Button label: plain text only — letters (any script, incl. Bangla), digits,
 * combining marks, spaces and . , ' & ! + -  (no markup / quote / brace / slash).
 */
export const ADD_TO_CART_LABEL_PATTERN = /^[\p{L}\p{N}\p{M} .,'&!+-]+$/u;
export const ADD_TO_CART_LABEL_MAX = 24;

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a #rrggbb hex value')
  .transform((v) => v.toLowerCase());
const optColor = hexColor.nullable().optional();
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const responsive = (min: number, max: number) =>
  z.strictObject({ mobile: int(min, max), tablet: int(min, max), desktop: int(min, max) });
const fontWeight = z.enum(['normal', 'medium', 'semibold', 'bold']);
const shadow = z.enum(['none', 'sm', 'md', 'lg']);

export const productCardConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(PRODUCT_CARD_SCHEMA_VERSION),
    /** The preset the admin started from (informational; all values below are explicit). */
    preset: z.enum(PRODUCT_CARD_PRESETS),

    /** Element visibility. Data-dependent elements also hide when their data is missing. */
    show: z.strictObject({
      image: z.boolean(),
      title: z.boolean(),
      price: z.boolean(),
      originalPrice: z.boolean(),
      discountBadge: z.boolean(),
      /** Only rendered with real data (reviewCount > 0 and a valid avgRating). */
      rating: z.boolean(),
      reviewCount: z.boolean(),
      /** Always hidden on the vendor's own storefront. */
      storeName: z.boolean(),
      verifiedBadge: z.boolean(),
      freeShippingBadge: z.boolean(),
      stockLabel: z.boolean(),
      addToCart: z.boolean(),
    }),

    card: z.strictObject({
      background: optColor,
      borderColor: optColor,
      borderWidth: int(0, 2),
      radius: int(0, 24),
      shadow,
      hoverShadow: shadow,
      /** Space between the image and the text block. */
      imageGap: responsive(0, 24),
      contentPaddingX: responsive(0, 24),
      contentPaddingY: int(0, 16),
      align: z.enum(['left', 'center']),
    }),

    image: z.strictObject({
      /** 'fixed' = fixed height per breakpoint (today's card); otherwise a ratio. */
      sizing: z.enum(['fixed', '1:1', '4:5', '3:4', '4:3']),
      height: responsive(80, 320),
      fit: z.enum(['contain', 'cover']),
      padding: int(0, 24),
      background: optColor,
    }),

    title: z.strictObject({
      size: responsive(10, 20),
      weight: fontWeight,
      lines: int(1, 3),
      color: optColor,
    }),

    price: z.strictObject({
      size: responsive(10, 28),
      weight: fontWeight,
      color: optColor,
      originalSize: responsive(9, 20),
      originalColor: optColor,
    }),

    discountBadge: z.strictObject({
      position: z.enum(['besidePrice', 'imageTopLeft', 'imageTopRight']),
      background: optColor,
      text: optColor,
      radius: int(0, 12),
    }),

    addToCart: z.strictObject({
      variant: z.enum(['filled', 'outline']),
      size: z.enum(['sm', 'md']),
      background: optColor,
      text: optColor,
      radius: int(0, 16),
      label: z
        .string()
        .trim()
        .min(1, 'Button label cannot be empty')
        .max(ADD_TO_CART_LABEL_MAX, `Button label can be at most ${ADD_TO_CART_LABEL_MAX} characters`)
        .regex(ADD_TO_CART_LABEL_PATTERN, "Button label may only contain letters, numbers, spaces and . , ' & ! + -")
        .optional(),
    }),

    /**
     * Product grid on the listing pages (/category/[slug] and /products).
     * Absent = their built-in grid, unchanged. Columns are a MAXIMUM on
     * tablet/desktop: the page drops columns rather than render cards
     * narrower than ~130px. Gaps in px.
     */
    grid: z
      .strictObject({
        columns: z.strictObject({ mobile: int(1, 2), tablet: int(2, 4), desktop: int(3, 6) }),
        gapX: responsive(0, 24),
        gapY: responsive(0, 24),
      })
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.show.addToCart && !ADD_TO_CART_AVAILABLE) {
      ctx.addIssue({
        code: 'custom',
        path: ['show', 'addToCart'],
        message: 'Add to Cart is not available on product cards yet',
      });
    }
  });

export type ProductCardConfig = z.infer<typeof productCardConfigSchema>;
export type ProductCardConfigValidation = SettingValidation<ProductCardConfig>;

export function validateProductCardConfig(raw: unknown): ProductCardConfigValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'INVALID_CONFIG', message: 'Configuration must be a JSON object' };
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version !== PRODUCT_CARD_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      message: `Unsupported schemaVersion ${JSON.stringify(version ?? null)}; expected ${PRODUCT_CARD_SCHEMA_VERSION}`,
    };
  }
  const parsed = productCardConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'INVALID_CONFIG',
      message: 'Product card configuration is invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  return { ok: true, config: parsed.data };
}
