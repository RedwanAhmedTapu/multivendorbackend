// product-module/routes/product.routes.ts
import { Router } from "express";
import multer from "multer";
import { PublicProductController } from "../controllers/product.controller.public.ts";
import { ReviewController } from "../controllers/review.controller.ts";
import { VendorProductController } from "../controllers/product.controller.vendor.ts";
import { AdminProductController } from "../controllers/product.controller.admin.ts";
import { BulkImportController } from "../controllers/bulkImport.controller.ts";
import { imageUpload, videoUpload } from "../../../middlewares/upload.middleware.ts";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { blockVendorEmployees, requirePermission } from "../../../middlewares/permission.middleware.ts";

const router = Router();

// Excel bulk-upload file handling — memory storage, since the file is parsed
// in-process by BulkProductService and never needs to touch disk. If your
// project's upload.middleware.ts already exposes a generic file-type upload
// helper, swap this for that instead of this inline multer instance.
const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const isExcel = /\.(xlsx|xls)$/i.test(file.originalname);
    if (!isExcel) return cb(new Error("Only .xlsx/.xls files are allowed") as any);
    cb(null, true);
  },
}).single("file");

// =====================================================
// UPLOAD ROUTES (Vendor only)
// =====================================================

router.post(
  "/upload",
  authenticateUser,
  authorizeRoles("VENDOR"),
  (req: any, res, next) => {
    const vendorId = req.user?.vendorId?.toString();
    if (!vendorId) return res.status(400).json({ success: false, message: "Vendor ID not found" });
    return imageUpload("product", "VENDOR", vendorId)(req, res, next);
  },
  (req: any, res) => {
    const files = req.files as Express.Multer.File[];
    if (!files?.length) return res.status(400).json({ success: false, message: "No files uploaded" });
    const vendorId = req.user?.vendorId;
    const urls = files.map((f) => `/uploads/products/${vendorId}/${f.filename}`);
    res.json({ success: true, data: { urls }, count: urls.length });
  }
);

router.post(
  "/upload-video",
  authenticateUser,
  authorizeRoles("VENDOR"),
  (req: any, res, next) => {
    const vendorId = req.user?.vendorId?.toString();
    if (!vendorId) return res.status(400).json({ success: false, message: "Vendor ID not found" });
    return videoUpload("product-video", "VENDOR", vendorId)(req, res, next);
  },
  (req: any, res) => {
    const file = req.file as Express.Multer.File;
    if (!file) return res.status(400).json({ success: false, message: "No video uploaded" });
    const vendorId = req.user?.vendorId;
    res.json({ success: true, data: { url: `/uploads/product-videos/${vendorId}/${file.filename}` } });
  }
);

// =====================================================
// PUBLIC ROUTES
// =====================================================

router.get("/search", PublicProductController.search);
router.get("/featured", PublicProductController.getFeatured);
router.get("/new-arrivals", PublicProductController.getNewArrivals);
router.get("/trending", PublicProductController.getTrending);
router.get("/best-selling", PublicProductController.getBestSelling);
router.get("/flash-sale", PublicProductController.getFlashSale);
router.get("/discounted", PublicProductController.getDiscounted);
router.post("/filter", PublicProductController.filter);
router.get("/category/:categoryId", PublicProductController.getByCategoryId);
router.get("/category/slug/:categorySlug", PublicProductController.getByCategorySlug);
router.get("/recently-viewed", authenticateUser, PublicProductController.getRecentlyViewed);
router.get("/:productId/related", PublicProductController.getRelated);
router.get("/:productId/similar", PublicProductController.getSimilar);
router.get("/", PublicProductController.getAll);

// =====================================================
// VENDOR ROUTES
// =====================================================

router.get("/vendor/my-products", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.getMyProducts);
router.get("/vendor/statistics", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.getStatistics);
router.get("/vendor/statistics/monthly", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.getMonthlyTrends);
router.get("/vendor/product-contents-score", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.getContentScoreOfVendorProduct);
router.get("/vendor/trash", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.getTrash);

