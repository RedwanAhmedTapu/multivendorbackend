// src/modules/hrm/controllers/salaryStructure.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { salaryStructureService } from "../services/salaryStructure.service.ts";

export const salaryStructureController = {
  async assign(req: HrScopedRequest, res: Response) {
    try {
      const result = await salaryStructureService.assign(req.hrScope, req.body, req.hrScope.actorUserId);
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async getCurrent(req: HrScopedRequest, res: Response) {
    try {
      const result = await salaryStructureService.getCurrent(req.hrScope, req.params.employeeId);
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async history(req: HrScopedRequest, res: Response) {
    try {
      const result = await salaryStructureService.history(req.hrScope, req.params.employeeId);
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
