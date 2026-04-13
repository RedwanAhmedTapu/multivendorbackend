// middleware/avatar-upload.middleware.ts
import multer from "multer";

export const avatarUpload = multer({
  storage: multer.memoryStorage(), // buffer → R2, no disk needed
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    /jpeg|jpg|png|webp/.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only jpeg, jpg, png, webp allowed"));
  },
}).single("avatar");