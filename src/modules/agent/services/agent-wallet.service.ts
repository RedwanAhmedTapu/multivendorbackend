// src/modules/agent/services/agent-wallet.service.ts
//
// Phase 7 — the agent wallet and its ledger (docs/agent-system-plan.md §2, §8 C5).
//
// The ledger (agent_wallet_transactions) is append-only and the wallet's
// `available` balance always equals the sum of its entries:
//   COMMISSION_CREDIT   +amount    a commission passed its hold period (availableAt)
//   COMMISSION_REVERSAL −amount    a refunded return reversed part of a CREDITED commission
//   WITHDRAWAL_HOLD     −amount    a withdrawal was requested (money moves to onHold)
//   WITHDRAWAL_RELEASE  +amount    a withdrawal was rejected or cancelled (hold released)
// A paid withdrawal only moves onHold → totalWithdrawn; it was already debited
// by its hold, so it adds no ledger entry.
//
// C5: a reversal after the money was withdrawn still debits, so `available`
// may go negative; later credits offset it automatically, and no withdrawal
// is possible until it is back above the requested amount.
//
// Posting is pull-based: syncWalletInTx posts every due credit and every
// unposted reversal of a credited commission, under the wallet row lock, and
// marks the source row (walletCreditedAt / walletPostedAt) in the same
// transaction. The accrual and reversal hooks, the clearance job, the wallet
// read and every withdrawal call it, so a failed hook converges on the next
// one. The ledger's @@unique([type, refType, refId]) is the last line of
// defence against a double post.

import Decimal from "decimal.js";
import { agentDb, agentTransaction, type AgentTx } from "../agent-db.ts";
import { assertNoSnapshotMutation } from "./agent-rate.service.ts";

export const LEDGER_REF = {
  commission: "AgentCommission",
  reversal: "AgentCommissionReversal",
  withdrawal: "AgentWithdrawal",
} as const;

/** Upper bound of rows posted per sync; the rest is picked up by the next one. */
const SYNC_BATCH = 500;

const dec = (v: unknown) => new Decimal(v == null ? 0 : (v as any).toString());

export type WalletState = {
  agentId: string;
  available: Decimal;
  pendingClearance: Decimal;
  onHold: Decimal;
  totalEarned: Decimal;
  totalWithdrawn: Decimal;
};

/**
 * Make sure the agent's wallet row exists, then lock it (SELECT … FOR UPDATE)
 * for the rest of the transaction. Every money mutation goes through here.
 */
export async function lockWallet(tx: AgentTx, agentId: string): Promise<WalletState> {
  const db = tx as any;
  await db.$executeRaw`INSERT INTO "agent_wallets" ("agentId", "updatedAt") VALUES (${agentId}, NOW()) ON CONFLICT ("agentId") DO NOTHING`;
  await db.$executeRaw`SELECT "agentId" FROM "agent_wallets" WHERE "agentId" = ${agentId} FOR UPDATE`;
  const w = await db.agentWallet.findUnique({ where: { agentId } });
  if (!w) throw new Error(`Wallet for agent ${agentId} could not be created`);
  return {
    agentId,
    available: dec(w.available),
    pendingClearance: dec(w.pendingClearance),
    onHold: dec(w.onHold),
    totalEarned: dec(w.totalEarned),
    totalWithdrawn: dec(w.totalWithdrawn),
  };
}

/** Append one ledger entry and move `available` by the same signed amount. */
export async function postLedger(
  tx: AgentTx,
  w: WalletState,
  entry: { type: string; amount: Decimal; refType: string; refId: string; note?: string | null; createdById?: string | null },
): Promise<void> {
  if (entry.amount.isZero()) return; // CHECK (amount <> 0): a zero movement is not an entry
  w.available = w.available.plus(entry.amount);
  await (tx as any).agentWalletTransaction.create({
    data: {
      agentId: w.agentId,
      type: entry.type,
      amount: entry.amount.toFixed(2),
      refType: entry.refType,
      refId: entry.refId,
      balanceAfter: w.available.toFixed(2),
      note: entry.note ?? null,
      createdById: entry.createdById ?? null,
    },
  });
}

/** Persist the cached balances of a locked wallet. */
export async function saveWallet(tx: AgentTx, w: WalletState): Promise<void> {
  await (tx as any).agentWallet.update({
    where: { agentId: w.agentId },
    data: {
      available: w.available.toFixed(2),
      pendingClearance: w.pendingClearance.toFixed(2),
      onHold: w.onHold.toFixed(2),
      totalEarned: w.totalEarned.toFixed(2),
      totalWithdrawn: w.totalWithdrawn.toFixed(2),
    },
  });
}

