// offers.controller.ts
import type { Request, Response, NextFunction } from 'express';
import {
  AdminOfferService,
  VendorOfferService,
  CustomerOfferService,
  OfferValidationService,
  OfferUsageService,
  OfferReportingService
} from '../services/offer.service.ts';

import type {
  CreateOfferDTO,
  OfferFilters,
  VendorOfferFilters,
  OrderValidationData
} from '../services/offer.service.ts';
import { deleteFromR2Admin, extractFileKeyFromUrl, generateOfferBannerKey, uploadToR2Admin } from '../lib/r2-admin-config.ts';

// =========================== 
// ADMIN OFFER CONTROLLER
// ===========================

class AdminOfferController {
  private adminOfferService: AdminOfferService;
  private reportingService: OfferReportingService;

  constructor() {
    this.adminOfferService = new AdminOfferService();
    this.reportingService = new OfferReportingService();
  }

 createOffer = async (req: Request, res: Response, next: NextFunction) => {
  let offerData: CreateOfferDTO | undefined;
  let uploadedBannerUrl: string | undefined;
  let uploadedFileKey: string | undefined;
  
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({ 
        success: false, 
        message: 'Unauthorized' 
      });
    }

    offerData = req.body as CreateOfferDTO;
    
    // Parse JSON string fields when using multipart/form-data
    if (typeof offerData.targetProductIds === 'string') {
      try {
        offerData.targetProductIds = JSON.parse(offerData.targetProductIds);
      } catch (e) {
        offerData.targetProductIds = [];
      }
    }
    
    if (typeof offerData.targetCategoryIds === 'string') {
      try {
        offerData.targetCategoryIds = JSON.parse(offerData.targetCategoryIds);
      } catch (e) {
        offerData.targetCategoryIds = [];
      }
    }
    
    if (typeof offerData.targetVendorIds === 'string') {
      try {
        offerData.targetVendorIds = JSON.parse(offerData.targetVendorIds);
      } catch (e) {
        offerData.targetVendorIds = [];
      }
    }
    
    if (typeof offerData.targetUserIds === 'string') {
      try {
        offerData.targetUserIds = JSON.parse(offerData.targetUserIds);
      } catch (e) {
        offerData.targetUserIds = [];
      }
    }

    // Parse nested config objects
    if (typeof offerData.voucherConfig === 'string') {
      try {
        offerData.voucherConfig = JSON.parse(offerData.voucherConfig);
      } catch (e) {
        offerData.voucherConfig = undefined;
      }
    }

    if (typeof offerData.stackRuleConfig === 'string') {
      try {
        offerData.stackRuleConfig = JSON.parse(offerData.stackRuleConfig);
      } catch (e) {
        offerData.stackRuleConfig = undefined;
      }
    }

    if (typeof offerData.countdownConfig === 'string') {
      try {
        offerData.countdownConfig = JSON.parse(offerData.countdownConfig);
      } catch (e) {
        offerData.countdownConfig = undefined;
      }
    }

    if (typeof offerData.buyXGetYConfig === 'string') {
      try {
        offerData.buyXGetYConfig = JSON.parse(offerData.buyXGetYConfig);
      } catch (e) {
        offerData.buyXGetYConfig = undefined;
      }
    }

    // Parse boolean fields
    if (typeof offerData.isPublic === 'string') {
      offerData.isPublic = offerData.isPublic === 'true';
    }
    
    if (typeof offerData.applicableToAll === 'string') {
      offerData.applicableToAll = offerData.applicableToAll === 'true';
    }

    // Parse numeric fields
    if (typeof offerData.discountValue === 'string') {
      offerData.discountValue = parseFloat(offerData.discountValue);
    }
    
    if (typeof offerData.maxDiscountAmount === 'string') {
      offerData.maxDiscountAmount = parseFloat(offerData.maxDiscountAmount);
    }
    
    if (typeof offerData.minOrderAmount === 'string') {
      offerData.minOrderAmount = parseFloat(offerData.minOrderAmount);
    }
    
    if (typeof offerData.totalUsageLimit === 'string') {
      offerData.totalUsageLimit = parseInt(offerData.totalUsageLimit);
    }
    
    if (typeof offerData.userUsageLimit === 'string') {
      offerData.userUsageLimit = parseInt(offerData.userUsageLimit);
    }
    
