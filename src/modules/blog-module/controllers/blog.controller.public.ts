// blog-module/controllers/blog.controller.public.ts
import type { Request, Response } from "express";
import { ok, fail, handleError } from "../utils/response.ts";
import { BlogPostService, BlogCategoryService, BlogNavService, BlogSiteService } from "../services/blog/index.ts";

export const PublicBlogController = {
  async list(req: Request, res: Response) {
    try {
      const { cursor, limit, category, tag, search } = req.query as Record<string, string>;
      const page = await BlogPostService.listPublishedPosts(
        { categorySlug: category, tag, search },
        cursor,
        Number(limit) || 12
      );
      return ok(res, page);
    } catch (err) {
      return handleError(res, err, "Failed to fetch posts");
    }
  },

  async getBySlug(req: Request, res: Response) {
    try {
      const post = await BlogPostService.getPostBySlug(req.params.slug);
      if (!post) return fail(res, "Post not found", 404);
      const related = await BlogPostService.getRelatedPosts(post.id, 4);
      return ok(res, { post, related });
    } catch (err) {
      return handleError(res, err, "Failed to fetch post");
    }
  },

  async latest(req: Request, res: Response) {
    try {
      const limit = Number(req.query.limit) || 6;
      return ok(res, await BlogPostService.getLatestPosts(limit));
    } catch (err) {
      return handleError(res, err, "Failed to fetch latest posts");
    }
  },

  async categories(_req: Request, res: Response) {
    try {
      return ok(res, await BlogCategoryService.getCategoryTree());
    } catch (err) {
      return handleError(res, err, "Failed to fetch categories");
    }
  },

  async nav(_req: Request, res: Response) {
    try {
      return ok(res, await BlogNavService.getPublicNavTree());
    } catch (err) {
      return handleError(res, err, "Failed to fetch navigation");
    }
  },

  async footer(_req: Request, res: Response) {
    try {
      return ok(res, await BlogSiteService.getPublicFooter());
    } catch (err) {
      return handleError(res, err, "Failed to fetch footer");
    }
  },

  async siteSettings(_req: Request, res: Response) {
    try {
      return ok(res, await BlogSiteService.getSiteSettings());
    } catch (err) {
      return handleError(res, err, "Failed to fetch site settings");
    }
  },
};
