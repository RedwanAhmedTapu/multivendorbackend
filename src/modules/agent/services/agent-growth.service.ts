// src/modules/agent/services/agent-growth.service.ts
//
// Phase 9 — shared growth metrics, the performance score and the leaderboard.
// Everything here is computed on read; nothing is stored.
//
// Delivered sales = Σ (delivered − returned units) × OrderItem.price over the
// agent's commission rows, i.e. the VAT-exclusive value of attributed lines
// that were actually delivered and not refunded. Delivered orders = distinct
// vendor orders among those rows.
//
// Performance score (0–100): only when the admin saved performanceWeights.
// Factors over the last PERFORMANCE_WINDOW_DAYS (Asia/Dhaka-agnostic rolling window):
//   vendorActivity  % of the agent's open-linked vendors with ≥1 new order
//   sales           percentile of delivered sales among ACTIVE agents
//   growth          percentile of sales growth vs the previous window
//   satisfaction    average published review rating on the agent's vendors' products × 20
// A factor with no data (no reviews; no sales in either window) is left out
// and the remaining weights are re-normalized. Percentiles make the score
// relative, so no sales target has to be hardcoded.
//
// Leaderboard: ACTIVE agents ranked by net commission earned in the period
// (today / this week from Monday / this month — Asia/Dhaka — or all time).
// PRIVACY: other agents are shown as name, avatar, rank and a 0–100 score
// relative to the leader; only the viewer sees their own ৳ amount.

import Decimal from "decimal.js";
import { agentDb } from "../agent-db.ts";
import { getAgentSettings, PERFORMANCE_FACTORS, type PerformanceWeights } from "./agent-settings.service.ts";

export const PERFORMANCE_WINDOW_DAYS = 30;
const DAY = 24 * 3600_000;
const DHAKA = 6 * 3600_000;

const dec = (v: unknown) => new Decimal(v == null ? 0 : (v as any).toString());

// ── Asia/Dhaka periods ────────────────────────────────────────────────────

export type LeaderboardPeriod = "daily" | "weekly" | "monthly" | "all";

/** Start (UTC instant) of the Dhaka day / Monday-week / month containing `now`. */
export function dhakaPeriodStart(now: Date, period: Exclude<LeaderboardPeriod, "all">): Date {
  const d = new Date(now.getTime() + DHAKA);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === "daily") return new Date(dayStart - DHAKA);
  if (period === "weekly") {
    const sinceMonday = (d.getUTCDay() + 6) % 7;
    return new Date(dayStart - sinceMonday * DAY - DHAKA);
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - DHAKA);
}

/** "YYYY-MM" of `date` in Asia/Dhaka. */
export function dhakaMonthKey(date: Date): string {
  return new Date(date.getTime() + DHAKA).toISOString().slice(0, 7);
}

/** [start, end) of a Dhaka month key. */
export function dhakaMonthRange(key: string): { from: Date; to: Date } {
  const [y, m] = key.split("-").map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1) - DHAKA), to: new Date(Date.UTC(y, m, 1) - DHAKA) };
}

// ── delivered sales ───────────────────────────────────────────────────────

export type DeliveredStats = { sales: Decimal; orders: number };

/**
 * Delivered sales and orders per agent (or per agent+vendor with byVendor)
 * from commission rows matching the filter.
 */
export async function deliveredStats(
  filter: { agentIds?: string[]; vendorId?: string; from?: Date; to?: Date },
  opts: { byVendor?: boolean } = {},
  db: any = agentDb.prisma,
): Promise<Map<string, DeliveredStats>> {
  const where: any = {};
  if (filter.agentIds) where.agentId = { in: filter.agentIds };
  if (filter.vendorId) where.vendorId = filter.vendorId;
  if (filter.from || filter.to) where.earnedAt = { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) };
  const rows: Array<{ agentId: string; vendorId: string; vendorOrderId: string; orderItemId: string; quantity: number; reversedQty: number }> =
    await db.agentCommission.findMany({ where, select: { agentId: true, vendorId: true, vendorOrderId: true, orderItemId: true, quantity: true, reversedQty: true } });
  const itemIds = [...new Set(rows.map((r) => r.orderItemId))];
  const items = itemIds.length ? await db.orderItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, price: true } }) : [];
  const price = new Map<string, Decimal>(items.map((i: any) => [i.id, dec(i.price)]));
  const acc = new Map<string, { sales: Decimal; orders: Set<string> }>();
  for (const r of rows) {
    const units = r.quantity - r.reversedQty;
    if (units <= 0) continue;
    const key = opts.byVendor ? `${r.agentId}:${r.vendorId}` : r.agentId;
    const a = acc.get(key) ?? { sales: new Decimal(0), orders: new Set<string>() };
    a.sales = a.sales.plus((price.get(r.orderItemId) ?? new Decimal(0)).times(units));
    a.orders.add(r.vendorOrderId);
    acc.set(key, a);
  }
  return new Map([...acc].map(([k, v]) => [k, { sales: v.sales, orders: v.orders.size }]));
}