    if (typeof offerData.priority === 'string') {
      offerData.priority = parseInt(offerData.priority);
    }
    
    // Validate required fields
    if (!offerData.title || !offerData.type) {
      return res.status(400).json({
        success: false,
        message: 'Title and offer type are required'
      });
    }

    // Handle banner image upload if provided
    if (req.file) {
      // Validate file type
      const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
      if (!allowedMimeTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid file type. Only JPEG, PNG, and WebP images are allowed.'
        });
      }

      // Validate file size (max 5MB)
      const maxSize = 5 * 1024 * 1024; // 5MB
      if (req.file.size > maxSize) {
        return res.status(400).json({
          success: false,
          message: 'File size too large. Maximum size is 5MB.'
        });
      }

      const fileName = req.file.originalname;
      const key = generateOfferBannerKey(offerData.type, fileName);
      
      // Upload will throw error if it fails, caught by outer try-catch
      const uploadResult = await uploadToR2Admin({
        file: req.file.buffer,
        key: key,
        contentType: req.file.mimetype
      });
      
      uploadedBannerUrl = uploadResult.url;
      uploadedFileKey = uploadResult.key;
      offerData.bannerImage = uploadedBannerUrl;
      
      console.log(`Banner image uploaded successfully for ${offerData.type} offer: ${uploadResult.key}`);
    }

    // Create the offer - if this fails, cleanup will run
    const offer = await this.adminOfferService.createOffer(adminId, offerData);

    res.status(201).json({
      success: true,
      message: 'Offer created successfully' + (uploadedBannerUrl ? ' with banner image' : ''),
      data: offer
    });
    
  } catch (error) {
    // Cleanup uploaded image if offer creation failed
    if (uploadedFileKey) {
      try {
        await deleteFromR2Admin(uploadedFileKey);
        console.log('✓ Cleaned up uploaded banner image due to offer creation failure');
      } catch (cleanupError) {
        console.error('✗ Failed to cleanup uploaded image:', cleanupError);
        // Log but don't throw - we want to report the original error
      }
    }
    
    next(error);
  }
};
  getAllOffers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filters: OfferFilters = {
        type: req.query.type as any,
        status: req.query.status as any,
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
        createdByType: req.query.createdByType as any,
        vendorId: req.query.vendorId as string,
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined
      };

      const offers = await this.adminOfferService.getAllOffers(filters);

      res.status(200).json({
        success: true,
        data: offers,
        pagination: {
          page: filters.page || 1,
          limit: filters.limit || 20,
          total: offers.length
        }
      });
    } catch (error) {
      next(error);
    }
  };

  getOfferById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { offerId } = req.params;

      const offer = await this.adminOfferService.getOfferById(offerId);

      if (!offer) {
        return res.status(404).json({
          success: false,
          message: 'Offer not found'
        });
      }

      res.status(200).json({
        success: true,
        data: offer
      });
    } catch (error) {
      next(error);
    }
  };

  updateOffer = async (req: Request, res: Response, next: NextFunction) => {
  let updateData: Partial<CreateOfferDTO> | undefined;
  
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({ 
        success: false, 
        message: 'Unauthorized' 
      });
    }

    const { offerId } = req.params;
    updateData = req.body as Partial<CreateOfferDTO>;

    // Validate offer exists and user has permission
    const existingOffer = await this.adminOfferService.getOfferById(offerId);
    if (!existingOffer) {
      return res.status(404).json({
        success: false,
        message: 'Offer not found'
      });
    }

    // Handle banner image upload if provided
    let uploadedBannerUrl: string | undefined;
    let oldBannerKey: string | null = null;
    
    if (req.file) {
      try {
        // Validate file type
        const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (!allowedMimeTypes.includes(req.file.mimetype)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid file type. Only JPEG, PNG, and WebP images are allowed.'
          });
        }

        // Validate file size (max 5MB)
        const maxSize = 5 * 1024 * 1024; // 5MB
        if (req.file.size > maxSize) {
          return res.status(400).json({
            success: false,
            message: 'File size too large. Maximum size is 5MB.'
          });
        }

        // Store old banner key for cleanup if upload succeeds
        if (existingOffer.bannerImage) {
          oldBannerKey = extractFileKeyFromUrl(existingOffer.bannerImage);
        }

        const fileName = req.file.originalname;
        const key = generateOfferBannerKey(updateData.type || existingOffer.type, fileName);
        
        const uploadResult = await uploadToR2Admin({
          file: req.file.buffer,
          key: key,
          contentType: req.file.mimetype
        });
        
        uploadedBannerUrl = uploadResult.url;
        updateData.bannerImage = uploadedBannerUrl;
        
        console.log(`Banner image uploaded successfully for offer ${offerId}: ${uploadResult.key}`);
        
      } catch (uploadError) {
        console.error('Banner image upload failed:', uploadError);
        return res.status(500).json({
          success: false,
          message: 'Failed to upload banner image. Please try again.'
        });
      }
    }

    // Handle banner image removal if bannerImage is explicitly set to empty string
    if (updateData.bannerImage === '' && existingOffer.bannerImage) {
      try {
        const fileKey = extractFileKeyFromUrl(existingOffer.bannerImage);
        if (fileKey) {
          await deleteFromR2Admin(fileKey);
          console.log(`Removed old banner image for offer ${offerId}: ${fileKey}`);
        }
        updateData.bannerImage = ''; // Ensure it's set to empty string
      } catch (deleteError) {
        console.error('Failed to delete old banner image:', deleteError);
        // Continue with update even if deletion fails
      }
    }

    // Update the offer
    const updatedOffer = await this.adminOfferService.updateOffer(adminId, offerId, updateData);

    // Clean up old banner image if new one was successfully uploaded
    if (uploadedBannerUrl && oldBannerKey) {
      try {
        await deleteFromR2Admin(oldBannerKey);
        console.log(`Cleaned up old banner image after successful update: ${oldBannerKey}`);
      } catch (cleanupError) {
        console.error('Failed to cleanup old banner image:', cleanupError);
        // Don't fail the request if cleanup fails
      }
    }

    res.status(200).json({
      success: true,
      message: 'Offer updated successfully' + (uploadedBannerUrl ? ' with new banner image' : ''),
      data: updatedOffer
    });
    
  } catch (error) {
    // If offer update fails after image upload, clean up the newly uploaded image
    if (updateData?.bannerImage && req.file) {
      try {
        const fileKey = extractFileKeyFromUrl(updateData.bannerImage);
        if (fileKey) {
          await deleteFromR2Admin(fileKey);
          console.log('Cleaned up uploaded banner image due to offer update failure');
        }
      } catch (cleanupError) {
        console.error('Failed to cleanup uploaded image after update failure:', cleanupError);
      }
    }
    next(error);
  }
};

  deleteOffer = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { offerId } = req.params;

      await this.adminOfferService.deleteOffer(adminId, offerId);

      res.status(200).json({
        success: true,
        message: 'Offer deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  };

  createFlashSale = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const flashSaleData = req.body;

      const flashSale = await this.adminOfferService.createFlashSale(adminId, flashSaleData);

      res.status(201).json({
        success: true,
        message: 'Flash sale created successfully',
        data: flashSale
      });
    } catch (error) {
      next(error);
    }
  };

  createSystemVoucher = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const voucherData = req.body;

      const voucher = await this.adminOfferService.createSystemVoucher(adminId, voucherData);

      res.status(201).json({
        success: true,
        message: 'System voucher created successfully',
        data: voucher
      });
    } catch (error) {
      next(error);
    }
  };

  approveVendorOffer = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { offerId } = req.params;
      const { approved } = req.body;

      const offer = await this.adminOfferService.approveVendorOffer(adminId, offerId, approved);

      res.status(200).json({
        success: true,
        message: `Offer ${approved ? 'approved' : 'rejected'} successfully`,
        data: offer
      });
    } catch (error) {
      next(error);
    }
  };

  getOfferAnalytics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { offerId } = req.params;
      const { startDate, endDate } = req.query;

      const dateRange = startDate && endDate ? {
        start: new Date(startDate as string),
        end: new Date(endDate as string)
      } : undefined;

      const analytics = await this.adminOfferService.getOfferAnalytics(offerId, dateRange);

      res.status(200).json({
        success: true,
        data: analytics
      });
    } catch (error) {
      next(error);
    }
  };

  getAllOfferAnalytics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate } = req.query;

      const dateRange = startDate && endDate ? {
        start: new Date(startDate as string),
        end: new Date(endDate as string)
      } : undefined;

      const analytics = await this.adminOfferService.getOfferAnalytics(undefined, dateRange);

      res.status(200).json({
        success: true,
        data: analytics
      });
    } catch (error) {
      next(error);
    }
  };

  // Vendor Permission Management
  getAllVendorPermissions = async (req: Request, res: Response, next: NextFunction) => {
    console.log(req.body)
    try {
      const filters = {
        vendorId: req.query.vendorId as string,
        vendorName: req.query.vendorName as string,
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined
      };

      const permissions = await this.adminOfferService.getAllVendorPermissions(filters);
      console.log(permissions,"per")

      res.status(200).json({
        success: true,
        data: permissions,
        pagination: {
          page: filters.page || 1,
          limit: filters.limit || 20,
          total: permissions.length
        }
      });
    } catch (error) {
      console.log(error,"per")

      next(error);
    }
  };

  getVendorPermissions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vendorId } = req.params;

      const permissions = await this.adminOfferService.getVendorPermissions(vendorId);

      res.status(200).json({
        success: true,
        data: permissions
      });
    } catch (error) {
      next(error);
    }
  };

  updateVendorPermissions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { vendorId } = req.params;
      const updateData = req.body;

      const permissions = await this.adminOfferService.updateVendorPermissions(
        adminId, 
        vendorId, 
        updateData
      );

      res.status(200).json({
        success: true,
        message: 'Vendor permissions updated successfully',
        data: permissions
      });
    } catch (error) {
      next(error);
    }
  };

  bulkUpdateVendorPermissions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { vendorIds, ...updateData } = req.body;

      if (!vendorIds || !Array.isArray(vendorIds)) {
        return res.status(400).json({
          success: false,
          message: 'vendorIds array is required'
        });
      }

      const result = await this.adminOfferService.bulkUpdateVendorPermissions(
        adminId,
        vendorIds,
        updateData
      );

      res.status(200).json({
        success: true,
        message: `Permissions updated for ${result.updated} vendors`,
        data: result
      });
    } catch (error) {
      next(error);
    }
  };

  resetVendorPermissions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { vendorId } = req.params;

      const permissions = await this.adminOfferService.resetVendorPermissions(adminId, vendorId);

      res.status(200).json({
        success: true,
        message: 'Vendor permissions reset to defaults',
        data: permissions
      });
    } catch (error) {
      next(error);
    }
  };

  getVendorPermissionStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await this.adminOfferService.getVendorPermissionStats();

      res.status(200).json({
        success: true,
        data: stats
      });
    } catch (error) {
      next(error);
    }
  };

  searchVendorsForPermissions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { query, limit } = req.query;

      if (!query) {
        return res.status(400).json({
          success: false,
          message: 'Search query is required'
        });
      }

      const vendors = await this.adminOfferService.searchVendorsForPermissions(
        query as string,
        limit ? parseInt(limit as string) : 10
      );

      res.status(200).json({
        success: true,
        data: vendors
      });
    } catch (error) {
      next(error);
    }
  };

  // Admin Reporting
  getOfferPerformanceReport = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filters = {
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
        offerType: req.query.offerType as any,
        vendorId: req.query.vendorId as string
      };

      const report = await this.reportingService.getOfferPerformanceReport(filters);

      res.status(200).json({
        success: true,
        data: report
      });
    } catch (error) {
      next(error);
    }
  };

  getTopPerformingOffers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filters = {
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
        vendorId: req.query.vendorId as string,
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined
      };

      const offers = await this.reportingService.getTopPerformingOffers(filters);

      res.status(200).json({
        success: true,
        data: offers
      });
    } catch (error) {
      next(error);
    }
  };

  getOfferTypeDistribution = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { vendorId } = req.query;

      const distribution = await this.reportingService.getOfferTypeDistribution(vendorId as string);

      res.status(200).json({
        success: true,
        data: distribution
      });
    } catch (error) {
      next(error);
    }
  };
}

