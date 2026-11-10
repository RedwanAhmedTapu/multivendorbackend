// src/controllers/bulkImportBank.controller.ts
import type { Request, Response } from "express";
import { BulkImportBankService } from "../services/bulkImportBankService.ts";

export async function bulkImportBank(req: Request, res: Response) {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, message: "No file uploaded. Attach an .xlsx file as 'file'." });

    const summary = await BulkImportBankService.importFromBuffer(file.buffer);
    const status = summary.imported === 0 && summary.failed > 0 ? 422 : 200;
    res.status(status).json({
      success: summary.failed === 0,
      message:
        summary.failed === 0
          ? `All ${summary.imported} banks imported successfully.`
          : `Import completed: ${summary.imported} banks saved, ${summary.failed} rows failed.`,
      ...summary,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || "Unexpected error during bank import." });
  }
}