// modules/analytics/business-advisor.service.ts
//
// Business Advisor queries. Everything is aggregated by the database
// (groupBy / count / aggregate) over a bounded date range; nothing loads the
// raw event stream. The scope is decided by the controller from the
// authenticated user — `vendorId: null` means platform-wide (admin only).
//
// Definitions (also returned in `definitions` so the UI can show them):
//   - Days are Asia/Dhaka calendar days; ranges are inclusive, ≤ 92 days; the
//     comparison period is the equally long period right before.
//   - Event metrics count recorded events: views (≤1 per journey·product·30
//     min), add-to-cart (each successful add), checkout starts (distinct
//     checkout attempts), orders (distinct orders containing the products).
//   - The FUNNEL is journey-based: distinct journeys (browser sessions) in the
//     range that reached each stage. It is not a strict nested cohort — a
//     journey can reach checkout without a recorded view (e.g. viewed in an
//     earlier session) — so stage-to-stage rates are reported as ratios.
//   - Checkout abandonment is customer-based: a customer whose LATEST checkout
//     start in the range has no order with this store after it, and is older
//     than 24 h (newer ones are "in progress").
//   - "Orders (all channels)" / revenue / payment outcomes come from the
//     authoritative order tables, so they include orders placed before
//     tracking began; revenue = vendor order subtotals of non-cancelled orders.
//   - Product impressions and session recordings do not exist.

import { prisma } from "../../config/prisma.ts";
import {
  ANALYTICS_LIMITS,
  ANALYTICS_TIMEZONE,
  CHECKOUT_FAILURE_REASONS,
  addDays,
  dayCount,
  dhakaDay,
  isoDay,
  journeyLabel,
  parseDay,
  TZ_OFFSET_MINUTES,
  type AnalyticsEventType,
} from "./analytics.contract.ts";

type Delegate = Record<string, (...args: any[]) => Promise<any>>;
export interface AdvisorDb {
  analyticsEvent?: Delegate;
  product: Delegate;
  vendorOrder: Delegate;
  order: Delegate;
}

export class AnalyticsNotReadyError extends Error {
  readonly code = "ANALYTICS_NOT_READY";
  constructor() {
    super("Analytics storage is not set up yet");
  }
}
export class InvalidRangeError extends Error {
  readonly code = "INVALID_RANGE";
}

export interface Range {
  from: Date;
  to: Date;
  days: number;
}

/** from / to ("YYYY-MM-DD", Dhaka days). Defaults to the last 30 days including today. */
export function resolveRange(q: { from?: unknown; to?: unknown }, now: Date = new Date()): Range {
  const today = dhakaDay(now);
  const hasFrom = q.from !== undefined && q.from !== "";
  const hasTo = q.to !== undefined && q.to !== "";
  const to = hasTo ? parseDay(q.to) : today;
  if (!to) throw new InvalidRangeError("`to` must be a date (YYYY-MM-DD)");
  const from = hasFrom ? parseDay(q.from) : addDays(to, -(ANALYTICS_LIMITS.defaultRangeDays - 1));
  if (!from) throw new InvalidRangeError("`from` must be a date (YYYY-MM-DD)");
  if (from.getTime() > to.getTime()) throw new InvalidRangeError("`from` must not be after `to`");
  if (to.getTime() > addDays(today, 1).getTime()) throw new InvalidRangeError("`to` can't be in the future");
  const days = dayCount(from, to);
  if (days > ANALYTICS_LIMITS.maxRangeDays) throw new InvalidRangeError(`The range can be at most ${ANALYTICS_LIMITS.maxRangeDays} days`);
  return { from, to, days };
}

export function previousRange(r: Range): Range {
  const to = addDays(r.from, -1);
  return { from: addDays(to, -(r.days - 1)), to, days: r.days };
}

/** Instant bounds of a Dhaka-day range: [from 00:00 +06, (to+1) 00:00 +06). */
export function instantBounds(r: Range): { gte: Date; lt: Date } {
  const off = TZ_OFFSET_MINUTES * 60_000;
  return { gte: new Date(r.from.getTime() - off), lt: new Date(addDays(r.to, 1).getTime() - off) };
}

const RATE_KEYS = new Set<string>(["viewToCart", "cartToCheckout", "checkoutToOrder"]);
const ratio = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 10000) / 100 : null);
const change = (cur: number, prev: number): number | null => (prev > 0 ? Math.round(((cur - prev) / prev) * 10000) / 100 : null);

