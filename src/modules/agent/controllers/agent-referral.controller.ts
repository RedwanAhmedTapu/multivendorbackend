// src/modules/agent/controllers/agent-referral.controller.ts
//
// Referral Tracking (Phase 8). Always the signed-in agent's own code and vendors.

import { z } from "zod";
import { handle, ok } from "../agent-http.ts";
import type { AgentRequest } from "../middlewares/agent-auth.middleware.ts";
import { pageQuery } from "../validators/agent-primitives.ts";
import { referralInfo, referredVendors } from "../services/agent-referral.service.ts";

const referredVendorsQuery = z.object({ ...pageQuery });

export const getReferral = handle(async (req: AgentRequest, res) => {
  ok(res, await referralInfo(req.agent!.id));
});

export const listReferredVendors = handle(async (req: AgentRequest, res) => {
  ok(res, await referredVendors(req.agent!.id, referredVendorsQuery.parse(req.query)));
});
