// controllers/review-image.controller.ts
//
// Multipart endpoints for review photos. The multer instance comes from the
// project's shared `imageUpload` factory (same 5MB limit, same image mime
// whitelist, same error envelope); the "VENDOR" argument it takes is only a
// label for the vendor storage flow and is unused by the factory itself.
//
// Ownership: the session user is passed to the service, which looks the review
// up as `{ id, userId }` — a foreign review id is a 404, never a 403 leak.

import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import { imageUpload } from "../../../middlewares/up.middleware.ts";
import { ReviewImageService } from "../services/product/review-image.service.ts";
import { ok, fail, handleError } from "../utils/response.ts";

/** Field `file`, one image per request. */
export const reviewImageUpload = imageUpload("review", "VENDOR", undefined, 1);

export const ReviewImageController = {
  async upload(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.rawId;
      if (!userId) return fail(res, "Login required", { status: 401 });

      const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
      const image = await ReviewImageService.add(userId, req.params.reviewId, {
        buffer: file?.buffer as Buffer,
        originalname: file?.originalname ?? "photo.jpg",
        mimetype: file?.mimetype ?? "",
        size: file?.size,
      });

      return ok(res, image, { status: 201, message: "Photo added" });
    } catch (error: any) {
      return handleError(res, error, "Failed to add review photo");
    }
  },

  async remove(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.rawId;
      if (!userId) return fail(res, "Login required", { status: 401 });

      const result = await ReviewImageService.remove(userId, req.params.reviewId, req.params.imageId);
      return ok(res, result, { message: "Photo removed" });
    } catch (error: any) {
      return handleError(res, error, "Failed to remove review photo");
    }
  },
};
