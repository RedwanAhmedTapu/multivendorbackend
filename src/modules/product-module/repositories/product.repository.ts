// repositories/product.repository.ts
import { prisma } from "../../../config/prisma.ts";
import { Prisma } from "@prisma/client";
import { publishedReviewFilter } from "../services/product/review-moderation.scope.ts";
import { cacheGet, cacheSet } from "../../../config/cache.ts";

/**
 * Centralized `select`/`include` shapes so every service reuses the exact
 * same Prisma query shape instead of hand-rolling includes (source of N+1
 * bugs and inconsistent payloads across roles).
 */

export const cardInclude = {
  vendor: {
    select: {
      id: true,
      storeName: true,
      avatar: true,
      verificationStatus: true,
    },
  },
  category: { select: { id: true, name: true, slug: true } },
  images: {
    orderBy: { sortOrder: "asc" as const },
    take: 1,
    select: { url: true, altText: true },
  },
  variants: {
    orderBy: { price: "asc" as const },
    select: {
      id: true,
      price: true,
      specialPrice: true,
      discount: true,
      sku: true,
      taxRate: true,
      stock: true,
      reservedQty: true,
      damagedQty: true,
    },
  },
  // avgRating / reviewCount are plain scalar columns on Product (denormalized
  // by ProductRatingService), so they come back automatically with this
  // `include` — no need to pull the reviews relation just for a star rating.
} satisfies Record<string, any>;

// FIX: management-grade include for vendor/admin DASHBOARD LISTS
// (VendorProductController.getMyProducts / AdminProductController.getAll,
// via ProductFilterService.filterForVendor/filterForAdmin).
//
// Sits between cardInclude and detailInclude:
//  - richer than cardInclude: brings back variant.name, variant.images,
//    variant.availability, and variant.attributes (needed to render the
//    expandable variant rows + edit-price modal on the management table),
//    plus a lightweight warehouseStock pull for ProductPickerModal's
//    per-warehouse filter/chips.
//  - lighter than detailInclude: skips reviews/seo/warranty/approvedBy,
//    and the warehouseStock here is id/quantity/rackId only (no nested
//    warehouse relation) — none of that renders in a list row, and
//    pulling it for every row of a paginated list would be wasteful.
//
// IMPORTANT: WarehouseStock's unique key is
// [variantId, warehouseId, rackId, rowNumber, shelfNumber] — the SAME
// warehouseId can appear on multiple rows here (one per rack/shelf). This
// raw include intentionally returns all of them; findManagementCardsByWhere
// below collapses them into one total-per-warehouse entry before returning,
// so no caller (ProductPickerModal etc.) has to remember to do that
// aggregation itself and risk silently dropping rack-split stock.
//
// Safe to keep this heavier than cardInclude because every caller of
// findManagementCardsByWhere is either vendor-scoped (WHERE vendorId = ?)
// or admin-scoped+paginated — never the high-traffic public listing path,
// which continues to use cardInclude untouched.
export const managementInclude = {
  vendor: {
    select: {
      id: true,
      storeName: true,
      avatar: true,
      verificationStatus: true,
    },
  },
  category: { select: { id: true, name: true, slug: true } },
  images: {
    orderBy: { sortOrder: "asc" as const },
    select: { url: true, altText: true },
  },
  variants: {
    orderBy: { price: "asc" as const },
    include: {
      images: {
        orderBy: { sortOrder: "asc" as const },
        select: { url: true, altText: true },
      },
      attributes: {
        include: { attributeValue: { include: { attribute: true } } },
      },
      // NOTE: raw per-rack rows — collapsed to per-warehouse totals by
      // collapseWarehouseStock() in findManagementCardsByWhere below.
      warehouseStock: {
        select: { warehouseId: true, quantity: true, rackId: true },
      },
    },
  },
} satisfies Record<string, any>;

export const detailInclude = {
  vendor: {
    select: {
      id: true,
      storeName: true,
      avatar: true,
      status: true,
      verificationStatus: true,
    },
  },
  category: {
    select: { id: true, name: true, slug: true, image: true },
  },
  brand: { select: { id: true, name: true } },
  images: { orderBy: { sortOrder: "asc" as const } },
  variants: {
    include: {
      images: { orderBy: { sortOrder: "asc" as const } },
      attributes: {
        include: { attributeValue: { include: { attribute: true } } },
      },
     
    },
  },
  attributes: {
    where: { isForVariant: false },
    include: { attribute: true, attributeValue: true },
  },
  warranty: true,
  seo: true,
  reviews: {
    // Hidden reviews never reach the customer's product page. While the
    // readiness switch is off this is `{}` — the same query as before.
    where: publishedReviewFilter(),
    include: { user: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" as const },
    take: 10,
  },
  approvedBy: { select: { id: true, name: true } },
} satisfies Record<string, any>;

// FIX: collapses raw per-rack WarehouseStock rows (multiple rows can share
// the same warehouseId — one per rack/row/shelf) into one summed entry per
// warehouseId. Without this, any caller reading `variant.warehouseStock`
// as if it were "one row per warehouse" (e.g. ProductPickerModal's
// getWarehouseStock()) would silently overwrite earlier rack quantities
// with the last one seen instead of summing them.
function collapseWarehouseStock(
  rows: { warehouseId: string; quantity: number; rackId: string | null }[],
): { warehouseId: string; quantity: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.warehouseId, (totals.get(row.warehouseId) ?? 0) + row.quantity);
  }
  return Array.from(totals, ([warehouseId, quantity]) => ({ warehouseId, quantity }));
}

