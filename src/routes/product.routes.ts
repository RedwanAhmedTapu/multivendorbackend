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
    if (!vendorId) return res.status(400).json({ success: false, message: "Vendor ID not found" });
    return imageUpload("product", "VENDOR", vendorId)(req, res, next);
  },
  (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) return res.status(400).json({ success: false, message: "No files uploaded" });

      const vendorId = req.user?.vendorId;
      const urls = files.map(file => `/uploads/products/${vendorId}/${file.filename}`);
      res.json({ success: true, urls });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// ----------------------
// Products CRUD
// ----------------------
router.get("/", ProductController.getAll);
router.get("/:id", ProductController.getById);

router.post(
  "/",
  authenticateUser,
  authorizeRoles("VENDOR"),
  (req, res, next) => imageUpload("product", "VENDOR", req.user?.vendorId)(req, res, next),
  ProductController.create
);

router.patch(
  "/:id",
  authenticateUser,
  authorizeRoles("ADMIN", "VENDOR"),
  (req, res, next) => imageUpload("product", "VENDOR", req.user?.vendorId)(req, res, next),
  ProductController.update
);

router.delete("/:id", authenticateUser, authorizeRoles("ADMIN", "VENDOR"), ProductController.remove);
router.post("/filter", authenticateUser, authorizeRoles("ADMIN", "VENDOR"), ProductController.filter);

export default router;
