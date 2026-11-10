// utils/filter-builder.util.ts
import type { AdminProductFilterInput, ProductFilterInput, VendorProductFilterInput } from "../../product-module/validators/product.validator.ts";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Builds the Prisma `where` clause shared by public/vendor/admin listing +
 * filter endpoints. Role-specific extras (approvalStatus, vendorId,
 * isDeleted visibility, date ranges) are layered on by the caller.
 *
 * NOTE: a few filters (rating, discount, brand-via-attribute, newArrival)
 * can't be expressed cleanly as a single Prisma `where` without denormalized
 * columns, so they are flagged in the returned `postFilters` object and
 * applied in-memory after the query — see product-filter.service.ts.
 */
export function buildBaseWhere(filters: ProductFilterInput) {
  const where: any = {};
  const postFilters: {
    minRating?: number;
    onSale?: boolean;
    newArrival?: boolean;
    hasDiscount?: boolean;
  } = {};

  const categoryIds = filters.categoryIds?.length
    ? filters.categoryIds
    : filters.categoryId
    ? [filters.categoryId]
    : filters.subCategoryId
    ? [filters.subCategoryId]
    : undefined;
  if (categoryIds) where.categoryId = { in: categoryIds };

  const brandIds = filters.brandIds?.length ? filters.brandIds : filters.brandId ? [filters.brandId] : undefined;
  if (brandIds) where.brandId = { in: brandIds };

  const searchTerm = filters.search || filters.keyword;
  if (searchTerm) {
    where.OR = [
      { name: { contains: searchTerm, mode: "insensitive" } },
      { nameBn: { contains: searchTerm, mode: "insensitive" } },
      { description: { contains: searchTerm, mode: "insensitive" } },
    ];
  }

  if (filters.tags?.length) {
    // Assumes a `tags String[]` scalar list on Product; adjust if tags are
    // modeled as a relation instead.
    where.tags = { hasSome: filters.tags };
  }

  const variantConditions: any[] = [];

  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    const priceCondition: any = {};
    if (filters.minPrice !== undefined) priceCondition.gte = filters.minPrice;
    if (filters.maxPrice !== undefined) priceCondition.lte = filters.maxPrice;
    variantConditions.push({ price: priceCondition });
  }

  if (filters.inStock) variantConditions.push({ warehouseStock: { some: { quantity: { gt: 0 } } } });
  if (filters.outOfStock) variantConditions.push({ warehouseStock: { every: { quantity: { lte: 0 } } } });

  if (filters.sku) variantConditions.push({ sku: { contains: filters.sku, mode: "insensitive" } });

  if (filters.color?.length || filters.size?.length) {
    const values = [...(filters.color || []), ...(filters.size || [])];
    variantConditions.push({
      attributes: { some: { attributeValue: { value: { in: values } } } },
    });
  }

  if (variantConditions.length) {
    where.variants = { some: { AND: variantConditions } };
  }

  if (filters.attributes && Object.keys(filters.attributes).length) {
    const attributeConditions = Object.entries(filters.attributes)
      .filter(([, values]) => Array.isArray(values) && values.length > 0)
      .map(([attributeId, valueIds]) => ({
        variants: { some: { attributes: { some: { attributeValueId: { in: valueIds } } } } },
      }));
    if (attributeConditions.length) where.AND = [...(where.AND || []), ...attributeConditions];
  }

  if (filters.freeShipping) {
    where.offerProducts = {
      some: {
        offer: {
          type: "FREE_SHIPPING",
          isActive: true,
          status: "ACTIVE",
          validFrom: { lte: new Date() },
          OR: [{ validTo: { gte: new Date() } }, { validTo: null }],
        },
      },
    };
  }

  if (filters.featured) where.isFeatured = true;
  if (filters.warehouseId) {
    where.variants = {
      ...(where.variants || {}),
      some: { ...(where.variants?.some || {}), warehouseStock: { some: { warehouseId: filters.warehouseId } } },
    };
  }

  if (filters.minRating !== undefined) postFilters.minRating = filters.minRating;
  if (filters.onSale) postFilters.onSale = true;
  if (filters.newArrival) postFilters.newArrival = true;
  if (filters.hasDiscount) postFilters.hasDiscount = true;

  return { where, postFilters };
}

