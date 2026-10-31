// src/modules/agent/controllers/agent-growth.controller.ts
//
// Phase 9 growth features (agent portal) and their admin actions, plus the
// admin wallet adjustment and payable report. Portal handlers ALWAYS scope to
// req.agent; the acting admin for audit rows always comes from req.user.

import type { Request } from "express";
import { z } from "zod";
import { handle, ok, requestOrigin } from "../agent-http.ts";
import type { AgentRequest } from "../middlewares/agent-auth.middleware.ts";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import type { AdminActor } from "../services/agent-audit.service.ts";
import { idSchema, pageQuery } from "../validators/agent-primitives.ts";
import { evaluateAgentLevel, evaluateAllAgentLevels, myLevel } from "../services/agent-level.service.ts";
import { bonusHistory, bonusProgress } from "../services/agent-bonus.service.ts";
import { leaderboard, performanceFor } from "../services/agent-growth.service.ts";
import { ALERT_TYPES, vendorAlerts } from "../services/agent-alerts.service.ts";
import * as training from "../services/agent-training.service.ts";
import { adjustAgentWallet, adminAgentWallet, payableReport } from "../services/agent-wallet-admin.service.ts";

const agentId = (req: AgentRequest) => req.agent!.id;
const param = (req: Request, key: string) => idSchema.parse(String(req.params[key] ?? ""));
function actorOf(req: AuthRequest): AdminActor {
  const origin = requestOrigin(req as Request);
  return { userId: req.user!.rawId, name: req.user!.name ?? null, ip: origin.ip, userAgent: origin.userAgent };
}

const pageOnly = z.object({ ...pageQuery });
const leaderboardQuery = z.object({ period: z.enum(["daily", "weekly", "monthly", "all"]).default("monthly"), top: z.coerce.number().int().min(3).max(50).default(10) });
const alertsQuery = z.object({ ...pageQuery, type: z.enum(ALERT_TYPES).optional() });
const evaluateBody = z.object({ agentId: idSchema.optional() }).strict();

// ── agent portal ──────────────────────────────────────────────────────────
export const getMyLevel = handle(async (req: AgentRequest, res) => ok(res, await myLevel(agentId(req))));
export const getBonusProgress = handle(async (req: AgentRequest, res) => ok(res, await bonusProgress(agentId(req))));
export const getBonusHistory = handle(async (req: AgentRequest, res) => ok(res, await bonusHistory(agentId(req), pageOnly.parse(req.query))));
export const getPerformance = handle(async (req: AgentRequest, res) => ok(res, await performanceFor(agentId(req))));
export const getLeaderboard = handle(async (req: AgentRequest, res) => {
  const q = leaderboardQuery.parse(req.query);
  ok(res, await leaderboard(agentId(req), q.period, new Date(), q.top));
});
export const getAlerts = handle(async (req: AgentRequest, res) => ok(res, await vendorAlerts(agentId(req), alertsQuery.parse(req.query))));
export const listTraining = handle(async (req: AgentRequest, res) => ok(res, await training.listPublishedTraining(training.trainingListQuery.parse(req.query))));
export const getTraining = handle(async (req: AgentRequest, res) => ok(res, await training.getPublishedTraining(param(req, "id"))));

// ── admin ─────────────────────────────────────────────────────────────────
/** "Run evaluation now": one agent (body.agentId) or every ACTIVE agent. */
export const adminEvaluateLevels = handle(async (req: AuthRequest, res) => {
  const body = evaluateBody.parse(req.body ?? {});
  ok(res, body.agentId ? await evaluateAgentLevel(body.agentId, actorOf(req)) : await evaluateAllAgentLevels(actorOf(req)));
});
export const adminListTraining = handle(async (req: AuthRequest, res) => ok(res, await training.adminListTraining(training.trainingListQuery.parse(req.query))));
export const adminCreateTraining = handle(async (req: AuthRequest, res) => ok(res, await training.createTraining(req.body, actorOf(req)), undefined, 201));
export const adminUpdateTraining = handle(async (req: AuthRequest, res) => ok(res, await training.updateTraining(param(req as Request, "id"), req.body, actorOf(req))));
export const adminDeleteTraining = handle(async (req: AuthRequest, res) => ok(res, await training.deleteTraining(param(req as Request, "id"), actorOf(req))));
export const adminGetAgentWallet = handle(async (req: AuthRequest, res) => ok(res, await adminAgentWallet(param(req as Request, "id"))));
export const adminAdjustAgentWallet = handle(async (req: AuthRequest, res) => {
  const out = await adjustAgentWallet(param(req as Request, "id"), req.body, actorOf(req));
  ok(res, out, { replayed: out.replayed }, out.replayed ? 200 : 201);
});
export const adminPayableReport = handle(async (req: AuthRequest, res) => ok(res, await payableReport(pageOnly.parse(req.query))));
