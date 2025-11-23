// routes/upload.ts
import { Router } from "express";
import multer from "multer";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";
import { uploadToR2, deleteFromR2 } from "../lib/cloudflare-r2.ts";

const router = Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, 
  }
});

// Video upload endpoint
router.post(
  "/video",
  authenticateUser,
  authorizeRoles("VENDOR", "ADMIN"),
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ 
          success: false, 
          message: "No video file provided" 
        });
      }

      const { key, userRole, vendorId } = req.body;
      
      if (!key) {
        return res.status(400).json({ 
          success: false, 
          message: "Key is required" 
        });
      }

      // Upload to R2
      const result = await uploadToR2({
        file: req.file.buffer,
        key,
        contentType: req.file.mimetype,
        vendorId: userRole === "VENDOR" ? vendorId : ""
      });

      return res.json({
        success: true,
        data: {
          url: result.url,
          key: result.key
        }
      });

    } catch (error: any) {
      console.error("Video upload error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to upload video"
      });
    }
  }
);

// Video delete endpoint
router.delete(
  "/video",
  authenticateUser,
  authorizeRoles("VENDOR", "ADMIN"),
  async (req, res) => {
    try {
      const { key } = req.body;

      if (!key) {
        return res.status(400).json({
          success: false,
          message: "Key is required"
        });
      }

      await deleteFromR2(key);

      return res.json({
        success: true,
        message: "Video deleted successfully"
      });

    } catch (error: any) {
      console.error("Video delete error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to delete video"
      });
    }
  }
);

export default router;