// src/modules/agent/controllers/agent-wallet.controller.ts
//
// Phase 7: wallet, payout methods and withdrawals (agent portal), and the
// admin withdrawal actions plus "re-run accrual". Portal handlers ALWAYS
// scope to req.agent — no agent id is accepted from the client. The acting
// admin for audit rows always comes from req.user.

import type { Request } from "express";
import { handle, ok, requestOrigin } from "../agent-http.ts";
import type { AgentRequest } from "../middlewares/agent-auth.middleware.ts";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import type { AdminActor } from "../services/agent-audit.service.ts";
import { listWalletTransactions } from "../services/agent-wallet.service.ts";
import * as payout from "../services/agent-payout.service.ts";
import * as wd from "../services/agent-withdrawal.service.ts";
import { rerunAccrualForDelivery } from "../services/agent-commission-admin.service.ts";
import {
  adminWithdrawalListQuery,
  walletTransactionsQuery,
  withdrawalListQuery,
  withdrawalMarkPaidSchema,
  withdrawalRejectSchema,
} from "../validators/agent-wallet.validators.ts";
import { idSchema } from "../validators/agent-primitives.ts";

const agentId = (req: AgentRequest) => req.agent!.id;
const param = (req: Request, key: string) => idSchema.parse(String(req.params[key] ?? ""));

function actorOf(req: AuthRequest): AdminActor {
  const origin = requestOrigin(req as Request);
  return { userId: req.user!.rawId, name: req.user!.name ?? null, ip: origin.ip, userAgent: origin.userAgent };
}

// ── agent portal: wallet ──────────────────────────────────────────────────
export const getWallet = handle(async (req: AgentRequest, res) => {
  ok(res, await wd.getAgentWallet(agentId(req)));
});

export const listTransactions = handle(async (req: AgentRequest, res) => {
  const q = walletTransactionsQuery.parse(req.query);
  ok(res, await listWalletTransactions(agentId(req), q));
});

// ── agent portal: payout methods ──────────────────────────────────────────
export const listPayoutMethods = handle(async (req: AgentRequest, res) => {
  ok(res, await payout.listPayoutMethods(agentId(req)));
});

export const createPayoutMethod = handle(async (req: AgentRequest, res) => {
  ok(res, await payout.createPayoutMethod(agentId(req), req.body), undefined, 201);
});

export const updatePayoutMethod = handle(async (req: AgentRequest, res) => {
  ok(res, await payout.updatePayoutMethod(agentId(req), param(req, "id"), req.body));
});

export const deletePayoutMethod = handle(async (req: AgentRequest, res) => {
  ok(res, await payout.deletePayoutMethod(agentId(req), param(req, "id")));
});

export const setDefaultPayoutMethod = handle(async (req: AgentRequest, res) => {
  ok(res, await payout.setDefaultPayoutMethod(agentId(req), param(req, "id")));
});

// ── agent portal: withdrawals ─────────────────────────────────────────────
export const listMyWithdrawals = handle(async (req: AgentRequest, res) => {
  const q = withdrawalListQuery.parse(req.query);
  ok(res, await wd.listAgentWithdrawals(agentId(req), q));
});

export const requestWithdrawal = handle(async (req: AgentRequest, res) => {
  const out = await wd.requestWithdrawal(agentId(req), req.body);
  ok(res, out.withdrawal, { replayed: out.replayed }, out.replayed ? 200 : 201);
});

export const cancelMyWithdrawal = handle(async (req: AgentRequest, res) => {
  ok(res, await wd.cancelWithdrawal(agentId(req), param(req, "id")));
});

// ── admin ─────────────────────────────────────────────────────────────────
export const adminListWithdrawals = handle(async (req: AuthRequest, res) => {
  const q = adminWithdrawalListQuery.parse(req.query);
  ok(res, await wd.adminListWithdrawals(q));
});

export const adminGetWithdrawal = handle(async (req: AuthRequest, res) => {
  ok(res, await wd.adminGetWithdrawal(param(req as Request, "id")));
});

export const adminApproveWithdrawal = handle(async (req: AuthRequest, res) => {
  ok(res, await wd.approveWithdrawal(param(req as Request, "id"), actorOf(req)));
});

export const adminRejectWithdrawal = handle(async (req: AuthRequest, res) => {
  const { reason } = withdrawalRejectSchema.parse(req.body);
  ok(res, await wd.rejectWithdrawal(param(req as Request, "id"), reason, actorOf(req)));
});

export const adminMarkWithdrawalPaid = handle(async (req: AuthRequest, res) => {
  const body = withdrawalMarkPaidSchema.parse(req.body);
  ok(res, await wd.markWithdrawalPaid(param(req as Request, "id"), body, actorOf(req)));
});

export const adminRerunAccrual = handle(async (req: AuthRequest, res) => {
  ok(res, await rerunAccrualForDelivery(param(req as Request, "deliveryId"), actorOf(req)));
});
