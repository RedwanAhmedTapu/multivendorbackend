// src/modules/hrm/controllers/leave.controller.ts
import type { Response } from "express";
import { selfEmployeeId, type HrScopedRequest } from "../utils/hrmScope.ts";
import { leaveService } from "../services/leave.service.ts";

export const leaveController = {
  async createType(req: HrScopedRequest, res: Response) {
    try {
      const type = await leaveService.createType(req.hrScope, req.body);
      res.status(201).json({ success: true, data: type });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async updateType(req: HrScopedRequest, res: Response) {
    try {
      const type = await leaveService.updateType(req.hrScope, req.params.id, req.body);
      res.status(200).json({ success: true, data: type });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async listTypes(req: HrScopedRequest, res: Response) {
    try {
      const types = await leaveService.listTypes(req.hrScope);
      res.status(200).json({ success: true, data: types });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  /** Management list — includes deactivated types (hrLeaveTypesEdit route). */
  async listAllTypes(req: HrScopedRequest, res: Response) {
    try {
      const types = await leaveService.listTypes(req.hrScope, true);
      res.status(200).json({ success: true, data: types });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async createRequest(req: HrScopedRequest, res: Response) {
    try {
      // Self-service: always the authenticated employee themself — a
      // client-supplied employeeId is never trusted here.
      const employeeId = selfEmployeeId(req);
      if (!employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const request = await leaveService.createRequest(req.hrScope, { ...req.body, employeeId });
      res.status(201).json({ success: true, data: request });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async list(req: HrScopedRequest, res: Response) {
    try {
      const result = await leaveService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async myRequests(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const result = await leaveService.list(req.hrScope, {
        ...(req.query as any),
        employeeId: req.user.employeeId,
      });
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async getById(req: HrScopedRequest, res: Response) {
    try {
      const request = await leaveService.getById(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: request });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },

  async actOn(req: HrScopedRequest, res: Response) {
    try {
      const request = await leaveService.actOn(
        req.hrScope,
        req.params.id,
        req.body,
        req.hrScope.actorUserId,
        req.user?.employeeId ?? null
      );
      res.status(200).json({ success: true, data: request });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async myBalances(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const balances = await leaveService.myBalances(req.hrScope, req.user.employeeId);
      res.status(200).json({ success: true, data: balances });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