export function createBusinessAdvisorService(db: AdvisorDb, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  const events = () => {
    if (!db.analyticsEvent?.groupBy) throw new AnalyticsNotReadyError();
    return db.analyticsEvent;
  };
  /** Prisma "table does not exist" (migration not applied) → not ready. */
  const guard = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (err: any) {
      if (err?.code === "P2021" || err?.code === "P2022") throw new AnalyticsNotReadyError();
      throw err;
    }
  };
  const scopeWhere = (vendorId: string | null) => (vendorId ? { vendorId } : {});
  const dayWhere = (r: Range) => ({ day: { gte: r.from, lte: r.to } });

  async function eventTotals(vendorId: string | null, r: Range, productId?: string) {
    const where = { ...scopeWhere(vendorId), ...dayWhere(r), ...(productId ? { productId } : {}) };
    const [byType, checkoutGroups, failureGroups, orderGroups] = await Promise.all([
      guard(events().groupBy({ by: ["type"], where, _count: { _all: true }, _sum: { quantity: true, valueMinor: true } })),
      guard(events().groupBy({ by: ["groupKey"], where: { ...where, type: "CHECKOUT_STARTED" }, _count: { _all: true } })),
      guard(events().groupBy({ by: ["groupKey", "reason"], where: { ...where, type: "CHECKOUT_FAILED" }, _count: { _all: true } })),
      guard(events().groupBy({ by: ["orderId"], where: { ...where, type: "ORDER_PLACED" }, _count: { _all: true } })),
    ]);
    const count = (t: AnalyticsEventType) => byType.find((g: any) => g.type === t)?._count?._all ?? 0;
    const ordered = byType.find((g: any) => g.type === "ORDER_PLACED");
    const reasons: Record<string, number> = {};
    for (const g of failureGroups) reasons[g.reason ?? "OTHER"] = (reasons[g.reason ?? "OTHER"] ?? 0) + 1;
    return {
      views: count("PRODUCT_VIEW"),
      addToCart: count("ADD_TO_CART"),
      removeFromCart: count("REMOVE_FROM_CART"),
      checkoutStarts: checkoutGroups.length,
      checkoutFailures: failureGroups.length,
      orders: orderGroups.filter((g: any) => g.orderId).length,
      unitsOrdered: ordered?._sum?.quantity ?? 0,
      orderedValueMinor: ordered?._sum?.valueMinor ?? 0,
      failureReasons: CHECKOUT_FAILURE_REASONS.map((reason) => ({ reason, attempts: reasons[reason] ?? 0 })).filter((x) => x.attempts > 0),
    };
  }

  /** Journeys (sessions) that reached each stage; capped so a huge range can't load unbounded rows. */
  async function journeyFunnel(vendorId: string | null, r: Range, productId?: string) {
    const cap = 50_000;
    const rows = await guard(
      events().groupBy({
        by: ["sessionKey", "type"],
        where: { ...scopeWhere(vendorId), ...dayWhere(r), ...(productId ? { productId } : {}), type: { in: ["PRODUCT_VIEW", "ADD_TO_CART", "CHECKOUT_STARTED", "ORDER_PLACED"] } },
        _count: { _all: true },
        orderBy: { sessionKey: "asc" },
        take: cap + 1,
      })
    );
    const truncated = rows.length > cap;
    const stagesBy = new Map<string, Set<string>>();
    const buyNow = new Set<string>();
    for (const row of rows.slice(0, cap)) {
      if (!stagesBy.has(row.sessionKey)) stagesBy.set(row.sessionKey, new Set());
      stagesBy.get(row.sessionKey)!.add(row.type);
    }
    // Buy-Now journeys (direct path): ADD_TO_CART recorded with source BUY_NOW
    const direct = await guard(
      events().groupBy({
        by: ["sessionKey"],
        where: { ...scopeWhere(vendorId), ...dayWhere(r), ...(productId ? { productId } : {}), type: "ADD_TO_CART", source: "BUY_NOW" },
        _count: { _all: true },
        orderBy: { sessionKey: "asc" },
        take: cap,
      })
    );
    for (const d of direct) buyNow.add(d.sessionKey);
    const reached = (t: string, onlyDirect?: boolean) =>
      [...stagesBy.entries()].filter(([k, s]) => s.has(t) && (onlyDirect === undefined || buyNow.has(k) === onlyDirect)).length;
    const stage = (key: string, label: string, t: string, prev: number | null, direct?: boolean) => {
      const value = reached(t, direct);
      return { key, label, journeys: value, fromPrevious: prev === null ? null : ratio(value, prev), dropOff: prev === null ? null : Math.max(prev - value, 0) };
    };
    const build = (direct?: boolean) => {
      const v = stage("views", "Viewed a product", "PRODUCT_VIEW", null, direct);
      const c = stage("cart", "Added to cart", "ADD_TO_CART", v.journeys, direct);
      const k = stage("checkout", "Started checkout", "CHECKOUT_STARTED", c.journeys, direct);
      const o = stage("order", "Placed an order", "ORDER_PLACED", k.journeys, direct);
      return [v, c, k, o];
    };
    return {
      basis: "journeys" as const,
      truncated,
      totalJourneys: stagesBy.size,
      stages: build(),
      paths: {
        cart: { label: "Add to cart → checkout", stages: build(false).slice(1) },
        buyNow: { label: "Buy Now → checkout", stages: build(true).slice(1) },
      },
    };
  }

  /** Customer-based checkout abandonment (see header). */
  async function checkoutAbandonment(vendorId: string | null, r: Range) {
    // Phase 2 audit (B2): the latest checkout INSIDE the range, and orders up
    // to one day after it, are read separately — a single max over the
    // extended window let a next-day checkout hide the in-range one.
    const latest = (type: string, rr: Range) =>
      guard(
        events().groupBy({
          by: ["actorKey"],
          where: { ...scopeWhere(vendorId), ...dayWhere(rr), type },
          _max: { occurredAt: true },
          orderBy: { actorKey: "asc" },
          take: 50_001,
        })
      );
    const [checkoutRows, orderRows] = await Promise.all([latest("CHECKOUT_STARTED", r), latest("ORDER_PLACED", { ...r, to: addDays(r.to, 1) })]);
    const per = new Map<string, { checkout?: Date; order?: Date }>();
    for (const row of checkoutRows) if (row._max?.occurredAt) per.set(row.actorKey, { checkout: new Date(row._max.occurredAt) });
    for (const row of orderRows) {
      const e = per.get(row.actorKey);
      if (e && row._max?.occurredAt) e.order = new Date(row._max.occurredAt);
    }
    const cutoff = now().getTime() - ANALYTICS_LIMITS.abandonAfterHours * 3_600_000;
    let started = 0,
      converted = 0,
      abandoned = 0,
      inProgress = 0;
    for (const e of per.values()) {
      if (!e.checkout) continue;
      started++;
      if (e.order && e.order.getTime() >= e.checkout.getTime()) converted++;
      else if (e.checkout.getTime() < cutoff) abandoned++;
      else inProgress++;
    }
    return { customersStarted: started, converted, abandoned, inProgress, abandonmentRate: ratio(abandoned, started - inProgress), windowHours: ANALYTICS_LIMITS.abandonAfterHours };
  }

  async function dailySeries(vendorId: string | null, r: Range, productId?: string) {
    const where = { ...scopeWhere(vendorId), ...dayWhere(r), ...(productId ? { productId } : {}) };
    const [byDayType, checkoutDays, orderDays] = await Promise.all([
      guard(events().groupBy({ by: ["day", "type"], where: { ...where, type: { in: ["PRODUCT_VIEW", "ADD_TO_CART"] } }, _count: { _all: true } })),
      guard(events().groupBy({ by: ["day", "groupKey"], where: { ...where, type: "CHECKOUT_STARTED" }, _count: { _all: true } })),
      guard(events().groupBy({ by: ["day", "orderId"], where: { ...where, type: "ORDER_PLACED" }, _count: { _all: true } })),
    ]);
    const series = new Map<string, { day: string; views: number; addToCart: number; checkoutStarts: number; orders: number }>();
    for (let d = r.from; d.getTime() <= r.to.getTime(); d = addDays(d, 1)) series.set(isoDay(d), { day: isoDay(d), views: 0, addToCart: 0, checkoutStarts: 0, orders: 0 });
    const at = (day: unknown) => series.get(isoDay(new Date(day as any)));
    for (const g of byDayType) {
      const s = at(g.day);
      if (!s) continue;
      if (g.type === "PRODUCT_VIEW") s.views += g._count._all;
      if (g.type === "ADD_TO_CART") s.addToCart += g._count._all;
    }
    for (const g of checkoutDays) at(g.day) && at(g.day)!.checkoutStarts++;
    for (const g of orderDays) if (g.orderId) at(g.day) && at(g.day)!.orders++;
    return [...series.values()];
  }

  /** Authoritative order / payment figures (include orders placed before tracking began). */
  async function orderOutcomes(vendorId: string | null, r: Range) {
    const createdAt = instantBounds(r);
    const where = { ...scopeWhere(vendorId), createdAt };
    const [placed, cancelled, paid, paymentFailed, cod, revenue] = await Promise.all([
      db.vendorOrder.count({ where }),
      db.vendorOrder.count({ where: { ...where, status: "CANCELLED" } }),
      db.vendorOrder.count({ where: { ...where, order: { paymentStatus: "PAID" } } }),
      db.vendorOrder.count({ where: { ...where, order: { paymentStatus: "FAILED" } } }),
      db.vendorOrder.count({ where: { ...where, order: { paymentmethod: "COD" } } }),
      db.vendorOrder.aggregate({ where: { ...where, status: { notIn: ["CANCELLED"] } }, _sum: { subtotal: true } }),
    ]);
    return {
      ordersPlaced: placed,
      cancelled,
      paid,
      paymentFailed,
      cashOnDelivery: cod,
      revenueMinor: Math.round(Number(revenue?._sum?.subtotal ?? 0) * 100),
    };
  }

  function insightsFrom(k: ReturnType<typeof kpiShape>, abandonment: Awaited<ReturnType<typeof checkoutAbandonment>>, failures: { reason: string; attempts: number }[], prevFailures: number) {
    const min = ANALYTICS_LIMITS.insightMinSample;
    const out: { id: string; tone: "info" | "warning" | "positive"; fact: string; hypothesis: string | null; sample: number }[] = [];
    if (k.views >= min && k.viewToCart !== null && k.viewToCart < 2) {
      out.push({ id: "low-view-to-cart", tone: "warning", fact: `Only ${k.viewToCart}% of product views led to an add-to-cart (${k.addToCart} of ${k.views}).`, hypothesis: "Price, photos, delivery information or stock on the product pages may be holding customers back.", sample: k.views });
    }
    if (k.checkoutStarts >= min && k.checkoutToOrder !== null && k.checkoutToOrder < 50) {
      out.push({ id: "checkout-drop", tone: "warning", fact: `${k.checkoutToOrder}% of checkout starts became orders (${k.orders} of ${k.checkoutStarts}).`, hypothesis: "Delivery charges or availability at checkout may be causing customers to leave.", sample: k.checkoutStarts });
    }
    const totalFailures = failures.reduce((s, f) => s + f.attempts, 0);
    const top = [...failures].sort((a, b) => b.attempts - a.attempts)[0];
    if (top && totalFailures >= Math.max(5, Math.floor(min / 2))) {
      out.push({ id: `failure-${top.reason}`, tone: "warning", fact: `${top.attempts} of ${totalFailures} failed checkout attempts were ${FAILURE_COPY[top.reason]?.toLowerCase() ?? "other errors"}.`, hypothesis: FAILURE_HINT[top.reason] ?? null, sample: totalFailures });
    }
    if (prevFailures >= 5 && totalFailures >= prevFailures * 1.5) {
      out.push({ id: "failures-up", tone: "warning", fact: `Failed checkout attempts rose from ${prevFailures} to ${totalFailures} compared with the previous period.`, hypothesis: null, sample: totalFailures });
    }
    const decided = abandonment.customersStarted - abandonment.inProgress;
    if (decided >= min && abandonment.abandonmentRate !== null && abandonment.abandonmentRate >= 60) {
      out.push({ id: "abandonment", tone: "warning", fact: `${abandonment.abandonmentRate}% of customers who started checkout did not order within ${abandonment.windowHours} hours (${abandonment.abandoned} of ${decided}).`, hypothesis: "Consider reviewing delivery fees and payment options shown at checkout.", sample: decided });
    }
    if (k.views >= min && k.viewToCart !== null && k.viewToCart >= 10) {
      out.push({ id: "strong-interest", tone: "positive", fact: `${k.viewToCart}% of product views led to an add-to-cart — strong interest.`, hypothesis: null, sample: k.views });
    }
    return out;
  }

  function kpiShape(t: Awaited<ReturnType<typeof eventTotals>>) {
    return {
      views: t.views,
      addToCart: t.addToCart,
      checkoutStarts: t.checkoutStarts,
      orders: t.orders,
      unitsOrdered: t.unitsOrdered,
      orderedValueMinor: t.orderedValueMinor,
      checkoutFailures: t.checkoutFailures,
      viewToCart: ratio(t.addToCart, t.views),
      cartToCheckout: ratio(t.checkoutStarts, t.addToCart),
      checkoutToOrder: ratio(t.orders, t.checkoutStarts),
    };
  }

  return {
    async overview(scope: { vendorId: string | null }, q: { from?: unknown; to?: unknown; productId?: unknown }) {
      events(); // not set up → throw BEFORE any parallel query starts (no dangling rejections)
      const r = resolveRange(q, now());
      const prev = previousRange(r);
      const productId = typeof q.productId === "string" && q.productId ? q.productId : undefined;
      const [cur, before, funnel, abandonment, series, orders, ordersPrev, first] = await Promise.all([
        eventTotals(scope.vendorId, r, productId),
        eventTotals(scope.vendorId, prev, productId),
        journeyFunnel(scope.vendorId, r, productId),
        checkoutAbandonment(scope.vendorId, r),
        dailySeries(scope.vendorId, r, productId),
        productId ? Promise.resolve(null) : orderOutcomes(scope.vendorId, r),
        productId ? Promise.resolve(null) : orderOutcomes(scope.vendorId, prev),
        guard(events().aggregate({ where: scopeWhere(scope.vendorId), _min: { occurredAt: true } })),
      ]);
      const k = kpiShape(cur);
      const p = kpiShape(before);
      // counts: % change vs the previous period; rates: change in percentage points
      const kpis = Object.fromEntries(
        (Object.keys(k) as (keyof typeof k)[]).map((key) => {
          const value = k[key];
          const previous = p[key];
          const isRate = RATE_KEYS.has(key);
          return [
            key,
            {
              value,
              previous,
              change: isRate || value === null || previous === null ? null : change(value, previous),
              pointsChange: isRate && value !== null && previous !== null ? Math.round((value - previous) * 100) / 100 : null,
            },
          ];
        })
      );
      return {
        scope: { vendorId: scope.vendorId, platform: scope.vendorId === null },
        range: { from: isoDay(r.from), to: isoDay(r.to), days: r.days, timezone: ANALYTICS_TIMEZONE },
        comparison: { from: isoDay(prev.from), to: isoDay(prev.to) },
        productId: productId ?? null,
        trackingStartedAt: first?._min?.occurredAt ? new Date(first._min.occurredAt).toISOString() : null,
        kpis,
        funnel,
        abandonment,
        series,
        failureReasons: cur.failureReasons,
        orders: orders && ordersPrev ? { current: orders, previous: ordersPrev } : null,
        insights: insightsFrom(k, abandonment, cur.failureReasons, before.checkoutFailures),
        definitions: DEFINITIONS,
      };
    },

    async products(scope: { vendorId: string | null }, q: { from?: unknown; to?: unknown; q?: unknown; sort?: unknown; page?: unknown; pageSize?: unknown }) {
      events();
      const r = resolveRange(q, now());
      const prev = previousRange(r);
      const pageSize = Math.min(Math.max(Number(q.pageSize) || 10, 1), ANALYTICS_LIMITS.productsPageMax);
      const page = Math.max(Number(q.page) || 1, 1);
      const sortKey = (["views", "addToCart", "checkoutStarts", "orders", "orderedValueMinor", "conversion"] as const).find((s) => s === q.sort) ?? "views";
      const where = (rr: Range) => ({ ...scopeWhere(scope.vendorId), ...dayWhere(rr) });
      const [byProductType, ordersByProduct, prevByProduct] = await Promise.all([
        guard(events().groupBy({ by: ["productId", "type"], where: where(r), _count: { _all: true }, _sum: { quantity: true, valueMinor: true } })),
        guard(events().groupBy({ by: ["productId", "orderId"], where: { ...where(r), type: "ORDER_PLACED" }, _count: { _all: true } })),
        guard(events().groupBy({ by: ["productId", "type"], where: { ...where(prev), type: { in: ["PRODUCT_VIEW", "ORDER_PLACED"] } }, _count: { _all: true } })),
      ]);
      const stats = new Map<string, any>();
      const row = (id: string) => {
        if (!stats.has(id)) stats.set(id, { productId: id, views: 0, addToCart: 0, checkoutStarts: 0, orders: 0, unitsOrdered: 0, orderedValueMinor: 0, previousViews: 0, previousOrderLines: 0 });
        return stats.get(id);
      };
      for (const g of byProductType) {
        const s = row(g.productId);
        if (g.type === "PRODUCT_VIEW") s.views = g._count._all;
        if (g.type === "ADD_TO_CART") s.addToCart = g._count._all;
        if (g.type === "CHECKOUT_STARTED") s.checkoutStarts = g._count._all;
        if (g.type === "ORDER_PLACED") {
          s.unitsOrdered = g._sum?.quantity ?? 0;
          s.orderedValueMinor = g._sum?.valueMinor ?? 0;
        }
      }
      for (const g of ordersByProduct) if (g.orderId) row(g.productId).orders++;
      for (const g of prevByProduct) {
        if (!stats.has(g.productId)) continue;
        if (g.type === "PRODUCT_VIEW") stats.get(g.productId).previousViews = g._count._all;
        if (g.type === "ORDER_PLACED") stats.get(g.productId).previousOrderLines = g._count._all;
      }
      const ids = [...stats.keys()];
      const products = ids.length
        ? await db.product.findMany({
            where: { id: { in: ids }, ...scopeWhere(scope.vendorId) },
            select: { id: true, name: true, slug: true, vendorId: true, images: { select: { url: true }, take: 1 } },
          })
        : [];
      const info = new Map(products.map((p: any) => [p.id, p]));
      const term = typeof q.q === "string" ? q.q.trim().toLowerCase() : "";
      let list = [...stats.values()]
        .filter((s) => info.has(s.productId)) // a product outside the scope never appears
        .map((s) => {
          const p: any = info.get(s.productId);
          return {
            ...s,
            name: p.name,
            slug: p.slug,
            thumbnail: p.images?.[0]?.url ?? null,
            conversion: ratio(s.orders, s.views),
            viewsChange: change(s.views, s.previousViews),
          };
        });
      if (term) list = list.filter((s) => s.name.toLowerCase().includes(term) || s.productId.toLowerCase() === term);
      list.sort((a, b) => (b[sortKey] ?? -1) - (a[sortKey] ?? -1) || a.name.localeCompare(b.name));
      const total = list.length;
      return {
        range: { from: isoDay(r.from), to: isoDay(r.to), days: r.days, timezone: ANALYTICS_TIMEZONE },
        sort: sortKey,
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
        items: list.slice((page - 1) * pageSize, page * pageSize),
      };
    },

    /**
     * Recent journeys that touched the scope's products. Each journey shows
     * only the events on those products (another vendor's steps in the same
     * session are never included) and no customer identity.
     */
    async journeys(scope: { vendorId: string | null }, q: { from?: unknown; to?: unknown; page?: unknown; productId?: unknown }) {
      events();
      const r = resolveRange(q, now());
      const page = Math.max(Number(q.page) || 1, 1);
      const size = ANALYTICS_LIMITS.journeysPageSize;
      const productId = typeof q.productId === "string" && q.productId ? q.productId : undefined;
      const where = { ...scopeWhere(scope.vendorId), ...dayWhere(r), ...(productId ? { productId } : {}) };
      const [groups, totalGroups] = await Promise.all([
        guard(events().groupBy({ by: ["sessionKey"], where, _max: { occurredAt: true }, _min: { occurredAt: true }, orderBy: { _max: { occurredAt: "desc" } }, skip: (page - 1) * size, take: size })),
        guard(events().groupBy({ by: ["sessionKey"], where, _count: { _all: true }, orderBy: { sessionKey: "asc" }, take: 10_001 })),
      ]);
      const keys = groups.map((g: any) => g.sessionKey);
      // Phase 2 audit (B1): each journey's LATEST steps, capped per journey —
      // one shared cap let a long journey starve the others of their steps.
      const max = ANALYTICS_LIMITS.journeyMaxEvents;
      const perJourney = await Promise.all(
        keys.map((key: string) =>
          guard(
            events().findMany({
              where: { ...scopeWhere(scope.vendorId), sessionKey: key },
              orderBy: { occurredAt: "desc" },
              take: max + 1,
              select: { type: true, occurredAt: true, productId: true, sessionKey: true, actorKey: true, source: true, reason: true, quantity: true, orderId: true },
            })
          )
        )
      );
      const truncatedKeys = new Set(keys.filter((_k: string, i: number) => perJourney[i].length > max));
      const rows = perJourney.flatMap((list: any[]) => list.slice(0, max).reverse());
      // A truncated journey's start, outcome and path must still reflect ALL
      // its steps, not just the displayed ones: one small aggregate per page
      // (≤ 20 journeys × step types × sources) gives each journey's first
      // event time, every step type it recorded, and whether Buy Now was used.
      const facts = keys.length
        ? await guard(
            events().groupBy({
              by: ["sessionKey", "type", "source"],
              where: { ...scopeWhere(scope.vendorId), sessionKey: { in: keys } },
              _min: { occurredAt: true },
              orderBy: [{ sessionKey: "asc" }, { type: "asc" }],
            })
          )
        : [];
      const factsBy = new Map<string, { types: Set<string>; buyNow: boolean; first: Date | null }>();
      for (const g of facts) {
        const e = factsBy.get(g.sessionKey) ?? { types: new Set<string>(), buyNow: false, first: null };
        e.types.add(g.type);
        if (g.type === "ADD_TO_CART" && g.source === "BUY_NOW") e.buyNow = true;
        const at = g._min?.occurredAt ? new Date(g._min.occurredAt) : null;
        if (at && (!e.first || at < e.first)) e.first = at;
        factsBy.set(g.sessionKey, e);
      }
      const orderIds = [...new Set(rows.filter((e: any) => e.orderId).map((e: any) => e.orderId))];
      const actors = [...new Set(rows.map((e: any) => e.actorKey))];
      const [orders, laterOrders, products] = await Promise.all([
        orderIds.length ? db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, status: true, paymentStatus: true, paymentmethod: true } }) : [],
        actors.length ? guard(events().groupBy({ by: ["actorKey"], where: { ...scopeWhere(scope.vendorId), actorKey: { in: actors }, type: "ORDER_PLACED" }, _max: { occurredAt: true } })) : [],
        db.product.findMany({ where: { id: { in: [...new Set(rows.map((e: any) => e.productId))] }, ...scopeWhere(scope.vendorId) }, select: { id: true, name: true, images: { select: { url: true }, take: 1 } } }),
      ]);
      const orderById = new Map(orders.map((o: any) => [o.id, o]));
      const lastOrderByActor = new Map<string, Date | null>(laterOrders.map((g: any) => [g.actorKey, g._max?.occurredAt ? new Date(g._max.occurredAt) : null]));
      const productById = new Map(products.map((p: any) => [p.id, p]));
      const cutoff = now().getTime() - ANALYTICS_LIMITS.abandonAfterHours * 3_600_000;

      const items = keys.map((key: string) => {
        const steps = rows.filter((e: any) => e.sessionKey === key);
        const fact = factsBy.get(key);
        const types = fact?.types ?? new Set(steps.map((s: any) => s.type));
        const last = steps[steps.length - 1];
        const lastAt = last ? new Date(last.occurredAt) : new Date(0);
        const actor = steps[0]?.actorKey;
        let outcome: string;
        const placed = steps.filter((s: any) => s.type === "ORDER_PLACED").map((s: any) => orderById.get(s.orderId)).filter(Boolean);
        if (placed.length) {
          const o: any = placed[placed.length - 1];
          // Phase 2 audit (B3): refunded / returned orders were falling through to "payment pending".
          outcome =
            o.status === "CANCELLED"
              ? "ORDER_CANCELLED"
              : o.status === "REFUNDED" || o.status === "RETURNED" || o.paymentStatus === "REFUNDED" || o.paymentStatus === "PARTIALLY_REFUNDED"
                ? "ORDER_REFUNDED"
                : o.paymentStatus === "PAID"
                  ? "ORDERED_PAID"
                  : o.paymentStatus === "FAILED"
                    ? "PAYMENT_FAILED"
                    : o.paymentmethod === "COD"
                      ? "ORDERED_COD"
                      : "ORDERED_PAYMENT_PENDING";
        } else if (types.has("ORDER_PLACED")) outcome = "ORDERED";
        else if (actor && lastOrderByActor.get(actor) && lastOrderByActor.get(actor)!.getTime() > lastAt.getTime()) outcome = "ORDERED_LATER";
        else if (last?.type === "CHECKOUT_FAILED") outcome = "CHECKOUT_FAILED";
        else if (lastAt.getTime() >= cutoff) outcome = "IN_PROGRESS";
        else if (types.has("CHECKOUT_STARTED")) outcome = "ABANDONED_CHECKOUT";
        else if (types.has("ADD_TO_CART")) outcome = "ABANDONED_CART";
        else outcome = "BROWSED";
        const buyNow = fact?.buyNow ?? steps.some((s: any) => s.type === "ADD_TO_CART" && s.source === "BUY_NOW");
        const path = buyNow ? "BUY_NOW" : types.has("ADD_TO_CART") || types.has("CHECKOUT_STARTED") ? "CART" : "BROWSE";
        const first = fact?.first ?? (steps[0] ? new Date(steps[0].occurredAt) : lastAt);
        return {
          id: journeyLabel(key),
          stepsTruncated: truncatedKeys.has(key),
          startedAt: first.toISOString(),
          lastActivityAt: lastAt.toISOString(),
          durationSeconds: Math.max(Math.round((lastAt.getTime() - first.getTime()) / 1000), 0),
          path,
          outcome,
          products: [...new Set(steps.map((s: any) => s.productId))].map((id) => ({ id, name: (productById.get(id) as any)?.name ?? "Unavailable product", thumbnail: (productById.get(id) as any)?.images?.[0]?.url ?? null })),
          steps: steps.map((s: any, i: number) => ({
            type: s.type,
            at: new Date(s.occurredAt).toISOString(),
            secondsSincePrevious: i === 0 ? null : Math.round((new Date(s.occurredAt).getTime() - new Date(steps[i - 1].occurredAt).getTime()) / 1000),
            productId: s.productId,
            productName: (productById.get(s.productId) as any)?.name ?? "Unavailable product",
            source: s.source,
            reason: s.reason,
            quantity: s.quantity,
          })),
        };
      });
      const total = Math.min(totalGroups.length, 10_000);
      return {
        range: { from: isoDay(r.from), to: isoDay(r.to), days: r.days, timezone: ANALYTICS_TIMEZONE },
        page,
        pageSize: size,
        total,
        totalPages: Math.max(Math.ceil(total / size), 1),
        items,
        abandonAfterHours: ANALYTICS_LIMITS.abandonAfterHours,
        replayNotice: "Event-based journey replay — a timeline of recorded shopping events, not a recording of the customer's screen.",
      };
    },
  };
}

