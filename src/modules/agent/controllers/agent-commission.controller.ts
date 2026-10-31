// src/modules/agent/controllers/agent-commission.controller.ts
//
// Commission Dashboard (agent portal) and the admin commission list.
// Portal handlers ALWAYS scope to req.agent — no agent id is accepted from the client.

import type { Response } from "express";
import { handle, ok } from "../agent-http.ts";
import type { AgentRequest } from "../middlewares/agent-auth.middleware.ts";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import * as read from "../services/agent-commission-read.service.ts";
import {
  adminCommissionExportQuery,
  adminCommissionListQuery,
  agentCommissionExportQuery,
  agentCommissionListQuery,
  agentCommissionTrendQuery,
} from "../validators/agent-commission.validators.ts";

const agentId = (req: AgentRequest) => req.agent!.id;

function sendCsv(res: Response, filename: string, out: { csv: string; total: number; truncated: boolean }) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Total-Count", String(out.total));
  res.setHeader("X-Truncated", out.truncated ? "1" : "0");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(out.csv);
}

const stamp = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);

// ── agent portal ──────────────────────────────────────────────────────────
export const commissionSummary = handle(async (req: AgentRequest, res) => {
  ok(res, await read.commissionSummary(agentId(req)));
});

export const commissionEarningsTrend = handle(async (req: AgentRequest, res) => {
  const { range } = agentCommissionTrendQuery.parse(req.query);
  ok(res, await read.commissionEarningsTrend(agentId(req), range));
});

export const listMyCommissions = handle(async (req: AgentRequest, res) => {
  const q = agentCommissionListQuery.parse(req.query);
  ok(res, await read.listCommissions(q, { scopeAgentId: agentId(req) }));
});

export const exportMyCommissions = handle(async (req: AgentRequest, res) => {
  const q = agentCommissionExportQuery.parse(req.query);
  sendCsv(res, `finixmart-commissions-${stamp()}.csv`, await read.exportCommissionsCsv(q, { scopeAgentId: agentId(req) }));
});

// ── admin ─────────────────────────────────────────────────────────────────
export const adminListCommissions = handle(async (req: AuthRequest, res) => {
  const q = adminCommissionListQuery.parse(req.query);
  ok(res, await read.listCommissions(q, { withAgent: true }));
});

export const adminExportCommissions = handle(async (req: AuthRequest, res) => {
  const q = adminCommissionExportQuery.parse(req.query);
  sendCsv(res, `finixmart-agent-commissions-${stamp()}.csv`, await read.exportCommissionsCsv(q, { withAgent: true }));
});
