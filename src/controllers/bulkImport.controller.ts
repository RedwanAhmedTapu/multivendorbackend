import type { Request, Response } from "express";
import { BulkImportService } from "../services/bulkImport.service.ts";

export const BulkImportController = {
  async upload(req: Request, res: Response) {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const result = await BulkImportService.import(req.file.path);
      return res.json(result);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
};
