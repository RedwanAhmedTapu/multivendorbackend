// src/modules/agent/services/agent-referral.service.ts
//
// Phase 8 — referral attribution (docs/agent-system-plan.md §5.3, C6).
//
// A vendor who signs up through an agent's link (`/vendor-register?ref=REF-…`)
// is linked to that agent with source REFERRAL_CODE, right after the vendor
// row is created (auth.controller verifyEmail / verifyOtp).
//   - best-effort: attachVendorToAgentByCodeSafe never throws, so an invalid,
//     unknown or inactive code can never block a registration;
//   - one open link per vendor (lockConfigArea + the partial unique index
//     agent_vendor_links_one_open_per_vendor): an existing link always wins;
//   - only ACTIVE agents can take new vendors (same rule as admin assignment);
//   - audited in agent_config_audits as the system actor.
// The agent portal reads its own code, link, stats and referred vendors
// (store names only — no vendor owner or customer contact data).

import Decimal from "decimal.js";
import { agentDb, agentTransaction, lockConfigArea } from "../agent-db.ts";
import { notFound } from "../agent-http.ts";
import { writeConfigAudit, type AdminActor } from "./agent-audit.service.ts";

export const REFERRAL_ACTOR: AdminActor = { userId: "system:referral-signup", name: "Referral signup", ip: null, userAgent: null };

/** Canonical "REF-XXXXXXXX", or null when the input can't be a referral code. */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^REF-[A-Z0-9]{4,16}$/.test(code) ? code : null;
}

export type AttachResult =
  | { status: "LINKED"; agentId: string; linkId: string }
  | { status: "SKIPPED"; reason: "NO_CODE" | "INVALID_CODE" | "UNKNOWN_CODE" | "AGENT_NOT_ACTIVE" | "VENDOR_NOT_FOUND" | "ALREADY_LINKED" };

export async function attachVendorToAgentByCode(vendorId: string, rawCode: unknown, now: Date = new Date()): Promise<AttachResult> {
  if (rawCode == null || rawCode === "") return { status: "SKIPPED", reason: "NO_CODE" };
  const code = normalizeReferralCode(rawCode);
  if (!code) return { status: "SKIPPED", reason: "INVALID_CODE" };
  try {
    return await agentTransaction(async (tx: any) => {
      await lockConfigArea(tx, `vendor-link:${vendorId}`);
      const agent = await tx.agent.findUnique({ where: { referralCode: code }, select: { id: true, status: true } });
      if (!agent) return { status: "SKIPPED", reason: "UNKNOWN_CODE" } as const;
      if (agent.status !== "ACTIVE") return { status: "SKIPPED", reason: "AGENT_NOT_ACTIVE" } as const;
      const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, select: { id: true, storeName: true } });
      if (!vendor) return { status: "SKIPPED", reason: "VENDOR_NOT_FOUND" } as const;
      const open = await tx.agentVendorLink.findFirst({ where: { vendorId, endedAt: null }, select: { id: true } });
      if (open) return { status: "SKIPPED", reason: "ALREADY_LINKED" } as const;
      const link = await tx.agentVendorLink.create({
        data: { agentId: agent.id, vendorId, source: "REFERRAL_CODE", startedAt: now, note: `Signed up with ${code}` },
        select: { id: true },
      });
      await writeConfigAudit(tx, {
        entity: "VENDOR_LINK",
        entityId: link.id,
        action: "CREATE",
        newValue: { agentId: agent.id, vendorId, vendorName: vendor.storeName, source: "REFERRAL_CODE", referralCode: code, startedAt: now },
        actor: REFERRAL_ACTOR,
      });
      return { status: "LINKED", agentId: agent.id, linkId: link.id } as const;
    });
  } catch (err: any) {
    // The partial unique index: a concurrent assignment won.
    if (err?.code === "P2002") return { status: "SKIPPED", reason: "ALREADY_LINKED" };
    throw err;
  }
}

