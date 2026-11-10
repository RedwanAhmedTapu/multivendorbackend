// services/statistics/admin-statistics.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { cacheGet, cacheSet, cacheKeys } from "../../../../config/cache.ts";
import { VendorStatisticsService } from "./vendor-statistics.service.ts";

export const AdminStatisticsService = {
  /**
   * Everything vendor stats has, scoped to one vendor if vendorId is
   * passed, PLUS the marketplace-wide numbers below when it isn't.
   */
  async getStatistics(vendorId?: string) {
    if (vendorId) return VendorStatisticsService.getStatistics(vendorId);

    const cacheKey = cacheKeys.adminStats();
    const cached = await cacheGet<any>(cacheKey);
    if (cached) return cached;

    const baseWhere = { isDeleted: false };

    const [
      total,
      pending,
      active,
      rejected,
      deleted,
      totalVendors,
      productsByCategory,
      productsByBrand,
      productsByWarehouse,
      topVendors,
      recentlyApproved,
      recentlyRejected,
      mostViewed,
      mostSold,
    ] = await Promise.all([
      prisma.product.count({ where: baseWhere }),
      prisma.product.count({ where: { ...baseWhere, approvalStatus: "PENDING" } }),
      prisma.product.count({ where: { ...baseWhere, approvalStatus: "ACTIVE" } }),
      prisma.product.count({ where: { ...baseWhere, approvalStatus: "REJECTED" } }),
      prisma.product.count({ where: { isDeleted: true } }),
      prisma.vendor.count(),
      prisma.product.groupBy({ by: ["categoryId"], where: baseWhere, _count: { _all: true } }),
      prisma.product.groupBy({ by: ["brandId"], where: baseWhere, _count: { _all: true } }),
      prisma.warehouseStock.groupBy({ by: ["warehouseId"], _count: { _all: true } }),
      prisma.product.groupBy({ by: ["vendorId"], where: baseWhere, _count: { _all: true }, orderBy: { _count: { vendorId: "desc" } }, take: 10 }),
      prisma.product.findMany({ where: { ...baseWhere, approvalStatus: "ACTIVE" }, orderBy: { updatedAt: "desc" }, take: 10, select: { id: true, name: true, updatedAt: true, vendor: { select: { storeName: true } } } }),
      prisma.product.findMany({ where: { ...baseWhere, approvalStatus: "REJECTED" }, orderBy: { updatedAt: "desc" }, take: 10, select: { id: true, name: true, updatedAt: true, vendor: { select: { storeName: true } } } }),
      prisma.product.findMany({ where: { ...baseWhere, approvalStatus: "ACTIVE" }, orderBy: { viewCount: "desc" }, take: 10, select: { id: true, name: true, viewCount: true } }),
      prisma.product.findMany({ where: { ...baseWhere, approvalStatus: "ACTIVE" }, orderBy: { salesCount: "desc" }, take: 10, select: { id: true, name: true, salesCount: true } }),
    ]);

    const vendorIds = topVendors.map((v) => v.vendorId);
    const vendors = await prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, storeName: true } });

    const inventorySummary = await prisma.productVariant.aggregate({
      where: { product: baseWhere },
      _sum: { avgCost: true },
      _count: { _all: true },
    });

    const monthlyGrowth = await prisma.$queryRaw<{ month: string; count: bigint }[]>`
      SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month, COUNT(*) AS count
      FROM products
      WHERE "isDeleted" = false AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1
    `;

    const result = {
      global: {
        totalProducts: total,
        totalVendors,
        pendingApprovals: pending,
        approvedProducts: active,
        rejectedProducts: rejected,
        deletedProducts: deleted,
      },
      productsByCategory: productsByCategory.map((c) => ({ categoryId: c.categoryId, count: c._count._all })),
      productsByBrand: productsByBrand.map((b) => ({ brandId: b.brandId, count: b._count._all })),
      productsByWarehouse: productsByWarehouse.map((w) => ({ warehouseId: w.warehouseId, count: w._count._all })),
      topVendors: topVendors.map((v) => ({
        vendorId: v.vendorId,
        vendorName: vendors.find((vv) => vv.id === v.vendorId)?.storeName ?? "Unknown",
        productCount: v._count._all,
      })),
      inventorySummary: {
        totalVariants: inventorySummary._count._all,
        totalInventoryValue: inventorySummary._sum.avgCost ?? 0,
      },
      monthlyProductGrowth: monthlyGrowth.map((m) => ({ month: m.month, count: Number(m.count) })),
      approvalTrends: {
        recentlyApproved,
        recentlyRejected,
      },
      productHealthReport: {
        mostViewed,
        mostSold,
        // mostReviewed / mostWishlisted follow the same groupBy/orderBy
        // pattern against review.count() and wishlistCount respectively.
      },
    };

    await cacheSet(cacheKey, result, 300);
    return result;
  },
};
