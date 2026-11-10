// services/product/product-filter.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { ProductRepository, cardInclude } from "../../repositories/product.repository.ts";
import {
  buildBaseWhere,
  buildSortOrderBy,
  applyPostFilters,
  applyAdminFilters,
  applyVendorFilters,
  applyPublicVisibility,
  publicProductWhere,
} from "../../utils/filter-builder.util.ts";
import { buildOffsetArgs, paginateOffsetResult, buildCursorArgs, paginateCursorResult } from "../../utils/pagination.ts";
import type { AdminProductFilterInput, ProductFilterInput, VendorProductFilterInput } from "../../validators/product.validator.ts";
import { cacheGet, cacheSet, cacheKeys, hashFilters } from "../../../../config/cache.ts";

const NEW_ARRIVAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// A categoryId that can never match a real row — used when a given
// categorySlug doesn't resolve to any category, so we return an empty
// result set instead of throwing or silently ignoring the filter.
const NO_MATCH_CATEGORY_ID = "__no_match__";

function priceAwareOrderBy(sortBy?: ProductFilterInput["sortBy"]) {
  // Price/rating/discount sorts need the variant relation ordered, which
  // Prisma supports via a nested orderBy on a to-many relation only for
  // aggregate functions — so we sort in application code for these cases
  // after fetching a slightly larger page. Everything else uses a DB-level
  // orderBy from buildSortOrderBy().
  // price_asc/price_desc/highest_discount need a variant-level value not
  // expressible as a simple Prisma orderBy, so those still go through the
  // over-fetch + in-memory sort path. rating_* now sorts at the DB level
  // (avgRating is a real column) via buildSortOrderBy(), so it's excluded here.
  return ["price_asc", "price_desc", "highest_discount"].includes(sortBy || "");
}

function applyInMemorySort<T extends { variants: any[]; avgRating?: number }>(
  items: T[],
  sortBy?: ProductFilterInput["sortBy"]
): T[] {
  // avgRating is a denormalized column on Product (kept in sync by
  // ProductRatingService), not computed from a fetched reviews list —
  // cardInclude no longer pulls the reviews relation at all.
  const avgRating = (p: T) => p.avgRating ?? 0;
  const bestDiscount = (p: T) => Math.max(0, ...p.variants.map((v: any) => v.discount || 0), 0);
  const lowestPrice = (p: T) => Math.min(...p.variants.map((v: any) => Number(v.specialPrice ?? v.price ?? Infinity)));

  switch (sortBy) {
    case "price_asc":
      return [...items].sort((a, b) => lowestPrice(a) - lowestPrice(b));
    case "price_desc":
      return [...items].sort((a, b) => lowestPrice(b) - lowestPrice(a));
    case "rating_asc":
      return [...items].sort((a, b) => avgRating(a) - avgRating(b));
    case "rating_desc":
    case "top_rated":
      return [...items].sort((a, b) => avgRating(b) - avgRating(a));
    case "highest_discount":
      return [...items].sort((a, b) => bestDiscount(b) - bestDiscount(a));
    default:
      return items;
  }
}

// ==================== Category tree helpers ====================

type CategoryNode = { id: string; slug: string; parentId: string | null };

const CATEGORY_TREE_CACHE_KEY = "category:tree:all";
const CATEGORY_TREE_TTL = 3600; // 1 hour — category structure rarely changes

/**
 * Fetches the entire category tree in flat form (id, slug, parentId only)
 * and caches it for an hour. Cheap query — categories tables are small —
 * and caching means almost every request skips the DB round trip entirely.
 */
async function getAllCategoriesFlat(): Promise<CategoryNode[]> {
  const cached = await cacheGet<CategoryNode[]>(CATEGORY_TREE_CACHE_KEY);
  if (cached) return cached;

  const categories = await prisma.category.findMany({
    select: { id: true, slug: true, parentId: true },
  });

  await cacheSet(CATEGORY_TREE_CACHE_KEY, categories, CATEGORY_TREE_TTL);
  return categories;
}

