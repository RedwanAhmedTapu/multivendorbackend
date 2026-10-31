// src/modules/agent/services/agent-portal.service.ts
//
// READ-ONLY monitoring data for the agent portal (Phase 5).
// Scope and privacy rules: see agent-portal.scope.ts. Every query here is
// scoped by the authenticated agent's OPEN vendor links, and order data by
// the link's start date. No customer identity is ever selected.

import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";
import { agentDb } from "../agent-db.ts";
import { notFound } from "../agent-http.ts";
import {
  RANGE_DAYS,
  bucketLabels,
  daysAgo,
  dhakaStartOf,
  effectivePrice,
  fillSeries,
  growthPercent,
  ratePercent,
  stockState,
  tenureOrderWhere,
  vendorHealth,
  type OpenLink,
  type VendorHealth,
} from "./agent-portal.scope.ts";

const TENURE_JOIN = (agentId: string) => Prisma.sql`
  JOIN agent_vendor_links l
    ON l."vendorId" = vo."vendorId"
   AND l."agentId" = ${agentId}
   AND l."endedAt" IS NULL
   AND vo."createdAt" >= l."startedAt"`;

export async function getOpenLinks(agentId: string): Promise<OpenLink[]> {
  const rows = await agentDb.prisma.agentVendorLink.findMany({
    where: { agentId, endedAt: null },
    select: { vendorId: true, startedAt: true },
  });
  return rows;
}

export async function assertVendorInScope(agentId: string, vendorId: string): Promise<OpenLink> {
  const link = await agentDb.prisma.agentVendorLink.findFirst({
    where: { agentId, vendorId, endedAt: null },
    select: { vendorId: true, startedAt: true },
  });
  if (!link) throw notFound("Vendor"); // out of scope looks exactly like missing
  return link;
}

// ── Per-vendor statistics (one query for all linked vendors) ─────────────

type VendorStatRow = {
  vendorId: string;
  orders: number;
  orders30: number;
  ordersPrev30: number;
  delivered: number;
  cancelled: number;
  returned: number;
  deliveredSales: string;
  sales30: string;
  salesPrev30: string;
};

async function vendorStats(agentId: string, now: Date, vendorId?: string): Promise<Map<string, VendorStatRow>> {
  const d30 = daysAgo(now, 30);
  const d60 = daysAgo(now, 60);
  const rows = await agentDb.prisma.$queryRaw<any[]>`
    SELECT vo."vendorId" AS "vendorId",
           COUNT(*)::int AS "orders",
           COUNT(*) FILTER (WHERE vo."createdAt" >= ${d30})::int AS "orders30",
           COUNT(*) FILTER (WHERE vo."createdAt" >= ${d60} AND vo."createdAt" < ${d30})::int AS "ordersPrev30",
           COUNT(*) FILTER (WHERE vo."status" = 'DELIVERED')::int AS "delivered",
           COUNT(*) FILTER (WHERE vo."status" = 'CANCELLED')::int AS "cancelled",
           COUNT(*) FILTER (WHERE vo."status" IN ('RETURNED', 'FAILED_TO_DELIVER'))::int AS "returned",
           COALESCE(SUM(vo."subtotal") FILTER (WHERE vo."status" = 'DELIVERED'), 0)::text AS "deliveredSales",
           COALESCE(SUM(vo."subtotal") FILTER (WHERE vo."status" = 'DELIVERED' AND vo."deliveredAt" >= ${d30}), 0)::text AS "sales30",
           COALESCE(SUM(vo."subtotal") FILTER (WHERE vo."status" = 'DELIVERED' AND vo."deliveredAt" >= ${d60} AND vo."deliveredAt" < ${d30}), 0)::text AS "salesPrev30"
      FROM vendor_orders vo
      ${TENURE_JOIN(agentId)}
     ${vendorId ? Prisma.sql`WHERE vo."vendorId" = ${vendorId}` : Prisma.empty}
     GROUP BY vo."vendorId"`;
  return new Map(rows.map((r) => [r.vendorId, r as VendorStatRow]));
}

const EMPTY_STATS = (vendorId: string): VendorStatRow => ({
  vendorId,
  orders: 0,
  orders30: 0,
  ordersPrev30: 0,
  delivered: 0,
  cancelled: 0,
  returned: 0,
  deliveredSales: "0",
  sales30: "0",
  salesPrev30: "0",
});

async function vendorRatings(vendorIds: string[]): Promise<Map<string, { rating: number | null; reviews: number; products: number }>> {
  if (!vendorIds.length) return new Map();
  const rows = await agentDb.prisma.$queryRaw<any[]>`
    SELECT p."vendorId" AS "vendorId",
           (SUM(p."avgRating" * p."reviewCount") / NULLIF(SUM(p."reviewCount"), 0))::float8 AS "rating",
           COALESCE(SUM(p."reviewCount"), 0)::int AS "reviews",
           COUNT(*)::int AS "products"
      FROM products p
     WHERE p."vendorId" = ANY(${vendorIds}::text[]) AND p."isDeleted" = false
     GROUP BY p."vendorId"`;
  return new Map(
    rows.map((r) => [r.vendorId, { rating: r.rating == null ? null : Math.round(r.rating * 10) / 10, reviews: r.reviews, products: r.products }]),
  );
}

