// controllers/review-vendor.controller.ts
//
// Thin, mirroring ReviewController: parse → service → ok()/fail()/handleError().
// The vendor identity comes only from the session (req.user.vendorId), never
// from the query string or the body.

import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import { ReviewVendorService } from "../services/product/review-vendor.service.ts";
import { ReviewSchemaNotProvisionedError } from "../services/product/review-moderation.scope.ts";
import {
  vendorListQuerySchema,
  vendorReplySchema,
} from "../validators/review-moderation.validator.ts";
import { ok, fail, handleError } from "../utils/response.ts";

export const ReviewVendorController = {
  async list(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) return fail(res, "Vendor account required", { status: 403 });

      const query = vendorListQuerySchema.parse(req.query);
      const { items, pagination, meta } = await ReviewVendorService.list(vendorId, query);

      return ok(res, items, { pagination, meta, message: "Vendor reviews fetched" });
    } catch (error: any) {
      if (error instanceof ReviewSchemaNotProvisionedError) {
        return fail(res, error.message, {
          status: error.statusCode,
          errors: [{ code: error.code, requiredSteps: error.steps }],
        });
      }
      return handleError(res, error, "Failed to fetch vendor reviews");
    }
  },

  async reply(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      const actorUserId = req.user?.rawId;
      if (!vendorId) return fail(res, "Vendor account required", { status: 403 });
      if (!actorUserId) return fail(res, "Login required", { status: 401 });

      const { reply } = vendorReplySchema.parse(req.body);
      const result = await ReviewVendorService.reply(
        vendorId,
        actorUserId,
        req.params.reviewId,
        reply
      );

      return ok(res, result, { message: "Seller response saved" });
    } catch (error: any) {
      if (error instanceof ReviewSchemaNotProvisionedError) {
        return fail(res, error.message, {
          status: error.statusCode,
          errors: [{ code: error.code, requiredSteps: error.steps }],
        });
      }
      return handleError(res, error, "Failed to save seller response");
    }
  },
};
