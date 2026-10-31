// src/modules/agent/services/agent-alerts.service.ts
//
// Phase 9 — Vendor Activity Alerts, computed on read for the agent's
// open-linked vendors. Every threshold is the admin setting vendorAlertRules;
// until it is saved the screen says "not configured" and nothing is computed.
//   INACTIVITY   no new order for inactivityDays (vendors linked at least that long)
//   LOW_RATING   published reviews at or below lowRatingMax stars in lookbackDays
//   LOW_STOCK    active product variants at or below lowStockUnits
//   GROWTH_UP / GROWTH_DOWN  orders in the last lookbackDays vs the window before
//                changed by at least growthPercent (vendors with orders in both)
// PRIVACY: review alerts carry the product, rating, date and a short excerpt
// of the comment — never the reviewer.

import { agentDb } from "../agent-db.ts";
import { getAgentSettings } from "./agent-settings.service.ts";

export const ALERT_TYPES = ["INACTIVITY", "LOW_RATING", "LOW_STOCK", "GROWTH_UP", "GROWTH_DOWN"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
const DAY = 24 * 3600_000;
const MAX_PER_TYPE = 200;

export type VendorAlert = {
  id: string;
  type: AlertType;
  severity: "critical" | "warning" | "info";
  vendorId: string;
  storeName: string;
  title: string;
  detail: string;
  at: string;
};

export async function vendorAlerts(agentId: string, q: { type?: AlertType; page: number; limit: number }, now: Date = new Date()) {
  const settings = await getAgentSettings();
  const rules = settings.values.vendorAlertRules;
  if (!rules) {
    return { configured: false as const, message: "Vendor alerts start once FinixMart sets the alert thresholds.", items: [], total: 0, page: q.page, limit: q.limit, counts: {} };
  }
  const db = agentDb.prisma as any;
  const links: Array<{ vendorId: string; startedAt: Date; vendor: { storeName: string } }> = await db.agentVendorLink.findMany({
    where: { agentId, endedAt: null },
    select: { vendorId: true, startedAt: true, vendor: { select: { storeName: true } } },
  });
  const vendorIds = links.map((l) => l.vendorId);
  const store = new Map(links.map((l) => [l.vendorId, l.vendor?.storeName ?? "—"]));
  const alerts: VendorAlert[] = [];
  if (vendorIds.length) {
    const inactiveSince = new Date(now.getTime() - rules.inactivityDays * DAY);
    const lbFrom = new Date(now.getTime() - rules.lookbackDays * DAY);
    const lbPrev = new Date(now.getTime() - 2 * rules.lookbackDays * DAY);
    const [lastOrders, reviews, lowStock, cur, prev] = await Promise.all([
      db.vendorOrder.groupBy({ by: ["vendorId"], where: { vendorId: { in: vendorIds } }, _max: { createdAt: true } }),
      db.review.findMany({
        where: { status: "PUBLISHED", rating: { lte: rules.lowRatingMax }, createdAt: { gte: lbFrom }, product: { vendorId: { in: vendorIds } } },
        orderBy: { createdAt: "desc" },
        take: MAX_PER_TYPE,
        // PRIVACY: no user relation, no userId.
        select: { id: true, rating: true, comment: true, createdAt: true, product: { select: { name: true, vendorId: true } } },
      }),
      db.productVariant.findMany({
        where: { stock: { lte: rules.lowStockUnits }, product: { vendorId: { in: vendorIds }, isDeleted: false, approvalStatus: "ACTIVE" } },
        orderBy: { stock: "asc" },
        take: MAX_PER_TYPE,
        select: { id: true, sku: true, stock: true, product: { select: { name: true, vendorId: true } } },
      }),
      db.vendorOrder.groupBy({ by: ["vendorId"], where: { vendorId: { in: vendorIds }, createdAt: { gte: lbFrom }, status: { not: "CANCELLED" } }, _count: { _all: true } }),
      db.vendorOrder.groupBy({ by: ["vendorId"], where: { vendorId: { in: vendorIds }, createdAt: { gte: lbPrev, lt: lbFrom }, status: { not: "CANCELLED" } }, _count: { _all: true } }),
    ]);

    const last = new Map<string, Date | null>(lastOrders.map((g: any) => [g.vendorId, g._max.createdAt ?? null]));
    for (const l of links) {
      if (l.startedAt > inactiveSince) continue; // too recently linked to call inactive
      const at = last.get(l.vendorId) ?? null;
      if (at && at > inactiveSince) continue;
      const days = at ? Math.floor((now.getTime() - at.getTime()) / DAY) : null;
      alerts.push({
        id: `INACTIVITY:${l.vendorId}`,
        type: "INACTIVITY",
        severity: "critical",
        vendorId: l.vendorId,
        storeName: store.get(l.vendorId)!,
        title: "No new orders",
        detail: days == null ? "No orders yet since the store joined you." : `No new order for ${days} days.`,
        at: (at ?? l.startedAt).toISOString(),
      });
    }
    for (const r of reviews) {
      const excerpt = r.comment ? String(r.comment).slice(0, 140) : "";
      alerts.push({
        id: `LOW_RATING:${r.id}`,
        type: "LOW_RATING",
        severity: r.rating <= 1 ? "critical" : "warning",
        vendorId: r.product.vendorId,
        storeName: store.get(r.product.vendorId) ?? "—",
        title: `${r.rating}-star review`,
        detail: `${r.product.name}${excerpt ? ` — “${excerpt}${String(r.comment).length > 140 ? "…" : ""}”` : ""}`,
        at: r.createdAt.toISOString(),
      });
    }
    for (const v of lowStock) {
      alerts.push({
        id: `LOW_STOCK:${v.id}`,
        type: "LOW_STOCK",
        severity: v.stock <= 0 ? "critical" : "warning",
        vendorId: v.product.vendorId,
        storeName: store.get(v.product.vendorId) ?? "—",
        title: v.stock <= 0 ? "Out of stock" : "Low stock",
        detail: `${v.product.name}${v.sku ? ` (${v.sku})` : ""}: ${v.stock} left`,
        at: now.toISOString(),
      });
    }
    const curBy = new Map<string, number>(cur.map((g: any) => [g.vendorId, g._count._all]));
    const prevBy = new Map<string, number>(prev.map((g: any) => [g.vendorId, g._count._all]));
    for (const vendorId of vendorIds) {
      const p = prevBy.get(vendorId) ?? 0;
      const c = curBy.get(vendorId) ?? 0;
      if (p === 0) continue;
      const change = Math.round(((c - p) / p) * 100);
      if (Math.abs(change) < rules.growthPercent) continue;
      const up = change > 0;
      alerts.push({
        id: `${up ? "GROWTH_UP" : "GROWTH_DOWN"}:${vendorId}`,
        type: up ? "GROWTH_UP" : "GROWTH_DOWN",
        severity: up ? "info" : "warning",
        vendorId,
        storeName: store.get(vendorId)!,
        title: up ? `Orders up ${change}%` : `Orders down ${Math.abs(change)}%`,
        detail: `${c} order(s) in the last ${rules.lookbackDays} days vs ${p} before.`,
        at: now.toISOString(),
      });
    }
  }

  const SEVERITY = { critical: 0, warning: 1, info: 2 } as const;
  alerts.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.at.localeCompare(a.at));
  const counts = Object.fromEntries(ALERT_TYPES.map((t) => [t, alerts.filter((a) => a.type === t).length]));
  const filtered = q.type ? alerts.filter((a) => a.type === q.type) : alerts;
  return {
    configured: true as const,
    rules,
    items: filtered.slice((q.page - 1) * q.limit, q.page * q.limit),
    total: filtered.length,
    page: q.page,
    limit: q.limit,
    counts,
  };
}
