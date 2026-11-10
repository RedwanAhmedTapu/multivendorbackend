// src/modules/hrm/controllers/department.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { departmentService } from "../services/department.service.ts";

export const departmentController = {
  async create(req: HrScopedRequest, res: Response) {
    try {
      const dept = await departmentService.create(req.hrScope, req.body);
      res.status(201).json({ success: true, data: dept });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async list(req: HrScopedRequest, res: Response) {
    try {
      const branchId = req.query.branchId as string | undefined;
      const depts = await departmentService.list(req.hrScope, branchId);
      res.status(200).json({ success: true, data: depts });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async getById(req: HrScopedRequest, res: Response) {
    try {
      const dept = await departmentService.getById(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: dept });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },

  async update(req: HrScopedRequest, res: Response) {
    try {
      const dept = await departmentService.update(req.hrScope, req.params.id, req.body);
      res.status(200).json({ success: true, data: dept });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async remove(req: HrScopedRequest, res: Response) {
    try {
      await departmentService.remove(req.hrScope, req.params.id);
      res.status(200).json({ success: true, message: "Department archived" });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
