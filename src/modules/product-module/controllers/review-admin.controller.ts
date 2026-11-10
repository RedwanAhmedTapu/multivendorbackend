// controllers/review-admin.controller.ts
//
// Admin-only review queue and status moderation. The router already restricts
// this surface to ADMIN; the controller re-checks the role so a future mounting
// mistake cannot silently expose moderation.

import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import { ReviewAdminService } from "../services/product/review-admin.service.ts";
import { ReviewSchemaNotProvisionedError } from "../services/product/review-moderation.scope.ts";
import { adminListQuerySchema, adminStatusSchema } from "../validators/review-moderation.validator.ts";
import { ok, fail, handleError } from "../utils/response.ts";

export const ReviewAdminController = {
  async list(req: AuthRequest, res: Response) {
    try {
      if (req.user?.role !== "ADMIN") return fail(res, "Admin access required", { status: 403 });

      const query = adminListQuerySchema.parse(req.query);
      const { items, pagination, meta } = await ReviewAdminService.list(query);

      return ok(res, items, { pagination, meta, message: "Reviews fetched" });
    } catch (error: any) {
      if (error instanceof ReviewSchemaNotProvisionedError) {
        return fail(res, error.message, {
          status: error.statusCode,
          errors: [{ code: error.code, requiredSteps: error.steps }],
        });
      }
      return handleError(res, error, "Failed to fetch reviews");
    }
  },

  async setStatus(req: AuthRequest, res: Response) {
    try {
      if (req.user?.role !== "ADMIN") return fail(res, "Admin access required", { status: 403 });

      const { status, reason } = adminStatusSchema.parse(req.body);
      const result = await ReviewAdminService.setStatus(req.params.reviewId, status, reason);

      return ok(res, result, {
        message: result.changed ? `Review ${status === "HIDDEN" ? "hidden" : "published"}` : "Status unchanged",
      });
    } catch (error: any) {
      if (error instanceof ReviewSchemaNotProvisionedError) {
        return fail(res, error.message, {
          status: error.statusCode,
          errors: [{ code: error.code, requiredSteps: error.steps }],
        });
      }
      return handleError(res, error, "Failed to update review status");
    }
  },
};
