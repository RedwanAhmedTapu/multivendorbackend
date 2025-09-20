// controllers/vendor.controller.ts
import type { Request, Response } from 'express';
import { VendorService } from '../services/vendor.service.ts';
import { VendorStatus, PayoutStatus } from '@prisma/client';
import type { 
  CreateVendorRequest, 
  UpdateVendorProfileRequest,
  VendorCommissionRequest,
  VendorPayoutRequest,
  VendorMonthlyChargeRequest,
  VendorOfferRequest,
  VendorFlagRequest,
  VendorFilterQuery,
  BulkCommissionUpdateRequest,
  BulkMonthlyChargeRequest,
  VendorExportOptions
} from '@/types/vendor.types.ts';

export class VendorController {
  private vendorService: VendorService;

  constructor() {
    this.vendorService = new VendorService();
  }

  // Vendor CRUD Operations
  createVendor = async (req: Request, res: Response) => {
    try {
      const data: CreateVendorRequest = req.body;
      const vendor = await this.vendorService.createVendor(data);
      
      res.status(201).json({
        success: true,
        message: 'Vendor created successfully',
        data: vendor
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to create vendor',
        error: error.message
      });
    }
  };

  getVendors = async (req: Request, res: Response) => {
    try {
      const filters: VendorFilterQuery = {
        status: req.query.status as VendorStatus,
        search: req.query.search as string,
        commissionMin: req.query.commissionMin ? parseFloat(req.query.commissionMin as string) : undefined,
        commissionMax: req.query.commissionMax ? parseFloat(req.query.commissionMax as string) : undefined,
        createdFrom: req.query.createdFrom ? new Date(req.query.createdFrom as string) : undefined,
        createdTo: req.query.createdTo ? new Date(req.query.createdTo as string) : undefined,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
        sortBy: req.query.sortBy as any,
        sortOrder: req.query.sortOrder as 'asc' | 'desc'
      };

      const result = await this.vendorService.getVendors(filters);
      
      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendors',
        error: error.message
      });
    }
  };

  getVendorById = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const vendor = await this.vendorService.getVendorById(id);
      
      if (!vendor) {
        return res.status(404).json({
          success: false,
          message: 'Vendor not found'
        });
      }

      res.json({
        success: true,
        data: vendor
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor',
        error: error.message
      });
    }
  };

  updateVendorProfile = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: UpdateVendorProfileRequest = req.body;
      
      const vendor = await this.vendorService.updateVendorProfile(id, data);
      
      res.json({
        success: true,
        message: 'Vendor profile updated successfully',
        data: vendor
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update vendor profile',
        error: error.message
      });
    }
  };

  approveVendor = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const vendor = await this.vendorService.updateVendorStatus(id, VendorStatus.ACTIVE);
      
      res.json({
        success: true,
        message: 'Vendor approved successfully',
        data: vendor
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to approve vendor',
        error: error.message
      });
    }
  };

  suspendVendor = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const vendor = await this.vendorService.updateVendorStatus(id, VendorStatus.SUSPENDED);
      
      res.json({
        success: true,
        message: 'Vendor suspended successfully',
        data: vendor
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to suspend vendor',
        error: error.message
      });
    }
  };

  deactivateVendor = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const vendor = await this.vendorService.updateVendorStatus(id, VendorStatus.DEACTIVATED);
      
      res.json({
        success: true,
        message: 'Vendor deactivated successfully',
        data: vendor
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to deactivate vendor',
        error: error.message
      });
    }
  };

  deleteVendor = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await this.vendorService.deleteVendor(id);
      
      res.json({
        success: true,
        message: 'Vendor deleted successfully'
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to delete vendor',
        error: error.message
      });
    }
  };

  // Commission Management
  setCommissionRate = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: VendorCommissionRequest = req.body;
      
      const vendor = await this.vendorService.setCommissionRate(id, data);
      
      res.json({
        success: true,
        message: 'Commission rate set successfully',
        data: vendor
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to set commission rate',
        error: error.message
      });
    }
  };

  getCommissionHistory = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const history = await this.vendorService.getCommissionHistory(id);
      
      res.json({
        success: true,
        data: history
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch commission history',
        error: error.message
      });
    }
  };

  bulkUpdateCommissions = async (req: Request, res: Response) => {
    try {
      const data: BulkCommissionUpdateRequest = req.body;
      const result = await this.vendorService.bulkUpdateCommissions(data);
      
      res.json({
        success: true,
        message: `Commission rates updated for ${result.updated} vendors`,
        data: result
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update commission rates',
        error: error.message
      });
    }
  };

  // Payout Management
  createPayout = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: VendorPayoutRequest = req.body;
      
      const payout = await this.vendorService.createPayout(id, data);
      
      res.status(201).json({
        success: true,
        message: 'Payout created successfully',
        data: payout
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to create payout',
        error: error.message
      });
    }
  };

  updatePayoutStatus = async (req: Request, res: Response) => {
    try {
      const { payoutId } = req.params;
      const { status, paidAt } = req.body;
      
      const payout = await this.vendorService.updatePayoutStatus(
        payoutId, 
        status as PayoutStatus, 
        paidAt ? new Date(paidAt) : undefined
      );
      
      res.json({
        success: true,
        message: 'Payout status updated successfully',
        data: payout
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update payout status',
        error: error.message
      });
    }
  };

  getVendorPayouts = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const payouts = await this.vendorService.getVendorPayouts(id);
      
      res.json({
        success: true,
        data: payouts
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor payouts',
        error: error.message
      });
    }
  };

  getPayoutSummary = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const summary = await this.vendorService.getPayoutSummary(id);
      
      res.json({
        success: true,
        data: summary
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch payout summary',
        error: error.message
      });
    }
  };

  // Monthly Charges
  setMonthlyCharge = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: VendorMonthlyChargeRequest = req.body;
      
      const charge = await this.vendorService.setMonthlyCharge(id, data);
      
      res.status(201).json({
        success: true,
        message: 'Monthly charge set successfully',
        data: charge
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to set monthly charge',
        error: error.message
      });
    }
  };

  bulkSetMonthlyCharges = async (req: Request, res: Response) => {
    try {
      const data: BulkMonthlyChargeRequest = req.body;
      const result = await this.vendorService.bulkSetMonthlyCharges(data);
      
      res.json({
        success: true,
        message: `Monthly charges set for ${data.vendorIds.length} vendors`,
        data: result
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to set monthly charges',
        error: error.message
      });
    }
  };

  getVendorCharges = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const charges = await this.vendorService.getVendorCharges(id);
      
      res.json({
        success: true,
        data: charges
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor charges',
        error: error.message
      });
    }
  };

  // Promotional Offers
  createOffer = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: VendorOfferRequest = req.body;
      
      const offer = await this.vendorService.createOffer(id, data);
      
      res.status(201).json({
        success: true,
        message: 'Promotional offer created successfully',
        data: offer
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to create promotional offer',
        error: error.message
      });
    }
  };

  getVendorOffers = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const offers = await this.vendorService.getVendorOffers(id);
      
      res.json({
        success: true,
        data: offers
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor offers',
        error: error.message
      });
    }
  };

  toggleOfferStatus = async (req: Request, res: Response) => {
    try {
      const { offerId } = req.params;
      const { isActive } = req.body;
      
      const offer = await this.vendorService.toggleOfferStatus(offerId, isActive);
      
      res.json({
        success: true,
        message: `Offer ${isActive ? 'activated' : 'deactivated'} successfully`,
        data: offer
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to toggle offer status',
        error: error.message
      });
    }
  };

  // Performance Monitoring
  getVendorPerformance = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const performance = await this.vendorService.getVendorPerformance(id);
      
      if (!performance) {
        return res.status(404).json({
          success: false,
          message: 'Performance data not found'
        });
      }

      res.json({
        success: true,
        data: performance
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor performance',
        error: error.message
      });
    }
  };

  updateVendorPerformance = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const performance = await this.vendorService.updateVendorPerformance(id);
      
      res.json({
        success: true,
        message: 'Vendor performance updated successfully',
        data: performance
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update vendor performance',
        error: error.message
      });
    }
  };

  // Fraud Detection
  detectFraud = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const fraudResult = await this.vendorService.detectFraud(id);
      
      res.json({
        success: true,
        data: fraudResult
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to detect fraud',
        error: error.message
      });
    }
  };

  // Flag Management
  flagVendor = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: VendorFlagRequest = req.body;
      
      const flag = await this.vendorService.flagVendor(id, data);
      
      res.status(201).json({
        success: true,
        message: 'Vendor flagged successfully',
        data: flag
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to flag vendor',
        error: error.message
      });
    }
  };

  getVendorFlags = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const flags = await this.vendorService.getVendorFlags(id);
      
      res.json({
        success: true,
        data: flags
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor flags',
        error: error.message
      });
    }
  };

  // Chat/Conversation Management
  getVendorConversations = async (req: Request, res: Response) => {
    try {
      const { vendorId, userId } = req.query;
      
      const conversations = await this.vendorService.getVendorConversations(
        vendorId as string,
        userId as string
      );
      
      res.json({
        success: true,
        data: conversations
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch conversations',
        error: error.message
      });
    }
  };

  getConversationMessages = async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;
      const messages = await this.vendorService.getConversationMessages(conversationId);
      
      res.json({
        success: true,
        data: messages
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch conversation messages',
        error: error.message
      });
    }
  };

  sendMessage = async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;
      const { senderId, content, metadata } = req.body;
      
      const message = await this.vendorService.sendMessage(
        conversationId,
        senderId,
        content,
        metadata
      );
      
      res.status(201).json({
        success: true,
        message: 'Message sent successfully',
        data: message
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to send message',
        error: error.message
      });
    }
  };

  // Export functionality
  exportVendors = async (req: Request, res: Response) => {
    try {
      const options: VendorExportOptions = {
        format: (req.query.format as 'csv' | 'xlsx') || 'csv',
        fields: (req.query.fields as string)?.split(',') || ['storeName', 'email', 'status'],
        filters: {
          status: req.query.status as VendorStatus,
          search: req.query.search as string,
          // ... other filters
        }
      };
      
      const exportData = await this.vendorService.exportVendors(options);
      
      res.json({
        success: true,
        data: exportData,
        count: exportData.length
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to export vendors',
        error: error.message
      });
    }
  };
}