/**
 * Given a root category id, returns that id plus every descendant id
 * (children, grandchildren, ...). If rootId is a leaf, only itself is
 * returned. Pure in-memory BFS over the already-fetched flat list — no
 * extra DB round trips, so this stays fast even with a large tree.
 */
function collectDescendantIds(rootId: string, allCategories: CategoryNode[]): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const cat of allCategories) {
    if (!cat.parentId) continue;
    const list = childrenByParent.get(cat.parentId) || [];
    list.push(cat.id);
    childrenByParent.set(cat.parentId, list);
  }

  const result: string[] = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift()!;
    const children = childrenByParent.get(current) || [];
    for (const childId of children) {
      result.push(childId);
      queue.push(childId);
    }
  }
  return result;
}

/**
 * Resolves a categorySlug to [that category's id, ...all descendant ids].
 * Products are created against leaf categories, while a shopper filtering
 * by a parent/mid-level slug expects to see everything underneath it too —
 * so this always expands to the full subtree, not just the matched id.
 * No match -> a sentinel id that guarantees zero rows.
 */
async function resolveCategorySlugToIds(slug: string): Promise<string[]> {
  const allCategories = await getAllCategoriesFlat();
  const root = allCategories.find((c) => c.slug === slug);
  if (!root) return [NO_MATCH_CATEGORY_ID];
  return collectDescendantIds(root.id, allCategories);
}

/**
 * Resolves `categorySlug` -> `categoryIds` (the slug's own id plus every
 * descendant id) on the filters object.
 * - If `categoryId` or `categoryIds` is already present, it wins and
 *   `categorySlug` is ignored (kept for backwards-compat with existing
 *   id-based callers).
 * - If only `categorySlug` is present, resolve the whole subtree so
 *   products assigned to a leaf category show up under a parent filter.
 */
async function resolveCategorySlugToId<
  T extends { categoryId?: string; categoryIds?: string[]; categorySlug?: string }
>(filters: T): Promise<T> {
  if (filters.categoryId || filters.categoryIds?.length || !filters.categorySlug) {
    return filters;
  }

  const categoryIds = await resolveCategorySlugToIds(filters.categorySlug);
  return { ...filters, categoryIds };
}

/**
 * Call this whenever a category is created, updated, or deleted so the
 * cached tree doesn't go stale until CATEGORY_TREE_TTL expires on its own.
 */
export async function invalidateCategoryTreeCache() {
  await cacheSet(CATEGORY_TREE_CACHE_KEY, null, 1);
}

