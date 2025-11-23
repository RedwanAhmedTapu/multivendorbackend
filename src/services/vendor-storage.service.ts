// services/vendor-storage.service.ts
import { PrismaClient } from "@prisma/client";
import { uploadToR2, deleteFromR2, R2_CONFIG } from "../lib/cloudflare-r2.ts";

const FREE_QUOTA_BYTES = BigInt(R2_CONFIG.freeQuotaGB) * 1024n * 1024n * 1024n;
const prisma = new PrismaClient();

export class VendorStorageService {

  // Check if vendor has enough quota
  async checkQuota(vendorId: string, fileSizeBytes: number): Promise<{
    allowed: boolean;
    reason?: string;
    currentUsage: string;
    totalQuota: string;
  }> {
    let storageUsage = await prisma.vendorStorageUsage.findUnique({
      where: { vendorId },
    });

    if (!storageUsage) {
      storageUsage = await prisma.vendorStorageUsage.create({
        data: {
          vendorId,
          totalUsedBytes: 0n,
          totalQuotaBytes: FREE_QUOTA_BYTES,
        },
      });
    }

    const newTotal = storageUsage.totalUsedBytes + BigInt(fileSizeBytes);
    const allowed = newTotal <= storageUsage.totalQuotaBytes;

    return {
      allowed,
      reason: allowed ? undefined : "Storage quota exceeded. Please purchase additional storage.",
      currentUsage: storageUsage.totalUsedBytes.toString(),
      totalQuota: storageUsage.totalQuotaBytes.toString(),
    };
  }

  // Upload file with quota check
  async uploadFile(params: {
    vendorId: string;
    file: Buffer;
    fileName: string;
    contentType: string;
    fileType: "IMAGE" | "DOCUMENT";
    productId?: string;
    variantId?: string;
  }) {
    const fileSize = BigInt(params.file.length);

    // Check quota
    const quotaCheck = await this.checkQuota(params.vendorId, Number(fileSize));
    if (!quotaCheck.allowed) {
      throw new Error(quotaCheck.reason);
    }

    const timestamp = Date.now();

    // Build dynamic fileKey (path in R2)
    let folderPath = `vendors/${params.vendorId}`;

    if (params.fileType === "IMAGE") {
      if (params.productId) {
        folderPath += `/products/${params.productId}`;
        if (params.variantId) {
          folderPath += `/variants/${params.variantId}`;
        }
      } else {
        folderPath += `/images`;
      }
    } else if (params.fileType === "DOCUMENT") {
      folderPath += `/documents`;
    } else {
      folderPath += `/others`;
    }

    const fileKey = `${folderPath}/${timestamp}-${params.fileName}`;

    // Upload to R2
    const uploadResult = await uploadToR2({
      file: params.file,
      key: fileKey,
      contentType: params.contentType,
      vendorId: params.vendorId,
    });
    console.log(uploadResult)

    // Save in DB (transactional)
    const storageFile = await prisma.$transaction(async (tx) => {
      const file = await tx.storageFile.create({
        data: {
          vendorId: params.vendorId,
          fileName: params.fileName,
          fileKey,
          fileSize,
          mimeType: params.contentType,
          fileType: params.fileType,
          r2Bucket: R2_CONFIG.bucket,
          r2Url: uploadResult.url,
          productId: params.productId,
          variantId: params.variantId,
        },
      });

      await tx.vendorStorageUsage.update({
        where: { vendorId: params.vendorId },
        data: {
          totalUsedBytes: { increment: fileSize },
          totalFiles: { increment: 1 },
          imageFiles:
            params.fileType === "IMAGE" ? { increment: 1 } : undefined,
          documentFiles:
            params.fileType === "DOCUMENT" ? { increment: 1 } : undefined,
          currentMonthUsage: { increment: fileSize },
          lastCalculatedAt: new Date(),
        },
      });

      return file;
    });

    return {
      ...storageFile,
      fileSize: storageFile.fileSize.toString(),
    };
  }

  // Delete file and reclaim quota
  async deleteFile(fileId: string) {
    const file = await prisma.storageFile.findUnique({ where: { id: fileId } });
    if (!file || !file.isActive) throw new Error("File not found or already deleted");

    await prisma.$transaction(async (tx) => {
      await tx.storageFile.update({
        where: { id: fileId },
        data: { isActive: false, deletedAt: new Date() },
      });

      await tx.vendorStorageUsage.update({
        where: { vendorId: file.vendorId },
        data: {
          totalUsedBytes: { decrement: file.fileSize },
          totalFiles: { decrement: 1 },
          lastCalculatedAt: new Date(),
        },
      });
    });

    await deleteFromR2(file.fileKey);
  }

