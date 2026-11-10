import multer from "multer";
import path from "path";
import crypto from "crypto";
import type { AuthRequest } from "./auth.middleware.ts";

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Memory storage — we don't persist to local disk at all,
// buffer goes straight to R2.
const storage = multer.memoryStorage();

const fileFilter = (
  _req: AuthRequest,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Invalid file type. Allowed: JPG, PNG, WEBP, PDF"));
  }
  cb(null, true);
};

export const brandDocumentUpload = (_vendorId: string) =>
  multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE },
  }).single("document");

/**
 * Builds the R2 object key for a vendor's brand document.
 * vendor/{vendorId}/branddocument/{uniqueName}
 */
export function buildBrandDocumentKey(vendorId: string, originalName: string) {
  const ext = path.extname(originalName);
  const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
  return `vendor/${vendorId}/branddocument/${uniqueName}`;
}