const money2 = (v: string | number | Decimal) => new Decimal(v.toString()).toFixed(2);

// ── Dashboard ─────────────────────────────────────────────────────────────

export async function dashboardSummary(agentId: string, now = new Date()) {
  const links = await getOpenLinks(agentId);
  const vendorIds = links.map((l) => l.vendorId);
  const monthStart = dhakaStartOf(now, "month");
  const [stats, commission, wallet, agent, levels, recentOrders, lowStock] = await Promise.all([
    vendorStats(agentId, now),
    agentDb.prisma.agentCommission.groupBy({
      by: ["status"],
      where: { agentId },
      _sum: { amount: true, reversedAmount: true },
    }),
    agentDb.prisma.agentWallet.findUnique({ where: { agentId } }),
    agentDb.prisma.agent.findUnique({ where: { id: agentId }, select: { level: { select: { id: true, name: true, rank: true } } } }),
    agentDb.prisma.agentLevel.findMany({ where: { isActive: true }, orderBy: { rank: "asc" } }),
    recentOrdersFor(links, 5),
    lowStockItems(vendorIds, 5),
  ]);

  let orders = 0, orders30 = 0, ordersPrev30 = 0;
  let deliveredSales = new Decimal(0), sales30 = new Decimal(0), salesPrev30 = new Decimal(0);
  const inactiveVendors: string[] = [];
  for (const id of vendorIds) {
    const s = stats.get(id) ?? EMPTY_STATS(id);
    orders += s.orders;
    orders30 += s.orders30;
    ordersPrev30 += s.ordersPrev30;
    deliveredSales = deliveredSales.plus(s.deliveredSales);
    sales30 = sales30.plus(s.sales30);
    salesPrev30 = salesPrev30.plus(s.salesPrev30);
    const link = links.find((l) => l.vendorId === id)!;
    if (s.orders30 === 0 && link.startedAt <= daysAgo(now, 30)) inactiveVendors.push(id);
  }

  let earned = new Decimal(0), pending = new Decimal(0);
  for (const row of commission as any[]) {
    const net = new Decimal(row._sum.amount?.toString() ?? 0).minus(row._sum.reversedAmount?.toString() ?? 0);
    earned = earned.plus(net);
    if (row.status === "PENDING_CLEARANCE") pending = pending.plus(net);
  }

  const inactiveNames = inactiveVendors.length
    ? await agentDb.prisma.vendor.findMany({ where: { id: { in: inactiveVendors.slice(0, 5) } }, select: { id: true, storeName: true } })
    : [];

  const current = agent?.level ?? null;
  const next = (levels as any[]).find((l) => !current || l.rank > current.rank) ?? null;
  const progress = next
    ? {
        level: { id: next.id, name: next.name, rank: next.rank },
        linkedVendors: { current: vendorIds.length, required: next.minActiveVendors },
        deliveredSales: { current: money2(deliveredSales), required: next.minDeliveredSales.toString() },
        percent: Math.max(
          0,
          Math.min(
            100,
            Math.round(
              Math.min(
                next.minActiveVendors ? vendorIds.length / next.minActiveVendors : 1,
                new Decimal(next.minDeliveredSales.toString()).gt(0) ? deliveredSales.dividedBy(next.minDeliveredSales.toString()).toNumber() : 1,
              ) * 100,
            ),
          ),
        ),
      }
    : null;

  return {
    vendors: {
      total: vendorIds.length,
      newThisMonth: links.filter((l) => l.startedAt >= monthStart).length,
    },
    orders: { total: orders, last30Days: orders30, growthPercent: growthPercent(orders30, ordersPrev30) },
    sales: { delivered: money2(deliveredSales), last30Days: money2(sales30), growthPercent: growthPercent(sales30.toString(), salesPrev30.toString()) },
    commission: { totalEarned: money2(earned), pendingClearance: money2(pending) },
    wallet: {
      available: money2(wallet?.available?.toString() ?? 0),
      pendingClearance: money2(wallet?.pendingClearance?.toString() ?? 0),
      onHold: money2(wallet?.onHold?.toString() ?? 0),
    },
    level: { current, next: progress },
    alerts: {
      inactiveVendors: inactiveNames.map((v: any) => ({ vendorId: v.id, storeName: v.storeName })),
      inactiveVendorCount: inactiveVendors.length,
      lowStock,
    },
    recentOrders,
  };
}