/** Open links whose vendor is ACTIVE ("active vendors" for levels and bonuses). */
export async function activeVendorCount(agentId: string, db: any = agentDb.prisma): Promise<number> {
  return db.agentVendorLink.count({ where: { agentId, endedAt: null, vendor: { status: "ACTIVE" } } });
}

// ── performance score ─────────────────────────────────────────────────────

/** Percentile (0–100) of `value` among `all` (ties count half); 100/0 when alone. */
export function percentileOf(value: number, all: number[]): number {
  if (all.length <= 1) return value > 0 ? 100 : 0;
  let below = 0;
  let equal = 0;
  for (const v of all) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  return Math.round(((below + (equal - 1) / 2) / (all.length - 1)) * 1000) / 10;
}

export type PerformanceFactors = { vendorActivity: number | null; sales: number | null; growth: number | null; satisfaction: number | null };

/** Weighted score over the factors that have data; null when none do. */
export function weightedScore(f: PerformanceFactors, w: PerformanceWeights): number | null {
  let sum = 0;
  let weights = 0;
  for (const k of PERFORMANCE_FACTORS) {
    const v = f[k];
    if (v == null || w[k] === 0) continue;
    sum += v * w[k];
    weights += w[k];
  }
  return weights === 0 ? null : Math.round((sum / weights) * 10) / 10;
}

type AgentRaw = { agentId: string; openVendors: number; activeVendors: number; sales: number; prevSales: number; ratingSum: number; ratingCount: number };

let perfCache: { at: number; key: string; data: Map<string, { factors: PerformanceFactors; raw: AgentRaw }> } | null = null;
export const PERFORMANCE_CACHE_MS = 5 * 60_000;
export function invalidatePerformanceCache() {
  perfCache = null;
}

/** Factors for every ACTIVE agent (percentiles need the whole population). Cached 5 min. */
export async function allAgentFactors(now: Date = new Date()): Promise<Map<string, { factors: PerformanceFactors; raw: AgentRaw }>> {
  const key = String(Math.floor(now.getTime() / PERFORMANCE_CACHE_MS));
  if (perfCache && perfCache.key === key && Date.now() - perfCache.at < PERFORMANCE_CACHE_MS) return perfCache.data;
  const db = agentDb.prisma as any;
  const from = new Date(now.getTime() - PERFORMANCE_WINDOW_DAYS * DAY);
  const prevFrom = new Date(now.getTime() - 2 * PERFORMANCE_WINDOW_DAYS * DAY);
  const agents: Array<{ id: string }> = await db.agent.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const agentIds = agents.map((a) => a.id);
  const links: Array<{ agentId: string; vendorId: string }> = agentIds.length
    ? await db.agentVendorLink.findMany({ where: { agentId: { in: agentIds }, endedAt: null }, select: { agentId: true, vendorId: true } })
    : [];
  const vendorIds = [...new Set(links.map((l) => l.vendorId))];
  const [cur, prev, orderGroups, reviews] = await Promise.all([
    deliveredStats({ agentIds, from, to: new Date(now.getTime() + 1) }, {}, db),
    deliveredStats({ agentIds, from: prevFrom, to: from }, {}, db),
    vendorIds.length ? db.vendorOrder.groupBy({ by: ["vendorId"], where: { vendorId: { in: vendorIds }, createdAt: { gte: from } }, _count: { _all: true } }) : [],
    vendorIds.length
      ? db.review.findMany({ where: { status: "PUBLISHED", createdAt: { gte: from }, product: { vendorId: { in: vendorIds } } }, select: { rating: true, product: { select: { vendorId: true } } } })
      : [],
  ]);
  const orderingVendors = new Set<string>(orderGroups.filter((g: any) => g._count._all > 0).map((g: any) => g.vendorId));
  const ratingByVendor = new Map<string, { sum: number; count: number }>();
  for (const r of reviews) {
    const v = ratingByVendor.get(r.product.vendorId) ?? { sum: 0, count: 0 };
    v.sum += r.rating;
    v.count += 1;
    ratingByVendor.set(r.product.vendorId, v);
  }

  const raw = new Map<string, AgentRaw>();
  for (const id of agentIds) raw.set(id, { agentId: id, openVendors: 0, activeVendors: 0, sales: 0, prevSales: 0, ratingSum: 0, ratingCount: 0 });
  for (const l of links) {
    const r = raw.get(l.agentId)!;
    r.openVendors += 1;
    if (orderingVendors.has(l.vendorId)) r.activeVendors += 1;
    const rv = ratingByVendor.get(l.vendorId);
    if (rv) {
      r.ratingSum += rv.sum;
      r.ratingCount += rv.count;
    }
  }
  for (const [id, s] of cur) if (raw.has(id)) raw.get(id)!.sales = s.sales.toNumber();
  for (const [id, s] of prev) if (raw.has(id)) raw.get(id)!.prevSales = s.sales.toNumber();

  const salesAll = [...raw.values()].map((r) => r.sales);
  const growthOf = (r: AgentRaw): number | null => (r.prevSales > 0 ? (r.sales - r.prevSales) / r.prevSales : r.sales > 0 ? Number.MAX_SAFE_INTEGER : null);
  const growthAll = [...raw.values()].map(growthOf).filter((g): g is number => g != null);

  const data = new Map<string, { factors: PerformanceFactors; raw: AgentRaw }>();
  for (const r of raw.values()) {
    const g = growthOf(r);
    data.set(r.agentId, {
      raw: r,
      factors: {
        vendorActivity: r.openVendors ? Math.round((r.activeVendors / r.openVendors) * 1000) / 10 : null,
        sales: r.sales > 0 || r.prevSales > 0 ? percentileOf(r.sales, salesAll) : null,
        growth: g == null ? null : percentileOf(g, growthAll),
        satisfaction: r.ratingCount ? Math.round((r.ratingSum / r.ratingCount) * 20 * 10) / 10 : null,
      },
    });
  }
  perfCache = { at: Date.now(), key, data };
  return data;
}

