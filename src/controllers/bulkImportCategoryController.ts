// src/controllers/bulkImportCategoryController.ts
import type { Request, Response } from "express";
import { BulkImportCategoryService } from "../services/bulkImportCategoryService.ts";

const ALLOWED_MIMETYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
]);

export async function bulkImportCategory(req: Request, res: Response) {
  try {
    const file = req.file; // set by multer

    if (!file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded. Attach an .xlsx file as 'file'.",
      });
    }

    if (
      !ALLOWED_MIMETYPES.has(file.mimetype) &&
      !file.originalname.toLowerCase().endsWith(".xlsx")
    ) {
      return res.status(400).json({
        success: false,
        message: "Uploaded file must be a .xlsx workbook.",
      });
    }

    const summary = await BulkImportCategoryService.importFromBuffer(file.buffer);

    // Build response — always return rowDetails so admin sees the full report
    const responsePayload = {
      success: summary.failed === 0, // true only if zero failures
      message:
        summary.failed === 0
          ? `All ${summary.imported} rows imported successfully.`
          : `Import completed: ${summary.imported} rows saved, ${summary.failed} rows failed.`,
      totalRows: summary.totalRows,
      imported: summary.imported,
      failed: summary.failed,
      categoriesCreated: summary.categoriesCreated,
      categoriesReused: summary.categoriesReused,
      attributesCreated: summary.attributesCreated,
      categoryAttributeLinks: summary.categoryAttributeLinks,
      warnings: summary.warnings,
      errors: summary.errors, // backward compatible: only failed rows
      rowDetails: summary.rowDetails, // ⭐ NEW: full per-row report
    };

    // If everything failed → 422 Unprocessable Entity
    // If partial success → 207 Multi-Status (or 200 with success:false)
    // If all success → 200 OK
    if (summary.imported === 0 && summary.failed > 0) {
      return res.status(422).json(responsePayload);
    }

    if (summary.failed > 0) {
      // Partial success — 200 but success:false so frontend knows some failed
      return res.status(200).json(responsePayload);
    }

    return res.status(200).json(responsePayload);
  } catch (err) {
    console.error("bulkImportCategory failed:", err);

    // Service throws for: file too large, too many rows, parse error, invalid template
    const isClientError =
      err instanceof Error &&
      (err.message.includes("exceeds the") ||
        err.message.includes("Too many rows") ||
        err.message.includes("No worksheet found") ||
        err.message.includes("No \"Level N\" columns"));

    return res.status(isClientError ? 400 : 500).json({
      success: false,
      message: err instanceof Error ? err.message : "Unexpected error during bulk import.",
    });
  }
}