/** The signup hook: never throws, so a referral problem can't block a registration. */
export async function attachVendorToAgentByCodeSafe(vendorId: string | null | undefined, rawCode: unknown): Promise<AttachResult | { status: "FAILED" }> {
  if (!vendorId) return { status: "SKIPPED", reason: "VENDOR_NOT_FOUND" };
  try {
    const result = await attachVendorToAgentByCode(vendorId, rawCode);
    if (result.status === "SKIPPED" && result.reason !== "NO_CODE") {
      console.warn(`[agent-referral] vendor ${vendorId} not linked: ${result.reason}`);
    }
    return result;
  } catch (err: any) {
    console.error(`[agent-referral] attach failed for vendor ${vendorId}: ${String(err?.message ?? err).slice(0, 300)}`);
    return { status: "FAILED" };
  }
}

// ── agent portal ──────────────────────────────────────────────────────────

export function vendorSignupUrl(code: string): string {
  const base = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/vendor-register?ref=${encodeURIComponent(code)}`;
}

const dhakaMonthStart = (now: Date) => {
  const d = new Date(now.getTime() + 6 * 3600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 6 * 3600_000);
};

export async function referralInfo(agentId: string, now: Date = new Date()) {
  const db = agentDb.prisma as any;
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { referralCode: true } });
  if (!agent) throw notFound("Agent");
  const where = { agentId, source: "REFERRAL_CODE" };
  const [total, active, thisMonth, links] = await Promise.all([
    db.agentVendorLink.count({ where }),
    db.agentVendorLink.count({ where: { ...where, endedAt: null } }),
    db.agentVendorLink.count({ where: { ...where, startedAt: { gte: dhakaMonthStart(now) } } }),
    db.agentVendorLink.findMany({ where, select: { vendorId: true } }),
  ]);
  const vendorIds = [...new Set(links.map((l: any) => l.vendorId))];
  const groups = vendorIds.length
    ? await db.agentCommission.groupBy({ by: ["vendorId"], where: { agentId, vendorId: { in: vendorIds } }, _sum: { amount: true, reversedAmount: true } })
    : [];
  const net = groups.reduce(
    (sum: Decimal, g: any) => sum.plus(g._sum.amount?.toString() ?? 0).minus(g._sum.reversedAmount?.toString() ?? 0),
    new Decimal(0),
  );
  const earning = groups.length;
  return {
    code: agent.referralCode,
    link: vendorSignupUrl(agent.referralCode),
    stats: {
      totalReferred: total,
      activeLinks: active,
      thisMonth,
      earningVendors: earning,
      commissionFromReferrals: Decimal.max(net, 0).toFixed(2),
    },
  };
}

export async function referredVendors(agentId: string, q: { page: number; limit: number }) {
  const db = agentDb.prisma as any;
  const where = { agentId, source: "REFERRAL_CODE" };
  const [rows, total] = await Promise.all([
    db.agentVendorLink.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: { id: true, vendorId: true, startedAt: true, endedAt: true, vendor: { select: { storeName: true, status: true } } },
    }),
    db.agentVendorLink.count({ where }),
  ]);
  const vendorIds = rows.map((r: any) => r.vendorId);
  const sums = vendorIds.length
    ? await db.agentCommission.groupBy({ by: ["vendorId"], where: { agentId, vendorId: { in: vendorIds } }, _sum: { amount: true, reversedAmount: true } })
    : [];
  const earnedBy = new Map<string, string>(
    sums.map((s: any) => [s.vendorId, Decimal.max(new Decimal(s._sum.amount?.toString() ?? 0).minus(s._sum.reversedAmount?.toString() ?? 0), 0).toFixed(2)]),
  );
  return {
    items: rows.map((r: any) => ({
      linkId: r.id,
      vendorId: r.vendorId,
      storeName: r.vendor?.storeName ?? "—",
      vendorStatus: r.vendor?.status ?? null,
      linkedAt: r.startedAt,
      endedAt: r.endedAt,
      active: r.endedAt == null,
      commissionEarned: earnedBy.get(r.vendorId) ?? "0.00",
    })),
    total,
    page: q.page,
    limit: q.limit,
  };
}