  // Purchase additional storage
  async purchaseStorage(vendorId: string, additionalGB: number) {
    const additionalBytes = BigInt(additionalGB) * 1024n * 1024n * 1024n;

    await prisma.vendorStorageUsage.update({
      where: { vendorId },
      data: {
        paidQuotaBytes: { increment: additionalBytes },
        totalQuotaBytes: { increment: additionalBytes },
      },
    });

    return {
      success: true,
      additionalGB,
      additionalBytes: additionalBytes.toString(),
    };
  }

  // Calculate monthly storage charges
  async calculateMonthlyCharges(vendorId: string, billingPeriod: string) {
    const usage = await prisma.vendorStorageUsage.findUnique({ where: { vendorId } });
    if (!usage) return null;

    const chargeableBytes = usage.totalUsedBytes > FREE_QUOTA_BYTES
      ? usage.totalUsedBytes - FREE_QUOTA_BYTES
      : 0n;

    if (chargeableBytes === 0n) return null;

    const chargeableGB = Number(chargeableBytes) / (1024 * 1024 * 1024);
    const totalCharge = chargeableGB * R2_CONFIG.pricePerGBOverQuota;

    const charge = await prisma.vendorStorageCharge.create({
      data: {
        vendorId,
        billingPeriod,
        usedBytes: usage.totalUsedBytes,
        chargeableBytes,
        pricePerGB: R2_CONFIG.pricePerGBOverQuota,
        totalCharge,
      },
    });

    return {
      ...charge,
      usedBytes: charge.usedBytes.toString(),
      chargeableBytes: charge.chargeableBytes.toString(),
    };
  }

  // Get vendor storage stats - FIXED VERSION
 async getStorageStats(vendorId: string) {
  const usage = await prisma.vendorStorageUsage.findUnique({
    where: { vendorId },
    include: { vendor: { select: { id: true, storeName: true } } },
  });
  if (!usage) return null;

  // Convert BigInt to Number
  const usedBytes = Number(usage.totalUsedBytes);
  const totalBytes = Number(usage.totalQuotaBytes);
  const paidBytes = Number(usage.paidQuotaBytes);

  // Derived sizes
  const usedMB = usedBytes / (1024 ** 2);
  const usedGB = usedBytes / (1024 ** 3);
  const totalGB = totalBytes / (1024 ** 3);
  const paidQuotaGB = paidBytes / (1024 ** 3);

  // Remaining space
  const remainingBytes = totalBytes - usedBytes;
  const remainingMB = remainingBytes / (1024 ** 2);
  const remainingGB = remainingBytes / (1024 ** 3);

  // Usage percentage
  const usagePercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

  // Helper function to truncate and keep fixed decimals
  const truncate = (value: number, decimals: number) => {
    const factor = 10 ** decimals;
    return Math.floor(value * factor) / factor;
  };

  // Format used space
  const [displayUsedSize, displayUsedUnit] =
    usedMB < 1
      ? [(usedBytes / 1024).toFixed(2), "KB"]
      : usedGB < 1
      ? [usedMB.toFixed(2), "MB"]
      : [truncate(usedGB, 2).toFixed(2), "GB"];

  // Format remaining space
  const [displayRemainingSize, displayRemainingUnit] =
    remainingMB < 1
      ? [(remainingBytes / 1024).toFixed(2), "KB"]
      : remainingGB < 1
      ? [remainingMB.toFixed(2), "MB"]
      : [truncate(remainingGB, 2).toFixed(2), "GB"];
  return {
    // Raw bytes
    usedBytes: usage.totalUsedBytes.toString(),
    totalBytes: usage.totalQuotaBytes.toString(),

    // Human-readable
    usedSize: displayUsedSize,
    usedUnit: displayUsedUnit,
    usedMB: usedMB.toFixed(2),
    usedGB: truncate(usedGB, 2).toFixed(2),
    totalGB: truncate(totalGB, 2).toFixed(2),

    // Remaining
    remainingBytes,
    remainingGB: truncate(remainingGB, 2).toFixed(2),
    remainingSize: displayRemainingSize,
    remainingUnit: displayRemainingUnit,

    // Percent
    usagePercent: usagePercent.toFixed(4),

    // Quota
    freeQuotaGB: R2_CONFIG.freeQuotaGB,
    paidQuotaGB: Number(paidQuotaGB.toFixed(2)),

    // File counts
    totalFiles: usage.totalFiles,
    imageFiles: usage.imageFiles,
    documentFiles: usage.documentFiles,
  };
}



}

export const vendorStorageService = new VendorStorageService();