// =========================== 
// VENDOR OFFER CONTROLLER
// ===========================

class VendorOfferController {
  private vendorOfferService: VendorOfferService;
  private reportingService: OfferReportingService;

  constructor() {
    this.vendorOfferService = new VendorOfferService();
    this.reportingService = new OfferReportingService();
  }

  createVendorOffer = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const offerData: CreateOfferDTO = req.body;

      const offer = await this.vendorOfferService.createVendorOffer(vendorId, offerData);

      res.status(201).json({
        success: true,
        message: 'Vendor offer created successfully',
        data: offer
      });
    } catch (error) {
      next(error);
    }
  };

  getVendorOffers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const filters: VendorOfferFilters = {
        type: req.query.type as any,
        status: req.query.status as any,
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined
      };

      const offers = await this.vendorOfferService.getVendorOffers(vendorId, filters);

      res.status(200).json({
        success: true,
        data: offers,
        pagination: {
          page: filters.page || 1,
          limit: filters.limit || 20,
          total: offers.length
        }
      });
    } catch (error) {
      next(error);
    }
  };

  getVendorOfferById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { offerId } = req.params;

      const offer = await this.vendorOfferService.getVendorOfferById(vendorId, offerId);

      if (!offer) {
        return res.status(404).json({
          success: false,
          message: 'Offer not found or not owned by vendor'
        });
      }

      res.status(200).json({
        success: true,
        data: offer
      });
    } catch (error) {
      next(error);
    }
  };

  createVendorVoucher = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const voucherData = req.body;

      const voucher = await this.vendorOfferService.createVendorVoucher(vendorId, voucherData);

      res.status(201).json({
        success: true,
        message: 'Vendor voucher created successfully',
        data: voucher
      });
    } catch (error) {
      next(error);
    }
  };

  updateVendorOffer = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { offerId } = req.params;
      const updateData: Partial<CreateOfferDTO> = req.body;

      const offer = await this.vendorOfferService.updateVendorOffer(vendorId, offerId, updateData);

      res.status(200).json({
        success: true,
        message: 'Vendor offer updated successfully',
        data: offer
      });
    } catch (error) {
      next(error);
    }
  };

  deactivateVendorOffer = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { offerId } = req.params;

      const offer = await this.vendorOfferService.deactivateVendorOffer(vendorId, offerId);

      res.status(200).json({
        success: true,
        message: 'Vendor offer deactivated successfully',
        data: offer
      });
    } catch (error) {
      next(error);
    }
  };

  getVendorOfferAnalytics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { offerId } = req.params;

      const analytics = await this.vendorOfferService.getVendorOfferAnalytics(vendorId, offerId);

      res.status(200).json({
        success: true,
        data: analytics
      });
    } catch (error) {
      next(error);
    }
  };

  getVendorPermissions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const permissions = await this.vendorOfferService.checkVendorPermissions(vendorId);

      res.status(200).json({
        success: true,
        data: permissions
      });
    } catch (error) {
      next(error);
    }
  };

  getVendorOffersSummary = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const summary = await this.reportingService.getVendorOffersSummary(vendorId);

      res.status(200).json({
        success: true,
        data: summary
      });
    } catch (error) {
      next(error);
    }
  };

  getVendorTopPerformingOffers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const filters = {
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
        vendorId,
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined
      };

      const offers = await this.reportingService.getTopPerformingOffers(filters);

      res.status(200).json({
        success: true,
        data: offers
      });
    } catch (error) {
      next(error);
    }
  };

  getVendorOfferTypeDistribution = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const distribution = await this.reportingService.getOfferTypeDistribution(vendorId);

      res.status(200).json({
        success: true,
        data: distribution
      });
    } catch (error) {
      next(error);
    }
  };
}

