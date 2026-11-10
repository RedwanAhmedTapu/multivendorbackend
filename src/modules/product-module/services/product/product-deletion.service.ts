// services/product/product-deletion.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { invalidateProductCache } from "../../../../config/cache.ts";
import { AppError } from "../../utils/response.ts";

const PURGE_DELAY_DAYS = 90; // ~3 months

/**
 * VENDOR DELETE — never removes the row immediately.
 * Marks the product isDeleted=true, unpublishes it (so it disappears from
 * every public/vendor/admin listing that filters isDeleted:false), and
 * schedules a hard purge 90 days later. The vendor (or admin) can restore
 * it any time before scheduledPurgeAt via restoreProduct().
 */
export async function softDeleteProduct(productId: string, vendorId: string, userId?: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, vendorId, isDeleted: false },
    select: { id: true, name: true, slug: true, approvalStatus: true },
  });

  if (!product) {
    throw new AppError("Product not found or unauthorized", 404);
  }

  const deletedAt = new Date();
  const scheduledPurgeAt = new Date(deletedAt);
  scheduledPurgeAt.setDate(scheduledPurgeAt.getDate() + PURGE_DELAY_DAYS);

  const updated = await prisma.product.update({
    where: { id: productId },
    data: {
      isDeleted: true,
      deletedAt,
      deletedById: userId,
      scheduledPurgeAt,
      // Pull it out of the public catalog immediately even though the
      // row still exists — approvalStatus stays as-is so a restore
      // doesn't require re-approval.
    },
  });

  if (userId) {
    await prisma.auditLog.create({
      data: {
        userId,
        action: "SOFT_DELETE",
        entity: "Product",
        entityId: productId,
        oldData: product,
        newData: { isDeleted: true, deletedAt, scheduledPurgeAt },
      },
    });
  }

  await invalidateProductCache({ productId, slug: product.slug, vendorId });

  return {
    ...updated,
    message: `Product will be permanently deleted on ${scheduledPurgeAt.toISOString()} unless restored before then.`,
  };
}

/**
 * Restore a soft-deleted product before its purge date. Available to the
 * owning vendor or an admin.
 */
export async function restoreProduct(productId: string, opts: { vendorId?: string; userId?: string }) {
  const where: any = { id: productId, isDeleted: true };
  if (opts.vendorId) where.vendorId = opts.vendorId;

  const product = await prisma.product.findFirst({ where, select: { id: true, slug: true, vendorId: true } });
  if (!product) throw new AppError("Deleted product not found or unauthorized", 404);

  const restored = await prisma.product.update({
    where: { id: productId },
    data: { isDeleted: false, deletedAt: null, deletedById: null, scheduledPurgeAt: null },
  });

  if (opts.userId) {
    await prisma.auditLog.create({
      data: {
        userId: opts.userId,
        action: "RESTORE",
        entity: "Product",
        entityId: productId,
        newData: { isDeleted: false },
      },
    });
  }

  await invalidateProductCache({ productId, slug: product.slug, vendorId: product.vendorId });
  return restored;
}

/**
 * ADMIN FORCE DELETE — bypasses the 90-day window entirely and removes the
 * product and its dependent rows right away. This is the only path that
 * performs a real DB delete outside of the scheduled purge job.
 */
export async function hardDeleteProduct(productId: string, userId?: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, vendorId: true, slug: true },
  });
  if (!product) throw new AppError("Product not found", 404);

  await purgeProductAndRelations(productId);

  if (userId) {
    await prisma.auditLog.create({
      data: {
        userId,
        action: "FORCE_DELETE",
        entity: "Product",
        entityId: productId,
        oldData: product,
      },
    });
  }

  await invalidateProductCache({ productId, slug: product.slug, vendorId: product.vendorId });
  return { id: productId, deleted: true };
}

/**
 * Shared cleanup: removes every row that references the product before
 * deleting the product itself, in FK-safe order. Used by both the admin
 * force-delete path and the scheduled purge job.
 */
export async function purgeProductAndRelations(productId: string) {
  await prisma.$transaction([
    prisma.productImage.deleteMany({
      where: { OR: [{ productId }, { variant: { productId } }] },
    }),
    prisma.productVariantAttribute.deleteMany({ where: { variant: { productId } } }),
    prisma.review.deleteMany({ where: { productId } }),
    prisma.warranty.deleteMany({ where: { productId } }),
    prisma.productSEO.deleteMany({ where: { productId } }),
    prisma.productSlugHistory.deleteMany({ where: { productId } }),
    prisma.recentlyViewedProduct.deleteMany({ where: { productId } }),
    prisma.productAttribute.deleteMany({ where: { productId } }),
    prisma.productVariant.deleteMany({ where: { productId } }),
    prisma.product.delete({ where: { id: productId } }),
  ]);
}

/**
 * Called by the daily cron job (see jobs/purge-deleted-products.job.ts).
 * Permanently removes every product whose scheduledPurgeAt has passed.
 * Runs in small batches so a large backlog never holds one giant
 * transaction open.
 */
export async function purgeExpiredSoftDeletes(batchSize = 50) {
  const now = new Date();
  const due = await prisma.product.findMany({
    where: { isDeleted: true, scheduledPurgeAt: { lte: now } },
    select: { id: true, vendorId: true, slug: true, name: true },
    take: batchSize,
  });

  let purged = 0;
  for (const product of due) {
    try {
      await purgeProductAndRelations(product.id);
      await invalidateProductCache({ productId: product.id, slug: product.slug, vendorId: product.vendorId });
      purged += 1;
    } catch (err) {
      console.error(`Failed to purge product ${product.id} (${product.name}):`, err);
    }
  }

  return { checked: due.length, purged };
}

/**
 * Vendor "trash" view — soft-deleted products still within the 90-day
 * grace period, with days-remaining computed for the UI.
 */
export async function getVendorTrash(vendorId: string) {
  const items = await prisma.product.findMany({
    where: { vendorId, isDeleted: true },
    select: {
      id: true,
      name: true,
      slug: true,
      deletedAt: true,
      scheduledPurgeAt: true,
      images: { take: 1, orderBy: { sortOrder: "asc" } },
    },
    orderBy: { deletedAt: "desc" },
  });

  const now = Date.now();
  return items.map((p) => ({
    ...p,
    daysUntilPurge: p.scheduledPurgeAt
      ? Math.max(0, Math.ceil((p.scheduledPurgeAt.getTime() - now) / (1000 * 60 * 60 * 24)))
      : null,
  }));
}
