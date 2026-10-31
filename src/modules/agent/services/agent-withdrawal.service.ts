// src/modules/agent/services/agent-withdrawal.service.ts
//
// Phase 7 — withdrawals (docs/agent-system-plan.md §2, §3b, §3c).
//
// Request (agent):
//   - Serializable transaction + wallet row lock (lockWallet via syncWalletInTx),
//     so two requests against one balance can never both pass;
//   - idempotent per (agentId, clientRequestId): a repeat returns the first
//     result; the same key with a different amount or method is refused (409);
//   - limits, fee, enabled methods and the auto-approve limit are read FRESH
//     inside the transaction; any missing setting → 409 SETTINGS_NOT_CONFIGURED;
//   - only an ACTIVE agent may withdraw. A suspended agent keeps accruing
//     commission (plan §8) but can't request, and an admin can't approve or
//     pay its withdrawals until it is reactivated (rejecting is allowed).
//   - the amount is held: WITHDRAWAL_HOLD −amount, onHold +amount. The fee
//     comes out of the amount (netAmount = amount − fee is what is paid out).
//
// Admin: approve (REQUESTED → APPROVED), reject (REQUESTED/APPROVED → REJECTED,
// hold released), mark-paid (APPROVED → PAID, transactionRef required). Every
// state change is a guarded updateMany on the expected status and writes an
// agent_config_audits row in the same transaction. Agents may cancel their own
// REQUESTED withdrawal (hold released).
// Payouts are manual: the admin pays outside the system and records the reference.

import Decimal from "decimal.js";
import { agentDb, agentTransaction, type AgentTx } from "../agent-db.ts";
import { AgentError, conflict, notFound } from "../agent-http.ts";
import { writeConfigAudit, type AdminActor } from "./agent-audit.service.ts";
import { getAgentSettings, requireConfigured, withdrawalFeeFor, type SettingKey } from "./agent-settings.service.ts";
import { LEDGER_REF, lockWallet, postLedger, saveWallet, shortRef, syncWalletInTx, walletJson } from "./agent-wallet.service.ts";
import { maskAccountNumber, PAYOUT_LABEL } from "./agent-payout.service.ts";
import { withdrawalRequestSchema } from "../validators/agent-wallet.validators.ts";

export const WITHDRAWAL_SETTING_KEYS: SettingKey[] = [
  "minWithdrawalAmount",
  "maxWithdrawalAmount",
  "withdrawalFee",
  "enabledPayoutMethods",
  "autoApproveWithdrawalLimit",
];

/** Audit actor for the automatic approval (no admin involved). */
export const AUTO_APPROVE_ACTOR: AdminActor = { userId: "system:auto-approve", name: "Auto-approval", ip: null, userAgent: null };

const dec = (v: unknown) => new Decimal(v == null ? 0 : (v as any).toString());

