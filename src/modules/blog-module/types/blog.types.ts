// blog-module/types/blog.types.ts
import type { BlogPostStatus } from "@prisma/client";

export interface CreateBlogPostInput {
  title: string;
  body: string;
  excerpt?: string;
  categoryId?: string;
  featuredImage?: string;
  featuredImageAlt?: string;
  tags?: string[];
  status?: BlogPostStatus;
  scheduledAt?: string;
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  authorId?: string;
  references?: { label: string; url: string; price?: number; source?: string; sortOrder?: number }[];
}

export type UpdateBlogPostInput = Partial<CreateBlogPostInput>;

export interface CreateBlogCategoryInput {
  name: string;
  description?: string;
  image?: string;
  parentId?: string;
  sortOrder?: number;
}

export type UpdateBlogCategoryInput = Partial<CreateBlogCategoryInput> & { isActive?: boolean };

export interface UpsertBlogNavItemInput {
  label: string;
  url?: string;
  parentId?: string;
  sortOrder?: number;
  isVisible?: boolean;
  openInNewTab?: boolean;
}

export interface UpdateBlogSiteSettingsInput {
  siteName?: string;
  logoUrl?: string;
  faviconUrl?: string;
  tagline?: string;
  primaryColorHex?: string;
  backgroundHex?: string;
  textColorHex?: string;
  defaultOgImage?: string;
  googleAnalyticsId?: string;
}

export interface UpsertBlogFooterInput {
  aboutTitle?: string;
  aboutText: string;
  facebookUrl?: string;
  youtubeUrl?: string;
  instagramUrl?: string;
  linkedinUrl?: string;
  twitterUrl?: string;
  copyrightText: string;
  columns: {
    id?: string;
    title: string;
    sortOrder?: number;
    isVisible?: boolean;
    elements: { id?: string; label: string; url: string; sortOrder?: number; isVisible?: boolean; openInNewTab?: boolean }[];
  }[];
}

export interface BlogPostListFilters {
  categorySlug?: string;
  tag?: string;
  search?: string;
  status?: BlogPostStatus;
  authorId?: string;
}
