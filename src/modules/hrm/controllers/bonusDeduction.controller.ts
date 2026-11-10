// src/modules/hrm/controllers/bonusDeduction.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { bonusService, deductionService } from "../services/bonusDeduction.service.ts";

export const bonusController = {
  async create(req: HrScopedRequest, res: Response) {
    try {
      const bonus = await bonusService.create(req.hrScope, req.body, req.hrScope.actorUserId);
      res.status(201).json({ success: true, data: bonus });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const bonuses = await bonusService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, data: bonuses });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async actOn(req: HrScopedRequest, res: Response) {
    try {
      const bonus = await bonusService.actOn(req.hrScope, req.params.id, req.body.status, req.hrScope.actorUserId);
      res.status(200).json({ success: true, data: bonus });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};

export const deductionController = {
  async create(req: HrScopedRequest, res: Response) {
    try {
      const ded = await deductionService.create(req.hrScope, req.body);
      res.status(201).json({ success: true, data: ded });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const deds = await deductionService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, data: deds });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async stop(req: HrScopedRequest, res: Response) {
    try {
      const ded = await deductionService.stop(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: ded });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