const WITHDRAWAL_SELECT = {
  id: true,
  agentId: true,
  amount: true,
  fee: true,
  netAmount: true,
  payoutMethodId: true,
  methodSnapshot: true,
  settingsSnapshot: true,
  status: true,
  clientRequestId: true,
  autoApproved: true,
  reviewedById: true,
  reviewedAt: true,
  rejectReason: true,
  paidById: true,
  paidAt: true,
  transactionRef: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Agent-facing shape: the account number is masked. */
export function withdrawalJson(w: any, opts: { fullAccount?: boolean } = {}) {
  const m = (w.methodSnapshot ?? {}) as Record<string, any>;
  return {
    id: w.id,
    ref: shortRef("WD", w.id),
    amount: dec(w.amount).toFixed(2),
    fee: dec(w.fee).toFixed(2),
    netAmount: dec(w.netAmount).toFixed(2),
    status: w.status,
    autoApproved: !!w.autoApproved,
    method: {
      type: m.type ?? null,
      label: PAYOUT_LABEL[m.type] ?? m.type ?? "—",
      accountName: m.accountName ?? null,
      accountNumberMasked: maskAccountNumber(m.accountNumber),
      bankName: m.bankName ?? null,
      ...(opts.fullAccount ? { accountNumber: m.accountNumber ?? null, branch: m.branch ?? null, routingNumber: m.routingNumber ?? null } : {}),
    },
    rejectReason: w.rejectReason ?? null,
    transactionRef: w.transactionRef ?? null,
    reviewedAt: w.reviewedAt ?? null,
    paidAt: w.paidAt ?? null,
    createdAt: w.createdAt,
  };
}

// ── agent: wallet summary ─────────────────────────────────────────────────

/** Wallet balances (synced first) plus the withdrawal rules the form needs. */
export async function getAgentWallet(agentId: string, now: Date = new Date()) {
  const w = await agentTransaction((tx) => syncWalletInTx(tx, agentId, now));
  const settings = await getAgentSettings();
  const v = settings.values;
  const missing = WITHDRAWAL_SETTING_KEYS.filter((k) => settings.missing.includes(k));
  const agent = await (agentDb.prisma as any).agent.findUnique({ where: { id: agentId }, select: { status: true } });
  const blockedReason =
    agent?.status !== "ACTIVE"
      ? "Your account is not active, so withdrawals are paused."
      : missing.length
        ? "Withdrawals open once FinixMart finishes setting up payouts."
        : w.available.lt(0)
          ? "Your balance is negative after a refunded return; it is offset by your next earnings."
          : v.minWithdrawalAmount && w.available.lt(v.minWithdrawalAmount)
            ? "Your available balance is below the minimum withdrawal."
            : null;
  return {
    ...walletJson(w),
    rules: {
      configured: missing.length === 0,
      minWithdrawalAmount: v.minWithdrawalAmount,
      maxWithdrawalAmount: v.maxWithdrawalAmount,
      withdrawalFee: v.withdrawalFee,
      enabledPayoutMethods: v.enabledPayoutMethods ?? [],
    },
    canWithdraw: blockedReason === null,
    blockedReason,
  };
}

// ── agent: request / list / cancel ────────────────────────────────────────

type RequestOutcome = { withdrawal: ReturnType<typeof withdrawalJson>; replayed: boolean };

function replay(existing: any, amount: string, payoutMethodId: string): RequestOutcome {
  if (dec(existing.amount).toFixed(2) !== amount || existing.payoutMethodId !== payoutMethodId) {
    throw conflict("This request id was already used for a different withdrawal", "IDEMPOTENCY_KEY_REUSED");
  }
  return { withdrawal: withdrawalJson(existing), replayed: true };
}

export async function requestWithdrawal(agentId: string, input: unknown, now: Date = new Date()): Promise<RequestOutcome> {
  const body = withdrawalRequestSchema.parse(input);
  const key = { agentId_clientRequestId: { agentId, clientRequestId: body.clientRequestId } };
  try {
    return await agentTransaction(async (tx: AgentTx) => {
      const db = tx as any;
      const existing = await db.agentWithdrawal.findUnique({ where: key, select: WITHDRAWAL_SELECT });
      if (existing) return replay(existing, body.amount, body.payoutMethodId);

      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { status: true } });
      if (agent?.status !== "ACTIVE") throw new AgentError("Withdrawals are paused while your account is not active", 403, "AGENT_NOT_ACTIVE");

      const settings = await getAgentSettings({ fresh: true, db });
      requireConfigured(settings, WITHDRAWAL_SETTING_KEYS, "Withdrawals");
      const v = settings.values;

      const method = await db.agentPayoutMethod.findFirst({
        where: { id: body.payoutMethodId, agentId },
        select: { id: true, type: true, accountName: true, accountNumber: true, bankName: true, branch: true, routingNumber: true },
      });
      if (!method) throw notFound("Payout method");
      if (!v.enabledPayoutMethods!.includes(method.type)) {
        throw new AgentError(`${PAYOUT_LABEL[method.type] ?? method.type} payouts are not enabled`, 409, "PAYOUT_METHOD_DISABLED", { enabledTypes: v.enabledPayoutMethods });
      }

      const amount = new Decimal(body.amount);
      if (amount.lt(v.minWithdrawalAmount!)) {
        throw new AgentError(`The minimum withdrawal is ৳${v.minWithdrawalAmount}`, 400, "AMOUNT_BELOW_MINIMUM", { min: v.minWithdrawalAmount });
      }
      if (amount.gt(v.maxWithdrawalAmount!)) {
        throw new AgentError(`The maximum withdrawal is ৳${v.maxWithdrawalAmount}`, 400, "AMOUNT_ABOVE_MAXIMUM", { max: v.maxWithdrawalAmount });
      }
      const fee = new Decimal(withdrawalFeeFor(body.amount, v.withdrawalFee));
      const net = amount.minus(fee);
      if (net.lte(0)) throw new AgentError("The fee would take the whole amount", 400, "AMOUNT_BELOW_FEE", { fee: fee.toFixed(2) });

      const w = await syncWalletInTx(tx, agentId, now);
      if (w.available.lt(amount)) {
        throw conflict("Your available balance is too low for this withdrawal", "INSUFFICIENT_BALANCE", { available: w.available.toFixed(2) });
      }

      const limit = new Decimal(v.autoApproveWithdrawalLimit!);
      const autoApproved = limit.gt(0) && amount.lte(limit);
      const created = await db.agentWithdrawal.create({
        data: {
          agentId,
          amount: amount.toFixed(2),
          fee: fee.toFixed(2),
          netAmount: net.toFixed(2),
          payoutMethodId: method.id,
          methodSnapshot: {
            type: method.type,
            accountName: method.accountName,
            accountNumber: method.accountNumber,
            bankName: method.bankName,
            branch: method.branch,
            routingNumber: method.routingNumber,
          },
          settingsSnapshot: {
            minWithdrawalAmount: v.minWithdrawalAmount,
            maxWithdrawalAmount: v.maxWithdrawalAmount,
            withdrawalFee: v.withdrawalFee,
            autoApproveWithdrawalLimit: v.autoApproveWithdrawalLimit,
            readAt: now.toISOString(),
          },
          status: autoApproved ? "APPROVED" : "REQUESTED",
          clientRequestId: body.clientRequestId,
          autoApproved,
          reviewedAt: autoApproved ? now : null,
        },
        select: WITHDRAWAL_SELECT,
      });

      await postLedger(tx, w, { type: "WITHDRAWAL_HOLD", amount: amount.negated(), refType: LEDGER_REF.withdrawal, refId: created.id });
      w.onHold = w.onHold.plus(amount);
      await saveWallet(tx, w);

      if (autoApproved) {
        await writeConfigAudit(tx, {
          entity: "WITHDRAWAL",
          entityId: created.id,
          action: "STATUS",
          oldValue: { status: "REQUESTED" },
          newValue: { status: "APPROVED", autoApproved: true, amount: amount.toFixed(2), autoApproveWithdrawalLimit: v.autoApproveWithdrawalLimit, agentId },
          actor: AUTO_APPROVE_ACTOR,
        });
      }
      return { withdrawal: withdrawalJson(created), replayed: false };
    });
  } catch (err: any) {
    // A concurrent double-submit with the same clientRequestId: the other one won.
    if (err?.code === "P2002") {
      const existing = await (agentDb.prisma as any).agentWithdrawal.findUnique({ where: key, select: WITHDRAWAL_SELECT });
      if (existing) return replay(existing, body.amount, body.payoutMethodId);
    }
    throw err;
  }
}

