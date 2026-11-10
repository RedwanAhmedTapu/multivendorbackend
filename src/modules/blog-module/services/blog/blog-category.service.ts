// blog-module/services/blog/blog-category.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { BlogRepository } from "../../repositories/blog.repository.ts";
import { generateUniqueSlug } from "../../utils/slug.util.ts";
import type { CreateBlogCategoryInput, UpdateBlogCategoryInput } from "../../types/blog.types.ts";

export function getCategoryTree() {
  return BlogRepository.activeCategoryTree();
}

export function listAllCategoriesForAdmin() {
  return prisma.blogCategory.findMany({
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }],
    include: { _count: { select: { posts: true } } },
  });
}

export async function createCategory(input: CreateBlogCategoryInput) {
  const slug = await generateUniqueSlug(input.name, "blogCategory");
  return prisma.blogCategory.create({
    data: {
      name: input.name,
      slug,
      description: input.description,
      image: input.image,
      parentId: input.parentId,
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export async function updateCategory(id: string, input: UpdateBlogCategoryInput) {
  const existing = await prisma.blogCategory.findUniqueOrThrow({ where: { id } });
  const slug = input.name && input.name !== existing.name
    ? await generateUniqueSlug(input.name, "blogCategory", id)
    : undefined;

  return prisma.blogCategory.update({
    where: { id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(slug ? { slug } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.image !== undefined ? { image: input.image } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
}

// Reassigns posts to null category before deleting, so deleting a category
// never cascades into deleting content.
export function deleteCategory(id: string) {
  return prisma.$transaction([
    prisma.blogPost.updateMany({ where: { categoryId: id }, data: { categoryId: null } }),
    prisma.blogCategory.delete({ where: { id } }),
  ]);
}
