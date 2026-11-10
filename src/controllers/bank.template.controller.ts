// src/controllers/bank.template.controller.ts
import type { Request, Response } from "express";
import { BankTemplateGenerator } from "../utils/excelTemplates/bankTemplateGenerator.ts";

export const BankTemplateController = {
  async downloadTemplate(req: Request, res: Response) {
    try {
      const buffer = await BankTemplateGenerator.generateWorkbookBuffer();
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="bank_template.xlsx"');
      res.setHeader("Content-Length", buffer.length);
      res.send(buffer);
    } catch (error: any) {
      res.status(500).json({ success: false, message: "Failed to generate template", error: error.message });
    }
  },
};