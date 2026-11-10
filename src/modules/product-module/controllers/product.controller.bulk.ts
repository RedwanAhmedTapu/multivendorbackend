// controllers/product.controller.bulk.ts
import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import { BulkProductService } from "../services/product/product-bulk.service.ts";
import { ok, fail, handleError } from "../utils/response.ts";

export const BulkProductController = {
  /**
   * POST /api/products/vendor/bulk-upload/:categoryId
   * multipart/form-data, field name "file" — the filled copy of the
   * category's Excel template (see TemplateController.downloadTemplate).
   */
  async upload(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) return fail(res, "User is not associated with a vendor account", { status: 403 });

      const { categoryId } = req.params;
      if (!categoryId) return fail(res, "Category ID is required", { status: 400 });

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return fail(res, "No file uploaded. Attach the filled template under the 'file' field.", { status: 400 });

      const summary = await BulkProductService.importFromExcel(vendorId, req.user?.rawId ?? req.user?.id, categoryId, file.buffer);

      // Partial success is common (some rows valid, some not) — surface it as
      // 207-style info via 200, but flag full failure as 422 so the client
      // doesn't treat it as a clean success.
      const status = summary.failed > 0 && summary.created === 0 ? 422 : 200;
      return ok(res, summary, {
        status,
        message: `${summary.created}/${summary.totalGroups} product(s) created${summary.failed ? `, ${summary.failed} failed` : ""}`,
      });
    } catch (error: any) {
      return handleError(res, error, "Failed to bulk import products");
    }
  },
};