/** The agent's performance score, or { configured: false } until the weights are saved. */
export async function performanceFor(agentId: string, now: Date = new Date()) {
  const settings = await getAgentSettings();
  const weights = settings.values.performanceWeights;
  if (!weights) {
    return { configured: false as const, message: "FinixMart hasn't set up the performance score yet. It appears here once the score weights are configured." };
  }
  const all = await allAgentFactors(now);
  const mine = all.get(agentId);
  const factors: PerformanceFactors = mine?.factors ?? { vendorActivity: null, sales: null, growth: null, satisfaction: null };
  const score = weightedScore(factors, weights);
  const scores = [...all.values()].map((x) => weightedScore(x.factors, weights)).filter((s): s is number => s != null);
  return {
    configured: true as const,
    windowDays: PERFORMANCE_WINDOW_DAYS,
    score,
    /** Share of ACTIVE agents scoring at or below this agent. */
    percentile: score == null ? null : percentileOf(score, scores),
    weights,
    factors,
    detail: mine
      ? {
          openVendors: mine.raw.openVendors,
          orderingVendors: mine.raw.activeVendors,
          deliveredSales: new Decimal(mine.raw.sales).toFixed(2),
          previousDeliveredSales: new Decimal(mine.raw.prevSales).toFixed(2),
          reviews: mine.raw.ratingCount,
          averageRating: mine.raw.ratingCount ? Math.round((mine.raw.ratingSum / mine.raw.ratingCount) * 10) / 10 : null,
        }
      : null,
  };
}

/** Score only (levels need it); null when not configured or no data. */
export async function performanceScoreOf(agentId: string, now: Date = new Date()): Promise<number | null> {
  const p = await performanceFor(agentId, now);
  return p.configured ? p.score : null;
}

// ── leaderboard ───────────────────────────────────────────────────────────

export async function leaderboard(agentId: string, period: LeaderboardPeriod, now: Date = new Date(), top = 10) {
  const db = agentDb.prisma as any;
  const where: any = period === "all" ? {} : { earnedAt: { gte: dhakaPeriodStart(now, period) } };
  const groups: Array<{ agentId: string; _sum: { amount: unknown; reversedAmount: unknown } }> = await db.agentCommission.groupBy({
    by: ["agentId"],
    where,
    _sum: { amount: true, reversedAmount: true },
  });
  const agents: Array<{ id: string; name: string; avatar: string | null }> = groups.length
    ? await db.agent.findMany({ where: { id: { in: groups.map((g) => g.agentId) }, status: "ACTIVE" }, select: { id: true, name: true, avatar: true } })
    : [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const ranked = groups
    .filter((g) => byId.has(g.agentId))
    .map((g) => ({ agentId: g.agentId, net: Decimal.max(dec(g._sum.amount).minus(dec(g._sum.reversedAmount)), 0) }))
    .filter((r) => r.net.gt(0))
    .sort((a, b) => b.net.comparedTo(a.net) || a.agentId.localeCompare(b.agentId));
  const leader = ranked[0]?.net ?? new Decimal(0);
  let rank = 0;
  let prev: Decimal | null = null;
  const rows = ranked.map((r, i) => {
    if (!prev || !r.net.eq(prev)) rank = i + 1; // competition ranking: ties share a rank
    prev = r.net;
    const a = byId.get(r.agentId)!;
    return {
      rank,
      agentId: r.agentId,
      name: a.name,
      avatar: a.avatar,
      score: leader.gt(0) ? r.net.dividedBy(leader).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber() : 0,
      net: r.net,
    };
  });
  const publicRow = (r: (typeof rows)[number]) => ({ rank: r.rank, name: r.name, avatar: r.avatar, score: r.score, isMe: r.agentId === agentId });
  const me = rows.find((r) => r.agentId === agentId);
  return {
    period,
    since: period === "all" ? null : dhakaPeriodStart(now, period),
    participants: rows.length,
    entries: rows.slice(0, top).map(publicRow),
    me: me ? { rank: me.rank, score: me.score, earned: me.net.toFixed(2) } : { rank: null, score: 0, earned: "0.00" },
  };
}
