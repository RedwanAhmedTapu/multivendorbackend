// controllers/vendor-storage.controller.ts
import type { Request, Response } from "express";
import { vendorStorageService } from "../services/vendor-storage.service.ts";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class VendorStorageController {
  
  // Upload single file
  async uploadFile(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({ 
          success: false, 
          message: "Vendor ID not found" 
        });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ 
          success: false, 
          message: "No file uploaded" 
        });
      }

      // Determine file type
      const fileType = file.mimetype.startsWith('image/') ? 'IMAGE' : 'DOCUMENT';

      // Upload file with quota check
      const storageFile = await vendorStorageService.uploadFile({
        vendorId,
        file: file.buffer,
        fileName: file.originalname,
        contentType: file.mimetype,
        fileType,
        productId: req.body.productId,
        variantId: req.body.variantId,
      });

      res.json({
        success: true,
        file: {
          id: storageFile.id,
          fileName: storageFile.fileName,
          url: storageFile.r2Url,
          fileSize: storageFile.fileSize,
          mimeType: storageFile.mimeType,
        },
      });
    } catch (error: any) {
      console.error('File upload error:', error);
      res.status(error.message.includes('quota') ? 403 : 500).json({
        success: false,
        message: error.message || "File upload failed",
      });
    }
  }

  // Upload multiple files
  async uploadMultipleFiles(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({ 
          success: false, 
          message: "Vendor ID not found" 
        });
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ 
          success: false, 
          message: "No files uploaded" 
        });
      }

      // Calculate total size first
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);

      // Check quota for all files at once
      const quotaCheck = await vendorStorageService.checkQuota(vendorId, totalSize);
      if (!quotaCheck.allowed) {
        return res.status(403).json({
          success: false,
          message: quotaCheck.reason,
          currentUsage: quotaCheck.currentUsage.toString(),
          totalQuota: quotaCheck.totalQuota.toString(),
          requiredSpace: totalSize,
        });
      }

      // Upload all files
      const uploadPromises = files.map(file => {
        const fileType = file.mimetype.startsWith('image/') ? 'IMAGE' : 'DOCUMENT';
        
        return vendorStorageService.uploadFile({
          vendorId,
          file: file.buffer,
          fileName: file.originalname,
          contentType: file.mimetype,
          fileType,
          productId: req.body.productId,
          variantId: req.body.variantId,
        });
      });

      const uploadedFiles = await Promise.all(uploadPromises);

      res.json({
        success: true,
        files: uploadedFiles.map(file => ({
          id: file.id,
          fileName: file.fileName,
          url: file.r2Url,
          path: file.r2Url, // For backward compatibility
          fileSize: file.fileSize,
          mimeType: file.mimeType,
        })),
        totalFiles: uploadedFiles.length,
        totalSize,
      });
    } catch (error: any) {
      console.error('Multiple files upload error:', error);
      res.status(error.message.includes('quota') ? 403 : 500).json({
        success: false,
        message: error.message || "Files upload failed",
      });
    }
  }

  // Delete file
  async deleteFile(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      const { fileId } = req.params;

      if (!vendorId || !fileId) {
        return res.status(400).json({ 
          success: false, 
          message: "Missing required parameters" 
        });
      }

      // Verify file belongs to vendor
      const file = await prisma.storageFile.findFirst({
        where: { 
          id: fileId,
          vendorId,
          isActive: true,
        },
      });

      if (!file) {
        return res.status(404).json({ 
          success: false, 
          message: "File not found or already deleted" 
        });
      }

      await vendorStorageService.deleteFile(fileId);

      res.json({
        success: true,
        message: "File deleted successfully",
      });
    } catch (error: any) {
      console.error('File deletion error:', error);
      res.status(500).json({
        success: false,
        message: error.message || "File deletion failed",
      });
    }
  }

  // Get storage stats
  // Get storage stats (Controller)