export async function salesTrend(agentId: string, range: "7d" | "30d" | "6m" | "12m", now = new Date()) {
  const unit = range === "7d" || range === "30d" ? "day" : "month";
  const count = range === "7d" ? 7 : range === "30d" ? 30 : range === "6m" ? 6 : 12;
  const labels = bucketLabels(now, unit, count);
  const from = unit === "day" ? daysAgo(dhakaStartOf(now, "day"), count - 1) : dhakaStartOf(new Date(Date.parse(labels[0] + "-01T00:00:00+06:00")), "month");
  const fmt = unit === "day" ? "YYYY-MM-DD" : "YYYY-MM";
  const rows = await agentDb.prisma.$queryRaw<Array<{ bucket: string; value: string; orders: number }>>`
    SELECT to_char(vo."deliveredAt" AT TIME ZONE 'Asia/Dhaka', ${fmt}) AS "bucket",
           COALESCE(SUM(vo."subtotal"), 0)::text AS "value",
           COUNT(*)::int AS "orders"
      FROM vendor_orders vo
      ${TENURE_JOIN(agentId)}
     WHERE vo."status" = 'DELIVERED' AND vo."deliveredAt" >= ${from}
     GROUP BY 1`;
  const orderMap = new Map(rows.map((r) => [r.bucket, r.orders]));
  return {
    range,
    unit,
    series: fillSeries(labels, rows).map((p) => ({ ...p, orders: orderMap.get(p.bucket) ?? 0 })),
  };
}

export async function commissionTrend(agentId: string, range: "6m" | "12m", now = new Date()) {
  const count = range === "6m" ? 6 : 12;
  const labels = bucketLabels(now, "month", count);
  const from = new Date(Date.parse(labels[0] + "-01T00:00:00+06:00"));
  const rows = await agentDb.prisma.$queryRaw<Array<{ bucket: string; value: string }>>`
    SELECT to_char(c."earnedAt" AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') AS "bucket",
           COALESCE(SUM(c."amount" - c."reversedAmount"), 0)::text AS "value"
      FROM agent_commissions c
     WHERE c."agentId" = ${agentId} AND c."earnedAt" >= ${from}
     GROUP BY 1`;
  return { range, series: fillSeries(labels, rows) };
}

// ── Vendors ───────────────────────────────────────────────────────────────

type VendorRow = {
  vendorId: string;
  storeName: string;
  avatar: string | null;
  status: string;
  linkedSince: Date;
  products: number;
  orders: number;
  deliveredSales: string;
  sales30: string;
  growthPercent: number | null;
  rating: number | null;
  reviews: number;
  health: VendorHealth;
};

async function linkedVendorRows(agentId: string, now: Date): Promise<VendorRow[]> {
  const links = await getOpenLinks(agentId);
  if (!links.length) return [];
  const ids = links.map((l) => l.vendorId);
  const [vendors, stats, ratings] = await Promise.all([
    agentDb.prisma.vendor.findMany({ where: { id: { in: ids } }, select: { id: true, storeName: true, avatar: true, status: true } }),
    vendorStats(agentId, now),
    vendorRatings(ids),
  ]);
  const vmap = new Map((vendors as any[]).map((v) => [v.id, v]));
  return links
    .filter((l) => vmap.has(l.vendorId))
    .map((l) => {
      const v = vmap.get(l.vendorId);
      const s = stats.get(l.vendorId) ?? EMPTY_STATS(l.vendorId);
      const r = ratings.get(l.vendorId);
      return {
        vendorId: l.vendorId,
        storeName: v.storeName,
        avatar: v.avatar,
        status: v.status,
        linkedSince: l.startedAt,
        products: r?.products ?? 0,
        orders: s.orders,
        deliveredSales: money2(s.deliveredSales),
        sales30: money2(s.sales30),
        growthPercent: growthPercent(s.sales30, s.salesPrev30),
        rating: r?.rating ?? null,
        reviews: r?.reviews ?? 0,
        health: vendorHealth(s),
      };
    });
}

export async function listVendors(agentId: string, q: { filter: string; q?: string; page: number; limit: number }, now = new Date()) {
  const all = await linkedVendorRows(agentId, now);
  const counts = { ALL: all.length, ACTIVE: 0, GROWING: 0, DECLINING: 0, INACTIVE: 0 } as Record<string, number>;
  for (const v of all) counts[v.health]++;
  let rows = q.filter === "ALL" ? all : all.filter((v) => v.health === q.filter);
  if (q.q) {
    const term = q.q.toLowerCase();
    rows = rows.filter((v) => v.storeName.toLowerCase().includes(term));
  }
  rows.sort((a, b) => new Decimal(b.deliveredSales).comparedTo(a.deliveredSales) || a.storeName.localeCompare(b.storeName));
  const top = [...all].sort((a, b) => new Decimal(b.sales30).comparedTo(a.sales30))[0] ?? null;
  const attention =
    [...all].filter((v) => v.health === "DECLINING" || v.health === "INACTIVE").sort((a, b) => (a.growthPercent ?? -100) - (b.growthPercent ?? -100))[0] ?? null;
  return {
    items: rows.slice((q.page - 1) * q.limit, q.page * q.limit),
    total: rows.length,
    page: q.page,
    limit: q.limit,
    counts,
    highlights: {
      topPerformer: top && new Decimal(top.sales30).gt(0) ? { vendorId: top.vendorId, storeName: top.storeName, growthPercent: top.growthPercent, sales30: top.sales30 } : null,
      needsAttention: attention ? { vendorId: attention.vendorId, storeName: attention.storeName, health: attention.health, growthPercent: attention.growthPercent } : null,
    },
  };
}

