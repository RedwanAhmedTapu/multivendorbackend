// src/modules/hrm/controllers/resignation.controller.ts
import type { Response } from "express";
import { selfEmployeeId, type HrScopedRequest } from "../utils/hrmScope.ts";
import { resignationService, exitClearanceService, finalSettlementService } from "../services/resignation.service.ts";

export const resignationController = {
  async submit(req: HrScopedRequest, res: Response) {
    try {
      // Self-service: always the authenticated employee themself — a
      // client-supplied employeeId is never trusted here.
      const employeeId = selfEmployeeId(req);
      if (!employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const resignation = await resignationService.submit(req.hrScope, { ...req.body, employeeId });
      res.status(201).json({ success: true, data: resignation });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const resignations = await resignationService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, data: resignations });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async getById(req: HrScopedRequest, res: Response) {
    try {
      const resignation = await resignationService.getById(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: resignation });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },
  async actOn(req: HrScopedRequest, res: Response) {
    try {
      const resignation = await resignationService.actOn(req.hrScope, req.params.id, req.body, req.hrScope.actorUserId);
      res.status(200).json({ success: true, data: resignation });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async withdraw(req: HrScopedRequest, res: Response) {
    try {
      const resignation = await resignationService.withdraw(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: resignation });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};

export const exitClearanceController = {
  async getByResignation(req: HrScopedRequest, res: Response) {
    try {
      const clearance = await exitClearanceService.getByResignation(req.hrScope, req.params.resignationId);
      res.status(200).json({ success: true, data: clearance });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },
  async updateChecklist(req: HrScopedRequest, res: Response) {
    try {
      const clearance = await exitClearanceService.updateChecklist(req.hrScope, req.params.resignationId, req.body.checklistJson);
      res.status(200).json({ success: true, data: clearance });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};

export const finalSettlementController = {
  async compute(req: HrScopedRequest, res: Response) {
    try {
      const settlement = await finalSettlementService.compute(req.hrScope, req.params.resignationId);
      res.status(200).json({ success: true, data: settlement });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async approve(req: HrScopedRequest, res: Response) {
    try {
      const settlement = await finalSettlementService.approve(req.hrScope, req.params.resignationId, req.hrScope.actorUserId);
      res.status(200).json({ success: true, data: settlement });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async markPaid(req: HrScopedRequest, res: Response) {
    try {
      const settlement = await finalSettlementService.markPaid(req.hrScope, req.params.resignationId);
      res.status(200).json({ success: true, data: settlement });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