class WalletSyncConflict extends Error {}

/**
 * Lock the wallet and post everything that is due: credits for commissions
 * past availableAt, then debits for reversals of credited commissions. Also
 * recomputes pendingClearance and totalEarned (both net of reversals) from
 * the commission rows. Returns the locked, up-to-date wallet (not yet saved
 * when the caller goes on to mutate it — saveWallet is called here).
 */
export async function syncWalletInTx(tx: AgentTx, agentId: string, now: Date): Promise<WalletState> {
  const db = tx as any;
  const w = await lockWallet(tx, agentId);

  const due = await db.agentCommission.findMany({
    where: { agentId, walletCreditedAt: null, availableAt: { lte: now } },
    orderBy: { availableAt: "asc" },
    take: SYNC_BATCH,
    select: { id: true, amount: true, status: true },
  });
  for (const c of due) {
    await postLedger(tx, w, { type: "COMMISSION_CREDIT", amount: dec(c.amount), refType: LEDGER_REF.commission, refId: c.id });
    const data: Record<string, unknown> = { walletCreditedAt: now };
    if (c.status === "PENDING_CLEARANCE") data.status = "AVAILABLE";
    assertNoSnapshotMutation(data);
    const upd = await db.agentCommission.updateMany({ where: { id: c.id, walletCreditedAt: null }, data });
    if (upd.count !== 1) throw new WalletSyncConflict(`commission ${c.id} was credited concurrently`);
  }

  const reversals = await db.agentCommissionReversal.findMany({
    where: { walletPostedAt: null, commission: { agentId, walletCreditedAt: { not: null } } },
    orderBy: { createdAt: "asc" },
    take: SYNC_BATCH,
    select: { id: true, amount: true, vendorReturnId: true },
  });
  for (const r of reversals) {
    await postLedger(tx, w, {
      type: "COMMISSION_REVERSAL",
      amount: dec(r.amount).negated(),
      refType: LEDGER_REF.reversal,
      refId: r.id,
      note: `Return ${r.vendorReturnId}`,
    });
    const upd = await db.agentCommissionReversal.updateMany({ where: { id: r.id, walletPostedAt: null }, data: { walletPostedAt: now } });
    if (upd.count !== 1) throw new WalletSyncConflict(`reversal ${r.id} was posted concurrently`);
  }

  const [pending, earned] = await Promise.all([
    db.agentCommission.aggregate({ where: { agentId, walletCreditedAt: null }, _sum: { amount: true, reversedAmount: true } }),
    db.agentCommission.aggregate({ where: { agentId }, _sum: { amount: true, reversedAmount: true } }),
  ]);
  w.pendingClearance = Decimal.max(dec(pending._sum.amount).minus(dec(pending._sum.reversedAmount)), 0);
  w.totalEarned = Decimal.max(dec(earned._sum.amount).minus(dec(earned._sum.reversedAmount)), 0);
  await saveWallet(tx, w);
  return w;
}

/** Sync one agent's wallet in its own Serializable transaction. */
export async function syncAgentWallet(agentId: string, now: Date = new Date()): Promise<WalletState> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await agentTransaction((tx) => syncWalletInTx(tx, agentId, now));
    } catch (err) {
      if (err instanceof WalletSyncConflict && attempt < 3) continue;
      throw err;
    }
  }
}

/** Never throws: used after accrual / reversal, where the caller must not fail. */
export async function syncAgentWalletSafe(agentId: string, now: Date = new Date()): Promise<boolean> {
  try {
    await syncAgentWallet(agentId, now);
    return true;
  } catch (err: any) {
    console.error(`[agent-wallet] sync failed for agent ${agentId}: ${String(err?.message ?? err).slice(0, 300)}`);
    return false;
  }
}

/**
 * Job body: sync every wallet that has something to post (a matured,
 * uncredited commission or an unposted reversal of a credited one).
 */
