// src/modules/agent/services/agent-commission-read.service.ts
//
// Read side of the commission engine: the agent's Commission Dashboard
// (summary, trend, history, CSV) and the admin commission list.
//
// Scope: the agent portal ALWAYS passes the authenticated agent's id; the
// admin list may filter by any agent. Money is returned as decimal strings
// (৳ formatting happens in the UI). Customer data is never selected.
// "Withdrawable" is derived from availableAt (effectiveCommissionStatus), so
// the screens are right even before the clearance job has run.

import Decimal from "decimal.js";
import { agentDb } from "../agent-db.ts";
import { effectiveCommissionStatus } from "./agent-commission.service.ts";
import { bucketLabels, dhakaBucket, dhakaStartOf, fillSeries, growthPercent } from "./agent-portal.scope.ts";

export const COMMISSION_FILTER_STATUSES = ["ALL", "PENDING", "AVAILABLE", "PARTIALLY_REVERSED", "REVERSED"] as const;
export type CommissionFilterStatus = (typeof COMMISSION_FILTER_STATUSES)[number];

export type CommissionFilters = {
  status: CommissionFilterStatus;
  vendorId?: string;
  agentId?: string;
  /** Asia/Dhaka calendar days, YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DHAKA_OFFSET = "+06:00";

/** Start of a Dhaka calendar day as a UTC instant. */
export function dhakaDayStart(day: string): Date {
  return new Date(`${day}T00:00:00${DHAKA_OFFSET}`);
}

/** Prisma where for the commission list. `scopeAgentId` (agent portal) always wins over filters.agentId. */
export function commissionWhere(filters: CommissionFilters, now: Date, scopeAgentId?: string): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const agentId = scopeAgentId ?? filters.agentId;
  if (agentId) where.agentId = agentId;
  if (filters.vendorId) where.vendorId = filters.vendorId;
  const earnedAt: Record<string, Date> = {};
  if (filters.from) earnedAt.gte = dhakaDayStart(filters.from);
  if (filters.to) earnedAt.lt = new Date(dhakaDayStart(filters.to).getTime() + DAY_MS);
  if (Object.keys(earnedAt).length) where.earnedAt = earnedAt;
  switch (filters.status) {
    case "PENDING":
      where.status = "PENDING_CLEARANCE";
      where.availableAt = { gt: now };
      break;
    case "AVAILABLE":
      where.status = { in: ["PENDING_CLEARANCE", "AVAILABLE"] };
      where.availableAt = { lte: now };
      break;
    case "PARTIALLY_REVERSED":
    case "REVERSED":
      where.status = filters.status;
      break;
  }
  return where;
}

const ROW_SELECT = {
  id: true,
  agentId: true,
  vendorId: true,
  orderId: true,
  vendorOrderId: true,
  orderItemId: true,
  deliveryId: true,
  quantity: true,
  baseAmount: true,
  amount: true,
  reversedAmount: true,
  reversedQty: true,
  ratePercent: true,
  rateSource: true,
  levelName: true,
  status: true,
  earnedAt: true,
  availableAt: true,
} as const;

/** Short display reference, e.g. "COM-7Q3K9X2A" (derived from the row id). */
export const commissionRef = (id: string) => `COM-${id.slice(-8).toUpperCase()}`;

const s2 = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString()).toFixed(2);

async function decorate(rows: any[], now: Date, withAgent: boolean) {
  const db = agentDb.prisma as any;
  const vendorIds = [...new Set(rows.map((r) => r.vendorId))];
  const orderIds = [...new Set(rows.map((r) => r.orderId))];
  const agentIds = withAgent ? [...new Set(rows.map((r) => r.agentId))] : [];
  const [vendors, orders, agents] = await Promise.all([
    vendorIds.length ? db.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, storeName: true } }) : [],
    orderIds.length ? db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true } }) : [],
    agentIds.length ? db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, agentCode: true } }) : [],
  ]);
  const vendorBy = new Map(vendors.map((v: any) => [v.id, v.storeName]));
  const orderBy = new Map(orders.map((o: any) => [o.id, o.orderNumber]));
  const agentBy = new Map(agents.map((a: any) => [a.id, a]));
  return rows.map((r) => {
    const out: Record<string, unknown> = {
      id: r.id,
      ref: commissionRef(r.id),
      orderId: r.orderId,
      orderNumber: orderBy.get(r.orderId) ?? null,
      vendorOrderId: r.vendorOrderId,
      vendorId: r.vendorId,
      storeName: vendorBy.get(r.vendorId) ?? "—",
      quantity: r.quantity,
      reversedQty: r.reversedQty,
      baseAmount: new Decimal(r.baseAmount.toString()).toFixed(4),
      ratePercent: new Decimal(r.ratePercent.toString()).toFixed(4),
      rateSource: r.rateSource,
      amount: s2(r.amount),
      reversedAmount: s2(r.reversedAmount),
      netAmount: new Decimal(r.amount.toString()).minus(r.reversedAmount.toString()).toFixed(2),
      status: effectiveCommissionStatus(r, now),
      earnedAt: r.earnedAt,
      availableAt: r.availableAt,
    };
    if (withAgent) {
      const a: any = agentBy.get(r.agentId);
      out.agentId = r.agentId;
      out.agentName = a?.name ?? "—";
      out.agentCode = a?.agentCode ?? null;
      out.levelName = r.levelName ?? null;
    }
    return out;
  });
}

