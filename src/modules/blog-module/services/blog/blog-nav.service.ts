// blog-module/services/blog/blog-nav.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { BlogRepository } from "../../repositories/blog.repository.ts";
import type { UpsertBlogNavItemInput } from "../../types/blog.types.ts";

// Public — used by the blog site's header. Two levels only (top-level +
// one dropdown level), matching the reference design.
export function getPublicNavTree() {
  return BlogRepository.activeNavTree();
}

export function listAllNavItemsForAdmin() {
  return prisma.blogNavItem.findMany({
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }],
  });
}

export function createNavItem(input: UpsertBlogNavItemInput) {
  return prisma.blogNavItem.create({
    data: {
      label: input.label,
      url: input.url,
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
      isVisible: input.isVisible ?? true,
      openInNewTab: input.openInNewTab ?? false,
    },
  });
}

export function updateNavItem(id: string, input: UpsertBlogNavItemInput) {
  return prisma.blogNavItem.update({
    where: { id },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isVisible !== undefined ? { isVisible: input.isVisible } : {}),
      ...(input.openInNewTab !== undefined ? { openInNewTab: input.openInNewTab } : {}),
    },
  });
}

export function deleteNavItem(id: string) {
  return prisma.blogNavItem.delete({ where: { id } }); // children cascade
}

export async function reorderNavItems(orderedIds: string[]) {
  await prisma.$transaction(
    orderedIds.map((id, sortOrder) => prisma.blogNavItem.update({ where: { id }, data: { sortOrder } }))
  );
}
