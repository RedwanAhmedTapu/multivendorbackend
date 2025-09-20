import multer from "multer";
import path from "path";
import fs from "fs";
import type { Request } from "express";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = /jpeg|jpg|png|gif|webp/;

// -----------------------------
// Helpers
// -----------------------------
function getUploadDir(
  type: "product" | "category" | "slider",
  role?: "VENDOR" | "ADMIN",
  identifier?: string
) {
  let dir: string;

  switch (type) {
    case "slider":
      dir =
        role === "VENDOR"
          ? path.join("uploads", "sliders", "vendorImages")
          : path.join("uploads", "sliders", "adminImages");
      break;

    case "product":
      if (identifier) dir = path.join("uploads", "products", identifier);
      else
        dir =
          role === "VENDOR"
            ? path.join("uploads", "products", "vendorImages")
            : path.join("uploads", "products", "adminImages");
      break;

    case "category":
      dir = path.join("uploads", "category");
      break;

    default:
      dir = path.join("uploads", "general");
      break;
  }

  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storageFactory(
  type: "product" | "category" | "slider",
  role?: "VENDOR" | "ADMIN",
  identifier?: string
) {
  return multer.diskStorage({
    destination: (_req, _file, cb) =>
      cb(null, getUploadDir(type, role, identifier)),
    filename: (_req, file, cb) => {
      const uniqueSuffix =
        Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(
        null,
        `${type}-${uniqueSuffix}${path.extname(file.originalname)}`
      );
    },
  });
}

function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) {
  const ext = path.extname(file.originalname).toLowerCase().substring(1);
  if (ALLOWED_TYPES.test(ext)) cb(null, true);
  else cb(new Error("Only image files (jpeg, jpg, png, gif, webp) are allowed"));
}

// -----------------------------
// Dynamic Upload Middleware
// -----------------------------
export function imageUpload(
  type: "product" | "category" | "slider",
  role?: "VENDOR" | "ADMIN",
  identifier?: string,
  maxCount = 10
) {
  const upload = multer({
    storage: storageFactory(type, role, identifier),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter,
  });

  if (type === "product") {
    return upload.array("images", maxCount); // multiple images
  }

  // category & slider = single image
  return upload.single("image");
}

// -----------------------------
// Public URL generator
// -----------------------------
export function getImageUrl(
  req: Request,
  type: "product" | "category" | "slider",
  filename: string,
  identifier?: string,
  role?: "VENDOR" | "ADMIN"
) {
  const baseUrl =
    process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;

  if (type === "slider") {
    const folder = role === "VENDOR" ? "vendorImages" : "adminImages";
    return `${baseUrl}/uploads/sliders/${folder}/${filename}`;
  }

  if (type === "product") {
    return identifier
      ? `${baseUrl}/uploads/products/${identifier}/${filename}`
      : role === "VENDOR"
      ? `${baseUrl}/uploads/products/vendorImages/${filename}`
      : `${baseUrl}/uploads/products/adminImages/${filename}`;
  }

  return `${baseUrl}/uploads/${type}/${filename}`;
}
