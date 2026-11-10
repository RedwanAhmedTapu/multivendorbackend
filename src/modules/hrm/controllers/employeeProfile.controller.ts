// src/modules/hrm/controllers/employeeProfile.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { employeeProfileService } from "../services/employeeProfile.service.ts";
import { getHrCapabilities } from "../../../middlewares/permission.middleware.ts";

export const employeeProfileController = {
  async create(req: HrScopedRequest, res: Response) {
    try {
      const profile = await employeeProfileService.create(req.hrScope, req.body);
      res.status(201).json({ success: true, data: profile });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async list(req: HrScopedRequest, res: Response) {
    try {
      const result = await employeeProfileService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async getById(req: HrScopedRequest, res: Response) {
    try {
      // Salary/bank shaping is driven by server-derived capabilities —
      // the viewer's own session, not client hints.
      const caps = await getHrCapabilities(req.user);
      const profile = await employeeProfileService.getById(req.hrScope, req.params.id, {
        salaryView: caps.hrSalaryView,
        bankFull: caps.hrBankView,
      });
      res.status(200).json({ success: true, data: profile });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },

  async getMyProfile(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const profile = await employeeProfileService.getMyProfile(req.hrScope, req.user.employeeId);
      res.status(200).json({ success: true, data: profile });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },

  async update(req: HrScopedRequest, res: Response) {
    try {
      const profile = await employeeProfileService.update(
        req.hrScope,
        req.params.id,
        req.body,
        req.hrScope.actorUserId
      );
      res.status(200).json({ success: true, data: profile });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  /** Archive (soft delete) — INACTIVE + history event. */
  async remove(req: HrScopedRequest, res: Response) {
    try {
      await employeeProfileService.remove(req.hrScope, req.params.id, req.hrScope.actorUserId);
      res.status(200).json({ success: true, message: "Employee archived (INACTIVE)" });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  /** Permanent delete — requires typed employee code, re-verified server-side. */
  async hardDelete(req: HrScopedRequest, res: Response) {
    try {
      const result = await employeeProfileService.hardDelete(
        req.hrScope,
        req.params.id,
        req.body?.confirm,
        req.hrScope.actorUserId
      );
      res.status(200).json({ success: true, message: `Permanently deleted ${result.fullName} (${result.code})` });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
