// src/modules/hrm/controllers/letter.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { letterTemplateService, letterService } from "../services/letter.service.ts";
import { renderLetterPdf } from "../services/letterPdf.service.ts";
import { getHrCapabilities } from "../../../middlewares/permission.middleware.ts";

export const letterTemplateController = {
  async create(req: HrScopedRequest, res: Response) {
    try {
      const template = await letterTemplateService.create(req.hrScope, req.body);
      res.status(201).json({ success: true, data: template });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const templates = await letterTemplateService.list(req.hrScope);
      res.status(200).json({ success: true, data: templates });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  /** Management list — includes deactivated templates. */
  async listAll(req: HrScopedRequest, res: Response) {
    try {
      const templates = await letterTemplateService.listAll(req.hrScope);
      res.status(200).json({ success: true, data: templates });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async update(req: HrScopedRequest, res: Response) {
    try {
      const template = await letterTemplateService.update(req.hrScope, req.params.id, req.body);
      res.status(200).json({ success: true, data: template });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async remove(req: HrScopedRequest, res: Response) {
    try {
      const result = await letterTemplateService.remove(req.hrScope, req.params.id);
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};

export const letterController = {
  async generate(req: HrScopedRequest, res: Response) {
    try {
      // Salary variables in the template body require hrSalaryView —
      // resolved server-side from the session, never from the client.
      const caps = await getHrCapabilities(req.user);
      const letter = await letterService.generate(
        req.hrScope, req.body, req.hrScope.actorUserId, caps.hrSalaryView
      );
      res.status(201).json({ success: true, data: letter });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async list(req: HrScopedRequest, res: Response) {
    try {
      const letters = await letterService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, data: letters });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async getById(req: HrScopedRequest, res: Response) {
    try {
      const letter = await letterService.getById(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: letter });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  },
  async prepare(req: HrScopedRequest, res: Response) {
    try {
      const letter = await letterService.prepare(req.hrScope, req.params.id, req.hrScope.actorUserId);
      res.status(200).json({ success: true, data: letter });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async approve(req: HrScopedRequest, res: Response) {
    try {
      const letter = await letterService.approve(req.hrScope, req.params.id, req.hrScope.actorUserId);
      res.status(200).json({ success: true, data: letter });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async reject(req: HrScopedRequest, res: Response) {
    try {
      const letter = await letterService.reject(req.hrScope, req.params.id, req.hrScope.actorUserId);
      res.status(200).json({ success: true, data: letter });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async issue(req: HrScopedRequest, res: Response) {
    try {
      const letter = await letterService.issue(req.hrScope, req.params.id);
      res.status(200).json({ success: true, data: letter });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
  async downloadPdf(req: HrScopedRequest, res: Response) {
    try {
      const letter = await letterService.getById(req.hrScope, req.params.id);
      if (!["APPROVED", "ISSUED"].includes(letter.status)) {
        res.status(400).json({ success: false, message: "Only an APPROVED or ISSUED letter can be downloaded as PDF" });
        return;
      }
      const pdfBuffer = await renderLetterPdf(letter);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${letter.letterNumber}.pdf"`);
      res.send(pdfBuffer);
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async downloadMyPdf(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const letter = await letterService.getById(req.hrScope, req.params.id);
      if (letter.employeeId !== req.user.employeeId) {
        res.status(403).json({ success: false, message: "Forbidden" });
        return;
      }
      if (letter.status !== "ISSUED") {
        res.status(400).json({ success: false, message: "This letter hasn't been issued yet" });
        return;
      }
      const pdfBuffer = await renderLetterPdf(letter);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${letter.letterNumber}.pdf"`);
      res.send(pdfBuffer);
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async myLetters(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) { res.status(400).json({ success: false, message: "No employee record" }); return; }
      const letters = await letterService.list(req.hrScope, { employeeId: req.user.employeeId, status: "ISSUED" });
      res.status(200).json({ success: true, data: letters });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
