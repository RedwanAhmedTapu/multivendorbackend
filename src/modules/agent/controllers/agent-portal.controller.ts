// src/modules/agent/controllers/agent-portal.controller.ts
//
// Read-only monitoring endpoints. The agent is ALWAYS req.agent (set by
// authenticateAgent); no vendor/agent scope is accepted from the client.

import { handle, ok } from "../agent-http.ts";
import type { AgentRequest } from "../middlewares/agent-auth.middleware.ts";
import * as portal from "../services/agent-portal.service.ts";
import { getAgentSettings } from "../services/agent-settings.service.ts";
import {
  commissionTrendQuery,
  orderListQuery,
  orderParams,
  performanceQuery,
  productListQuery,
  reviewListQuery,
  salesTrendQuery,
  vendorListQuery,
  vendorParams,
} from "../validators/agent-portal.validators.ts";

const agentId = (req: AgentRequest) => req.agent!.id;

export const dashboardSummary = handle(async (req: AgentRequest, res) => {
  ok(res, await portal.dashboardSummary(agentId(req)));
});

export const salesTrend = handle(async (req: AgentRequest, res) => {
  const { range } = salesTrendQuery.parse(req.query);
  ok(res, await portal.salesTrend(agentId(req), range));
});

export const commissionTrend = handle(async (req: AgentRequest, res) => {
  const { range } = commissionTrendQuery.parse(req.query);
  ok(res, await portal.commissionTrend(agentId(req), range));
});

export const listVendors = handle(async (req: AgentRequest, res) => {
  ok(res, await portal.listVendors(agentId(req), vendorListQuery.parse(req.query)));
});

export const vendorDetail = handle(async (req: AgentRequest, res) => {
  const { vendorId } = vendorParams.parse(req.params);
  ok(res, await portal.vendorDetail(agentId(req), vendorId));
});

export const listOrders = handle(async (req: AgentRequest, res) => {
  ok(res, await portal.listOrders(agentId(req), orderListQuery.parse(req.query)));
});

export const orderDetail = handle(async (req: AgentRequest, res) => {
  const { vendorOrderId } = orderParams.parse(req.params);
  ok(res, await portal.orderDetail(agentId(req), vendorOrderId));
});

export const listProducts = handle(async (req: AgentRequest, res) => {
  ok(res, await portal.listProducts(agentId(req), productListQuery.parse(req.query)));
});

export const listReviews = handle(async (req: AgentRequest, res) => {
  ok(res, await portal.listReviews(agentId(req), reviewListQuery.parse(req.query)));
});

export const vendorPerformance = handle(async (req: AgentRequest, res) => {
  const { range } = performanceQuery.parse(req.query);
  ok(res, await portal.vendorPerformance(agentId(req), range));
});

export const analyticsInsights = handle(async (req: AgentRequest, res) => {
  ok(res, await portal.analyticsInsights(agentId(req)));
});

/** The program terms an agent may see (no admin-only data). */
export const programInfo = handle(async (_req: AgentRequest, res) => {
  const { values, missing } = await getAgentSettings();
  ok(res, {
    minWithdrawalAmount: values.minWithdrawalAmount,
    maxWithdrawalAmount: values.maxWithdrawalAmount,
    withdrawalFee: values.withdrawalFee,
    enabledPayoutMethods: values.enabledPayoutMethods,
    holdDays: values.holdDays,
    commissionDurationMonths: values.commissionDurationMonths,
    configured: {
      withdrawals: !["minWithdrawalAmount", "maxWithdrawalAmount", "withdrawalFee", "enabledPayoutMethods"].some((k) => missing.includes(k as any)),
    },
  });
});