export async function listAgentWithdrawals(agentId: string, q: { page: number; limit: number; status?: string }) {
  const db = agentDb.prisma as any;
  const where: any = { agentId, ...(q.status ? { status: q.status } : {}) };
  const [rows, total, open, paid] = await Promise.all([
    db.agentWithdrawal.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.limit, take: q.limit, select: WITHDRAWAL_SELECT }),
    db.agentWithdrawal.count({ where }),
    db.agentWithdrawal.aggregate({ where: { agentId, status: { in: ["REQUESTED", "APPROVED"] } }, _sum: { amount: true } }),
    db.agentWithdrawal.aggregate({ where: { agentId, status: "PAID" }, _sum: { amount: true } }),
  ]);
  return {
    items: rows.map((r: any) => withdrawalJson(r)),
    total,
    page: q.page,
    limit: q.limit,
    totals: { pending: dec(open._sum.amount).toFixed(2), paid: dec(paid._sum.amount).toFixed(2) },
  };
}

/** Move a withdrawal from one of `from` to `to` with a guarded update; returns the row before the change. */
async function transition(tx: AgentTx, id: string, from: string[], data: Record<string, unknown>, agentId?: string) {
  const db = tx as any;
  const row = await db.agentWithdrawal.findFirst({ where: { id, ...(agentId ? { agentId } : {}) }, select: WITHDRAWAL_SELECT });
  if (!row) throw notFound("Withdrawal");
  if (!from.includes(row.status)) {
    throw conflict(`This withdrawal is ${row.status.toLowerCase()} and can't be changed this way`, "INVALID_WITHDRAWAL_STATE", { status: row.status });
  }
  const upd = await db.agentWithdrawal.updateMany({ where: { id, status: row.status }, data });
  if (upd.count !== 1) throw conflict("This withdrawal was changed by someone else; reload and try again", "WITHDRAWAL_CHANGED");
  return row;
}

