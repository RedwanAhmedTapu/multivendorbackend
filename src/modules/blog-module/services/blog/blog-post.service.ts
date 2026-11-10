// blog-module/services/blog/blog-post.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { BlogRepository, postCardSelect } from "../../repositories/blog.repository.ts";
import { generateUniqueSlug, estimateReadTimeMinutes } from "../../utils/slug.util.ts";
import { buildOffsetArgs, toOffsetPage, buildCursorArgs, toCursorPage } from "../../utils/pagination.ts";
import type { CreateBlogPostInput, UpdateBlogPostInput, BlogPostListFilters } from "../../types/blog.types.ts";

// ── Public ────────────────────────────────────────────────────

export async function listPublishedPosts(filters: BlogPostListFilters, cursor?: string, limit = 12) {
  const where = {
    status: "PUBLISHED" as const,
    ...(filters.categorySlug ? { category: { slug: filters.categorySlug } } : {}),
    ...(filters.tag ? { tags: { has: filters.tag } } : {}),
    ...(filters.search
      ? {
          OR: [
            { title: { contains: filters.search, mode: "insensitive" as const } },
            { excerpt: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const rows = await prisma.blogPost.findMany({
    where,
    orderBy: { publishedAt: "desc" },
    select: postCardSelect,
    ...buildCursorArgs(cursor, limit),
  });

  return toCursorPage(rows, limit);
}

export async function getPostBySlug(slug: string) {
  const post = await BlogRepository.findPublishedBySlug(slug);
  if (!post) return null;
  // fire-and-forget view count bump
  BlogRepository.incrementViewCount(post.id).catch(() => void 0);
  return post;
}

export function getRelatedPosts(currentPostId: string, limit = 4) {
  return BlogRepository.findRecent(limit, currentPostId);
}

export function getLatestPosts(limit = 6) {
  return BlogRepository.findRecent(limit);
}

// ── Admin / Employee ─────────────────────────────────────────

export async function listPostsForAdmin(page = 1, limit = 20, filters: BlogPostListFilters = {}) {
  const where = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.authorId ? { authorId: filters.authorId } : {}),
    ...(filters.categorySlug ? { category: { slug: filters.categorySlug } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.blogPost.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: { ...postCardSelect, status: true, createdAt: true },
      ...buildOffsetArgs(page, limit),
    }),
    prisma.blogPost.count({ where }),
  ]);
  return toOffsetPage(items, total, page, limit);
}

export function getPostByIdForAdmin(id: string) {
  return prisma.blogPost.findUnique({
    where: { id },
    include: { category: true, references: { orderBy: { sortOrder: "asc" } } },
  });
}

export async function createPost(input: CreateBlogPostInput) {
  const slug = await generateUniqueSlug(input.title, "blogPost");
  const status = input.status ?? "DRAFT";

  return prisma.blogPost.create({
    data: {
      title: input.title,
      slug,
      body: input.body,
      excerpt: input.excerpt,
      categoryId: input.categoryId,
      featuredImage: input.featuredImage,
      featuredImageAlt: input.featuredImageAlt,
      tags: input.tags ?? [],
      status,
      published: status === "PUBLISHED",
      publishedAt: status === "PUBLISHED" ? new Date() : null,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      readTimeMinutes: estimateReadTimeMinutes(input.body),
      metaTitle: input.metaTitle ?? input.title.slice(0, 60),
      metaDescription: input.metaDescription ?? input.excerpt?.slice(0, 160),
      ogImage: input.ogImage ?? input.featuredImage,
      authorId: input.authorId,
      ...(input.references?.length
        ? { references: { createMany: { data: input.references } } }
        : {}),
    },
    include: { category: true, references: true },
  });
}

export async function updatePost(id: string, input: UpdateBlogPostInput) {
  const existing = await prisma.blogPost.findUniqueOrThrow({ where: { id } });

  // keep a revision snapshot before overwriting body/title
  if (input.title || input.body) {
    await prisma.blogPostRevision.create({
      data: { postId: id, title: existing.title, body: existing.body, editedBy: undefined },
    });
  }

  const slug = input.title && input.title !== existing.title
    ? await generateUniqueSlug(input.title, "blogPost", id)
    : undefined;

  const goingLive = input.status === "PUBLISHED" && existing.status !== "PUBLISHED";

  const post = await prisma.blogPost.update({
    where: { id },
    data: {
      ...(input.title ? { title: input.title } : {}),
      ...(slug ? { slug } : {}),
      ...(input.body ? { body: input.body, readTimeMinutes: estimateReadTimeMinutes(input.body) } : {}),
      ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.featuredImage !== undefined ? { featuredImage: input.featuredImage } : {}),
      ...(input.featuredImageAlt !== undefined ? { featuredImageAlt: input.featuredImageAlt } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.status ? { status: input.status, published: input.status === "PUBLISHED" } : {}),
      ...(goingLive ? { publishedAt: new Date() } : {}),
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null } : {}),
      ...(input.metaTitle !== undefined ? { metaTitle: input.metaTitle } : {}),
      ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
      ...(input.ogImage !== undefined ? { ogImage: input.ogImage } : {}),
    },
    include: { category: true, references: true },
  });

  if (input.references) {
    await prisma.blogPostReference.deleteMany({ where: { postId: id } });
    if (input.references.length) {
      await prisma.blogPostReference.createMany({
        data: input.references.map((r, i) => ({ ...r, postId: id, sortOrder: r.sortOrder ?? i })),
      });
    }
  }

  return post;
}

export function deletePost(id: string) {
  return prisma.blogPost.delete({ where: { id } });
}

export function restoreRevision(revisionId: string) {
  return prisma.$transaction(async (tx) => {
    const revision = await tx.blogPostRevision.findUniqueOrThrow({ where: { id: revisionId } });
    return tx.blogPost.update({
      where: { id: revision.postId },
      data: { title: revision.title, body: revision.body },
    });
  });
}
