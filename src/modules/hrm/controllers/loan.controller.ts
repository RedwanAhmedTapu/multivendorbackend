// src/modules/hrm/controllers/loan.controller.ts
import type { Response } from "express";
import { selfEmployeeId, type HrScopedRequest } from "../utils/hrmScope.ts";
import { loanService } from "../services/loan.service.ts";

export const loanController = {
  async apply(req: HrScopedRequest, res: Response) {
    try {
      // Self-service: always the authenticated employee themself — a
      // client-supplied employeeId is never trusted here.
      const employeeId = selfEmployeeId(req);
      if (!employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const loan = await loanService.apply(req.hrScope, { ...req.body, employeeId });
      res.status(201).json({ success: true, data: loan });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const loans = await loanService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, data: loans });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async getById(req: HrScopedRequest, res: Response) {
    try {
      const loan = await loanService.getById(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: loan });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },
  async actOn(req: HrScopedRequest, res: Response) {
    try {
      const loan = await loanService.actOn(req.hrScope, req.params.id, req.body.status, req.hrScope.actorUserId);
      res.status(200).json({ success: true, data: loan });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async recordPayment(req: HrScopedRequest, res: Response) {
    try {
      const { installmentNo, amount } = req.body;
      const installment = await loanService.recordPayment(req.hrScope, req.params.id, installmentNo, amount);
      res.status(200).json({ success: true, data: installment });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async myLoans(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const loans = await loanService.list(req.hrScope, { employeeId: req.user.employeeId });
      res.status(200).json({ success: true, data: loans });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
