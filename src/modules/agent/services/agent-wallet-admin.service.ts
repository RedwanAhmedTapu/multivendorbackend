// src/modules/agent/services/agent-wallet-admin.service.ts
//
// Admin wallet tools (Phase 8–9 extras):
//   - adjustment: a signed ADJUSTMENT ledger entry with a mandatory reason,
//     idempotent per (agent, clientRequestId), under the wallet lock, audited
//     (WALLET / CREATE) in the same transaction. Used e.g. to settle a
//     deactivated agent's balance after paying it outside FinixMart (negative
//     adjustment) or to correct a mistake. available may go negative.
//   - payable report: what FinixMart owes agents, from the cached wallets
//     (kept current by the clearance job and every wallet read).

import Decimal from "decimal.js";
import { z } from "zod";
import { agentDb, agentTransaction } from "../agent-db.ts";
import { conflict, notFound } from "../agent-http.ts";
import { writeConfigAudit, type AdminActor } from "./agent-audit.service.ts";
import { postLedger, saveWallet, syncWalletInTx, walletJson } from "./agent-wallet.service.ts";

export const ADJUSTMENT_REF = "AdminAdjustment";
const MAX_ADJUSTMENT = new Decimal("10000000");

export const walletAdjustmentSchema = z
  .object({
    clientRequestId: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/, { error: "clientRequestId may contain letters, digits, - and _ only" }),
    amount: z.union([z.string(), z.number()]).transform((v, ctx) => {
      const t = String(v).trim();
      if (!/^-?\d+(\.\d{1,2})?$/.test(t)) {
        ctx.addIssue({ code: "custom", message: "Enter a ৳ amount with at most 2 decimals (negative to deduct)" });
        return z.NEVER;
      }
      const d = new Decimal(t);
      if (d.isZero()) {
        ctx.addIssue({ code: "custom", message: "The amount can't be 0" });
        return z.NEVER;
      }
      if (d.abs().gt(MAX_ADJUSTMENT)) {
        ctx.addIssue({ code: "custom", message: "The amount is too large" });
        return z.NEVER;
      }
      return d.toFixed(2);
    }),
    reason: z.string().trim().min(5, { error: "Give a reason (at least 5 characters)" }).max(500),
  })
  .strict();

const dec = (v: unknown) => new Decimal(v == null ? 0 : (v as any).toString());

export async function adjustAgentWallet(agentId: string, input: unknown, actor: AdminActor, now: Date = new Date()) {
  const body = walletAdjustmentSchema.parse(input);
  const refId = `${agentId}:${body.clientRequestId}`;
  const db = agentDb.prisma as any;
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } });
  if (!agent) throw notFound("Agent");
  return agentTransaction(async (tx: any) => {
    const w = await syncWalletInTx(tx, agentId, now);
    const existing = await tx.agentWalletTransaction.findFirst({ where: { type: "ADJUSTMENT", refType: ADJUSTMENT_REF, refId }, select: { id: true, amount: true } });
    if (existing) {
      if (dec(existing.amount).toFixed(2) !== body.amount) throw conflict("This request id was already used for a different adjustment", "IDEMPOTENCY_KEY_REUSED");
      return { replayed: true, transactionId: existing.id, wallet: walletJson(w) };
    }
    const amount = new Decimal(body.amount);
    await postLedger(tx, w, { type: "ADJUSTMENT", amount, refType: ADJUSTMENT_REF, refId, note: body.reason, createdById: actor.userId });
    await saveWallet(tx, w);
    await writeConfigAudit(tx, {
      entity: "WALLET",
      entityId: agentId,
      action: "CREATE",
      newValue: { kind: "ADJUSTMENT", amount: amount.toFixed(2), reason: body.reason, clientRequestId: body.clientRequestId, balanceAfter: w.available.toFixed(2) },
      actor,
    });
    const tr = await tx.agentWalletTransaction.findFirst({ where: { type: "ADJUSTMENT", refType: ADJUSTMENT_REF, refId }, select: { id: true } });
    return { replayed: false, transactionId: tr?.id ?? null, wallet: walletJson(w) };
  });
}

/** Admin view of one agent's wallet and latest ledger entries. */
export async function adminAgentWallet(agentId: string, now: Date = new Date()) {
  const db = agentDb.prisma as any;
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, status: true } });
  if (!agent) throw notFound("Agent");
  const w = await agentTransaction((tx) => syncWalletInTx(tx, agentId, now));
  const ledger = await db.agentWalletTransaction.findMany({
    where: { agentId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 25,
    select: { id: true, type: true, amount: true, balanceAfter: true, refType: true, note: true, createdById: true, createdAt: true },
  });
  return {
    ...walletJson(w),
    agentStatus: agent.status,
    ledger: ledger.map((l: any) => ({ ...l, amount: dec(l.amount).toFixed(2), balanceAfter: dec(l.balanceAfter).toFixed(2) })),
  };
}

/** Total owed to agents now (available > 0 + on hold) and later (pending clearance). */
export async function payableReport(q: { page: number; limit: number }) {
  const db = agentDb.prisma as any;
  const wallets: Array<any> = await db.agentWallet.findMany({
    select: { agentId: true, available: true, pendingClearance: true, onHold: true, totalWithdrawn: true, updatedAt: true },
  });
  let owedNow = new Decimal(0);
  let onHold = new Decimal(0);
  let pending = new Decimal(0);
  let receivable = new Decimal(0);
  const rows = wallets.map((w) => {
    const available = dec(w.available);
    owedNow = owedNow.plus(Decimal.max(available, 0));
    receivable = receivable.plus(Decimal.max(available.negated(), 0));
    onHold = onHold.plus(dec(w.onHold));
    pending = pending.plus(dec(w.pendingClearance));
    return { ...w, available, total: Decimal.max(available, 0).plus(dec(w.onHold)).plus(dec(w.pendingClearance)) };
  });
  rows.sort((a, b) => b.total.comparedTo(a.total));
  const page = rows.filter((r) => !r.total.isZero() || r.available.lt(0)).slice((q.page - 1) * q.limit, q.page * q.limit);
  const agents = page.length ? await db.agent.findMany({ where: { id: { in: page.map((r) => r.agentId) } }, select: { id: true, name: true, agentCode: true, status: true } }) : [];
  const by = new Map(agents.map((a: any) => [a.id, a]));
  return {
    totals: {
      availableToWithdraw: owedNow.toFixed(2),
      onHold: onHold.toFixed(2),
      pendingClearance: pending.toFixed(2),
      totalOwed: owedNow.plus(onHold).plus(pending).toFixed(2),
      /** Negative balances (C5 reversals after withdrawal) to be offset by future earnings. */
      negativeBalances: receivable.toFixed(2),
    },
    items: page.map((r) => {
      const a: any = by.get(r.agentId);
      return {
        agentId: r.agentId,
        name: a?.name ?? "—",
        agentCode: a?.agentCode ?? null,
        status: a?.status ?? null,
        available: r.available.toFixed(2),
        onHold: dec(r.onHold).toFixed(2),
        pendingClearance: dec(r.pendingClearance).toFixed(2),
        totalWithdrawn: dec(r.totalWithdrawn).toFixed(2),
        updatedAt: r.updatedAt,
      };
    }),
    total: rows.filter((r) => !r.total.isZero() || r.available.lt(0)).length,
    page: q.page,
    limit: q.limit,
    asOf: "Balances as of each wallet's last sync (every 15 minutes by the clearance job, and on every wallet read).",
  };
}

