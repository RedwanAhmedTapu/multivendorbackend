// src/modules/hrm/controllers/employeeLifecycle.controller.ts
//
// Promotion / transfer / salary revision controllers: create PENDING
// records, act on them (APPROVED/REJECTED), and list the employee's
// history timeline.

import type { Response } from "express";
import { employeeLifecycleService, type LifecycleKind } from "../services/employeeLifecycle.service.ts";
import type { HrScopedRequest } from "../utils/hrmScope.ts";

function sendError(res: Response, error: any) {
  const status = /not found/i.test(String(error?.message)) ? 404 : 400;
  res.status(status).json({ success: false, message: error?.message ?? "Request failed" });
}

const KINDS: Record<string, LifecycleKind> = {
  promotions: "promotions",
  transfers: "transfers",
  "salary-revisions": "salaryRevisions",
};

export const employeeLifecycleController = {
  create(req: HrScopedRequest, res: Response) {
    const kind = KINDS[req.params.kind];
    if (!kind) {
      res.status(404).json({ success: false, message: "Unknown lifecycle action" });
      return;
    }
    (async () => {
      try {
        const actorUserId = req.hrScope.actorUserId;
        let record;
        if (kind === "promotions") {
          record = await employeeLifecycleService.createPromotion(req.hrScope, req.params.id, req.body, actorUserId);
        } else if (kind === "transfers") {
          record = await employeeLifecycleService.createTransfer(req.hrScope, req.params.id, req.body, actorUserId);
        } else {
          record = await employeeLifecycleService.createSalaryRevision(req.hrScope, req.params.id, req.body, actorUserId);
        }
        res.status(201).json({ success: true, data: record });
      } catch (error: any) {
        sendError(res, error);
      }
    })();
  },

  act(req: HrScopedRequest, res: Response) {
    const kind = KINDS[req.params.kind];
    if (!kind) {
      res.status(404).json({ success: false, message: "Unknown lifecycle action" });
      return;
    }
    (async () => {
      try {
        const record = await employeeLifecycleService.actOn(
          req.hrScope,
          kind,
          req.params.id,
          req.params.sectionId,
          req.body.status,
          req.hrScope.actorUserId
        );
        res.status(200).json({ success: true, data: record });
      } catch (error: any) {
        sendError(res, error);
      }
    })();
  },

  listHistory: (req: HrScopedRequest, res: Response) => {
    (async () => {
      try {
        const history = await employeeLifecycleService.listHistory(req.hrScope, req.params.id);
        res.status(200).json({ success: true, data: history });
      } catch (error: any) {
        sendError(res, error);
      }
    })();
  },
};
