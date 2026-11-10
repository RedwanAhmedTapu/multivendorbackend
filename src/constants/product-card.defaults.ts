// src/constants/product-card.defaults.ts
//
// "FinixMart Default" product card = today's homepage card
// (multivendorsite components/product/productcard/ProductCard.tsx, grid view),
// with the two approved changes:
//   1. compact MOBILE spacing only — image box 176→150px, image-to-text gap
//      24→6px, horizontal text padding 16→8px (tablet/desktop unchanged);
//   2. ratings render only with real data (handled by the card itself).
// Measured from the current card:
//   image box h-44 (176px), object-contain, bg-gray-50; card border 1px
//   gray-200, rounded-lg (10px: --radius is 0.625rem), shadow-sm, hover shadow-lg; Card gap-6 (24px);
//   content px-4 py-1; title 14px, 2 lines, gray-800 — rendered semibold with
//   line-height 1.3 (globals.css h1–h6 rule wins over font-medium/leading-tight);
//   price text-xl (20px) bold (teal-600 when discounted); original price
//   text-sm (14px) gray-400; discount badge beside the price, rounded-md (8px = --radius − 2px).
// Colors are null = the built-in colors above.
import type { ProductCardConfig } from '../validators/product-card.validator.ts';
import { PRODUCT_CARD_SCHEMA_VERSION } from '../validators/product-card.validator.ts';

/** Fresh copy on every call — callers may mutate it safely. */
export function getDefaultProductCardConfig(): ProductCardConfig {
  return {
    schemaVersion: PRODUCT_CARD_SCHEMA_VERSION,
    preset: 'finixmartDefault',
    show: {
      image: true,
      title: true,
      price: true,
      originalPrice: true,
      discountBadge: true,
      rating: true,
      // today's card shows the average only, not "(n reviews)"
      reviewCount: false,
      storeName: true,
      verifiedBadge: true,
      freeShippingBadge: true,
      stockLabel: false,
      addToCart: false,
    },
    card: {
      background: null,
      borderColor: null,
      borderWidth: 1,
      radius: 10, // rounded-lg = var(--radius) = 0.625rem in this project
      shadow: 'sm',
      hoverShadow: 'lg',
      imageGap: { mobile: 6, tablet: 24, desktop: 24 },
      contentPaddingX: { mobile: 8, tablet: 16, desktop: 16 },
      contentPaddingY: 4,
      align: 'left',
    },
    image: {
      sizing: 'fixed',
      height: { mobile: 150, tablet: 176, desktop: 176 },
      fit: 'contain',
      padding: 0,
      background: null,
    },
    title: {
      size: { mobile: 14, tablet: 14, desktop: 14 },
      // globals.css h1–h6 rule (font-weight 600, line-height 1.3) overrides the
      // card's font-medium today, so the rendered title is semibold.
      weight: 'semibold',
      lines: 2,
      color: null,
    },
    price: {
      size: { mobile: 20, tablet: 20, desktop: 20 },
      weight: 'bold',
      color: null,
      originalSize: { mobile: 14, tablet: 14, desktop: 14 },
      originalColor: null,
    },
    discountBadge: {
      position: 'besidePrice',
      background: null,
      text: null,
      radius: 8,
    },
    addToCart: {
      variant: 'filled',
      size: 'sm',
      background: null,
      text: null,
      radius: 8,
    },
  };
}