export async function syncDueAgentWallets(now: Date = new Date()): Promise<{ agents: number; failed: number }> {
  const db = agentDb.prisma as any;
  const [due, revs] = await Promise.all([
    db.agentCommission.findMany({
      where: { walletCreditedAt: null, availableAt: { lte: now } },
      distinct: ["agentId"],
      take: 200,
      select: { agentId: true },
    }),
    db.agentCommissionReversal.findMany({
      where: { walletPostedAt: null, commission: { walletCreditedAt: { not: null } } },
      take: 200,
      select: { commission: { select: { agentId: true } } },
    }),
  ]);
  const agentIds = new Set<string>([...due.map((r: any) => r.agentId), ...revs.map((r: any) => r.commission.agentId)]);
  let failed = 0;
  for (const agentId of agentIds) if (!(await syncAgentWalletSafe(agentId, now))) failed += 1;
  return { agents: agentIds.size, failed };
}

// ── reads ─────────────────────────────────────────────────────────────────

export function walletJson(w: WalletState) {
  return {
    available: w.available.toFixed(2),
    pendingClearance: w.pendingClearance.toFixed(2),
    onHold: w.onHold.toFixed(2),
    totalEarned: w.totalEarned.toFixed(2),
    totalWithdrawn: w.totalWithdrawn.toFixed(2),
    /** C5: a reversal after a withdrawal; offset by future earnings. */
    negative: w.available.lt(0),
    withdrawable: Decimal.max(w.available, 0).toFixed(2),
  };
}

const TX_LABEL: Record<string, string> = {
  COMMISSION_CREDIT: "Commission credited",
  COMMISSION_REVERSAL: "Commission reversed (refunded return)",
  BONUS_CREDIT: "Bonus",
  WITHDRAWAL_HOLD: "Withdrawal requested",
  WITHDRAWAL_RELEASE: "Withdrawal returned to balance",
  WITHDRAWAL_PAID: "Withdrawal paid",
  ADJUSTMENT: "Adjustment",
};

export const shortRef = (prefix: string, id: string) => `${prefix}-${id.slice(-8).toUpperCase()}`;

/** One page of the agent's ledger, newest first, with order numbers where known. */
export async function listWalletTransactions(agentId: string, q: { page: number; limit: number; type?: string }) {
  const db = agentDb.prisma as any;
  const where: any = { agentId, ...(q.type ? { type: q.type } : {}) };
  const [rows, total] = await Promise.all([
    db.agentWalletTransaction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: { id: true, type: true, amount: true, balanceAfter: true, refType: true, refId: true, note: true, createdAt: true },
    }),
    db.agentWalletTransaction.count({ where }),
  ]);

  // Order numbers for commission credits and reversals.
  const commissionIds = rows.filter((r: any) => r.refType === LEDGER_REF.commission).map((r: any) => r.refId);
  const reversalIds = rows.filter((r: any) => r.refType === LEDGER_REF.reversal).map((r: any) => r.refId);
  const reversals = reversalIds.length
    ? await db.agentCommissionReversal.findMany({ where: { id: { in: reversalIds } }, select: { id: true, commissionId: true } })
    : [];
  const allCommissionIds = [...new Set([...commissionIds, ...reversals.map((r: any) => r.commissionId)])];
  const commissions = allCommissionIds.length
    ? await db.agentCommission.findMany({ where: { id: { in: allCommissionIds } }, select: { id: true, orderId: true } })
    : [];
  const orders = commissions.length
    ? await db.order.findMany({ where: { id: { in: [...new Set(commissions.map((c: any) => c.orderId))] } }, select: { id: true, orderNumber: true } })
    : [];
  const orderNo = new Map(orders.map((o: any) => [o.id, o.orderNumber]));
  const commissionOrder = new Map(commissions.map((c: any) => [c.id, orderNo.get(c.orderId) ?? null]));
  const reversalCommission = new Map(reversals.map((r: any) => [r.id, r.commissionId]));

  const items = rows.map((r: any) => {
    const commissionId = r.refType === LEDGER_REF.commission ? r.refId : r.refType === LEDGER_REF.reversal ? reversalCommission.get(r.refId) : null;
    return {
      id: r.id,
      ref: shortRef("TRX", r.id),
      type: r.type,
      label: TX_LABEL[r.type] ?? r.type,
      amount: dec(r.amount).toFixed(2),
      balanceAfter: dec(r.balanceAfter).toFixed(2),
      orderNumber: commissionId ? (commissionOrder.get(commissionId) ?? null) : null,
      withdrawalRef: r.refType === LEDGER_REF.withdrawal ? shortRef("WD", r.refId) : null,
      createdAt: r.createdAt,
    };
  });
  return { items, total, page: q.page, limit: q.limit };
}