async getStorageStats(req: Request, res: Response) {
  try {
    const vendorId = req.user?.vendorId?.toString();
    if (!vendorId) {
      return res.status(400).json({
        success: false,
        message: "Vendor ID not found",
      });
    }

    const stats = await vendorStorageService.getStorageStats(vendorId);
    if (!stats) {
      return res.status(404).json({
        success: false,
        message: "Storage stats not found",
      });
    }

    // Safe numeric conversions
    const usedBytes = parseFloat(stats.usedBytes);
    const totalBytes = parseFloat(stats.totalBytes);
    const usedGB = parseFloat(stats.usedGB);
    const totalGB = parseFloat(stats.totalGB);
    const remainingGB = parseFloat(stats.remainingGB);
    const usagePercent = parseFloat(stats.usagePercent);
    const remainingBytes = totalBytes - usedBytes;

    return res.json({
      success: true,
      stats: {
        usedBytes,
        totalBytes,
        remainingBytes,

        usedGB,
        totalGB,
        remainingGB,

        usedSize: stats.usedSize,
        usedUnit: stats.usedUnit,
        usedMB: parseFloat(stats.usedMB),

        freeQuotaGB: stats.freeQuotaGB,
        paidQuotaGB: stats.paidQuotaGB,

        usagePercent,

        totalFiles: stats.totalFiles,
        imageFiles: stats.imageFiles,
        documentFiles: stats.documentFiles,
      },
    });
  } catch (error: any) {
    console.error("Get storage stats error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch storage stats",
    });
  }
}



  // Check quota
  async checkQuota(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      const { requiredSpace } = req.body;

      if (!vendorId) {
        return res.status(400).json({ 
          success: false, 
          message: "Vendor ID not found" 
        });
      }

      if (!requiredSpace || requiredSpace <= 0) {
        return res.status(400).json({ 
          success: false, 
          message: "Invalid required space value" 
        });
      }

      const quotaCheck = await vendorStorageService.checkQuota(
        vendorId, 
        requiredSpace
      );

      res.json({
        success: true,
        available: quotaCheck.allowed,
        currentUsage: quotaCheck.currentUsage.toString(),
        totalQuota: quotaCheck.totalQuota.toString(),
        availableSpace: (Number(quotaCheck.totalQuota) - Number(quotaCheck.currentUsage)).toString(),
        requiredSpace,
        reason: quotaCheck.reason,
      });
    } catch (error: any) {
      console.error('Check quota error:', error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to check quota",
      });
    }
  }

  // Purchase additional storage
  async purchaseStorage(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      const { additionalGB } = req.body;

      if (!vendorId) {
        return res.status(400).json({ 
          success: false, 
          message: "Vendor ID not found" 
        });
      }

      if (!additionalGB || additionalGB <= 0) {
        return res.status(400).json({ 
          success: false, 
          message: "Invalid storage amount" 
        });
      }

      const result = await vendorStorageService.purchaseStorage(
        vendorId, 
        additionalGB
      );

      res.json({
        success: true,
        message: `Successfully purchased ${additionalGB}GB of additional storage`,
        ...result,
      });
    } catch (error: any) {
      console.error('Purchase storage error:', error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to purchase storage",
      });
    }
  }

 // Get vendor files
async getVendorFiles(req: Request, res: Response) {
  try {
    const vendorId = req.user?.vendorId?.toString();
    if (!vendorId) {
      return res.status(400).json({ 
        success: false, 
        message: "Vendor ID not found" 
      });
    }

    const { 
      category, 
      page = 1, 
      limit = 20,
      fileType,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {
      vendorId,
      isActive: true,
    };

    if (fileType) {
      where.fileType = fileType;
    }

    if (category) {
      // You can add category filtering based on productId/variantId
      // or add a category field to your schema
    }

    const [files, total] = await Promise.all([
      prisma.storageFile.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          fileName: true,
          fileKey: true,
          fileSize: true,
          mimeType: true,
          fileType: true,
          r2Url: true,
          productId: true,
          variantId: true,
          createdAt: true,
        },
      }),
      prisma.storageFile.count({ where }),
    ]);

    // Convert BigInt fields to strings
    const serializedFiles = files.map(file => ({
      ...file,
      id: file.id.toString(),
      productId: file.productId?.toString(),
      variantId: file.variantId?.toString(),
    }));

    res.json({
      success: true,
      files: serializedFiles,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error: any) {
    console.error('Get vendor files error:', error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch files",
    });
  }
}

  // Calculate monthly charges (Admin only)
  async calculateMonthlyCharges(req: Request, res: Response) {
    try {
      const { vendorIds, calculationDate } = req.body;
      
      const billingPeriod = calculationDate || 
        new Date().toISOString().slice(0, 7); // YYYY-MM format

      let vendors: string[] = vendorIds;

      // If no specific vendors, calculate for all
      if (!vendors || vendors.length === 0) {
        const allVendors = await prisma.vendor.findMany({
          select: { id: true },
        });
        vendors = allVendors.map(v => v.id);
      }

      const charges = await Promise.all(
        vendors.map(vendorId => 
          vendorStorageService.calculateMonthlyCharges(vendorId, billingPeriod)
        )
      );

      const validCharges = charges.filter(c => c !== null);

      res.json({
        success: true,
        billingPeriod,
        totalVendors: vendors.length,
        chargedVendors: validCharges.length,
        charges: validCharges,
        totalCharge: validCharges.reduce((sum, c) => sum + c!.totalCharge, 0),
      });
    } catch (error: any) {
      console.error('Calculate monthly charges error:', error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to calculate charges",
      });
    }
  }
}

export const vendorStorageController = new VendorStorageController();