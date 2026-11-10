// blog-module/services/blog/blog-site.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { BlogRepository } from "../../repositories/blog.repository.ts";
import type { UpdateBlogSiteSettingsInput, UpsertBlogFooterInput } from "../../types/blog.types.ts";

// ── Site identity (logo, name, colors) ──────────────────────

export function getSiteSettings() {
  return BlogRepository.siteSettings();
}

export async function updateSiteSettings(input: UpdateBlogSiteSettingsInput) {
  const existing = await prisma.blogSiteSettings.findFirst();
  if (!existing) {
    return prisma.blogSiteSettings.create({ data: { aboutText: "", ...input } as any });
  }
  return prisma.blogSiteSettings.update({ where: { id: existing.id }, data: input });
}

// ── Footer (admin/employee fully editable, dynamic) ─────────

export function getPublicFooter() {
  return BlogRepository.footerWithColumns();
}

export function getFooterForAdmin() {
  return prisma.blogFooterSettings.findFirst({
    include: { columns: { orderBy: { sortOrder: "asc" }, include: { elements: { orderBy: { sortOrder: "asc" } } } } },
  });
}

// Full replace-semantics upsert: admin submits the whole footer tree
// (columns + elements) and we reconcile it in one transaction — simplest
// mental model for a "footer builder" UI with drag-and-drop columns.
export async function upsertFooter(input: UpsertBlogFooterInput) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.blogFooterSettings.findFirst();

    const settings = existing
      ? await tx.blogFooterSettings.update({
          where: { id: existing.id },
          data: {
            aboutTitle: input.aboutTitle,
            aboutText: input.aboutText,
            facebookUrl: input.facebookUrl,
            youtubeUrl: input.youtubeUrl,
            instagramUrl: input.instagramUrl,
            linkedinUrl: input.linkedinUrl,
            twitterUrl: input.twitterUrl,
            copyrightText: input.copyrightText,
          },
        })
      : await tx.blogFooterSettings.create({
          data: {
            aboutTitle: input.aboutTitle ?? "About Us",
            aboutText: input.aboutText,
            facebookUrl: input.facebookUrl,
            youtubeUrl: input.youtubeUrl,
            instagramUrl: input.instagramUrl,
            linkedinUrl: input.linkedinUrl,
            twitterUrl: input.twitterUrl,
            copyrightText: input.copyrightText,
          },
        });

    // wipe & rebuild columns/elements — simplest correct approach for a
    // low-frequency admin action like editing the footer.
    await tx.blogFooterColumn.deleteMany({ where: { footerSettingsId: settings.id } });

    for (const [colIdx, col] of input.columns.entries()) {
      await tx.blogFooterColumn.create({
        data: {
          title: col.title,
          sortOrder: col.sortOrder ?? colIdx,
          isVisible: col.isVisible ?? true,
          footerSettingsId: settings.id,
          elements: {
            createMany: {
              data: col.elements.map((el, elIdx) => ({
                label: el.label,
                url: el.url,
                sortOrder: el.sortOrder ?? elIdx,
                isVisible: el.isVisible ?? true,
                openInNewTab: el.openInNewTab ?? false,
              })),
            },
          },
        },
      });
    }

    return getFooterForAdmin();
  });
}
