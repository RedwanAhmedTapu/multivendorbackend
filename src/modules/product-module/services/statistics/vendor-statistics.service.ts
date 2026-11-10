// services/statistics/vendor-statistics.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { cacheGet, cacheSet, cacheKeys } from "../../../../config/cache.ts";
import { publishedReviewFilter } from "../product/review-moderation.scope.ts";

/**
 * Kept entirely separate from ProductService per the brief:
 * "Statistics should never be mixed inside ProductService."
 */
export const VendorStatisticsService = {
  async getStatistics(vendorId: string) {
    const cacheKey = cacheKeys.vendorStats(vendorId);
    const cached = await cacheGet<any>(cacheKey);
    if (cached) return cached;

    const baseWhere = { vendorId, isDeleted: false };

    const [
      total,
      pending,
      active,
      rejected,
      draft,
      featured,
      newArrival,
      onSale,
      freeShipping,
      totalReviews,
      avgRating,
      recentlyAdded,
      recentlyUpdated,
      categoryDistribution,
      brandDistribution,
      topProducts,
    ] = await Promise.all([
      prisma.product.count({ where: baseWhere }),
      prisma.product.count({ where: { ...baseWhere, approvalStatus: "PENDING" } }),
      prisma.product.count({ where: { ...baseWhere, approvalStatus: "ACTIVE" } }),
      prisma.product.count({ where: { ...baseWhere, approvalStatus: "REJECTED" } }),
      prisma.product.count({ where: { ...baseWhere, approvalStatus: "DRAFT" } }),
      prisma.product.count({ where: { ...baseWhere, isFeatured: true } }),
      prisma.product.count({
        where: { ...baseWhere, createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      }),
      prisma.product.count({ where: { ...baseWhere, variants: { some: { specialPrice: { not: null } } } } }),
      prisma.product.count({
        where: {
          ...baseWhere,
          offerProducts: { some: { offer: { type: "FREE_SHIPPING", isActive: true, status: "ACTIVE" } } },
        },
      }),
      prisma.review.count({ where: { product: baseWhere, ...publishedReviewFilter() } }),
      prisma.review.aggregate({ where: { product: baseWhere, ...publishedReviewFilter() }, _avg: { rating: true } }),
      prisma.product.findMany({ where: baseWhere, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, name: true, createdAt: true } }),
      prisma.product.findMany({ where: baseWhere, orderBy: { updatedAt: "desc" }, take: 5, select: { id: true, name: true, updatedAt: true } }),
      prisma.product.groupBy({ by: ["categoryId"], where: baseWhere, _count: { _all: true } }),
      prisma.product.groupBy({ by: ["brandId"], where: baseWhere, _count: { _all: true } }),
      prisma.product.findMany({
        where: baseWhere,
        orderBy: [{ salesCount: "desc" }],
        take: 5,
        select: { id: true, name: true, salesCount: true, viewCount: true },
      }),
    ]);

    const [outOfStock, lowStock, inventory] = await Promise.all([
      prisma.productVariant.count({ where: { product: baseWhere, warehouseStock: { none: {} } } }),
      countLowStock(vendorId),
      prisma.productVariant.aggregate({
        where: { product: baseWhere },
        _sum: { avgCost: true },
      }),
    ]);

    // Category/brand names for the distribution buckets
    const categoryIds = categoryDistribution.map((c) => c.categoryId).filter(Boolean) as string[];
    const brandIds = brandDistribution.map((b) => b.brandId).filter(Boolean) as string[];
    const [categories, brands] = await Promise.all([
      prisma.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }),
      prisma.brand.findMany({ where: { id: { in: brandIds } }, select: { id: true, name: true } }),
    ]);

    const result = {
      total,
      pending,
      active,
      rejected,
      draft,
      archived: 0, // maps to INACTIVE if you use that status for archiving
      featured,
      newArrival,
      outOfStock,
      lowStock,
      inStock: total - outOfStock,
      onSale,
      freeShippingProducts: freeShipping,
      totalInventoryUnits: null, // requires SUM(warehouseStock.quantity) — see raw query note in README
      inventoryValue: inventory._sum.avgCost ?? 0,
      averageProductRating: Math.round((avgRating._avg.rating || 0) * 10) / 10,
      totalReviews,
      recentlyAddedProducts: recentlyAdded,
      recentlyUpdatedProducts: recentlyUpdated,
      categoryDistribution: categoryDistribution.map((c) => ({
        categoryId: c.categoryId,
        categoryName: categories.find((cat) => cat.id === c.categoryId)?.name ?? "Uncategorized",
        count: c._count._all,
      })),
      brandDistribution: brandDistribution.map((b) => ({
        brandId: b.brandId,
        brandName: brands.find((br) => br.id === b.brandId)?.name ?? "No Brand",
        count: b._count._all,
      })),
      topProducts,
    };

    await cacheSet(cacheKey, result, 300);
    return result;
  },

  /** Monthly product creation / sales / revenue for the last 12 months. */
  async getMonthlyTrends(vendorId: string) {
    const rows = await prisma.$queryRaw<
      { month: string; productsCreated: bigint }[]
    >`
      SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month,
             COUNT(*) AS "productsCreated"
      FROM products
      WHERE "vendorId" = ${vendorId} AND "isDeleted" = false
        AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({ month: r.month, productsCreated: Number(r.productsCreated) }));
  },
};

async function countLowStock(vendorId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) as count
    FROM product_variants pv
    JOIN products p ON p.id = pv."productId"
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(ws.quantity), 0) AS total
      FROM "WarehouseStock" ws
      WHERE ws."variantId" = pv.id
    ) stock ON true
    WHERE p."vendorId" = ${vendorId} AND p."isDeleted" = false
      AND stock.total <= COALESCE(pv."reorderLevel", 10) AND stock.total > 0
  `;
  return Number(rows[0]?.count ?? 0);
}