export const ProductFilterService = {
  /**
   * PUBLIC listing / filter — cursor-paginated, approved+non-deleted only.
   * Accepts either `categoryId`/`categoryIds` (exact ids) or `categorySlug`
   * (resolved to the full subtree above); explicit ids win if present.
   */
  async filterForPublic(filters: ProductFilterInput) {
    filters = await resolveCategorySlugToId(filters);

    const cacheKey = cacheKeys.productListing(hashFilters(filters as any));
    const cached = await cacheGet<any>(cacheKey);
    if (cached) return cached;

    const { where, postFilters } = buildBaseWhere(filters);
    applyPublicVisibility(where);
    const needsMemorySort = priceAwareOrderBy(filters.sortBy);
    const { take } = buildCursorArgs({ cursor: filters.cursor, limit: filters.limit });

    const rows = await prisma.product.findMany({
      where,
      include: cardInclude,
      orderBy: needsMemorySort ? { createdAt: "desc" } : buildSortOrderBy(filters.sortBy),
      take: needsMemorySort ? take + 40 : take, // over-fetch a bit so in-memory sort has enough to work with
    });

    let filtered = applyPostFilters(rows as any, postFilters);
    if (needsMemorySort) filtered = applyInMemorySort(filtered as any, filters.sortBy);

    const result = paginateCursorResult(filtered as any, take - 1);
    await cacheSet(cacheKey, result, 60);
    return result;
  },

  /**
   * VENDOR listing — offset-paginated (dashboards want total page counts),
   * scoped to the vendor's own products, excludes soft-deleted.
   * Also accepts `categoryId`/`categoryIds` or `categorySlug`.
   */
 async filterForVendor(vendorId: string, filters: VendorProductFilterInput) {
  filters = await resolveCategorySlugToId(filters as any);

  let { where, postFilters } = buildBaseWhere(filters);
  where = applyVendorFilters(where, vendorId, filters);

  if (filters.lowStock) {
    const lowStockVariantIds = await ProductRepository.findLowStockVariantIds(vendorId);
    where.variants = { some: { id: { in: lowStockVariantIds } } };
  }

  const { page, limit, skip, take } = buildOffsetArgs(filters);
  const total = await ProductRepository.countByWhere(where);

  const needsMemorySort = priceAwareOrderBy(filters.sortBy);
  // FIX: findCardsByWhere -> findManagementCardsByWhere so this dashboard
  // gets variant.name/images/availability/attributes.
  const rows = await ProductRepository.findManagementCardsByWhere(where, {
    orderBy: needsMemorySort ? { createdAt: "desc" } : buildSortOrderBy(filters.sortBy),
    skip: needsMemorySort ? 0 : skip,
    take: needsMemorySort ? skip + take + 40 : take,
  });

  let filtered = applyPostFilters(rows as any, postFilters);
  if (needsMemorySort) filtered = applyInMemorySort(filtered as any, filters.sortBy).slice(skip, skip + take);

  return { items: filtered, pagination: paginateOffsetResult(total, page, limit) };
},

  /**
   * ADMIN listing — offset-paginated, sees all statuses (optionally
   * including soft-deleted for the trash view).
   * Also accepts `categoryId`/`categoryIds` or `categorySlug`.
   */
  async filterForAdmin(filters: AdminProductFilterInput) {
    filters = await resolveCategorySlugToId(filters as any);

    let { where, postFilters } = buildBaseWhere(filters);
    where = applyAdminFilters(where, filters);

    const { page, limit, skip, take } = buildOffsetArgs(filters);
    const total = await ProductRepository.countByWhere(where);

    const needsMemorySort = priceAwareOrderBy(filters.sortBy);
    const rows = await ProductRepository.findCardsByWhere(where, {
      orderBy: needsMemorySort ? { createdAt: "desc" } : buildSortOrderBy(filters.sortBy),
      skip: needsMemorySort ? 0 : skip,
      take: needsMemorySort ? skip + take + 40 : take,
    });

    let filtered = applyPostFilters(rows as any, postFilters);
    if (needsMemorySort) filtered = applyInMemorySort(filtered as any, filters.sortBy).slice(skip, skip + take);

    return { items: filtered, pagination: paginateOffsetResult(total, page, limit) };
  },

  // ==================== Discovery endpoints ====================

  async featured(limit = 10) {
    const cacheKey = cacheKeys.featured(limit);
    const cached = await cacheGet<any[]>(cacheKey);
    if (cached) return cached;

    const items = await ProductRepository.findCardsByWhere(
      publicProductWhere({ isFeatured: true }),
      { orderBy: { createdAt: "desc" }, take: limit }
    );
    await cacheSet(cacheKey, items, 300);
    return items;
  },

  async newArrivals(limit = 10) {
    const cacheKey = cacheKeys.newArrivals(limit);
    const cached = await cacheGet<any[]>(cacheKey);
    if (cached) return cached;

    const items = await ProductRepository.findCardsByWhere(
      publicProductWhere({
        createdAt: { gte: new Date(Date.now() - NEW_ARRIVAL_WINDOW_MS) },
      }),
      { orderBy: { createdAt: "desc" }, take: limit }
    );
    await cacheSet(cacheKey, items, 300);
    return items;
  },

  /**
   * Trending = weighted mix of recent views, sales, and wishlist adds.
   * Uses the denormalized counters (viewCount/salesCount/wishlistCount)
   * rather than scanning event logs, so this stays cheap at read time —
   * those counters are incremented by their respective write paths
   * (view tracking, order completion, wishlist add).
   */
  async trending(limit = 10) {
    const cacheKey = cacheKeys.trending(limit);
    const cached = await cacheGet<any[]>(cacheKey);
    if (cached) return cached;

    const rows = await prisma.product.findMany({
      where: publicProductWhere(),
      include: cardInclude,
      take: limit * 3,
      orderBy: { updatedAt: "desc" },
    });

    const scored = rows
      .map((p: any) => ({
        ...p,
        trendScore: p.viewCount * 1 + p.salesCount * 5 + p.wishlistCount * 2,
      }))
      .sort((a, b) => b.trendScore - a.trendScore)
      .slice(0, limit);

    await cacheSet(cacheKey, scored, 180);
    return scored;
  },

  async bestSelling(limit = 10) {
    const cacheKey = cacheKeys.bestSelling(limit);
    const cached = await cacheGet<any[]>(cacheKey);
    if (cached) return cached;

    const items = await ProductRepository.findCardsByWhere(
      publicProductWhere({ salesCount: { gt: 0 } }),
      { orderBy: { salesCount: "desc" }, take: limit }
    );
    await cacheSet(cacheKey, items, 300);
    return items;
  },

  async flashSale(limit = 20) {
    const now = new Date();
    return prisma.product.findMany({
      where: publicProductWhere({
        offerProducts: {
          some: {
            offer: {
              type: "FLASH_SALE" as any,
              isActive: true,
              status: "ACTIVE",
              validFrom: { lte: now },
              OR: [{ validTo: { gte: now } }, { validTo: null }],
            },
          },
        },
      }),
      include: cardInclude,
      take: limit,
    });
  },

  async discounted(limit = 20) {
    const rows = await prisma.product.findMany({
      where: publicProductWhere(),
      include: cardInclude,
      take: limit * 3,
      orderBy: { createdAt: "desc" },
    });
    return rows
      .filter((p: any) => p.variants.some((v: any) => v.discount && v.discount > 0))
      .sort(
        (a: any, b: any) =>
          Math.max(...b.variants.map((v: any) => v.discount || 0)) -
          Math.max(...a.variants.map((v: any) => v.discount || 0))
      )
      .slice(0, limit);
  },

  /**
   * Same category or brand — excludes the current product. Only ACTIVE,
   * non-deleted products. (Product has no `tags` column — selecting/filtering
   * on it made Prisma throw for every request, so the endpoint always failed.)
   */
  async related(productId: string, limit = 10) {
    const cacheKey = cacheKeys.related(productId);
    const cached = await cacheGet<any[]>(cacheKey);
    if (cached) return cached;

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { categoryId: true, brandId: true },
    });
    if (!product) return [];

    const items = await prisma.product.findMany({
      where: publicProductWhere({
        id: { not: productId },
        OR: [
          { categoryId: product.categoryId },
          ...(product.brandId ? [{ brandId: product.brandId }] : []),
        ],
      }),
      include: cardInclude,
      take: limit,
      orderBy: { createdAt: "desc" },
    });

    await cacheSet(cacheKey, items, 600);
    return items;
  },

  /** Recommendation-lite: related() plus a popularity tiebreaker. */
  async similar(productId: string, limit = 10) {
    const related = await this.related(productId, limit * 2);
    return (related as any[])
      .sort((a, b) => b.viewCount + b.salesCount * 3 - (a.viewCount + a.salesCount * 3))
      .slice(0, limit);
  },

  async recentlyViewed(userId: string, limit = 10) {
    // Visibility (approved, non-deleted, ACTIVE vendor) is applied in the
    // query, so `take` counts only products the viewer may still see.
    const rows = await prisma.recentlyViewedProduct.findMany({
      where: { userId, product: publicProductWhere() },
      orderBy: { viewedAt: "desc" },
      take: limit,
      include: { product: { include: cardInclude } },
    });
    return rows.map((r) => r.product);
  },

  async trackRecentlyViewed(userId: string, productId: string) {
    await prisma.recentlyViewedProduct.upsert({
      where: { userId_productId: { userId, productId } },
      update: { viewedAt: new Date() },
      create: { userId, productId },
    });
    await ProductRepository.incrementViewCount(productId);
  },
};