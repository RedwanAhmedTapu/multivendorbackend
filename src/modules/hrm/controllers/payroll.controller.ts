// src/modules/hrm/controllers/payroll.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { payrollService } from "../services/payroll.service.ts";

export const payrollController = {
  async createRun(req: HrScopedRequest, res: Response) {
    try {
      const { periodMonth, periodYear } = req.body;
      const run = await payrollService.createRun(req.hrScope, periodMonth, periodYear, req.hrScope.actorUserId);
      res.status(201).json({ success: true, data: run });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async list(req: HrScopedRequest, res: Response) {
    try {
      const runs = await payrollService.list(req.hrScope);
      res.status(200).json({ success: true, data: runs });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async getById(req: HrScopedRequest, res: Response) {
    try {
      const run = await payrollService.getById(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: run });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },

  async calculate(req: HrScopedRequest, res: Response) {
    try {
      const run = await payrollService.calculate(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: run });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async approve(req: HrScopedRequest, res: Response) {
    try {
      const run = await payrollService.approve(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: run });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async markPaid(req: HrScopedRequest, res: Response) {
    try {
      const run = await payrollService.markPaid(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: run });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
