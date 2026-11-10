// src/modules/hrm/controllers/performance.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { reviewCycleService, performanceReviewService, kpiService } from "../services/performance.service.ts";

export const reviewCycleController = {
  async create(req: HrScopedRequest, res: Response) {
    try {
      const cycle = await reviewCycleService.create(req.hrScope, req.body);
      res.status(201).json({ success: true, data: cycle });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const cycles = await reviewCycleService.list(req.hrScope);
      res.status(200).json({ success: true, data: cycles });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async close(req: HrScopedRequest, res: Response) {
    try {
      const cycle = await reviewCycleService.close(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: cycle });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};

export const performanceReviewController = {
  async create(req: HrScopedRequest, res: Response) {
    try {
      const review = await performanceReviewService.create(req.hrScope, req.body);
      res.status(201).json({ success: true, data: review });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async submit(req: HrScopedRequest, res: Response) {
    try {
      const review = await performanceReviewService.submit(req.hrScope, req.params.id, req.body);
      res.status(200).json({ success: true, data: review });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async acknowledge(req: HrScopedRequest, res: Response) {
    try {
      const review = await performanceReviewService.acknowledge(req.hrScope, req.params.id, req.body.employeeComments);
      res.status(200).json({ success: true, data: review });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async finalize(req: HrScopedRequest, res: Response) {
    try {
      const review = await performanceReviewService.finalize(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: review });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const reviews = await performanceReviewService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, data: reviews });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async myReviews(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) { res.status(400).json({ success: false, message: "No employee record" }); return; }
      const reviews = await performanceReviewService.list(req.hrScope, { employeeId: req.user.employeeId });
      res.status(200).json({ success: true, data: reviews });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};

export const kpiController = {
  async createTemplate(req: HrScopedRequest, res: Response) {
    try {
      const template = await kpiService.createTemplate(req.hrScope, req.body);
      res.status(201).json({ success: true, data: template });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async listTemplates(req: HrScopedRequest, res: Response) {
    try {
      const templates = await kpiService.listTemplates(req.hrScope);
      res.status(200).json({ success: true, data: templates });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async assign(req: HrScopedRequest, res: Response) {
    try {
      const assignment = await kpiService.assign(req.hrScope, req.body);
      res.status(201).json({ success: true, data: assignment });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async submitResults(req: HrScopedRequest, res: Response) {
    try {
      const assignment = await kpiService.submitResults(req.hrScope, req.params.id, req.body.resultsJson);
      res.status(200).json({ success: true, data: assignment });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async review(req: HrScopedRequest, res: Response) {
    try {
      const assignment = await kpiService.review(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: assignment });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const assignments = await kpiService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, data: assignments });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async myAssignments(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) { res.status(400).json({ success: false, message: "No employee record" }); return; }
      const assignments = await kpiService.list(req.hrScope, { employeeId: req.user.employeeId });
      res.status(200).json({ success: true, data: assignments });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
