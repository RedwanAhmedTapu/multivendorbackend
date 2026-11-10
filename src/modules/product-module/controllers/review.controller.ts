// controllers/review.controller.ts
import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import { ReviewService } from "../services/product/review.service.ts";
import { ReviewEligibilityService } from "../services/product/review-eligibility.service.ts";
import { createReviewSchema, updateReviewSchema, listReviewsQuerySchema } from "../validators/review.validator.ts";
import { ok, fail, handleError } from "../utils/response.ts";

export const ReviewController = {
  async create(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.rawId;
      if (!userId) return fail(res, "Login required", { status: 401 });

      const input = createReviewSchema.parse(req.body);
      const review = await ReviewService.create(userId, input);
      return ok(res, review, { message: "Review submitted", status: 201 });
    } catch (error: any) {
      return handleError(res, error, "Failed to submit review");
    }
  },

  async update(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.rawId;
      if (!userId) return fail(res, "Login required", { status: 401 });

      const input = updateReviewSchema.parse(req.body);
      const review = await ReviewService.update(userId, req.params.reviewId, input);
      return ok(res, review, { message: "Review updated" });
    } catch (error: any) {
      return handleError(res, error, "Failed to update review");
    }
  },

  async remove(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.rawId;
      if (!userId) return fail(res, "Login required", { status: 401 });

      const result = await ReviewService.remove(userId, req.params.reviewId);
      return ok(res, result, { message: "Review deleted" });
    } catch (error: any) {
      return handleError(res, error, "Failed to delete review");
    }
  },

  async listByProduct(req: AuthRequest, res: Response) {
    try {
      const query = listReviewsQuerySchema.parse(req.query);
      const { items, pagination } = await ReviewService.listByProduct(req.params.productId, query);
      return ok(res, items, { pagination, message: "Reviews fetched" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch reviews");
    }
  },

  async getEligibility(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.rawId;
      if (!userId) return fail(res, "Login required", { status: 401 });

      const eligibility = await ReviewEligibilityService.check(userId, req.params.productId);
      return ok(res, eligibility, {
        message: eligibility.eligible ? "Eligible to review" : "Not eligible to review",
      });
    } catch (error: any) {
      return handleError(res, error, "Failed to check review eligibility");
    }
  },

  async getMine(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.rawId;
      if (!userId) return fail(res, "Login required", { status: 401 });

      const reviews = await ReviewService.listByUserAndProduct(userId, req.params.productId);
      return ok(res, reviews, { message: reviews.length ? "Reviews found" : "No reviews yet" });
    } catch (error: any) {
      return handleError(res, error, "Failed to fetch your review");
    }
  },
};