/**
 * Walks a findManagementCardsByWhere() result and replaces each variant's
 * raw per-rack warehouseStock array with the collapsed per-warehouse
 * totals. Mutates and returns the same array for convenience.
 */
function collapseManagementResult<
  T extends {
    variants: {
      warehouseStock: { warehouseId: string; quantity: number; rackId: string | null }[];
    }[];
  },
>(products: T[]): T[] {
  for (const product of products) {
    for (const variant of product.variants) {
      (variant as any).warehouseStock = collapseWarehouseStock(variant.warehouseStock);
    }
  }
  return products;
}

export const ProductRepository = {
  findCardsByWhere(
    where: any,
    opts: { orderBy?: any; skip?: number; take: number },
  ) {
    return prisma.product.findMany({
      where,
      include: cardInclude,
      orderBy: opts.orderBy ?? { createdAt: "desc" },
      skip: opts.skip,
      take: opts.take,
    });
  },

  // FIX: same shape/signature as findCardsByWhere, but with managementInclude
  // instead of cardInclude — used by ProductFilterService.filterForVendor
  // (and optionally filterForAdmin) so the vendor/admin product management
  // table AND ProductPickerModal share this one query. The raw per-rack
  // warehouseStock rows Prisma returns are collapsed to per-warehouse
  // totals before this resolves, so callers never see duplicate
  // warehouseId entries or have to aggregate rack rows themselves.
  async findManagementCardsByWhere(
    where: any,
    opts: { orderBy?: any; skip?: number; take: number },
  ) {
    const rows = await prisma.product.findMany({
      where,
      include: managementInclude,
      orderBy: opts.orderBy ?? { createdAt: "desc" },
      skip: opts.skip,
      take: opts.take,
    });
    return collapseManagementResult(rows as any);
  },

  countByWhere(where: any) {
    return prisma.product.count({ where });
  },

  findDetailBySlug(slug: string) {
    return prisma.product.findFirst({
      where: { slug, isDeleted: false },
      include: detailInclude,
    });
  },

  findDetailById(id: string, extraWhere: any = {}) {
    return prisma.product.findFirst({
      where: { id, isDeleted: false, ...extraWhere },
      include: detailInclude,
    });
  },

  incrementViewCount(productId: string) {
    return prisma.product.update({
      where: { id: productId },
      data: { viewCount: { increment: 1 } },
    });
  },

  /**
   * Low-stock detection needs to compare warehouseStock.quantity against
   * the variant's own reorderLevel — a same-row column comparison Prisma
   * can't express declaratively, so it's a raw query.
   */
  async findLowStockVariantIds(vendorId: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT pv.id
      FROM product_variants pv
      JOIN products p ON p.id = pv."productId"
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(ws.quantity), 0) AS total
        FROM "warehouse_stock" ws
        WHERE ws."variantId" = pv.id
      ) stock ON true
      WHERE p."vendorId" = ${vendorId}
        AND p."isDeleted" = false
        AND stock.total <= COALESCE(pv."reorderLevel", 10)
    `;
    return rows.map((r) => r.id);
  },

  /**
   * "In stock" / "out of stock" listing filters need `stock - reservedQty -
   * damagedQty` (available units), which — like reorderLevel above — is a
   * same-row column comparison Prisma's declarative `where` can't express,
   * so it's a raw query returning matching variant ids. `stock` is the
   * denormalized grand total (see schema comment on ProductVariant), so
   * this reads one indexed column per row, not the WarehouseStock table.
   */
  async findAvailableStockVariantIds(
    op: "gt" | "lte",
    threshold = 0,
  ): Promise<string[]> {
    const comparator = op === "gt" ? Prisma.sql`>` : Prisma.sql`<=`;
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM product_variants
      WHERE (stock - "reservedQty" - "damagedQty") ${comparator} ${threshold}
    `;
    return rows.map((r) => r.id);
  },
  async getCategoryAncestryChain(
    categoryId: string,
  ): Promise<{ id: string; name: string; slug: string }[]> {
    return prisma.$queryRaw`
    WITH RECURSIVE category_chain AS (
      SELECT id, name, slug, "parentId", 0 AS depth
      FROM "categories"
      WHERE id = ${categoryId}
      UNION ALL
      SELECT c.id, c.name, c.slug, c."parentId", cc.depth + 1
      FROM "categories" c
      INNER JOIN category_chain cc ON c.id = cc."parentId"
    )
    SELECT id, name, slug FROM category_chain ORDER BY depth DESC
  `;
  },
  async getCategoryAncestryChainCached(categoryId: string) {
    const cacheKey = `category-chain:${categoryId}`;
    const cached =
      await cacheGet<{ id: string; name: string; slug: string }[]>(cacheKey);
    if (cached) return cached;

    const chain = await this.getCategoryAncestryChain(categoryId);
    await cacheSet(cacheKey, chain, 3600); // ১ ঘণ্টা — category tree কম পাল্টায়
    return chain;
  },
};