// =========================== 
// CUSTOMER OFFER CONTROLLER
// ===========================

class CustomerOfferController {
  private customerOfferService: CustomerOfferService;
  private validationService: OfferValidationService;
  private usageService: OfferUsageService;

  constructor() {
    this.customerOfferService = new CustomerOfferService();
    this.validationService = new OfferValidationService();
    this.usageService = new OfferUsageService();
  }

  getAvailableOffers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id || 'guest';

      const filters = {
        type: req.query.type as any,
        categoryId: req.query.categoryId as string,
        vendorId: req.query.vendorId as string,
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined
      };

      const offers = await this.customerOfferService.getAvailableOffers(userId, filters);

      res.status(200).json({
        success: true,
        data: offers,
        pagination: {
          page: filters.page || 1,
          limit: filters.limit || 20,
          total: offers.length
        }
      });
    } catch (error) {
      next(error);
    }
  };

  applyVoucherCode = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { code, orderData } = req.body;

      if (!code || !orderData) {
        return res.status(400).json({
          success: false,
          message: 'Voucher code and order data are required'
        });
      }

      const result = await this.customerOfferService.applyVoucherCode(userId, code, orderData);

      res.status(200).json({
        success: true,
        message: result.message,
        data: result
      });
    } catch (error) {
      next(error);
    }
  };

  getActiveCountdownOffers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const offers = await this.customerOfferService.getActiveCountdownOffers();

      res.status(200).json({
        success: true,
        data: offers
      });
    } catch (error) {
      next(error);
    }
  };

  getBuyXGetYOffers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id || 'guest';

      const offers = await this.customerOfferService.getBuyXGetYOffers(userId);

      res.status(200).json({
        success: true,
        data: offers
      });
    } catch (error) {
      next(error);
    }
  };

  validateOfferForOrder = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const { offerId, orderData } = req.body;

      if (!offerId || !orderData) {
        return res.status(400).json({
          success: false,
          message: 'Offer ID and order data are required'
        });
      }

      const validationData: OrderValidationData = {
        userId,
        items: orderData.items,
        subtotal: orderData.subtotal
      };

      const result = await this.validationService.validateOfferForOrder(offerId, validationData);

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  };

  getUserOfferUsageHistory = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ 
          success: false, 
          message: 'Unauthorized' 
        });
      }

      const filters = {
        offerId: req.query.offerId as string,
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined
      };

      const history = await this.usageService.getUserOfferUsageHistory(userId, filters);

      res.status(200).json({
        success: true,
        data: history,
        pagination: {
          page: filters.page || 1,
          limit: filters.limit || 20,
          total: history.length
        }
      });
    } catch (error) {
      next(error);
    }
  };
}

