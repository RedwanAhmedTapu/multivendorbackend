// modules/chat/routes/media.routes.ts
import { Router } from "express";
import { upload } from "../../../lib/multr-config.ts";
import { uploadImageController, uploadAudioController, deleteMediaController, getMediaController } from "../controllers/media.controller.ts";
import { authenticateUser } from "../../../middlewares/auth.middleware.ts";

const router = Router();

// All routes require authentication
router.use(authenticateUser);

// Upload image (multipart/form-data: file + messageId)
router.post(
  "/image",
  upload.single("file"),
  uploadImageController
);

// Upload audio (multipart/form-data: file + messageId + duration)
router.post(
  "/audio",
  upload.single("file"),
  uploadAudioController
);

// Get media info
router.get("/:messageId", getMediaController);

// Delete media
router.delete("/:messageId", deleteMediaController);

export default router;