// blog-module/controllers/blog.controller.admin.ts
import type { Request, Response } from "express";
import { ok, created, fail, handleError } from "../utils/response.ts";
import { BlogPostService, BlogCategoryService, BlogNavService, BlogSiteService } from "../services/blog/index.ts";
import {
  createBlogPostSchema,
  updateBlogPostSchema,
  createBlogCategorySchema,
  updateBlogCategorySchema,
  upsertBlogNavItemSchema,
  reorderNavSchema,
  updateBlogSiteSettingsSchema,
  upsertBlogFooterSchema,
} from "../validators/blog.validator.ts";

// ── Posts ────────────────────────────────────────────────────

export const AdminBlogPostController = {
  async list(req: Request, res: Response) {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const { status, category, authorId } = req.query as Record<string, string>;
      const result = await BlogPostService.listPostsForAdmin(page, limit, {
        status: status as any,
        categorySlug: category,
        authorId,
      });
      return ok(res, result);
    } catch (err) {
      return handleError(res, err, "Failed to list posts");
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const post = await BlogPostService.getPostByIdForAdmin(req.params.id);
      if (!post) return fail(res, "Post not found", 404);
      return ok(res, post);
    } catch (err) {
      return handleError(res, err, "Failed to fetch post");
    }
  },

  async create(req: Request, res: Response) {
    const parsed = createBlogPostSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, "Validation failed", 422, parsed.error.issues);
    try {
      const authorId = (req as any).user?.id;
      const post = await BlogPostService.createPost({ ...parsed.data, authorId });
      return created(res, post, "Post created");
    } catch (err) {
      return handleError(res, err, "Failed to create post");
    }
  },

  async update(req: Request, res: Response) {
    const parsed = updateBlogPostSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, "Validation failed", 422, parsed.error.issues);
    try {
      const post = await BlogPostService.updatePost(req.params.id, parsed.data);
      return ok(res, post, "Post updated");
    } catch (err) {
      return handleError(res, err, "Failed to update post");
    }
  },

  async remove(req: Request, res: Response) {
    try {
      await BlogPostService.deletePost(req.params.id);
      return ok(res, { id: req.params.id }, "Post deleted");
    } catch (err) {
      return handleError(res, err, "Failed to delete post");
    }
  },

  async restoreRevision(req: Request, res: Response) {
    try {
      const post = await BlogPostService.restoreRevision(req.params.revisionId);
      return ok(res, post, "Revision restored");
    } catch (err) {
      return handleError(res, err, "Failed to restore revision");
    }
  },
};

// ── Categories ───────────────────────────────────────────────

export const AdminBlogCategoryController = {
  async list(_req: Request, res: Response) {
    try {
      return ok(res, await BlogCategoryService.listAllCategoriesForAdmin());
    } catch (err) {
      return handleError(res, err, "Failed to list categories");
    }
  },
  async create(req: Request, res: Response) {
    const parsed = createBlogCategorySchema.safeParse(req.body);
    if (!parsed.success) return fail(res, "Validation failed", 422, parsed.error.issues);
    try {
      return created(res, await BlogCategoryService.createCategory(parsed.data), "Category created");
    } catch (err) {
      return handleError(res, err, "Failed to create category");
    }
  },
  async update(req: Request, res: Response) {
    const parsed = updateBlogCategorySchema.safeParse(req.body);
    if (!parsed.success) return fail(res, "Validation failed", 422, parsed.error.issues);
    try {
      return ok(res, await BlogCategoryService.updateCategory(req.params.id, parsed.data), "Category updated");
    } catch (err) {
      return handleError(res, err, "Failed to update category");
    }
  },
  async remove(req: Request, res: Response) {
    try {
      await BlogCategoryService.deleteCategory(req.params.id);
      return ok(res, { id: req.params.id }, "Category deleted");
    } catch (err) {
      return handleError(res, err, "Failed to delete category");
    }
  },
};

// ── Nav menu (two-layer dropdown) ───────────────────────────

export const AdminBlogNavController = {
  async list(_req: Request, res: Response) {
    try {
      return ok(res, await BlogNavService.listAllNavItemsForAdmin());
    } catch (err) {
      return handleError(res, err, "Failed to list nav items");
    }
  },
  async create(req: Request, res: Response) {
    const parsed = upsertBlogNavItemSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, "Validation failed", 422, parsed.error.issues);
    try {
      return created(res, await BlogNavService.createNavItem(parsed.data), "Nav item created");
    } catch (err) {
      return handleError(res, err, "Failed to create nav item");
    }
  },
  async update(req: Request, res: Response) {
    const parsed = upsertBlogNavItemSchema.partial().safeParse(req.body);
    if (!parsed.success) return fail(res, "Validation failed", 422, parsed.error.issues);
    try {
      return ok(res, await BlogNavService.updateNavItem(req.params.id, parsed.data as any), "Nav item updated");
    } catch (err) {
      return handleError(res, err, "Failed to update nav item");
    }
  },
  async remove(req: Request, res: Response) {
    try {
      await BlogNavService.deleteNavItem(req.params.id);
      return ok(res, { id: req.params.id }, "Nav item deleted");
    } catch (err) {
      return handleError(res, err, "Failed to delete nav item");
    }
  },
  async reorder(req: Request, res: Response) {
    const parsed = reorderNavSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, "Validation failed", 422, parsed.error.issues);
    try {
      await BlogNavService.reorderNavItems(parsed.data.orderedIds);
      return ok(res, { message: "Reordered" });
    } catch (err) {
      return handleError(res, err, "Failed to reorder nav items");
    }
  },
};

// ── Site settings (logo, brand colors) ──────────────────────

export const AdminBlogSiteController = {
  async getSettings(_req: Request, res: Response) {
    try {
      return ok(res, await BlogSiteService.getSiteSettings());
    } catch (err) {
      return handleError(res, err, "Failed to fetch site settings");
    }
  },
  async updateSettings(req: Request, res: Response) {
    const parsed = updateBlogSiteSettingsSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, "Validation failed", 422, parsed.error.issues);
    try {
      return ok(res, await BlogSiteService.updateSiteSettings(parsed.data), "Site settings updated");
    } catch (err) {
      return handleError(res, err, "Failed to update site settings");
    }
  },

  async getFooter(_req: Request, res: Response) {
    try {
      return ok(res, await BlogSiteService.getFooterForAdmin());
    } catch (err) {
      return handleError(res, err, "Failed to fetch footer");
    }
  },
  async upsertFooter(req: Request, res: Response) {
    const parsed = upsertBlogFooterSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, "Validation failed", 422, parsed.error.issues);
    try {
      return ok(res, await BlogSiteService.upsertFooter(parsed.data), "Footer updated");
    } catch (err) {
      return handleError(res, err, "Failed to update footer");
    }
  },
};