export async function vendorDetail(agentId: string, vendorId: string, now = new Date()) {
  const link = await assertVendorInScope(agentId, vendorId);
  const sixMonthsLabels = bucketLabels(now, "month", 6);
  const trendFrom = new Date(Date.parse(sixMonthsLabels[0] + "-01T00:00:00+06:00"));
  const [vendor, stats, ratings, trendRows, topRows] = await Promise.all([
    agentDb.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, storeName: true, avatar: true, status: true, verificationStatus: true, createdAt: true },
    }),
    vendorStats(agentId, now, vendorId),
    vendorRatings([vendorId]),
    agentDb.prisma.$queryRaw<Array<{ bucket: string; value: string }>>`
      SELECT to_char(vo."deliveredAt" AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') AS "bucket",
             COALESCE(SUM(vo."subtotal"), 0)::text AS "value"
        FROM vendor_orders vo
        ${TENURE_JOIN(agentId)}
       WHERE vo."vendorId" = ${vendorId} AND vo."status" = 'DELIVERED' AND vo."deliveredAt" >= ${trendFrom}
       GROUP BY 1`,
    agentDb.prisma.$queryRaw<Array<{ productId: string; units: number; sales: string }>>`
      SELECT pv."productId" AS "productId",
             SUM(oi."deliveredQuantity")::int AS "units",
             SUM(oi."price" * oi."deliveredQuantity")::text AS "sales"
        FROM order_items oi
        JOIN vendor_orders vo ON vo.id = oi."vendorOrderId"
        ${TENURE_JOIN(agentId)}
        JOIN product_variants pv ON pv.id = oi."variantId"
       WHERE vo."vendorId" = ${vendorId} AND oi."deliveredQuantity" > 0
       GROUP BY pv."productId"
       ORDER BY SUM(oi."price" * oi."deliveredQuantity") DESC
       LIMIT 5`,
  ]);
  if (!vendor) throw notFound("Vendor");
  const s = stats.get(vendorId) ?? EMPTY_STATS(vendorId);
  const r = ratings.get(vendorId);
  const productIds = topRows.map((t) => t.productId);
  const products = productIds.length
    ? await agentDb.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          name: true,
          images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
          variants: { select: { sku: true, price: true, specialPrice: true, stock: true, reorderLevel: true } },
        },
      })
    : [];
  const pmap = new Map((products as any[]).map((p) => [p.id, p]));
  const closed = s.delivered + s.cancelled + s.returned;
  return {
    vendor: {
      id: vendor.id,
      storeName: vendor.storeName,
      avatar: vendor.avatar,
      status: vendor.status,
      verificationStatus: vendor.verificationStatus,
      joinedAt: vendor.createdAt,
      linkedSince: link.startedAt,
    },
    kpis: {
      products: r?.products ?? 0,
      orders: s.orders,
      deliveredSales: money2(s.deliveredSales),
      salesGrowthPercent: growthPercent(s.sales30, s.salesPrev30),
      ordersGrowthPercent: growthPercent(s.orders30, s.ordersPrev30),
      rating: r?.rating ?? null,
      reviews: r?.reviews ?? 0,
      health: vendorHealth(s),
    },
    rates: {
      completionPercent: ratePercent(s.delivered, closed),
      cancellationPercent: ratePercent(s.cancelled, s.orders),
      returnPercent: ratePercent(s.returned, s.delivered + s.returned),
    },
    trend: fillSeries(sixMonthsLabels, trendRows),
    topProducts: topRows
      .filter((t) => pmap.has(t.productId))
      .map((t) => {
        const p = pmap.get(t.productId);
        const stock = p.variants.reduce((a: number, v: any) => a + v.stock, 0);
        const reorder = p.variants.reduce((a: number, v: any) => a + (v.reorderLevel ?? 0), 0);
        const prices = p.variants.map((v: any) => new Decimal(effectivePrice(v.price, v.specialPrice)));
        return {
          productId: p.id,
          name: p.name,
          sku: p.variants[0]?.sku ?? null,
          image: p.images[0]?.url ?? null,
          price: prices.length ? Decimal.min(...prices).toFixed(2) : null,
          stock,
          stockState: stockState(stock, reorder),
          unitsSold: t.units,
          sales: money2(t.sales),
        };
      }),
  };
}

// ── Orders ────────────────────────────────────────────────────────────────

const ORDER_LIST_SELECT = {
  id: true,
  status: true,
  subtotal: true,
  createdAt: true,
  shippedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  vendor: { select: { id: true, storeName: true } },
  order: { select: { orderNumber: true } },
  _count: { select: { items: true } },
} as const;

async function commissionByVendorOrder(agentId: string, vendorOrderIds: string[]) {
  if (!vendorOrderIds.length) return new Map<string, string>();
  const rows = await agentDb.prisma.agentCommission.groupBy({
    by: ["vendorOrderId"],
    where: { agentId, vendorOrderId: { in: vendorOrderIds } },
    _sum: { amount: true, reversedAmount: true },
  });
  return new Map(
    (rows as any[]).map((r) => [r.vendorOrderId, money2(new Decimal(r._sum.amount?.toString() ?? 0).minus(r._sum.reversedAmount?.toString() ?? 0))]),
  );
}

