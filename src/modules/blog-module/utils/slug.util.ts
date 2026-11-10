// blog-module/utils/slug.util.ts
import { prisma } from "../../../config/prisma.ts"; // adjust to your project's prisma client path

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")  // accent strip (é → e)
    .replace(/[^a-z0-9\s-]/g, "")     // special char remove (&, /, !, etc.)
    .replace(/\s+/g, "-")             // space → hyphen
    .replace(/-+/g, "-")              // multiple hyphen → single
    .replace(/^-|-$/g, "");           // leading/trailing hyphen trim
}
/**
 * Generates a unique slug for a BlogPost or BlogCategory, appending
 * -2, -3, ... on collision. `excludeId` lets updates keep their own slug.
 */
export async function generateUniqueSlug(
  base: string,
  model: "blogPost" | "blogCategory",
  excludeId?: string
): Promise<string> {
  const root = slugify(base) || "post";
  let candidate = root;
  let suffix = 2;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await (prisma as any)[model].findFirst({
      where: { slug: candidate, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (!existing) return candidate;
    candidate = `${root}-${suffix++}`;
  }
}

export function estimateReadTimeMinutes(html: string): number {
  const words = html
    .replace(/<[^>]*>/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 200)); // ~200 wpm
}