export async function listCommissions(
  filters: CommissionFilters & { page: number; limit: number },
  opts: { scopeAgentId?: string; withAgent?: boolean; now?: Date } = {},
) {
  const db = agentDb.prisma as any;
  const now = opts.now ?? new Date();
  const where = commissionWhere(filters, now, opts.scopeAgentId);
  const [rows, total, sums] = await Promise.all([
    db.agentCommission.findMany({
      where,
      orderBy: [{ earnedAt: "desc" }, { id: "desc" }],
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      select: ROW_SELECT,
    }),
    db.agentCommission.count({ where }),
    db.agentCommission.findMany({ where, select: { amount: true, reversedAmount: true } }),
  ]);
  let earned = new Decimal(0);
  let reversed = new Decimal(0);
  for (const s of sums) {
    earned = earned.plus(s.amount.toString());
    reversed = reversed.plus(s.reversedAmount.toString());
  }
  return {
    items: await decorate(rows, now, !!opts.withAgent),
    page: filters.page,
    limit: filters.limit,
    total,
    totals: { earned: earned.toFixed(2), reversed: reversed.toFixed(2), net: earned.minus(reversed).toFixed(2) },
  };
}

/** KPI cards: everything net of reversals. */
export async function commissionSummary(agentId: string, now = new Date()) {
  const rows = await (agentDb.prisma as any).agentCommission.findMany({
    where: { agentId },
    select: { amount: true, reversedAmount: true, availableAt: true, status: true, earnedAt: true },
  });
  const thisMonthStart = dhakaStartOf(now, "month");
  const lastMonthStart = dhakaStartOf(new Date(thisMonthStart.getTime() - DAY_MS), "month");
  let total = new Decimal(0);
  let pending = new Decimal(0);
  let available = new Decimal(0);
  let reversed = new Decimal(0);
  let thisMonth = new Decimal(0);
  let lastMonth = new Decimal(0);
  for (const r of rows) {
    const net = new Decimal(r.amount.toString()).minus(r.reversedAmount.toString());
    total = total.plus(net);
    reversed = reversed.plus(r.reversedAmount.toString());
    if (r.availableAt.getTime() <= now.getTime()) available = available.plus(net);
    else pending = pending.plus(net);
    if (r.earnedAt >= thisMonthStart) thisMonth = thisMonth.plus(net);
    else if (r.earnedAt >= lastMonthStart) lastMonth = lastMonth.plus(net);
  }
  return {
    totalEarned: total.toFixed(2),
    pendingClearance: pending.toFixed(2),
    available: available.toFixed(2),
    reversed: reversed.toFixed(2),
    thisMonth: thisMonth.toFixed(2),
    lastMonth: lastMonth.toFixed(2),
    monthGrowthPercent: growthPercent(thisMonth.toFixed(2), lastMonth.toFixed(2)),
    commissions: rows.length,
  };
}

export const COMMISSION_TREND_RANGES = { "7d": { unit: "day", count: 7 }, "1m": { unit: "day", count: 30 }, "1y": { unit: "month", count: 12 } } as const;
export type CommissionTrendRange = keyof typeof COMMISSION_TREND_RANGES;

/** Net commission earned per Dhaka day (7d, 1m) or month (1y). */
export async function commissionEarningsTrend(agentId: string, range: CommissionTrendRange, now = new Date()) {
  const { unit, count } = COMMISSION_TREND_RANGES[range];
  const labels = bucketLabels(now, unit, count);
  const from = unit === "day" ? dhakaDayStart(labels[0]) : new Date(`${labels[0]}-01T00:00:00${DHAKA_OFFSET}`);
  const rows = await (agentDb.prisma as any).agentCommission.findMany({
    where: { agentId, earnedAt: { gte: from } },
    select: { amount: true, reversedAmount: true, earnedAt: true },
  });
  const by = new Map<string, Decimal>();
  for (const r of rows) {
    const b = dhakaBucket(r.earnedAt, unit);
    by.set(b, (by.get(b) ?? new Decimal(0)).plus(new Decimal(r.amount.toString()).minus(r.reversedAmount.toString())));
  }
  return {
    range,
    unit,
    series: fillSeries(labels, [...by].map(([bucket, v]) => ({ bucket, value: v.toFixed(2) }))),
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export const CSV_MAX_ROWS = 5000;

/** RFC 4180 cell; cells that a spreadsheet would run as a formula are prefixed with '. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const dhakaTime = (d: Date) => new Date(d.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");

export function commissionsCsv(items: Array<Record<string, any>>, withAgent = false): string {
  const header = [
    "Commission",
    ...(withAgent ? ["Agent", "Agent code"] : []),
    "Order",
    "Vendor",
    "Units",
    "Base: FinixMart commission (BDT)",
    "Rate (%)",
    "Rate source",
    "Earned (BDT)",
    "Reversed (BDT)",
    "Net (BDT)",
    "Status",
    "Earned at (Asia/Dhaka)",
    "Withdrawable from (Asia/Dhaka)",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const i of items) {
    lines.push(
      [
        i.ref,
        ...(withAgent ? [i.agentName, i.agentCode] : []),
        i.orderNumber ?? i.orderId,
        i.storeName,
        i.quantity,
        new Decimal(i.baseAmount).toFixed(2),
        new Decimal(i.ratePercent).toString(),
        i.rateSource,
        i.amount,
        i.reversedAmount,
        i.netAmount,
        i.status,
        dhakaTime(new Date(i.earnedAt)),
        dhakaTime(new Date(i.availableAt)),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export async function exportCommissionsCsv(filters: CommissionFilters, opts: { scopeAgentId?: string; withAgent?: boolean; now?: Date } = {}) {
  const list = await listCommissions({ ...filters, page: 1, limit: CSV_MAX_ROWS }, opts);
  return { csv: commissionsCsv(list.items, !!opts.withAgent), total: list.total, truncated: list.total > CSV_MAX_ROWS };
}
