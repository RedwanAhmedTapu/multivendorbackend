// blog-module/routes/blog.routes.ts
import { Router } from "express";
import { PublicBlogController } from "../controllers/blog.controller.public.ts";
import {
  AdminBlogPostController,
  AdminBlogCategoryController,
  AdminBlogNavController,
  AdminBlogSiteController,
} from "../controllers/blog.controller.admin.ts";
// NOTE: matches your actual project files —
//   middlewares/up.middleware.ts   → imageUpload() (multer memoryStorage, single file by default)
//   lib/r2-admin-config.ts         → uploadToR2Admin() + generateFileKey()
// Adjust these two relative paths to wherever blog-module ends up living
// (e.g. if you place it at src/modules/blog-module, these are correct
// relative to server.ts's ./modules/* siblings — 3 levels up to project root).
import { imageUpload } from "../../../middlewares/up.middleware.ts";
import { uploadToR2Admin, generateFileKey } from "../../../lib/r2-admin-config.ts";
// TODO: point this at whatever auth middleware your other routes use
// (e.g. modules/auth/middlewares/auth.middleware.ts) — file wasn't shared,
// so the path below is a placeholder.
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";

const router = Router();

// =====================================================
// PUBLIC ROUTES — consumed by blog.finixmart.com.bd
// =====================================================
router.get("/nav", PublicBlogController.nav);
router.get("/footer", PublicBlogController.footer);
router.get("/site-settings", PublicBlogController.siteSettings);
router.get("/categories", PublicBlogController.categories);
router.get("/posts/latest", PublicBlogController.latest);
router.get("/posts", PublicBlogController.list);
router.get("/posts/:slug", PublicBlogController.getBySlug);

// =====================================================
// UPLOAD (Admin/Employee) — featured images, logo, favicon, OG image.
// Uses your real R2 pipeline: imageUpload() buffers the file in memory
// (multer.memoryStorage), then uploadToR2Admin() pushes it to Cloudflare
// R2 and we store ONLY the returned KEY — never the full domain — in
// Postgres. The full https:// URL is built on the READ side (frontend/
// admin panel prepend R2_PUBLIC_DOMAIN), exactly like storeEditorApi's
// uploadStoreImage already does for product images.
// =====================================================
router.post(
  "/upload",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  imageUpload("blog", "ADMIN"), // maxFiles defaults to 1 → req.file (not req.files)
  async (req: any, res) => {
    try {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        return res.status(400).json({ success: false, message: "No file uploaded" });
      }

      const key = generateFileKey("blog", file.originalname);
      const { key: savedKey } = await uploadToR2Admin({
        file: file.buffer,
        key,
        contentType: file.mimetype,
      });

      // Same envelope shape as storeEditorApi's UploadFileResponse —
      // `file.url` intentionally holds the R2 KEY, not a full URL.
      return res.json({
        success: true,
        file: {
          url: savedKey,
          fileName: file.originalname,
          fileSize: file.size,
          mimeType: file.mimetype,
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "Upload failed" });
    }
  }
);

// =====================================================
// ADMIN / EMPLOYEE — posts
// =====================================================
router.get("/admin/posts", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogPostController.list);
router.get("/admin/posts/:id", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogPostController.getById);
router.post("/admin/posts", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogPostController.create);
router.put("/admin/posts/:id", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogPostController.update);
router.delete("/admin/posts/:id", authenticateUser, authorizeRoles("ADMIN"), AdminBlogPostController.remove);
router.post(
  "/admin/posts/revisions/:revisionId/restore",
  authenticateUser,
  authorizeRoles("ADMIN", "EMPLOYEE"),
  AdminBlogPostController.restoreRevision
);

// ADMIN / EMPLOYEE — categories
router.get("/admin/categories", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogCategoryController.list);
router.post("/admin/categories", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogCategoryController.create);
router.put("/admin/categories/:id", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogCategoryController.update);
router.delete("/admin/categories/:id", authenticateUser, authorizeRoles("ADMIN"), AdminBlogCategoryController.remove);

// ADMIN / EMPLOYEE — nav menu (two-layer dropdown)
router.get("/admin/nav", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogNavController.list);
router.post("/admin/nav", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogNavController.create);
router.put("/admin/nav/:id", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogNavController.update);
router.delete("/admin/nav/:id", authenticateUser, authorizeRoles("ADMIN"), AdminBlogNavController.remove);
router.put("/admin/nav-reorder", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogNavController.reorder);

// ADMIN / EMPLOYEE — site settings (logo, brand colors) & footer
router.get("/admin/site-settings", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogSiteController.getSettings);
router.put("/admin/site-settings", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogSiteController.updateSettings);
router.get("/admin/footer", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogSiteController.getFooter);
router.put("/admin/footer", authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), AdminBlogSiteController.upsertFooter);

export default router;
