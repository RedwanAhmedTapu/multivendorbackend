import multer from "multer";
import path from "path";
import fs from "fs";
import type { Request } from "express";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = /jpeg|jpg|png|gif|webp/;

// Function to get folder based on type and identifier
function getUploadDir(type: string, identifier?: string) {
  let dir = path.join("uploads", type);
  if (identifier) {
    dir = path.join(dir, identifier);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Storage configuration factory
function storageFactory(type: string, identifier?: string) {
  return multer.diskStorage({
    destination: (_req: Request, _file, cb) => {
      const dir = getUploadDir(type, identifier);
      cb(null, dir);
    },
    filename: (_req: Request, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `${type}-${uniqueSuffix}${path.extname(file.originalname)}`);
    },
  });
}

// File filter
function fileFilter(_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  const ext = path.extname(file.originalname).toLowerCase().substring(1);
  if (ALLOWED_TYPES.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only image files (jpeg, jpg, png, gif, webp) are allowed"));
  }
}

// Middleware factory
export function imageUpload(type: string, identifier?: string) {
  return multer({
    storage: storageFactory(type, identifier),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter,
  }).array("images", 10); // max 10 files
}

// Function to get public URL
export function getImageUrl(req: Request, type: string, filename: string, identifier?: string) {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
  if (identifier) {
    return `${baseUrl}/uploads/${type}/${identifier}/${filename}`;
  }
  return `${baseUrl}/uploads/${type}/${filename}`;
}