// =========================== 
// PUBLIC OFFER CONTROLLER
// ===========================

class PublicOfferController {
  private customerOfferService: CustomerOfferService;

  constructor() {
    this.customerOfferService = new CustomerOfferService();
  }

  getPublicOffers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filters = {
        type: req.query.type as any,
        categoryId: req.query.categoryId as string,
        vendorId: req.query.vendorId as string,
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined
      };

      const offers = await this.customerOfferService.getAvailableOffers('guest', filters);

      // Filter only public offers for guest users
      const publicOffers = offers.filter(offer => offer.isPublic);

      res.status(200).json({
        success: true,
        data: publicOffers,
        pagination: {
          page: filters.page || 1,
          limit: filters.limit || 20,
          total: publicOffers.length
        }
      });
    } catch (error) {
      next(error);
    }
  };

  getActiveFlashSales = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const offers = await this.customerOfferService.getActiveCountdownOffers();

      res.status(200).json({
        success: true,
        data: offers
      });
    } catch (error) {
      next(error);
    }
  };

  getBuyXGetYOffers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const offers = await this.customerOfferService.getBuyXGetYOffers('guest');

      res.status(200).json({
        success: true,
        data: offers
      });
    } catch (error) {
      next(error);
    }
  };
}

// =========================== 
// OFFER USAGE CONTROLLER
// ===========================

class OfferUsageController {
  private usageService: OfferUsageService;

  constructor() {
    this.usageService = new OfferUsageService();
  }

  recordOfferUsage = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const usageData = req.body;

      if (!usageData.offerId || !usageData.userId || usageData.discountApplied === undefined || !usageData.orderAmount) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: offerId, userId, discountApplied, orderAmount'
        });
      }

      await this.usageService.recordOfferUsage(usageData);

      res.status(201).json({
        success: true,
        message: 'Offer usage recorded successfully'
      });
    } catch (error) {
      next(error);
    }
  };

  getOfferUsageStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { offerId } = req.params;

      const stats = await this.usageService.getOfferUsageStats(offerId);

      res.status(200).json({
        success: true,
        data: stats
      });
    } catch (error) {
      next(error);
    }
  };
}

// =========================== 
// EXPORTS
// ===========================

export {
  AdminOfferController,
  VendorOfferController,
  CustomerOfferController,
  PublicOfferController,
  OfferUsageController
};