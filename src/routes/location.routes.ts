import { Router } from "express";
import multer from "multer";
import { LocationController } from "../controllers/location.controller.ts";

const router = Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only CSV and Excel files are allowed."));
    }
  },
});

// ============================================
// Special routes (must be before /:id route)
// ============================================

// Search locations
router.get("/search", LocationController.search);

// Get locations by type
router.get("/divisions", LocationController.getDivisions);
router.get("/districts", LocationController.getDistricts);
router.get("/thanas", LocationController.getThanas);

// Get special location types
router.get("/leaf", LocationController.getLeafLocations);
router.get("/cod", LocationController.getCodLocations);

// Get locations by level (with optional parent filter)
router.get("/level/:level", LocationController.getByLevel);

// Get children of a specific location
router.get("/children/:parentId", LocationController.getChildren);

// Bulk upload
router.post("/bulk-upload", upload.single("file"), LocationController.bulkUpload);

// ============================================
// CRUD operations
// ============================================

// Get all locations (tree structure)
router.get("/", LocationController.getAll);

// Get location by ID
router.get("/:id", LocationController.getById);

// Create location
router.post("/", LocationController.create);

// Update location
router.put("/:id", LocationController.update);

// Delete location
router.delete("/:id", LocationController.remove);

export default router;