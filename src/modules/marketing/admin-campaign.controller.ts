// src/modules/marketing/admin-campaign.controller.ts
// Admin vendor-programme API handlers: validate input (zod), call the
// service, map MarketingError → HTTP. Actor for audit = User id (rawId).

import type { Request, Response, NextFunction } from "express";
import { ZodError, type ZodType } from "zod";
import type { AuthRequest } from "../../middlewares/auth.middleware.ts";
import { MarketingError, type CampaignService } from "./campaign.service.ts";
import {
  bulkReviewSchema,
  cancelSchema,
  createProgrammeSchema,
  listPagesQuery,
  listRegistrationsQuery,
  rejectSchema,
  updateProgrammeSchema,
} from "./campaign.validators.ts";

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value ?? {});
}

export function handle(fn: (req: AuthRequest, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req as AuthRequest, res);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ success: false, message: "Validation error", errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
        return;
      }
      if (err instanceof MarketingError) {
        res.status(err.statusCode).json({ success: false, message: err.message, details: err.details });
        return;
      }
      next(err);
    }
  };
}

export const actorOf = (req: AuthRequest) => {
  const userId = req.user?.rawId;
  if (!userId) throw new MarketingError(400, "Missing authenticated user");
  return { userId };
};

export function createAdminCampaignController(service: CampaignService) {
  return {
    listPages: handle(async (req, res) => {
      const result = await service.listCampaignPages(parse(listPagesQuery, req.query));
      res.json({ success: true, data: result.items, pagination: result.pagination });
    }),
    getProgramme: handle(async (req, res) => {
      res.json({ success: true, data: await service.getProgrammeByPage(req.params.pageId) });
    }),
    createProgramme: handle(async (req, res) => {
      const body = parse(createProgrammeSchema, req.body);
      res.status(201).json({ success: true, data: await service.createProgramme(actorOf(req), req.params.pageId, body) });
    }),
    updateProgramme: handle(async (req, res) => {
      const { acknowledgeTightening, ...patch } = parse(updateProgrammeSchema, req.body) as any;
      const result = await service.updateProgramme(actorOf(req), req.params.id, patch, { acknowledgeTightening });
      res.json({ success: true, data: result.programme, warning: result.warning });
    }),
    publish: handle(async (req, res) => {
      res.json({ success: true, data: await service.publishProgramme(actorOf(req), req.params.id) });
    }),
    cancel: handle(async (req, res) => {
      const { reason } = parse(cancelSchema, req.body);
      res.json({ success: true, data: await service.cancelProgramme(actorOf(req), req.params.id, reason) });
    }),
    listRegistrations: handle(async (req, res) => {
      const result = await service.listRegistrations(req.params.id, parse(listRegistrationsQuery, req.query));
      res.json({ success: true, data: result.items, pagination: result.pagination });
    }),
    approve: handle(async (req, res) => {
      res.json({ success: true, data: await service.approveRegistration(actorOf(req), req.params.id) });
    }),
    reject: handle(async (req, res) => {
      const { reason } = parse(rejectSchema, req.body);
      res.json({ success: true, data: await service.rejectRegistration(actorOf(req), req.params.id, reason) });
    }),
    bulkReview: handle(async (req, res) => {
      const body = parse(bulkReviewSchema, req.body);
      res.json({ success: true, data: await service.bulkReview(actorOf(req), req.params.id, body) });
    }),
  };
}
