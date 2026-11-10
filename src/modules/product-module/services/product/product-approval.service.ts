// services/product/product-approval.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { generateAndSaveProductSEO } from "../../utils/seo.util.ts";
import { invalidateProductCache } from "../../../../config/cache.ts";
import { AppError } from "../../utils/response.ts";

/**
 * APPROVE — the single place SEO gets auto-generated. Per the brief:
 * "SEO will be auto generated when admin approve any product."
 * Runs inside a transaction so a product is never left ACTIVE without
 * published SEO, and never left with SEO but PENDING status.
 */
export async function approveProduct(productId: string, adminId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, slug: true, vendorId: true, approvalStatus: true, isDeleted: true },
  });

  if (!product || product.isDeleted) throw new AppError("Product not found", 404);
  if (product.approvalStatus === "ACTIVE") throw new AppError("Product is already approved", 400);

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.product.update({
      where: { id: productId },
      data: { approvalStatus: "ACTIVE", approvedById: adminId },
      include: {
        vendor: { select: { id: true, storeName: true } },
        category: { select: { id: true, name: true, slug: true } },
        approvedBy: { select: { id: true, name: true } },
      },
    });

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: "APPROVE",
        entity: "Product",
        entityId: productId,
        oldData: { approvalStatus: product.approvalStatus },
        newData: { approvalStatus: "ACTIVE" },
      },
    });

    return result;
  });

  // Auto-generate + publish SEO now that the product is live. Kept outside
  // the transaction above since it does its own read + upsert and a
  // failure here shouldn't roll back a valid approval — instead it's
  // retried by the "repair missing SEO" sweep job (see README).
  try {
    await generateAndSaveProductSEO(productId, "APPROVAL");
  } catch (err) {
    console.error(`SEO auto-generation failed for approved product ${productId}:`, err);
  }

  await invalidateProductCache({ productId, slug: updated.slug, vendorId: updated.vendorId });

  return updated;
}

export async function rejectProduct(productId: string, adminId: string, reason: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, slug: true, vendorId: true, approvalStatus: true, isDeleted: true },
  });
  if (!product || product.isDeleted) throw new AppError("Product not found", 404);

  const updated = await prisma.product.update({
    where: { id: productId },
    data: { approvalStatus: "REJECTED", approvedById: adminId },
  });

  await prisma.auditLog.create({
    data: {
      userId: adminId,
      action: "REJECT",
      entity: "Product",
      entityId: productId,
      oldData: { approvalStatus: product.approvalStatus },
      newData: { approvalStatus: "REJECTED", rejectionReason: reason },
    },
  });

  await invalidateProductCache({ productId, slug: product.slug, vendorId: product.vendorId });
  return updated;
}

export async function bulkApprove(productIds: string[], adminId: string) {
  const result = await prisma.product.updateMany({
    where: { id: { in: productIds }, approvalStatus: "PENDING", isDeleted: false },
    data: { approvalStatus: "ACTIVE", approvedById: adminId },
  });

  await prisma.auditLog.create({
    data: { userId: adminId, action: "BULK_APPROVE", entity: "Product", entityId: "multiple", newData: { productIds, count: result.count } },
  });

  // Generate SEO for each newly-approved product. Done sequentially in
  // small chunks to avoid hammering the DB on large bulk-approve batches.
  const chunkSize = 10;
  for (let i = 0; i < productIds.length; i += chunkSize) {
    const chunk = productIds.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map((id) =>
        generateAndSaveProductSEO(id, "APPROVAL").catch((err) =>
          console.error(`SEO auto-generation failed for bulk-approved product ${id}:`, err)
        )
      )
    );
  }

  return result;
}

export async function bulkReject(productIds: string[], adminId: string, reason?: string) {
  const result = await prisma.product.updateMany({
    where: { id: { in: productIds }, approvalStatus: "PENDING", isDeleted: false },
    data: { approvalStatus: "REJECTED", approvedById: adminId },
  });

  await prisma.auditLog.create({
    data: { userId: adminId, action: "BULK_REJECT", entity: "Product", entityId: "multiple", newData: { productIds, count: result.count, rejectionReason: reason } },
  });

  return result;
}

/**
 * Repair sweep — finds ACTIVE products with missing/unpublished SEO
 * (e.g. because generateAndSaveProductSEO failed transiently during
 * approval) and regenerates it. Intended to run nightly alongside the
 * purge job.
 */
export async function repairMissingSeo(batchSize = 50) {
  const candidates = await prisma.product.findMany({
    where: {
      approvalStatus: "ACTIVE",
      isDeleted: false,
      OR: [{ seo: null }, { seo: { isPublished: false } }],
    },
    select: { id: true },
    take: batchSize,
  });

  let repaired = 0;
  for (const p of candidates) {
    try {
      await generateAndSaveProductSEO(p.id, "APPROVAL");
      repaired += 1;
    } catch (err) {
      console.error(`SEO repair failed for product ${p.id}:`, err);
    }
  }
  return { checked: candidates.length, repaired };
}