/** Return a held amount to the balance (reject / cancel). Caller holds the wallet lock. */
async function releaseHold(tx: AgentTx, agentId: string, withdrawal: any, note: string, actorId: string | null) {
  const w = await lockWallet(tx, agentId);
  const amount = dec(withdrawal.amount);
  await postLedger(tx, w, { type: "WITHDRAWAL_RELEASE", amount, refType: LEDGER_REF.withdrawal, refId: withdrawal.id, note, createdById: actorId });
  w.onHold = Decimal.max(w.onHold.minus(amount), 0);
  await saveWallet(tx, w);
}

async function loadAgentIdOf(id: string, agentId?: string): Promise<string> {
  const row = await (agentDb.prisma as any).agentWithdrawal.findFirst({ where: { id, ...(agentId ? { agentId } : {}) }, select: { agentId: true } });
  if (!row) throw notFound("Withdrawal");
  return row.agentId;
}

export async function cancelWithdrawal(agentId: string, id: string, now: Date = new Date()) {
  await loadAgentIdOf(id, agentId);
  return agentTransaction(async (tx) => {
    await lockWallet(tx, agentId); // lock order: wallet first, then the withdrawal
    const before = await transition(tx, id, ["REQUESTED"], { status: "CANCELLED", reviewedAt: now }, agentId);
    await releaseHold(tx, agentId, before, "Cancelled by agent", null);
    const row = await (tx as any).agentWithdrawal.findUnique({ where: { id }, select: WITHDRAWAL_SELECT });
    return withdrawalJson(row);
  });
}

// ── admin ─────────────────────────────────────────────────────────────────

async function assertAgentActive(tx: AgentTx, agentId: string, action: string) {
  const agent = await (tx as any).agent.findUnique({ where: { id: agentId }, select: { status: true } });
  if (agent?.status !== "ACTIVE") {
    throw new AgentError(`The agent is ${String(agent?.status ?? "missing").toLowerCase()}; reactivate the agent before you ${action} this withdrawal (rejecting is allowed)`, 409, "AGENT_NOT_ACTIVE");
  }
}

export async function adminListWithdrawals(q: { page: number; limit: number; status?: string; agentId?: string }) {
  const db = agentDb.prisma as any;
  const where: any = { ...(q.status ? { status: q.status } : {}), ...(q.agentId ? { agentId: q.agentId } : {}) };
  const [rows, total, groups] = await Promise.all([
    db.agentWithdrawal.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.limit, take: q.limit, select: WITHDRAWAL_SELECT }),
    db.agentWithdrawal.count({ where }),
    db.agentWithdrawal.groupBy({ by: ["status"], where: q.agentId ? { agentId: q.agentId } : {}, _count: { _all: true }, _sum: { amount: true } }),
  ]);
  const agentIds = [...new Set(rows.map((r: any) => r.agentId))];
  const agents = agentIds.length ? await db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, agentCode: true, status: true } }) : [];
  const agentBy = new Map(agents.map((a: any) => [a.id, a]));
  const summary: Record<string, { count: number; amount: string }> = {};
  for (const g of groups) summary[g.status] = { count: g._count._all, amount: dec(g._sum.amount).toFixed(2) };
  return {
    items: rows.map((r: any) => {
      const a: any = agentBy.get(r.agentId);
      return { ...withdrawalJson(r), agent: { id: r.agentId, name: a?.name ?? "—", agentCode: a?.agentCode ?? null, status: a?.status ?? null } };
    }),
    total,
    page: q.page,
    limit: q.limit,
    summary,
  };
}

