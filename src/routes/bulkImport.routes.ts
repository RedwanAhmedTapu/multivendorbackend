import { Router } from "express";
import multer from "multer";
import { BulkImportController } from "../controllers/bulkImport.controller.ts";

const upload = multer({ dest: "uploads/" });
const router = Router();

router.post("/", upload.single("file"), BulkImportController.upload);

export default router;
