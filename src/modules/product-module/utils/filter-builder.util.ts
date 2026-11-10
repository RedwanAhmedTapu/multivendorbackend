// utils/filter-builder.util.ts
import type { AdminProductFilterInput, ProductFilterInput, VendorProductFilterInput } from "../validators/product.validator.ts";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Builds the Prisma `where` clause shared by public/vendor/admin listing +
 * filter endpoints. Role-specific extras (approvalStatus, vendorId,
 * isDeleted visibility, date ranges) are layered on by the caller.
 *
 * NOTE: a few filters (discount, brand-via-attribute, newArrival) still
 * can't be expressed cleanly as a single Prisma `where`, so they stay in
 * `postFilters` and are applied in-memory after the query — see
 * product-filter.service.ts.
 */
export function buildBaseWhere(filters: ProductFilterInput) {
  const where: any = {};
  const postFilters: {
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

  if (filters.inStock) {
    // stock is the denormalized grand-total column (indexed) — treats
    // "in stock" as physically-on-hand > 0. Reserved units (already held
    // by someone else's cart/order) still count as "in stock" here for
    // browsing purposes; the hard reservedQty/damagedQty-aware check
    // happens at add-to-cart/checkout time against live WarehouseStock.
    variantConditions.push({ stock: { gt: 0 } });
  }
  if (filters.outOfStock) {
    variantConditions.push({ stock: { lte: 0 } });
  }

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

  // ==========================================================================
  // PRODUCT-LEVEL (spec) ATTRIBUTES — RAM, Processor, Material, ইত্যাদি।
  //
  // ⚠️ FIX (was broken): আগে এটা ভুলভাবে `variants.attributes` relation-এ
  // filter করত, যেটা আসলে color/size-এর জন্য variant-scoped relation
  // (উপরে `variantConditions` ব্লকে যেটা ব্যবহার হয়েছে)। কিন্তু sidebar-এ
  // দেখানো attribute values আসে `categoryFilterService.ts` থেকে, যেটা
  // `prisma.productAttribute` (Product-scoped, variant না) থেকে id বানায়।
  // ফলে filter apply করার সময় সেই id কখনোই variant-attributes টেবিলে
  // পাওয়া যেত না -> where clause সবসময় zero rows রিটার্ন করত।
  //
  // এখন সরাসরি Product -> ProductAttribute relation-এ filter করা হচ্ছে,
  // আর attribute-এর type (SELECT/TEXT/NUMBER/BOOLEAN) অনুযায়ী সঠিক column-এ
  // ম্যাচ করা হচ্ছে, কারণ শুধু SELECT-এর id-ই আসল AttributeValue.id —
  // TEXT/NUMBER/BOOLEAN-এর "id" আসলে raw value/stringified value
  // (দেখো categoryFilterService.getFilterableAttributes)।
  //
  // ⚠️ IMPORTANT: এই `attributes` relation নামটা তোমার Prisma schema-তে
  // Product -> ProductAttribute reverse relation-এর নামের সাথে মিলিয়ে
  // নাও (যদি schema-তে অন্য নাম থাকে, যেমন `productAttributes`, তাহলে
  // এখানে সেটাই বসাও)।
  // ==========================================================================
  if (filters.attributes && Object.keys(filters.attributes).length) {
    const attributeConditions = Object.entries(filters.attributes)
      .filter(([, values]) => Array.isArray(values) && values.length > 0)
      .map(([attributeId, valueIds]) => {
        const numericValues = valueIds.map((v) => Number(v)).filter((n) => !isNaN(n));
        const booleanValues = valueIds.filter((v) => v === "true" || v === "false").map((v) => v === "true");

        return {
          attributes: {
            some: {
              attributeId,
              OR: [
                // SELECT — real AttributeValue.id
                { attributeValueId: { in: valueIds } },
                // TEXT — raw string value, case-insensitive
                { valueString: { in: valueIds, mode: "insensitive" as const } },
                // NUMBER — numeric-parseable values only
                ...(numericValues.length ? [{ valueNumber: { in: numericValues } }] : []),
                // BOOLEAN — "true"/"false" strings only
                ...(booleanValues.length ? [{ valueBoolean: { in: booleanValues } }] : []),
              ],
            },
          },
        };
      });
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

  // avgRating is now a real denormalized column on Product, so this can be
  // a proper DB-level where clause instead of an in-memory postFilter.
  if (filters.minRating !== undefined) where.avgRating = { gte: filters.minRating };
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
    case "rating_asc":
      return { avgRating: "asc" as const };
    case "rating_desc":
    case "top_rated":
      return { avgRating: "desc" as const };
    // price_asc / price_desc / highest_discount still need a variant-level
    // orderBy (price lives on ProductVariant, not Product), so those stay
    // in-memory — handled by the caller via priceAwareOrderBy().
    case "newest":
    default:
      return { createdAt: "desc" as const };
  }
}

export function applyPostFilters<T extends { createdAt?: Date; variants?: any[] }>(
  items: T[],
  postFilters: ReturnType<typeof buildBaseWhere>["postFilters"]
): T[] {
  let result = items;

  // minRating is applied as a DB-level `where.avgRating` clause in
  // buildBaseWhere now (avgRating is a real column), so nothing to do here
  // for it anymore — no in-memory filtering needed.

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

/** Public listing only ever sees approved, non-deleted products of an
 *  ACTIVE vendor (a SUSPENDED / DEACTIVATED / PENDING vendor's products are
 *  not public). Merges into an existing `where.vendor` filter. */
export function applyPublicVisibility(where: any) {
  where.approvalStatus = "ACTIVE";
  where.isDeleted = false;
  where.vendor = { ...(where.vendor ?? {}), ...PUBLIC_VENDOR_WHERE };
  return where;
}

/** Vendor condition for every public product read (Prisma relation filter). */
export const PUBLIC_VENDOR_WHERE = { status: "ACTIVE" } as const;

/** The same vendor condition for raw SQL over `products p` (constant SQL —
 *  no user input, so it is safe to interpolate). */
export const PUBLIC_VENDOR_SQL = `AND EXISTS (SELECT 1 FROM vendors v WHERE v.id = p."vendorId" AND v.status = 'ACTIVE')`;

/** Base `where` for a public product read: `extra` plus approved,
 *  non-deleted and ACTIVE vendor. */
export function publicProductWhere(extra: Record<string, any> = {}) {
  return applyPublicVisibility({ ...extra });
}

/** True when a product record (with `vendor.status` loaded) is public. */
export function isPublicProduct(product: any): boolean {
  return !!product && product.approvalStatus === "ACTIVE" && !product.isDeleted && product.vendor?.status === "ACTIVE";
}