// src/modules/agent/controllers/agent-admin.controller.ts
//
// Admin agent management. Mounted behind authenticateUser +
// authorizeRoles("ADMIN") + blockVendorEmployees (see agent.routes.ts).
// The acting admin for audit rows always comes from req.user.

import type { Request } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import { handle, ok, requestOrigin } from "../agent-http.ts";
import type { AdminActor } from "../services/agent-audit.service.ts";
import { listConfigAudit } from "../services/agent-audit.service.ts";
import * as admin from "../services/agent-admin.service.ts";
import * as config from "../services/agent-config.service.ts";
import { getAgentSettings, settingDefinitionsForClient, updateAgentSettings } from "../services/agent-settings.service.ts";
import {
  adminAgentCreateSchema,
  adminAgentListQuery,
  adminAgentUpdateSchema,
  agentStatusActionSchema,
  auditListQuery,
  lookupQuery,
  optionalReasonSchema,
  overrideEndSchema,
  ratePreviewQuery,
  vendorLinkAssignSchema,
} from "../validators/agent-config.validators.ts";

function actorOf(req: AuthRequest): AdminActor {
  const origin = requestOrigin(req as Request);
  return { userId: req.user!.rawId, name: req.user!.name ?? null, ip: origin.ip, userAgent: origin.userAgent };
}

const param = (req: Request, key: string) => String(req.params[key] ?? "");

// ── Settings ──────────────────────────────────────────────────────────────
export const getSettings = handle(async (_req: AuthRequest, res) => {
  const snapshot = await getAgentSettings({ fresh: true });
  ok(res, { ...snapshot, definitions: settingDefinitionsForClient() });
});

export const patchSettings = handle(async (req: AuthRequest, res) => {
  const { snapshot, changed } = await updateAgentSettings(req.body, actorOf(req));
  ok(res, { ...snapshot, definitions: settingDefinitionsForClient(), changed });
});

export const listAudit = handle(async (req: AuthRequest, res) => {
  ok(res, await listConfigAudit(auditListQuery.parse(req.query)));
});

// ── Levels ────────────────────────────────────────────────────────────────
export const listLevels = handle(async (_req, res) => ok(res, await config.listLevels()));
export const createLevel = handle(async (req: AuthRequest, res) => ok(res, await config.createLevel(req.body, actorOf(req)), undefined, 201));
export const updateLevel = handle(async (req: AuthRequest, res) => ok(res, await config.updateLevel(param(req, "id"), req.body, actorOf(req))));
export const deleteLevel = handle(async (req: AuthRequest, res) => {
  await config.deleteLevel(param(req, "id"), actorOf(req));
  ok(res, { deleted: true });
});

// ── Overrides ─────────────────────────────────────────────────────────────
export const listOverrides = handle(async (req, res) => ok(res, await config.listOverrides(req.query)));
export const createOverride = handle(async (req: AuthRequest, res) => ok(res, await config.createOverride(req.body, actorOf(req)), undefined, 201));
export const endOverride = handle(async (req: AuthRequest, res) => {
  const { note } = overrideEndSchema.parse(req.body ?? {});
  ok(res, await config.endOverride(param(req, "id"), note, actorOf(req)));
});
export const ratePreview = handle(async (req, res) => ok(res, await admin.previewRate(ratePreviewQuery.parse(req.query))));

// ── Bonus rules ───────────────────────────────────────────────────────────
export const listBonusRules = handle(async (_req, res) => ok(res, await config.listBonusRules()));
export const createBonusRule = handle(async (req: AuthRequest, res) => ok(res, await config.createBonusRule(req.body, actorOf(req)), undefined, 201));
export const updateBonusRule = handle(async (req: AuthRequest, res) => ok(res, await config.updateBonusRule(param(req, "id"), req.body, actorOf(req))));
export const deleteBonusRule = handle(async (req: AuthRequest, res) => {
  await config.deleteBonusRule(param(req, "id"), actorOf(req));
  ok(res, { deleted: true });
});

// ── Agents ────────────────────────────────────────────────────────────────
export const listAgents = handle(async (req, res) => ok(res, await admin.listAgents(adminAgentListQuery.parse(req.query))));
export const getAgent = handle(async (req, res) => ok(res, await admin.getAgentForAdmin(param(req, "id"))));
export const createAgent = handle(async (req: AuthRequest, res) => {
  const data = adminAgentCreateSchema.parse(req.body);
  ok(res, await admin.createAgent(data, actorOf(req)), undefined, 201);
});
export const updateAgent = handle(async (req: AuthRequest, res) => {
  const data = adminAgentUpdateSchema.parse(req.body);
  ok(res, await admin.updateAgentByAdmin(param(req, "id"), data, actorOf(req)));
});

export const approveAgent = handle(async (req: AuthRequest, res) => {
  optionalReasonSchema.parse(req.body ?? {});
  ok(res, await admin.changeAgentStatus(param(req, "id"), "approve", undefined, actorOf(req)));
});
export const reactivateAgent = handle(async (req: AuthRequest, res) => {
  const { reason } = optionalReasonSchema.parse(req.body ?? {});
  ok(res, await admin.changeAgentStatus(param(req, "id"), "reactivate", reason, actorOf(req)));
});
export const suspendAgent = handle(async (req: AuthRequest, res) => {
  const { reason } = agentStatusActionSchema.parse(req.body);
  ok(res, await admin.changeAgentStatus(param(req, "id"), "suspend", reason, actorOf(req)));
});
export const deactivateAgent = handle(async (req: AuthRequest, res) => {
  const { reason } = agentStatusActionSchema.parse(req.body);
  ok(res, await admin.changeAgentStatus(param(req, "id"), "deactivate", reason, actorOf(req)));
});

export const assignVendor = handle(async (req: AuthRequest, res) => {
  const data = vendorLinkAssignSchema.parse(req.body);
  ok(res, await admin.assignVendorToAgent(param(req, "id"), data, actorOf(req)), undefined, 201);
});
export const endVendorLink = handle(async (req: AuthRequest, res) => {
  const { reason } = optionalReasonSchema.parse(req.body ?? {});
  ok(res, await admin.endVendorLink(param(req, "linkId"), reason, actorOf(req)));
});

// ── Look-ups ──────────────────────────────────────────────────────────────
export const lookupVendors = handle(async (req, res) => ok(res, await admin.lookupVendors(lookupQuery.parse(req.query).q)));
export const lookupCategories = handle(async (req, res) => ok(res, await admin.lookupCategories(lookupQuery.parse(req.query).q)));
export const lookupAgents = handle(async (req, res) => ok(res, await admin.lookupAgents(lookupQuery.parse(req.query).q)));
