// src/modules/hrm/controllers/approval.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { approvalService } from "../services/approval.service.ts";

export const approvalController = {
  async createWorkflow(req: HrScopedRequest, res: Response) {
    try {
      const workflow = await approvalService.createWorkflow(req.hrScope, req.body);
      res.status(201).json({ success: true, data: workflow });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async listWorkflows(req: HrScopedRequest, res: Response) {
    try {
      const workflows = await approvalService.listWorkflows(req.hrScope);
      res.status(200).json({ success: true, data: workflows });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async listPending(req: HrScopedRequest, res: Response) {
    try {
      const processType = req.query.processType as string | undefined;
      const requests = await approvalService.listPending(req.hrScope, processType);
      res.status(200).json({ success: true, data: requests });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async getById(req: HrScopedRequest, res: Response) {
    try {
      const request = await approvalService.getById(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: request });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },

  async actOn(req: HrScopedRequest, res: Response) {
    try {
      const request = await approvalService.actOnRequest(
        req.hrScope,
        req.params.id,
        req.body,
        req.hrScope.actorUserId
      );
      res.status(200).json({ success: true, data: request });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