function orderRow(o: any, commission: Map<string, string>) {
  return {
    vendorOrderId: o.id,
    orderNumber: o.order?.orderNumber ?? null,
    status: o.status,
    amount: money2(o.subtotal.toString()),
    itemCount: o._count.items,
    vendor: { id: o.vendor.id, storeName: o.vendor.storeName },
    createdAt: o.createdAt,
    shippedAt: o.shippedAt,
    deliveredAt: o.deliveredAt,
    cancelledAt: o.cancelledAt,
    commission: commission.get(o.id) ?? null,
  };
}

async function recentOrdersFor(links: OpenLink[], take: number) {
  const rows = await agentDb.prisma.vendorOrder.findMany({
    where: tenureOrderWhere(links) as any,
    orderBy: { createdAt: "desc" },
    take,
    select: ORDER_LIST_SELECT,
  });
  return rows.map((o: any) => orderRow(o, new Map()));
}

export async function listOrders(agentId: string, q: { status: string; vendorId?: string; q?: string; page: number; limit: number }) {
  const links = await getOpenLinks(agentId);
  if (q.vendorId && !links.some((l) => l.vendorId === q.vendorId)) throw notFound("Vendor");
  const scope = tenureOrderWhere(links, q.vendorId);
  const where: any = { AND: [scope] };
  if (q.status !== "ALL") where.AND.push({ status: q.status });
  if (q.q) {
    where.AND.push({
      OR: [
        { order: { orderNumber: { contains: q.q, mode: "insensitive" } } },
        { vendor: { storeName: { contains: q.q, mode: "insensitive" } } },
      ],
    });
  }
  const [rows, total, byStatus] = await Promise.all([
    agentDb.prisma.vendorOrder.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.limit, take: q.limit, select: ORDER_LIST_SELECT }),
    agentDb.prisma.vendorOrder.count({ where }),
    agentDb.prisma.vendorOrder.groupBy({ by: ["status"], where: scope as any, _count: { _all: true } }),
  ]);
  const commission = await commissionByVendorOrder(agentId, rows.map((r: any) => r.id));
  const [earned, pending] = await Promise.all([
    agentDb.prisma.agentCommission.aggregate({ where: { agentId }, _sum: { amount: true, reversedAmount: true } }),
    agentDb.prisma.agentCommission.aggregate({ where: { agentId, status: "PENDING_CLEARANCE" }, _sum: { amount: true, reversedAmount: true } }),
  ]);
  const net = (a: any) => money2(new Decimal(a._sum.amount?.toString() ?? 0).minus(a._sum.reversedAmount?.toString() ?? 0));
  const statusCounts: Record<string, number> = {};
  let all = 0;
  for (const s of byStatus as any[]) {
    statusCounts[s.status] = s._count._all;
    all += s._count._all;
  }
  return {
    items: rows.map((o: any) => orderRow(o, commission)),
    total,
    page: q.page,
    limit: q.limit,
    stats: {
      totalOrders: all,
      deliveredOrders: statusCounts.DELIVERED ?? 0,
      statusCounts,
      totalCommission: net(earned),
      pendingCommission: net(pending),
    },
  };
}

export async function orderDetail(agentId: string, vendorOrderId: string) {
  const links = await getOpenLinks(agentId);
  const order = await agentDb.prisma.vendorOrder.findFirst({
    where: { AND: [{ id: vendorOrderId }, tenureOrderWhere(links)] } as any,
    select: {
      ...ORDER_LIST_SELECT,
      fulfillmentStatus: true,
      items: {
        select: {
          id: true,
          quantity: true,
          deliveredQuantity: true,
          returnedQuantity: true,
          price: true,
          variant: { select: { sku: true, name: true, product: { select: { id: true, name: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } } } },
        },
      },
    },
  });
  if (!order) throw notFound("Order");
  const commissions = await agentDb.prisma.agentCommission.findMany({
    where: { agentId, vendorOrderId },
    orderBy: { earnedAt: "asc" },
    select: { id: true, orderItemId: true, quantity: true, baseAmount: true, amount: true, reversedAmount: true, ratePercent: true, rateSource: true, status: true, earnedAt: true, availableAt: true },
  });
  const commission = await commissionByVendorOrder(agentId, [vendorOrderId]);
  return {
    ...orderRow(order, commission),
    fulfillmentStatus: (order as any).fulfillmentStatus,
    items: (order as any).items.map((i: any) => ({
      orderItemId: i.id,
      productId: i.variant.product.id,
      productName: i.variant.product.name,
      variantName: i.variant.name,
      sku: i.variant.sku,
      image: i.variant.product.images[0]?.url ?? null,
      quantity: i.quantity,
      deliveredQuantity: i.deliveredQuantity,
      returnedQuantity: i.returnedQuantity,
      unitPrice: money2(i.price.toString()),
      lineTotal: money2(new Decimal(i.price.toString()).times(i.quantity)),
    })),
    commissions: commissions.map((c: any) => ({
      ...c,
      baseAmount: money2(c.baseAmount.toString()),
      amount: money2(c.amount.toString()),
      reversedAmount: money2(c.reversedAmount.toString()),
      ratePercent: c.ratePercent.toString(),
    })),
  };
}

