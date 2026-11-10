// controllers/bulkImport.controller.ts
import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import { BulkProductService } from "../services/product/product-bulk.service.ts";
import { TemplateService } from "../services/product/bulkproductTemplate.service.ts";
import { ok, fail, handleError } from "../utils/response.ts";

const templateService = new TemplateService();

export const BulkImportController = {
  /**
   * POST /bulk-import/:categoryId
   * multipart/form-data, field name "file" — the vendor's filled copy of
   * the category template. Actually creates the products.
   */
  async upload(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId)
        return fail(res, "User is not associated with a vendor account", {
          status: 403,
        });

      const { categoryId } = req.params;
      if (!categoryId)
        return fail(res, "Category ID is required", { status: 400 });

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file)
        return fail(
          res,
          "No file uploaded. Attach the filled template under the 'file' field.",
          { status: 400 },
        );

      const summary = await BulkProductService.importFromExcel(
        vendorId,
        req.user?.rawId ?? req.user?.id,
        categoryId,
        file.buffer,
      );

      const status = summary.failed > 0 && summary.created === 0 ? 422 : 200;
      return ok(res, summary, {
        status,
        message: `${summary.created}/${summary.totalGroups} product(s) created${summary.failed ? `, ${summary.failed} failed` : ""}`,
      });
    } catch (error: any) {
      return handleError(res, error, "Failed to bulk import products");
    }
  },

  /**
   * GET /bulk-import/:categoryId/template
   * One-click: generates the category's Excel template and streams it
   * straight back — nothing persisted to disk (see TemplateService.
   * generateTemplateBuffer). This is what vendors hit before filling in
   * and re-uploading via upload() above.
   */
  async downloadTemplate(req: AuthRequest, res: Response) {
    try {
      const { categoryId } = req.params;
      if (!categoryId)
        return fail(res, "Category ID is required", { status: 400 });
      if (!req.user?.vendorId) {
        res
          .status(403)
          .json({
            message:
              "Only vendors and their employees can download this template",
          });
        return;
      }
      const { buffer, fileName } =
        await templateService.generateTemplateBuffer(categoryId, req.user.vendorId);

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`,
      );
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      res.send(buffer);
    } catch (error: any) {
      if (error.message?.includes("not found"))
        return fail(res, error.message, { status: 404 });
      if (error.message?.includes("not a leaf category"))
        return fail(res, error.message, { status: 400 });
      return handleError(res, error, "Failed to generate template");
    }
  },
};
