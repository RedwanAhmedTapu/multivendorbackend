// src/routes/bulkImportCategoryRoutes.ts
import { Router } from "express";
import multer from "multer";
import { bulkImportCategory } from "../controllers/bulkImportCategoryController.ts";

// npm install multer @types/multer   (if not already a dependency)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const isXlsx =
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.originalname.toLowerCase().endsWith(".xlsx");
    if (!isXlsx) return cb(new Error("Only .xlsx files are accepted."));
    cb(null, true);
  },
});

const router = Router();

// POST /api/bulk-import-category  (multipart/form-data, field name: "file")
router.post("/", upload.single("file"), bulkImportCategory);

export default router;