// ── Products ──────────────────────────────────────────────────────────────

export async function listProducts(
  agentId: string,
  q: { stock: string; approval: string; vendorId?: string; categoryId?: string; q?: string; page: number; limit: number },
  now = new Date(),
) {
  const links = await getOpenLinks(agentId);
  let vendorIds = links.map((l) => l.vendorId);
  if (q.vendorId) {
    if (!vendorIds.includes(q.vendorId)) throw notFound("Vendor");
    vendorIds = [q.vendorId];
  }
  const empty = { items: [], total: 0, page: q.page, limit: q.limit, stats: { total: 0, lowStock: 0, outOfStock: 0, newLast30Days: 0 } };
  if (!vendorIds.length) return empty;

  const conditions: Prisma.Sql[] = [Prisma.sql`p."vendorId" = ANY(${vendorIds}::text[])`, Prisma.sql`p."isDeleted" = false`];
  if (q.categoryId) conditions.push(Prisma.sql`p."categoryId" = ${q.categoryId}`);
  if (q.approval !== "ALL") conditions.push(Prisma.sql`p."approvalStatus"::text = ${q.approval}`);
  if (q.q) conditions.push(Prisma.sql`p."name" ILIKE ${"%" + q.q.replace(/[\\%_]/g, (c) => "\\" + c) + "%"}`);
  const whereSql = Prisma.join(conditions, " AND ");
  const having =
    q.stock === "OUT_OF_STOCK"
      ? Prisma.sql`HAVING COALESCE(SUM(pv."stock"), 0) <= 0`
      : q.stock === "LOW_STOCK"
        ? Prisma.sql`HAVING COALESCE(SUM(pv."stock"), 0) > 0 AND COALESCE(SUM(pv."stock"), 0) <= COALESCE(SUM(pv."reorderLevel"), 0)`
        : q.stock === "IN_STOCK"
          ? Prisma.sql`HAVING COALESCE(SUM(pv."stock"), 0) > COALESCE(SUM(pv."reorderLevel"), 0)`
          : Prisma.empty;

  const d30 = daysAgo(now, 30);
  const [page, totalRow, statsRow] = await Promise.all([
    agentDb.prisma.$queryRaw<Array<{ id: string; stock: number; reorder: number }>>`
      SELECT p.id, COALESCE(SUM(pv."stock"), 0)::int AS "stock", COALESCE(SUM(pv."reorderLevel"), 0)::int AS "reorder"
        FROM products p LEFT JOIN product_variants pv ON pv."productId" = p.id
       WHERE ${whereSql}
       GROUP BY p.id, p."createdAt"
       ${having}
       ORDER BY p."createdAt" DESC, p.id
       LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    agentDb.prisma.$queryRaw<Array<{ total: number }>>`
      SELECT COUNT(*)::int AS "total" FROM (
        SELECT p.id FROM products p LEFT JOIN product_variants pv ON pv."productId" = p.id
         WHERE ${whereSql} GROUP BY p.id ${having}) t`,
    agentDb.prisma.$queryRaw<Array<{ total: number; low: number; out: number; fresh: number }>>`
      SELECT COUNT(*)::int AS "total",
             COUNT(*) FILTER (WHERE t.stock > 0 AND t.stock <= t.reorder)::int AS "low",
             COUNT(*) FILTER (WHERE t.stock <= 0)::int AS "out",
             COUNT(*) FILTER (WHERE t."createdAt" >= ${d30})::int AS "fresh"
        FROM (SELECT p.id, p."createdAt", COALESCE(SUM(pv."stock"), 0) AS stock, COALESCE(SUM(pv."reorderLevel"), 0) AS reorder
                FROM products p LEFT JOIN product_variants pv ON pv."productId" = p.id
               WHERE p."vendorId" = ANY(${vendorIds}::text[]) AND p."isDeleted" = false
               GROUP BY p.id, p."createdAt") t`,
  ]);

  const ids = page.map((r) => r.id);
  const products = ids.length
    ? await agentDb.prisma.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          approvalStatus: true,
          createdAt: true,
          vendor: { select: { id: true, storeName: true } },
          category: { select: { id: true, name: true } },
          images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
          variants: { select: { sku: true, price: true, specialPrice: true } },
        },
      })
    : [];
  const pmap = new Map((products as any[]).map((p) => [p.id, p]));
  return {
    items: page
      .filter((r) => pmap.has(r.id))
      .map((r) => {
        const p = pmap.get(r.id);
        const prices = p.variants.map((v: any) => new Decimal(effectivePrice(v.price, v.specialPrice)));
        return {
          productId: p.id,
          name: p.name,
          sku: p.variants[0]?.sku ?? null,
          image: p.images[0]?.url ?? null,
          vendor: p.vendor,
          category: p.category,
          approvalStatus: p.approvalStatus,
          price: prices.length ? Decimal.min(...prices).toFixed(2) : null,
          stock: r.stock,
          reorderLevel: r.reorder,
          stockState: stockState(r.stock, r.reorder),
          createdAt: p.createdAt,
        };
      }),
    total: totalRow[0]?.total ?? 0,
    page: q.page,
    limit: q.limit,
    stats: {
      total: statsRow[0]?.total ?? 0,
      lowStock: statsRow[0]?.low ?? 0,
      outOfStock: statsRow[0]?.out ?? 0,
      newLast30Days: statsRow[0]?.fresh ?? 0,
    },
  };
}

async function lowStockItems(vendorIds: string[], take: number) {
  if (!vendorIds.length) return [];
  const rows = await agentDb.prisma.$queryRaw<Array<{ productId: string; name: string; vendorId: string; storeName: string; stock: number }>>`
    SELECT p.id AS "productId", p.name AS "name", v.id AS "vendorId", v."storeName" AS "storeName", pv."stock"::int AS "stock"
      FROM product_variants pv
      JOIN products p ON p.id = pv."productId"
      JOIN vendors v ON v.id = p."vendorId"
     WHERE p."vendorId" = ANY(${vendorIds}::text[]) AND p."isDeleted" = false
       AND p."approvalStatus" = 'ACTIVE'
       AND pv."reorderLevel" IS NOT NULL AND pv."stock" <= pv."reorderLevel"
     ORDER BY pv."stock" ASC, p."salesCount" DESC
     LIMIT ${take}`;
  return rows;
}

// ── Reviews ───────────────────────────────────────────────────────────────

export async function listReviews(agentId: string, q: { vendorId?: string; rating?: number; range: string; page: number; limit: number }, now = new Date()) {
  const links = await getOpenLinks(agentId);
  let vendorIds = links.map((l) => l.vendorId);
  if (q.vendorId) {
    if (!vendorIds.includes(q.vendorId)) throw notFound("Vendor");
    vendorIds = [q.vendorId];
  }
  const base: any = { status: "PUBLISHED", product: { vendorId: { in: vendorIds.length ? vendorIds : ["__none__"] } } };
  if (q.range !== "all") base.createdAt = { gte: daysAgo(now, RANGE_DAYS[q.range]) };
  const where = q.rating ? { ...base, rating: q.rating } : base;
  const [rows, total, agg, byRating] = await Promise.all([
    agentDb.prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      // PRIVACY: no user relation, no userId.
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        vendorReplyAt: true,
        product: {
          select: {
            id: true,
            name: true,
            images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
            vendor: { select: { id: true, storeName: true } },
          },
        },
      },
    }),
    agentDb.prisma.review.count({ where }),
    agentDb.prisma.review.aggregate({ where: base, _avg: { rating: true }, _count: { _all: true } }),
    agentDb.prisma.review.groupBy({ by: ["rating"], where: base, _count: { _all: true } }),
  ]);
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of byRating as any[]) dist[r.rating] = r._count._all;
  const count = (agg as any)._count._all as number;
  return {
    items: rows.map((r: any) => ({
      reviewId: r.id,
      rating: r.rating,
      comment: r.comment,
      createdAt: r.createdAt,
      vendorReplied: !!r.vendorReplyAt,
      product: { id: r.product.id, name: r.product.name, image: r.product.images[0]?.url ?? null },
      vendor: r.product.vendor,
    })),
    total,
    page: q.page,
    limit: q.limit,
    stats: {
      total: count,
      averageRating: (agg as any)._avg.rating == null ? null : Math.round((agg as any)._avg.rating * 10) / 10,
      positivePercent: ratePercent(dist[4] + dist[5], count),
      negative: dist[1] + dist[2],
      distribution: dist,
    },
  };
}

// ── Vendor performance & analytics ───────────────────────────────────────

async function rangeStats(agentId: string, from: Date, to: Date) {
  return agentDb.prisma.$queryRaw<Array<{ vendorId: string; delivered: number; cancelled: number; returned: number; sales: string }>>`
    SELECT vo."vendorId" AS "vendorId",
           COUNT(*) FILTER (WHERE vo."status" = 'DELIVERED' AND vo."deliveredAt" >= ${from} AND vo."deliveredAt" < ${to})::int AS "delivered",
           COUNT(*) FILTER (WHERE vo."status" = 'CANCELLED' AND vo."createdAt" >= ${from} AND vo."createdAt" < ${to})::int AS "cancelled",
           COUNT(*) FILTER (WHERE vo."status" IN ('RETURNED', 'FAILED_TO_DELIVER') AND vo."createdAt" >= ${from} AND vo."createdAt" < ${to})::int AS "returned",
           COALESCE(SUM(vo."subtotal") FILTER (WHERE vo."status" = 'DELIVERED' AND vo."deliveredAt" >= ${from} AND vo."deliveredAt" < ${to}), 0)::text AS "sales"
      FROM vendor_orders vo
      ${TENURE_JOIN(agentId)}
     GROUP BY vo."vendorId"`;
}

export async function vendorPerformance(agentId: string, range: "7d" | "30d" | "90d" | "365d", now = new Date()) {
  const days = RANGE_DAYS[range];
  const from = daysAgo(now, days);
  const prevFrom = daysAgo(now, days * 2);
  const vendors = await linkedVendorRows(agentId, now);
  const [cur, prev, categories] = await Promise.all([
    rangeStats(agentId, from, now),
    rangeStats(agentId, prevFrom, from),
    agentDb.prisma.$queryRaw<Array<{ category: string; orders: number }>>`
      SELECT c.name AS "category", COUNT(DISTINCT vo.id)::int AS "orders"
        FROM order_items oi
        JOIN vendor_orders vo ON vo.id = oi."vendorOrderId"
        ${TENURE_JOIN(agentId)}
        JOIN product_variants pv ON pv.id = oi."variantId"
        JOIN products p ON p.id = pv."productId"
        JOIN categories c ON c.id = p."categoryId"
       WHERE vo."status" = 'DELIVERED' AND vo."deliveredAt" >= ${from}
       GROUP BY c.name
       ORDER BY 2 DESC`,
  ]);
  const curMap = new Map(cur.map((r) => [r.vendorId, r]));
  const prevMap = new Map(prev.map((r) => [r.vendorId, r]));
  let delivered = 0, closed = 0, sales = new Decimal(0), prevSales = new Decimal(0);
  let ratingSum = 0, ratingWeight = 0;
  const ranking = vendors.map((v) => {
    const c = curMap.get(v.vendorId) ?? { delivered: 0, cancelled: 0, returned: 0, sales: "0" };
    const p = prevMap.get(v.vendorId) ?? { delivered: 0, cancelled: 0, returned: 0, sales: "0" };
    delivered += c.delivered;
    closed += c.delivered + c.cancelled + c.returned;
    sales = sales.plus(c.sales);
    prevSales = prevSales.plus(p.sales);
    if (v.rating != null && v.reviews > 0) {
      ratingSum += v.rating * v.reviews;
      ratingWeight += v.reviews;
    }
    return {
      vendorId: v.vendorId,
      storeName: v.storeName,
      sales: money2(c.sales),
      deliveredOrders: c.delivered,
      growthPercent: growthPercent(c.sales, p.sales),
      returnPercent: ratePercent(c.returned, c.delivered + c.returned),
      rating: v.rating,
      health: v.health,
    };
  });
  ranking.sort((a, b) => new Decimal(b.sales).comparedTo(a.sales));
  const totalCatOrders = categories.reduce((a, c) => a + c.orders, 0);
  const top = categories.slice(0, 4).map((c) => ({ category: c.category, orders: c.orders, percent: ratePercent(c.orders, totalCatOrders) }));
  const rest = categories.slice(4).reduce((a, c) => a + c.orders, 0);
  if (rest > 0) top.push({ category: "Others", orders: rest, percent: ratePercent(rest, totalCatOrders) });
  return {
    range,
    kpis: {
      averageOrderValue: delivered ? money2(sales.dividedBy(delivered)) : null,
      completionPercent: ratePercent(delivered, closed),
      averageRating: ratingWeight ? Math.round((ratingSum / ratingWeight) * 10) / 10 : null,
      salesGrowthPercent: growthPercent(sales.toString(), prevSales.toString()),
      deliveredSales: money2(sales),
      deliveredOrders: delivered,
    },
    categories: { totalOrders: totalCatOrders, items: top },
    ranking,
  };
}

export async function analyticsInsights(agentId: string, now = new Date()) {
  const [vendors, revenue] = await Promise.all([linkedVendorRows(agentId, now), salesTrend(agentId, "6m", now)]);
  const links = await getOpenLinks(agentId);
  const monthStart = dhakaStartOf(now, "month");
  const counts = { ACTIVE: 0, GROWING: 0, DECLINING: 0, INACTIVE: 0 } as Record<VendorHealth, number>;
  for (const v of vendors) counts[v.health]++;
  const bySales = [...vendors].sort((a, b) => new Decimal(b.sales30).comparedTo(a.sales30));
  const attention = vendors
    .filter((v) => v.health === "DECLINING" || v.health === "INACTIVE")
    .sort((a, b) => (a.growthPercent ?? -100) - (b.growthPercent ?? -100))[0];
  return {
    topPerformer: bySales[0] && new Decimal(bySales[0].sales30).gt(0) ? { vendorId: bySales[0].vendorId, storeName: bySales[0].storeName, sales30: bySales[0].sales30, growthPercent: bySales[0].growthPercent } : null,
    needsAttention: attention ? { vendorId: attention.vendorId, storeName: attention.storeName, sales30: attention.sales30, growthPercent: attention.growthPercent, health: attention.health } : null,
    newVendorsThisMonth: links.filter((l) => l.startedAt >= monthStart).length,
    revenueTrend: revenue.series,
    activity: { total: vendors.length, ...counts },
    topVendorsBySales: bySales.slice(0, 5).map((v) => ({ vendorId: v.vendorId, storeName: v.storeName, sales30: v.sales30 })),
    insights: [...vendors]
      .sort((a, b) => (b.growthPercent ?? -1000) - (a.growthPercent ?? -1000))
      .slice(0, 10)
      .map((v) => ({ vendorId: v.vendorId, storeName: v.storeName, health: v.health, growthPercent: v.growthPercent, sales30: v.sales30 })),
  };
}
