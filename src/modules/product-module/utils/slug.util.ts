// utils/slug.util.ts
import { prisma } from "../../../config/prisma.ts";

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
 * Generates a unique, SEO-clean slug for a product name.
 * Appends -2, -3, ... on collision. Excludes the product's own id when
 * regenerating a slug on update.
 */
export async function generateUniqueProductSlug(
  name: string,
  excludeProductId?: string
): Promise<string> {
  const base = slugify(name) || "product";
  let candidate = base;
  let suffix = 2;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await prisma.product.findFirst({
      where: {
        slug: candidate,
        ...(excludeProductId ? { id: { not: excludeProductId } } : {}),
      },
      select: { id: true },
    });

    // Also guard against colliding with a *previous* slug still redirecting
    const historyCollision = await prisma.productSlugHistory.findFirst({
      where: {
        oldSlug: candidate,
        ...(excludeProductId ? { productId: { not: excludeProductId } } : {}),
      },
      select: { id: true },
    });

    if (!existing && !historyCollision) return candidate;

    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}

/**
 * Called from the product update flow whenever the slug is about to change.
 * Preserves the old slug in ProductSlugHistory so old links 301-redirect
 * instead of 404ing.
 */
export async function recordSlugChange(productId: string, oldSlug: string) {
  if (!oldSlug) return;
  await prisma.productSlugHistory.upsert({
    where: { oldSlug },
    update: {},
    create: { productId, oldSlug },
  });
}

/**
 * Resolves a slug to a product id, following slug history if the current
 * slug moved. Returns { productId, currentSlug, redirected } or null.
 */
export async function resolveSlug(
  slug: string
): Promise<{ productId: string; currentSlug: string; redirected: boolean } | null> {
  const direct = await prisma.product.findFirst({
    where: { slug, isDeleted: false },
    select: { id: true, slug: true },
  });
  if (direct) return { productId: direct.id, currentSlug: direct.slug, redirected: false };

  const historical = await prisma.productSlugHistory.findUnique({
    where: { oldSlug: slug },
    include: { product: { select: { id: true, slug: true, isDeleted: true } } },
  });

  if (historical && !historical.product.isDeleted) {
    return {
      productId: historical.product.id,
      currentSlug: historical.product.slug,
      redirected: true,
    };
  }

  return null;
}
