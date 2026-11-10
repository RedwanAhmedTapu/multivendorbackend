// lib/multer-config.ts
import multer from "multer";

// Memory storage — files go to buffer, then to R2
// No disk I/O, faster for cloud uploads
const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max (handled per-type in validation)
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      // Images
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      // Audio
      "audio/mpeg",
      "audio/ogg",
      "audio/webm",
      "audio/aac",
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}`));
    }
  },
});