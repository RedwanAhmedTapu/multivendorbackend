// src/modules/hrm/controllers/designation.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { designationService } from "../services/designation.service.ts";

export const designationController = {
  async create(req: HrScopedRequest, res: Response) {
    try {
      const designation = await designationService.create(req.hrScope, req.body);
      res.status(201).json({ success: true, data: designation });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async list(req: HrScopedRequest, res: Response) {
    try {
      const departmentId = req.query.departmentId as string | undefined;
      const designations = await designationService.list(req.hrScope, departmentId);
      res.status(200).json({ success: true, data: designations });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async getById(req: HrScopedRequest, res: Response) {
    try {
      const designation = await designationService.getById(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: designation });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },

  async update(req: HrScopedRequest, res: Response) {
    try {
      const designation = await designationService.update(req.hrScope, req.params.id, req.body);
      res.status(200).json({ success: true, data: designation });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async remove(req: HrScopedRequest, res: Response) {
    try {
      await designationService.remove(req.hrScope, req.params.id);
      res.status(200).json({ success: true, message: "Designation archived" });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
