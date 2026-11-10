// src/modules/hrm/controllers/branch.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { branchService } from "../services/branch.service.ts";

export const branchController = {
  async create(req: HrScopedRequest, res: Response) {
    try {
      const branch = await branchService.create(req.hrScope, req.body);
      res.status(201).json({ success: true, data: branch });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async list(req: HrScopedRequest, res: Response) {
    try {
      const branches = await branchService.list(req.hrScope);
      res.status(200).json({ success: true, data: branches });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async getById(req: HrScopedRequest, res: Response) {
    try {
      const branch = await branchService.getById(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: branch });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },

  async update(req: HrScopedRequest, res: Response) {
    try {
      const branch = await branchService.update(req.hrScope, req.params.id, req.body);
      res.status(200).json({ success: true, data: branch });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async remove(req: HrScopedRequest, res: Response) {
    try {
      await branchService.remove(req.hrScope, req.params.id);
      res.status(200).json({ success: true, message: "Branch deactivated" });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