export function buildSortOrderBy(sortBy?: ProductFilterInput["sortBy"]) {
  switch (sortBy) {
    case "oldest":
      return { createdAt: "asc" as const };
    case "recently_updated":
      return { updatedAt: "desc" as const };
    case "most_viewed":
      return { viewCount: "desc" as const };
    case "best_selling":
      return { salesCount: "desc" as const };
    case "trending":
      // trending = weighted mix of views/sales/wishlist — computed in
      // product-filter.service.ts via a raw query; falls back to viewCount.
      return { viewCount: "desc" as const };
    case "popularity":
      return { wishlistCount: "desc" as const };
    // price_asc / price_desc / rating_* / top_rated / highest_discount need
    // either a variant-level orderBy or in-memory sort — handled by caller.
    case "newest":
    default:
      return { createdAt: "desc" as const };
  }
}

export function applyPostFilters<T extends { reviews?: { rating: number }[]; createdAt?: Date; variants?: any[] }>(
  items: T[],
  postFilters: ReturnType<typeof buildBaseWhere>["postFilters"]
): T[] {
  let result = items;

  if (postFilters.minRating !== undefined) {
    result = result.filter((p) => {
      const reviews = p.reviews || [];
      const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
      return avg >= postFilters.minRating!;
    });
  }

  if (postFilters.newArrival) {
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    result = result.filter((p) => (p.createdAt ? p.createdAt.getTime() >= cutoff : false));
  }

  if (postFilters.onSale || postFilters.hasDiscount) {
    result = result.filter((p) => (p.variants || []).some((v: any) => v.specialPrice && v.specialPrice < v.price));
  }

  return result;
}

/** Layers admin-only filters onto a base where clause. */
export function applyAdminFilters(where: any, filters: AdminProductFilterInput) {
  if (!filters.includeDeleted) where.isDeleted = false;
  if (filters.approvalStatus) where.approvalStatus = filters.approvalStatus;
  if (filters.vendorId) where.vendorId = filters.vendorId;
  if (filters.vendorName) where.vendor = { storeName: { contains: filters.vendorName, mode: "insensitive" } };
  if (filters.taxRateMin !== undefined || filters.taxRateMax !== undefined) {
    where.variants = {
      ...(where.variants || {}),
      some: {
        ...(where.variants?.some || {}),
        taxRate: {
          ...(filters.taxRateMin !== undefined ? { gte: filters.taxRateMin } : {}),
          ...(filters.taxRateMax !== undefined ? { lte: filters.taxRateMax } : {}),
        },
      },
    };
  }
  if (filters.createdFrom || filters.createdTo) {
    where.createdAt = {
      ...(filters.createdFrom ? { gte: filters.createdFrom } : {}),
      ...(filters.createdTo ? { lte: filters.createdTo } : {}),
    };
  }
  if (filters.updatedFrom || filters.updatedTo) {
    where.updatedAt = {
      ...(filters.updatedFrom ? { gte: filters.updatedFrom } : {}),
      ...(filters.updatedTo ? { lte: filters.updatedTo } : {}),
    };
  }
  return where;
}

/** Layers vendor-only filters (scoped to their own products) onto a base where clause. */
export function applyVendorFilters(where: any, vendorId: string, filters: VendorProductFilterInput) {
  where.vendorId = vendorId;
  where.isDeleted = false;
  if (filters.approvalStatus) where.approvalStatus = filters.approvalStatus;
  if (filters.lowStock) {
    where.variants = {
      ...(where.variants || {}),
      some: {
        ...(where.variants?.some || {}),
        AND: [
          ...(where.variants?.some?.AND || []),
          { warehouseStock: { some: {} } },
        ],
      },
    };
    // Precise "quantity <= reorderLevel" comparison needs a raw query since
    // Prisma can't compare two columns on the same row directly — see
    // ProductRepository.findLowStockVariantIds().
  }
  return where;
}

/** Public listing only ever sees approved, non-deleted products. */
export function applyPublicVisibility(where: any) {
  where.approvalStatus = "ACTIVE";
  where.isDeleted = false;
  return where;
}