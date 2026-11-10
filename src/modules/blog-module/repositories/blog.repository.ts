// blog-module/repositories/blog.repository.ts
// Centralized select/include shapes, mirroring product.repository.ts, so
// there's one place to fix N+1s or add a field to every card/list at once.
import { prisma } from "../../../config/prisma.ts";

export const postCardSelect = {
  id: true,
  title: true,
  slug: true,
  excerpt: true,
  featuredImage: true,
  featuredImageAlt: true,
  readTimeMinutes: true,
  viewCount: true,
  publishedAt: true,
  tags: true,
  category: { select: { id: true, name: true, slug: true } },
  author: { select: { id: true, name: true } },
} as const;

export const postDetailInclude = {
  category: { select: { id: true, name: true, slug: true } },
  author: { select: { id: true, name: true } },
  references: { orderBy: { sortOrder: "asc" as const } },
} as const;

export const BlogRepository = {
  findPublishedBySlug(slug: string) {
    return prisma.blogPost.findFirst({
      where: { slug, status: "PUBLISHED" },
      include: postDetailInclude,
    });
  },

  findRecent(limit: number, excludeId?: string) {
    return prisma.blogPost.findMany({
      where: { status: "PUBLISHED", ...(excludeId ? { id: { not: excludeId } } : {}) },
      orderBy: { publishedAt: "desc" },
      take: limit,
      select: postCardSelect,
    });
  },

  findByCategorySlug(categorySlug: string, take: number, skip = 0) {
    return prisma.blogPost.findMany({
      where: { status: "PUBLISHED", category: { slug: categorySlug } },
      orderBy: { publishedAt: "desc" },
      take,
      skip,
      select: postCardSelect,
    });
  },

  incrementViewCount(id: string) {
    return prisma.blogPost.update({ where: { id }, data: { viewCount: { increment: 1 } } });
  },

  activeNavTree() {
    return prisma.blogNavItem.findMany({
      where: { isVisible: true, parentId: null },
      orderBy: { sortOrder: "asc" },
      include: { children: { where: { isVisible: true }, orderBy: { sortOrder: "asc" } } },
    });
  },

  activeCategoryTree() {
    return prisma.blogCategory.findMany({
      where: { isActive: true, parentId: null },
      orderBy: { sortOrder: "asc" },
      include: { children: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } },
    });
  },

  footerWithColumns() {
    return prisma.blogFooterSettings.findFirst({
      where: { isActive: true },
      include: {
        columns: {
          where: { isVisible: true },
          orderBy: { sortOrder: "asc" },
          include: { elements: { where: { isVisible: true }, orderBy: { sortOrder: "asc" } } },
        },
      },
    });
  },

  siteSettings() {
    return prisma.blogSiteSettings.findFirst();
  },
};
