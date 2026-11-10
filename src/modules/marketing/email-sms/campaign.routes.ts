// src/modules/marketing/email-sms/campaign.routes.ts
//
// Email & SMS campaigns admin API, mounted at /api/marketing/admin/email-sms.
// Router-level guard for EVERY route, copied verbatim from the sibling admin
// marketing router so the authorization posture cannot drift:
//   authenticateUser → authorizeRoles("ADMIN","EMPLOYEE") → blockVendorEmployees
//   → requirePermission("marketingManagement")
// Anonymous → 401; customer/vendor/vendor-staff → 403; admin-side staff need the
// marketingManagement permission; ADMIN passes.
//
// Only dry-run execution exists on this surface. There is no route that calls a
// provider, so no request from this router can send a real email or SMS.

import { Router, type Request, type Response } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { blockVendorEmployees, requirePermission } from "../../../middlewares/permission.middleware.ts";
import {
  CampaignError, archiveDraft, createDraft, dryRun, getCampaign, listCampaigns, previewAudience, updateDraft,
} from "./campaign.service.ts";
import type { CampaignDb, CampaignRow } from "./campaign.service.ts";

export type EmailSmsRouterDeps = { db: CampaignDb; actorIdOf?: (req: Request) => string | null };

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

/** Trimmed, bounded, typed view of a campaign for the wire — no internals leak. */
function serialize(row: CampaignRow) {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    type: row.type,
    status: row.status,
    subject: row.subjectSnapshot,
    body: row.bodySnapshot,
    audienceKind: row.audienceKind,
    scheduledAt: row.scheduledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function fail(res: Response, err: unknown) {
  if (err instanceof CampaignError) {
    res.status(err.status).json({ success: false, code: err.code, error: err.message });
    return;
  }
  // Never surface internal errors or secrets to the client.
  console.error("[email-sms] request failed:", (err as Error)?.name ?? "error");
  res.status(500).json({ success: false, code: "INTERNAL", error: "Something went wrong" });
}

function badRequest(res: Response, code: string, message: string) {
  res.status(400).json({ success: false, code, error: message });
}

export function createEmailSmsCampaignRouter({ db, actorIdOf }: EmailSmsRouterDeps) {
  const router = Router();
  router.use(authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), blockVendorEmployees, requirePermission("marketingManagement"));
  const actor = (req: Request) => (actorIdOf ? actorIdOf(req) : (((req as any).user?.rawId ?? (req as any).user?.id ?? null) as string | null));

  router.post("/", async (req: Request, res: Response) => {
    try {
      const { name, channel, type, subject, body, audienceKind, idempotencyKey } = req.body ?? {};
      const row = await createDraft(db, { name, channel, type, subject, body, audienceKind, idempotencyKey }, actor(req));
      res.status(201).json({ success: true, data: serialize(row) });
    } catch (err) { fail(res, err); }
  });

  router.get("/", async (req: Request, res: Response) => {
    try {
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
      if (!Number.isInteger(page) || page < 1) return badRequest(res, "PAGE_INVALID", "page must be a positive integer");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return badRequest(res, "LIMIT_INVALID", "limit must be between 1 and 100");
      const status = typeof req.query.status === "string" ? (req.query.status as any) : "ALL";
      const channel = typeof req.query.channel === "string" ? (req.query.channel as any) : "ALL";
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const result = await listCampaigns(db, { page, limit, status, channel, search });
      res.json({ success: true, data: result.items.map(serialize), pagination: result.pagination });
    } catch (err) { fail(res, err); }
  });

  router.get("/:id", async (req: Request, res: Response) => {
    try {
      if (!ID_RE.test(req.params.id)) return badRequest(res, "ID_INVALID", "Invalid campaign id");
      res.json({ success: true, data: serialize(await getCampaign(db, req.params.id)) });
    } catch (err) { fail(res, err); }
  });

  router.patch("/:id", async (req: Request, res: Response) => {
    try {
      if (!ID_RE.test(req.params.id)) return badRequest(res, "ID_INVALID", "Invalid campaign id");
      const patch = req.body ?? {};
      res.json({ success: true, data: serialize(await updateDraft(db, req.params.id, patch)) });
    } catch (err) { fail(res, err); }
  });

  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      if (!ID_RE.test(req.params.id)) return badRequest(res, "ID_INVALID", "Invalid campaign id");
      res.json({ success: true, data: serialize(await archiveDraft(db, req.params.id)) });
    } catch (err) { fail(res, err); }
  });

  router.get("/:id/audience", async (req: Request, res: Response) => {
    try {
      if (!ID_RE.test(req.params.id)) return badRequest(res, "ID_INVALID", "Invalid campaign id");
      res.json({ success: true, data: await previewAudience(db, req.params.id) });
    } catch (err) { fail(res, err); }
  });

  router.post("/:id/dry-run", async (req: Request, res: Response) => {
    try {
      if (!ID_RE.test(req.params.id)) return badRequest(res, "ID_INVALID", "Invalid campaign id");
      res.json({ success: true, data: await dryRun(db, req.params.id) });
    } catch (err) { fail(res, err); }
  });

  return router;
}

export default createEmailSmsCampaignRouter;
