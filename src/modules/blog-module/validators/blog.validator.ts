// blog-module/validators/blog.validator.ts
import { z } from "zod";

const referenceSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
  price: z.number().nonnegative().optional(),
  source: z.string().optional(),
  sortOrder: z.number().int().optional(),
});

// featuredImage / ogImage store the raw R2 KEY (e.g.
// "admin/blog/1699999999-photo.jpg"), NOT a full URL — so these are
// plain strings, not z.string().url(). Only genuinely external links
// (BlogPostReference.url above) get url() validation.
export const createBlogPostSchema = z.object({
  title: z.string().min(3).max(200),
  body: z.string().min(1),
  excerpt: z.string().max(300).optional(),
  categoryId: z.string().cuid().optional(),
  featuredImage: z.string().optional(),
  featuredImageAlt: z.string().optional(),
  tags: z.array(z.string()).max(15).optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "SCHEDULED", "ARCHIVED"]).optional(),
  scheduledAt: z.string().datetime().optional(),
  metaTitle: z.string().max(60).optional(),
  metaDescription: z.string().max(160).optional(),
  ogImage: z.string().optional(),
  references: z.array(referenceSchema).max(20).optional(),
});

export const updateBlogPostSchema = createBlogPostSchema.partial();

export const createBlogCategorySchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(300).optional(),
  image: z.string().optional(), // R2 key, not a URL
  parentId: z.string().cuid().optional(),
  sortOrder: z.number().int().optional(),
});

export const updateBlogCategorySchema = createBlogCategorySchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const upsertBlogNavItemSchema = z.object({
  label: z.string().min(1).max(60),
  url: z.string().optional(),
  parentId: z.string().cuid().optional().nullable(),
  sortOrder: z.number().int().optional(),
  isVisible: z.boolean().optional(),
  openInNewTab: z.boolean().optional(),
});

export const reorderNavSchema = z.object({
  orderedIds: z.array(z.string().cuid()),
});

export const updateBlogSiteSettingsSchema = z.object({
  siteName: z.string().min(2).max(80).optional(),
  logoUrl: z.string().optional(), // R2 key, not a URL
  faviconUrl: z.string().optional(), // R2 key, not a URL
  tagline: z.string().max(160).optional(),
  primaryColorHex: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional(),
  backgroundHex: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional(),
  textColorHex: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional(),
  defaultOgImage: z.string().optional(), // R2 key, not a URL
  googleAnalyticsId: z.string().optional(),
});

export const upsertBlogFooterSchema = z.object({
  aboutTitle: z.string().optional(),
  aboutText: z.string().min(1),
  facebookUrl: z.string().url().optional(),
  youtubeUrl: z.string().url().optional(),
  instagramUrl: z.string().url().optional(),
  linkedinUrl: z.string().url().optional(),
  twitterUrl: z.string().url().optional(),
  copyrightText: z.string().min(1),
  columns: z
    .array(
      z.object({
        id: z.string().cuid().optional(),
        title: z.string().min(1),
        sortOrder: z.number().int().optional(),
        isVisible: z.boolean().optional(),
        elements: z.array(
          z.object({
            id: z.string().cuid().optional(),
            label: z.string().min(1),
            url: z.string().min(1),
            sortOrder: z.number().int().optional(),
            isVisible: z.boolean().optional(),
            openInNewTab: z.boolean().optional(),
          })
        ),
      })
    )
    .max(6),
});
