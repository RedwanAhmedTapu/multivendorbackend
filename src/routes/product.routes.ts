import { Router } from "express";
import { ProductController } from "../controllers/product.controller.ts";
import { imageUpload } from "../middlewares/upload.middleware.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();

// ----------------------
// Product Image Upload (Vendor only)
// ----------------------
router.post(
  "/upload/product",
  authenticateUser,
  authorizeRoles("VENDOR"),
  (req, res, next) => {
    const vendorId = req.user?.vendorId?.toString();
    if (!vendorId) {
      return res.status(400).json({ 
        success: false, 
        message: "Vendor ID not found" 
      });
    }
    return imageUpload("product", "VENDOR", vendorId)(req, res, next);
  },
  (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ 
          success: false, 
          message: "No files uploaded" 
        });
      }

      const vendorId = req.user?.vendorId;
      const urls = files.map(file => `/uploads/products/${vendorId}/${file.filename}`);
      
      res.json({ 
        success: true, 
        urls,
        count: urls.length 
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to upload images" 
      });
    }
  }
);

// ----------------------
// Public Routes
// ----------------------

// Get all products (public)
router.get("/", ProductController.getAll);

// Search products (public)
router.get("/search", ProductController.search);

// Filter products (public)
router.post("/filter", ProductController.filter);

// Get product by ID (public)
router.get("/:id", ProductController.getById);

// ----------------------
// Vendor-Specific Routes
// ----------------------

// Get products by vendor ID
router.get(
  "/vendor/:vendorId",
  ProductController.getByVendorId
);

// Get vendor product statistics
router.get(
  "/vendor/:vendorId/statistics",
  authenticateUser,
  authorizeRoles("VENDOR", "ADMIN"),
  ProductController.getStatistics
);

// ----------------------
// Product CRUD (Protected)
// ----------------------

// Create product (Vendor only)
router.post(
  "/",
  authenticateUser,
  authorizeRoles("VENDOR"),
  (req, res, next) => {
    const vendorId = req.user?.vendorId?.toString();
    if (!vendorId) {
      return res.status(400).json({ 
        success: false, 
        message: "Vendor ID not found" 
      });
    }
    return imageUpload("product", "VENDOR", vendorId)(req, res, next);
  },
  ProductController.create
);

// Update product (Vendor & Admin)
router.put(
  "/:id",
  authenticateUser,
  authorizeRoles("VENDOR", "ADMIN"),
  (req, res, next) => {
    const vendorId = req.user?.vendorId?.toString();
    if (req.user?.role === "VENDOR" && !vendorId) {
      return res.status(400).json({ 
        success: false, 
        message: "Vendor ID not found" 
      });
    }
    // Only apply image upload middleware if vendorId exists (for vendors)
    if (vendorId) {
      return imageUpload("product", "VENDOR", vendorId)(req, res, next);
    }
    next();
  },
  ProductController.update
);

// Update product status - Approve/Reject (Admin & Employee only)
router.patch(
  "/:id/status",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  ProductController.updateStatus
);

// Delete product (Vendor & Admin)
router.delete(
  "/:id",
  authenticateUser,
  authorizeRoles("VENDOR", "ADMIN"),
  ProductController.remove
);

export default router;