// One-click template download for a category — GET, no file attached.
// Registered before "/vendor/:id" so "bulk-import" is never swallowed by
// the :id param route.
router.get(
  "/vendor/bulk-import/:categoryId/template",
  authenticateUser,
  authorizeRoles("VENDOR","EMPLOYEE"),
  BulkImportController.downloadTemplate
);

// Bulk create — filled template upload.
router.post(
  "/vendor/bulk-import/:categoryId",
  authenticateUser,
  authorizeRoles("VENDOR","EMPLOYEE"),
  (req, res, next) => excelUpload(req, res, (err) => (err ? res.status(400).json({ success: false, message: err.message }) : next())),
  BulkImportController.upload
);

router.get("/vendor/:id", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.getById);
router.post("/vendor", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.create);
router.put("/vendor/:id", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.update);
router.delete("/vendor/:id", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.remove);
router.patch("/vendor/:id/restore", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.restore);
router.patch("/vendor/:id/variants/:variantId/stock", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.updateStock);
router.patch("/vendor/:id/variants/:variantId/price", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.updatePrice);
router.patch("/vendor/:id/variants/:variantId/special-price", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.updateSpecialPrice);
router.patch("/vendor/:id/variants/:variantId/reset-price-override", authenticateUser, authorizeRoles("VENDOR"), VendorProductController.resetPriceOverride);

// =====================================================
// ADMIN ROUTES
// =====================================================

// Every /admin/* product route (Phase 1 S1/P1): ADMIN, or an admin-side
// EMPLOYEE (vendorId null) holding productManagement. VENDOR is refused by
// authorizeRoles before requirePermission (which would wave VENDOR through),
// and vendor staff are refused even when they hold the flag.
const adminProductAccess = [
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  blockVendorEmployees,
  requirePermission("productManagement"),
];

router.get("/admin/all", ...adminProductAccess, AdminProductController.getAll);
router.get("/admin/pending", ...adminProductAccess, AdminProductController.getPendingApproval);
router.get("/admin/statistics", ...adminProductAccess, AdminProductController.getStatistics);
router.post("/admin/filter", ...adminProductAccess, AdminProductController.filter);
router.get("/admin/vendor/:vendorId", ...adminProductAccess, AdminProductController.getByVendorId);

// Approval workflow — approving auto-generates & publishes SEO
router.patch("/admin/:id/approve", ...adminProductAccess, AdminProductController.approveProduct);
router.patch("/admin/:id/reject", ...adminProductAccess, AdminProductController.rejectProduct);
router.post("/admin/bulk-approve", ...adminProductAccess, AdminProductController.bulkApprove);
router.post("/admin/bulk-reject", ...adminProductAccess, AdminProductController.bulkReject);
router.patch("/admin/:id/status", ...adminProductAccess, AdminProductController.updateStatus);
router.patch("/admin/:id/restore", ...adminProductAccess, AdminProductController.restore);

router.get("/admin/:id", ...adminProductAccess, AdminProductController.getById);
router.put("/admin/:id", ...adminProductAccess, AdminProductController.update);

// Only Admin permanently deletes — bypasses the vendor's 90-day grace window
router.delete("/admin/:id", authenticateUser, authorizeRoles("ADMIN"), AdminProductController.remove);

// =====================================================
// PRODUCT REVIEWS — the URLs the storefront already calls
//   GET /:productId/reviews             public list (paged, sortable, rating filter)
//   GET /:productId/reviews/me          the caller's own review (auth)
//   GET /:productId/reviews/eligibility may the caller review it? (auth)
// (ReviewService.listByProduct / getMine / eligibility did not exist as routes
// before, so the page's GET /products/:id/reviews answered 404.)
// =====================================================

router.get("/:productId/reviews", ReviewController.listByProduct);
router.get("/:productId/reviews/me", authenticateUser, ReviewController.getMine);
router.get("/:productId/reviews/eligibility", authenticateUser, ReviewController.getEligibility);

// =====================================================
// SEO detail route — MUST be registered last: it's a catch-all `/:slug`
// =====================================================
router.get("/:slug", PublicProductController.getBySlug);

export default router;