/** One withdrawal with the full payout details (admin only), the agent's wallet and its ledger entries. */
export async function adminGetWithdrawal(id: string) {
  const db = agentDb.prisma as any;
  const row = await db.agentWithdrawal.findUnique({ where: { id }, select: WITHDRAWAL_SELECT });
  if (!row) throw notFound("Withdrawal");
  const [agent, wallet, ledger] = await Promise.all([
    db.agent.findUnique({ where: { id: row.agentId }, select: { id: true, name: true, agentCode: true, status: true, email: true, phone: true } }),
    db.agentWallet.findUnique({ where: { agentId: row.agentId } }),
    db.agentWalletTransaction.findMany({ where: { refType: LEDGER_REF.withdrawal, refId: id }, orderBy: { createdAt: "asc" }, select: { id: true, type: true, amount: true, balanceAfter: true, createdAt: true } }),
  ]);
  return {
    ...withdrawalJson(row, { fullAccount: true }),
    settingsSnapshot: row.settingsSnapshot,
    reviewedById: row.reviewedById,
    paidById: row.paidById,
    agent,
    wallet: wallet
      ? { available: dec(wallet.available).toFixed(2), onHold: dec(wallet.onHold).toFixed(2), pendingClearance: dec(wallet.pendingClearance).toFixed(2) }
      : null,
    ledger: ledger.map((l: any) => ({ ...l, amount: dec(l.amount).toFixed(2), balanceAfter: dec(l.balanceAfter).toFixed(2) })),
  };
}

export async function approveWithdrawal(id: string, actor: AdminActor, now: Date = new Date()) {
  const agentId = await loadAgentIdOf(id);
  return agentTransaction(async (tx) => {
    await lockWallet(tx, agentId);
    await assertAgentActive(tx, agentId, "approve");
    const before = await transition(tx, id, ["REQUESTED"], { status: "APPROVED", reviewedById: actor.userId, reviewedAt: now });
    await writeConfigAudit(tx, {
      entity: "WITHDRAWAL",
      entityId: id,
      action: "STATUS",
      oldValue: { status: before.status },
      newValue: { status: "APPROVED", agentId, amount: dec(before.amount).toFixed(2) },
      actor,
    });
    return withdrawalJson(await (tx as any).agentWithdrawal.findUnique({ where: { id }, select: WITHDRAWAL_SELECT }));
  });
}

export async function rejectWithdrawal(id: string, reason: string, actor: AdminActor, now: Date = new Date()) {
  const agentId = await loadAgentIdOf(id);
  return agentTransaction(async (tx) => {
    await lockWallet(tx, agentId);
    const before = await transition(tx, id, ["REQUESTED", "APPROVED"], { status: "REJECTED", rejectReason: reason, reviewedById: actor.userId, reviewedAt: now });
    await releaseHold(tx, agentId, before, `Rejected: ${reason}`.slice(0, 500), actor.userId);
    await writeConfigAudit(tx, {
      entity: "WITHDRAWAL",
      entityId: id,
      action: "STATUS",
      oldValue: { status: before.status },
      newValue: { status: "REJECTED", reason, agentId, amount: dec(before.amount).toFixed(2), holdReleased: true },
      actor,
    });
    return withdrawalJson(await (tx as any).agentWithdrawal.findUnique({ where: { id }, select: WITHDRAWAL_SELECT }));
  });
}

export async function markWithdrawalPaid(id: string, input: { transactionRef: string; note?: string }, actor: AdminActor, now: Date = new Date()) {
  const agentId = await loadAgentIdOf(id);
  return agentTransaction(async (tx) => {
    const w = await lockWallet(tx, agentId);
    await assertAgentActive(tx, agentId, "pay");
    const before = await transition(tx, id, ["APPROVED"], { status: "PAID", transactionRef: input.transactionRef, paidById: actor.userId, paidAt: now });
    const amount = dec(before.amount);
    // Already debited by its hold: only onHold → totalWithdrawn moves.
    w.onHold = Decimal.max(w.onHold.minus(amount), 0);
    w.totalWithdrawn = w.totalWithdrawn.plus(amount);
    await saveWallet(tx, w);
    await writeConfigAudit(tx, {
      entity: "WITHDRAWAL",
      entityId: id,
      action: "STATUS",
      oldValue: { status: before.status },
      newValue: { status: "PAID", transactionRef: input.transactionRef, note: input.note ?? null, agentId, amount: amount.toFixed(2), netAmount: dec(before.netAmount).toFixed(2) },
      actor,
    });
    return withdrawalJson(await (tx as any).agentWithdrawal.findUnique({ where: { id }, select: WITHDRAWAL_SELECT }));
  });
}