export const FAILURE_COPY: Record<string, string> = {
  STOCK_UNAVAILABLE: "Stock unavailable",
  SHIPPING_UNAVAILABLE: "Delivery unavailable",
  ADDRESS_INVALID: "Address problem",
  PRICE_CHANGED: "Price changed at checkout",
  QUOTE_REVIEW_REQUIRED: "Checkout needed re-confirmation",
  CART_CHANGED: "Cart changed during checkout",
  VALIDATION: "Missing or invalid details",
  OTHER: "Other errors",
};
const FAILURE_HINT: Record<string, string> = {
  STOCK_UNAVAILABLE: "Keeping stock levels up to date may reduce these failures.",
  SHIPPING_UNAVAILABLE: "Some delivery areas may not be covered by your courier settings.",
  ADDRESS_INVALID: "Customers may be having trouble with the address step.",
  PRICE_CHANGED: "Frequent price changes may be interrupting checkouts.",
};

export const DEFINITIONS = {
  timezone: "Days are calendar days in Asia/Dhaka. The comparison period is the equally long period immediately before.",
  views: "Product page views by customers and visitors — at most one per browsing session, product and 30 minutes. Bots and staff accounts are excluded.",
  addToCart: "Successful add-to-cart actions (only counted after the cart was updated).",
  checkoutStarts: "Checkout attempts: a customer opened checkout with items selected. Repeat visits within 30 minutes with the same items count once.",
  orders: "Orders that included your products, recorded when the order was placed.",
  funnel: "Journey-based: each stage counts browsing sessions in the range that recorded that step at least once. Not a strict cohort — a session can reach checkout after viewing the product in an earlier session.",
  abandonment: "Customers whose latest checkout start in the range has no order with your store after it, once 24 hours have passed. Newer ones are shown as in progress.",
  ordersAuthoritative: "From your order records (all channels, including orders placed before tracking began). Revenue = subtotals of orders that weren't cancelled.",
  history: "Tracking started on the date shown; earlier views, carts and checkouts were never recorded and are not estimated.",
  impressions: "Product impressions in listings are not measured.",
};

export const businessAdvisorService = createBusinessAdvisorService(prisma as unknown as AdvisorDb);
