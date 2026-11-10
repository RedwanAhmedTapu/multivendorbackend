// src/constants/homepage-config.defaults.ts
//
// Built-in homepage configuration. It mirrors the CURRENT homepage exactly
// (multivendorsite components/layout/LayoutProvider.tsx + ProductGrid.tsx):
//   - same section order per layout;
//   - product sections: Flash Sale, Featured Products, New Arrivals — 12 items,
//     grid-cols-2 / md:grid-cols-5 / lg:grid-cols-6, "See All" link;
//   - Trending / Discounted are fetched today but not rendered → disabled here;
//     Best Selling (GET /products/best-selling) exists but isn't used → disabled;
//   - Footer is the last section of every layout (rendered on the homepage only);
//   - layout_3's category grid is hidden below md by the component itself
//     (CategoryLayout_3: `hidden md:flex`), so its mobile visibility is false;
//   - no appearance overrides → every component keeps its current styling;
//   - product card design is a separate global setting (product-card.defaults.ts).
import type { HomepageConfig, HomepageSection } from '../validators/homepage-config.validator.ts';
import { HOMEPAGE_CONFIG_SCHEMA_VERSION } from '../validators/homepage-config.validator.ts';

const ALL = { mobile: true, tablet: true, desktop: true };
const CURRENT_COLUMNS = { mobile: 2, tablet: 5, desktop: 6 };

const productSections = (): HomepageSection[] => [
  {
    id: 'products-flash-sale',
    type: 'productCollection',
    enabled: true,
    visibility: { ...ALL },
    settings: { source: 'flashSale', title: 'Flash Sale', limit: 12, columns: { ...CURRENT_COLUMNS }, showSeeAll: true },
  },
  {
    id: 'products-featured',
    type: 'productCollection',
    enabled: true,
    visibility: { ...ALL },
    settings: { source: 'featured', title: 'Featured Products', limit: 12, columns: { ...CURRENT_COLUMNS }, showSeeAll: true },
  },
  {
    id: 'products-new-arrivals',
    type: 'productCollection',
    enabled: true,
    visibility: { ...ALL },
    settings: { source: 'newArrivals', title: 'New Arrivals', limit: 12, columns: { ...CURRENT_COLUMNS }, showSeeAll: true },
  },
  {
    id: 'products-trending',
    type: 'productCollection',
    enabled: false,
    visibility: { ...ALL },
    settings: { source: 'trending', title: 'Trending Now', limit: 12, columns: { ...CURRENT_COLUMNS }, showSeeAll: true },
  },
  {
    id: 'products-best-selling',
    type: 'productCollection',
    enabled: false,
    visibility: { ...ALL },
    settings: { source: 'bestSelling', title: 'Best Selling', limit: 12, columns: { ...CURRENT_COLUMNS }, showSeeAll: true },
  },
  {
    id: 'products-discounted',
    type: 'productCollection',
    enabled: false,
    visibility: { ...ALL },
    settings: { source: 'discounted', title: 'Discounted Products', limit: 12, columns: { ...CURRENT_COLUMNS }, showSeeAll: true },
  },
];

const hero = (): HomepageSection => ({ id: 'hero', type: 'hero', enabled: true, visibility: { ...ALL } });
const benefits = (): HomepageSection => ({ id: 'benefits', type: 'benefits', enabled: true, visibility: { ...ALL } });
const footer = (): HomepageSection => ({ id: 'footer', type: 'footer', enabled: true, visibility: { ...ALL } });
const categoryCircles = (): HomepageSection => ({
  id: 'category-circles',
  type: 'categoryCircles',
  enabled: true,
  visibility: { ...ALL },
});

/** Returns a fresh copy every call — callers may mutate it safely. */
export function getDefaultHomepageConfig(): HomepageConfig {
  return {
    schemaVersion: HOMEPAGE_CONFIG_SCHEMA_VERSION,
    layouts: {
      // Layout 1 (default): Hero → Benefits → Categories → Products
      layout_1: { sections: [hero(), benefits(), categoryCircles(), ...productSections(), footer()] },
      // Layout 2: Horizontal category nav → Hero → Benefits → Categories → Products
      layout_2: {
        sections: [
          { id: 'horizontal-category-nav', type: 'horizontalCategoryNav', enabled: true, visibility: { ...ALL } },
          hero(),
          benefits(),
          categoryCircles(),
          ...productSections(),
          footer(),
        ],
      },
      // Layout 3: Category grid (replaces hero) → Benefits → Categories → Products
      layout_3: {
        sections: [
          {
            id: 'category-grid',
            type: 'categoryGrid',
            enabled: true,
            visibility: { mobile: false, tablet: true, desktop: true },
          },
          benefits(),
          categoryCircles(),
          ...productSections(),
          footer(),
        ],
      },
    },
    theme: { preset: 'finixmartDefault' },
  };
}
