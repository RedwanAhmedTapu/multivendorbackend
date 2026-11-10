// src/modules/hrm/controllers/advanceExpense.controller.ts
import type { Response } from "express";
import { selfEmployeeId, type HrScopedRequest } from "../utils/hrmScope.ts";
import { advanceService, expenseService } from "../services/advanceExpense.service.ts";

export const advanceController = {
  async apply(req: HrScopedRequest, res: Response) {
    try {
      // Self-service: always the authenticated employee themself — a
      // client-supplied employeeId is never trusted here.
      const employeeId = selfEmployeeId(req);
      if (!employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const adv = await advanceService.apply(req.hrScope, { ...req.body, employeeId });
      res.status(201).json({ success: true, data: adv });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async myAdvances(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) { res.status(400).json({ success: false, message: "No employee record" }); return; }
      const advs = await advanceService.list(req.hrScope, { employeeId: req.user.employeeId });
      res.status(200).json({ success: true, data: advs });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const advs = await advanceService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, data: advs });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async actOn(req: HrScopedRequest, res: Response) {
    try {
      const adv = await advanceService.actOn(req.hrScope, req.params.id, req.body.status, req.hrScope.actorUserId);
      res.status(200).json({ success: true, data: adv });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async recordRecovery(req: HrScopedRequest, res: Response) {
    try {
      const adv = await advanceService.recordRecovery(req.hrScope, req.params.id, req.body.amount);
      res.status(200).json({ success: true, data: adv });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};

export const expenseController = {
  async submit(req: HrScopedRequest, res: Response) {
    try {
      // Self-service: always the authenticated employee themself — a
      // client-supplied employeeId is never trusted here.
      const employeeId = selfEmployeeId(req);
      if (!employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const claim = await expenseService.submit(req.hrScope, { ...req.body, employeeId });
      res.status(201).json({ success: true, data: claim });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async myExpenses(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) { res.status(400).json({ success: false, message: "No employee record" }); return; }
      const claims = await expenseService.list(req.hrScope, { employeeId: req.user.employeeId });
      res.status(200).json({ success: true, data: claims });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const claims = await expenseService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, data: claims });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async actOn(req: HrScopedRequest, res: Response) {
    try {
      const claim = await expenseService.actOn(req.hrScope, req.params.id, req.body.status, req.body.approvedAmount, req.hrScope.actorUserId);
      res.status(200).json({ success: true, data: claim });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async markReimbursed(req: HrScopedRequest, res: Response) {
    try {
      const claim = await expenseService.markReimbursed(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: claim });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
