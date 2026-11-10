// routes/review.routes.ts
import { Router } from "express";
import { ReviewController } from "../controllers/review.controller.ts";
import { ReviewImageController, reviewImageUpload } from "../controllers/review-image.controller.ts";
import { authenticateUser } from "../../../middlewares/auth.middleware.ts";

const router = Router();

// Mounted at /api/reviews in server.ts
router.post("/", authenticateUser, ReviewController.create);
router.patch("/:reviewId", authenticateUser, ReviewController.update);
router.delete("/:reviewId", authenticateUser, ReviewController.remove);

// Review photos — one image per request, at most three per review (enforced by
// the service + the DB unique(reviewId, position) index).
router.post("/:reviewId/images", authenticateUser, reviewImageUpload, ReviewImageController.upload);
router.delete("/:reviewId/images/:imageId", authenticateUser, ReviewImageController.remove);

export default router;