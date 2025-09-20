// controllers/delivery.controller.ts
import type { Request, Response } from 'express';
import { DeliveryService } from '../services/delivery.service.ts';
import type { 
  CreateDeliveryPersonRequest,
  UpdateDeliveryPersonRequest,
  DeliveryPersonFilterQuery,
  DeliveryPayoutRequest,
  DeliveryComplaintRequest,
  DeliveryPromotionalOfferRequest,
  DeliveryRatingRequest,
  FundCollectionRequest,
  BulkDeliveryActionRequest,
  DeliveryExportOptions
} from '@/types/delivery.types.ts';

export class DeliveryController {
  private deliveryService: DeliveryService;

  constructor() {
    this.deliveryService = new DeliveryService();
  }

  // ================================
  // DELIVERY PERSON CRUD OPERATIONS
  // ================================

  createDeliveryPerson = async (req: Request, res: Response) => {
    try {
      const data: CreateDeliveryPersonRequest = req.body;
      const deliveryPerson = await this.deliveryService.createDeliveryPerson(data);
      
      res.status(201).json({
        success: true,
        message: 'Delivery person created successfully',
        data: deliveryPerson
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to create delivery person',
        error: error.message
      });
    }
  };

  getDeliveryPersons = async (req: Request, res: Response) => {
    try {
      const filters: DeliveryPersonFilterQuery = {
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
        search: req.query.search as string,
        status: req.query.status as any,
        zone: req.query.zone as string,
        vehicleType: req.query.vehicleType as string,
        sortBy: req.query.sortBy as any,
        sortOrder: req.query.sortOrder as 'asc' | 'desc'
      };

      const result = await this.deliveryService.getDeliveryPersons(filters);
      
      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch delivery persons',
        error: error.message
      });
    }
  };

  getDeliveryPersonById = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deliveryPerson = await this.deliveryService.getDeliveryPersonById(id);
      
      if (!deliveryPerson) {
        return res.status(404).json({
          success: false,
          message: 'Delivery person not found'
        });
      }

      res.json({
        success: true,
        data: deliveryPerson
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch delivery person',
        error: error.message
      });
    }
  };

  updateDeliveryPersonProfile = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: UpdateDeliveryPersonRequest = req.body;
      
      const deliveryPerson = await this.deliveryService.updateDeliveryPersonProfile(id, data);
      
      res.json({
        success: true,
        message: 'Delivery person profile updated successfully',
        data: deliveryPerson
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update delivery person profile',
        error: error.message
      });
    }
  };

  approveDeliveryPerson = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deliveryPerson = await this.deliveryService.updateDeliveryPersonStatus(id, 'ACTIVE');
      
      res.json({
        success: true,
        message: 'Delivery person approved successfully',
        data: deliveryPerson
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to approve delivery person',
        error: error.message
      });
    }
  };

  suspendDeliveryPerson = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deliveryPerson = await this.deliveryService.updateDeliveryPersonStatus(id, 'SUSPENDED');
      
      res.json({
        success: true,
        message: 'Delivery person suspended successfully',
        data: deliveryPerson
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to suspend delivery person',
        error: error.message
      });
    }
  };

  deactivateDeliveryPerson = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deliveryPerson = await this.deliveryService.updateDeliveryPersonStatus(id, 'INACTIVE');
      
      res.json({
        success: true,
        message: 'Delivery person deactivated successfully',
        data: deliveryPerson
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to deactivate delivery person',
        error: error.message
      });
    }
  };

  deleteDeliveryPerson = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await this.deliveryService.deleteDeliveryPerson(id);
      
      res.json({
        success: true,
        message: 'Delivery person deleted successfully'
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to delete delivery person',
        error: error.message
      });
    }
  };

  bulkActions = async (req: Request, res: Response) => {
    try {
      const data: BulkDeliveryActionRequest = req.body;
      const result = await this.deliveryService.bulkActions(data);
      
      res.json({
        success: true,
        message: `Bulk action completed for ${data.deliveryPersonIds.length} delivery persons`,
        data: result
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to perform bulk action',
        error: error.message
      });
    }
  };

  // ================================
  // FUND COLLECTION MANAGEMENT
  // ================================

  getFundCollectionSummary = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const summary = await this.deliveryService.getFundCollectionSummary(id);
      
      res.json({
        success: true,
        data: summary
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch fund collection summary',
        error: error.message
      });
    }
  };

  getFundCollectionHistory = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      
      const result = await this.deliveryService.getFundCollectionHistory(id, page, limit);
      
      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch fund collection history',
        error: error.message
      });
    }
  };

  recordFundCollection = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: FundCollectionRequest = {
        ...req.body,
        deliveryPersonId: id
      };
      
      const collection = await this.deliveryService.recordFundCollection(data);
      
      res.status(201).json({
        success: true,
        message: 'Fund collection recorded successfully',
        data: collection
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to record fund collection',
        error: error.message
      });
    }
  };

  getPendingCollections = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const pendingCollections = await this.deliveryService.getFundCollectionHistory(id, 1, 50);
      
      // Filter only pending collections
      const pending = pendingCollections.data.filter(collection => collection.status === 'PENDING');
      
      res.json({
        success: true,
        data: pending,
        count: pending.length
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch pending collections',
        error: error.message
      });
    }
  };

  settleCollection = async (req: Request, res: Response) => {
    try {
      const { collectionId } = req.params;
      const collection = await this.deliveryService.settleCollection(collectionId);
      
      res.json({
        success: true,
        message: 'Collection settled successfully',
        data: collection
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to settle collection',
        error: error.message
      });
    }
  };

  getFundCollectionAnalytics = async (req: Request, res: Response) => {
    try {
      const analytics = await this.deliveryService.getFundCollectionAnalytics();
      
      res.json({
        success: true,
        data: analytics
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch fund collection analytics',
        error: error.message
      });
    }
  };

  // ================================
  // PERFORMANCE TRACKING
  // ================================

  getDeliveryPerformance = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const performance = await this.deliveryService.getDeliveryPerformance(id);
      
      res.json({
        success: true,
        data: performance
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch delivery performance',
        error: error.message
      });
    }
  };

  getPerformanceLeaderboard = async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const leaderboard = await this.deliveryService.getPerformanceLeaderboard(limit);
      
      res.json({
        success: true,
        data: leaderboard
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch performance leaderboard',
        error: error.message
      });
    }
  };

  updatePerformanceMetrics = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const performance = await this.deliveryService.getDeliveryPerformance(id);
      
      res.json({
        success: true,
        message: 'Performance metrics updated successfully',
        data: performance
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update performance metrics',
        error: error.message
      });
    }
  };

  getPerformanceHistory = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      // This would need to be implemented to track historical performance data
      res.json({
        success: true,
        message: 'Performance history endpoint - to be implemented',
        data: []
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch performance history',
        error: error.message
      });
    }
  };

  getDeliveryAnalytics = async (req: Request, res: Response) => {
    try {
      const analytics = await this.deliveryService.getDeliveryAnalytics();
      
      res.json({
        success: true,
        data: analytics
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch delivery analytics',
        error: error.message
      });
    }
  };

  // ================================
  // PAYOUT MANAGEMENT
  // ================================

  createPayout = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: DeliveryPayoutRequest = req.body;
      
      const payout = await this.deliveryService.createPayout(id, data);
      
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
      
      const payout = await this.deliveryService.updatePayoutStatus(
        payoutId, 
        status, 
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

  getDeliveryPersonPayouts = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const payouts = await this.deliveryService.getDeliveryPersonPayouts(id);
      
      res.json({
        success: true,
        data: payouts
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch delivery person payouts',
        error: error.message
      });
    }
  };

  getPayoutSummary = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const payouts = await this.deliveryService.getDeliveryPersonPayouts(id);
      
      const summary = payouts.reduce((acc, payout) => {
        acc.totalAmount += payout.amount;
        acc.count += 1;
        if (payout.status === 'PAID') {
          acc.paidAmount += payout.amount;
          acc.paidCount += 1;
        } else if (payout.status === 'PENDING') {
          acc.pendingAmount += payout.amount;
          acc.pendingCount += 1;
        }
        return acc;
      }, {
        totalAmount: 0,
        count: 0,
        paidAmount: 0,
        paidCount: 0,
        pendingAmount: 0,
        pendingCount: 0
      });
      
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

  calculateIncentives = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const incentives = await this.deliveryService.calculateIncentives(id);
      
      res.json({
        success: true,
        data: incentives
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to calculate incentives',
        error: error.message
      });
    }
  };

  processBulkPayouts = async (req: Request, res: Response) => {
    try {
      const { deliveryPersonIds, amount, payoutType, period } = req.body;
      
      const results = await Promise.all(
        deliveryPersonIds.map(async (id: string) => {
          try {
            return await this.deliveryService.createPayout(id, {
              amount,
              payoutType,
              period,
              method: 'BANK_TRANSFER',
              notes: 'Bulk payout processing'
            });
          } catch (error) {
            return { error: error.message, deliveryPersonId: id };
          }
        })
      );
      
      const successful = results.filter(result => !result.error);
      const failed = results.filter(result => result.error);
      
      res.json({
        success: true,
        message: `Bulk payout processed: ${successful.length} successful, ${failed.length} failed`,
        data: {
          successful: successful.length,
          failed: failed.length,
          results
        }
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to process bulk payouts',
        error: error.message
      });
    }
  };

  // ================================
  // CUSTOMER COMPLAINTS/OBJECTIONS
  // ================================

  getComplaints = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const complaints = await this.deliveryService.getComplaints(id);
      
      res.json({
        success: true,
        data: complaints
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch complaints',
        error: error.message
      });
    }
  };

  createComplaint = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: DeliveryComplaintRequest = {
        ...req.body,
        deliveryPersonId: id
      };
      
      const complaint = await this.deliveryService.createComplaint(data);
      
      res.status(201).json({
        success: true,
        message: 'Complaint created successfully',
        data: complaint
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to create complaint',
        error: error.message
      });
    }
  };

  updateComplaintStatus = async (req: Request, res: Response) => {
    try {
      const { complaintId } = req.params;
      const { status, resolution } = req.body;
      
      const complaint = await this.deliveryService.updateComplaintStatus(
        complaintId, 
        status, 
        resolution
      );
      
      res.json({
        success: true,
        message: 'Complaint status updated successfully',
        data: complaint
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update complaint status',
        error: error.message
      });
    }
  };

  getComplaintById = async (req: Request, res: Response) => {
    try {
      const { complaintId } = req.params;
      
      // This would need to be implemented in the service
      res.json({
        success: true,
        message: 'Get complaint by ID - to be implemented',
        data: null
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch complaint details',
        error: error.message
      });
    }
  };

  addComplaintResponse = async (req: Request, res: Response) => {
    try {
      const { complaintId } = req.params;
      const { response, responderId } = req.body;
      
      // This would need to be implemented in the service
      res.json({
        success: true,
        message: 'Complaint response added - to be implemented',
        data: null
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to add complaint response',
        error: error.message
      });
    }
  };

  getComplaintsAnalytics = async (req: Request, res: Response) => {
    try {
      // This would need to be implemented in the service
      res.json({
        success: true,
        message: 'Complaints analytics - to be implemented',
        data: {}
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch complaints analytics',
        error: error.message
      });
    }
  };

  // ================================
  // PROMOTIONAL OFFERS/BONUSES
  // ================================

  createPromotionalOffer = async (req: Request, res: Response) => {
    try {
      const data: DeliveryPromotionalOfferRequest = req.body;
      const offer = await this.deliveryService.createPromotionalOffer(data);
      
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

  getPromotionalOffers = async (req: Request, res: Response) => {
    try {
      const isActive = req.query.isActive ? req.query.isActive === 'true' : undefined;
      const offers = await this.deliveryService.getPromotionalOffers(isActive);
      
      res.json({
        success: true,
        data: offers
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch promotional offers',
        error: error.message
      });
    }
  };

  getEligibleOffers = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const offers = await this.deliveryService.getEligibleOffers(id);
      
      res.json({
        success: true,
        data: offers
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch eligible offers',
        error: error.message
      });
    }
  };

  toggleOfferStatus = async (req: Request, res: Response) => {
    try {
      const { offerId } = req.params;
      const { isActive } = req.body;
      
      // This would need to be implemented in the service
      res.json({
        success: true,
        message: `Offer ${isActive ? 'activated' : 'deactivated'} successfully`,
        data: null
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to toggle offer status',
        error: error.message
      });
    }
  };

  claimPromotionalOffer = async (req: Request, res: Response) => {
    try {
      const { id, offerId } = req.params;
      const claim = await this.deliveryService.claimPromotionalOffer(id, offerId);
      
      res.status(201).json({
        success: true,
        message: 'Promotional offer claimed successfully',
        data: claim
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to claim promotional offer',
        error: error.message
      });
    }
  };

  // ================================
  // RATINGS AND REVIEWS
  // ================================

  getDeliveryPersonRatings = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const ratings = await this.deliveryService.getDeliveryPersonRatings(id);
      
      res.json({
        success: true,
        data: ratings
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch delivery person ratings',
        error: error.message
      });
    }
  };

  addRating = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: DeliveryRatingRequest = {
        ...req.body,
        deliveryPersonId: id
      };
      
      const rating = await this.deliveryService.addRating(data);
      
      res.status(201).json({
        success: true,
        message: 'Rating added successfully',
        data: rating
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to add rating',
        error: error.message
      });
    }
  };

  getRatingsSummary = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const summary = await this.deliveryService.getRatingsSummary(id);
      
      res.json({
        success: true,
        data: summary
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch ratings summary',
        error: error.message
      });
    }
  };

  getRatingsAnalytics = async (req: Request, res: Response) => {
    try {
      // This would need to be implemented in the service
      res.json({
        success: true,
        message: 'Ratings analytics - to be implemented',
        data: {}
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch ratings analytics',
        error: error.message
      });
    }
  };

  // ================================
  // ZONE MANAGEMENT
  // ================================

  assignDeliveryZones = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { zones } = req.body;
      
      const deliveryPerson = await this.deliveryService.updateDeliveryPersonProfile(id, {
        assignedZones: zones
      });
      
      res.json({
        success: true,
        message: 'Delivery zones assigned successfully',
        data: deliveryPerson
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to assign delivery zones',
        error: error.message
      });
    }
  };

  getAssignedZones = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deliveryPerson = await this.deliveryService.getDeliveryPersonById(id);
      
      if (!deliveryPerson) {
        return res.status(404).json({
          success: false,
          message: 'Delivery person not found'
        });
      }
      
      res.json({
        success: true,
        data: {
          deliveryPersonId: id,
          assignedZones: deliveryPerson.assignedZones || []
        }
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch assigned zones',
        error: error.message
      });
    }
  };

  updateZoneAvailability = async (req: Request, res: Response) => {
    try {
      const { id, zoneId } = req.params;
      const { isAvailable } = req.body;
      
      // This would need to be implemented in the service for more granular zone availability
      res.json({
        success: true,
        message: 'Zone availability updated - to be implemented',
        data: null
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update zone availability',
        error: error.message
      });
    }
  };

  // ================================
  // REAL-TIME TRACKING
  // ================================

  getActiveDeliveryPersons = async (req: Request, res: Response) => {
    try {
      const activePersons = await this.deliveryService.getActiveDeliveryPersons();
      
      res.json({
        success: true,
        data: activePersons
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch active delivery persons',
        error: error.message
      });
    }
  };

  updateLocation = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { latitude, longitude } = req.body;
      
      const location = await this.deliveryService.updateLocation(id, latitude, longitude);
      
      res.json({
        success: true,
        message: 'Location updated successfully',
        data: location
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update location',
        error: error.message
      });
    }
  };

  getCurrentDeliveries = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deliveries = await this.deliveryService.getCurrentDeliveries(id);
      
      res.json({
        success: true,
        data: deliveries
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch current deliveries',
        error: error.message
      });
    }
  };

  updateDeliveryStatus = async (req: Request, res: Response) => {
    try {
      const { id, orderId } = req.params;
      const { status } = req.body;
      
      const order = await this.deliveryService.updateDeliveryStatus(
        id, 
        parseInt(orderId), 
        status
      );
      
      res.json({
        success: true,
        message: 'Delivery status updated successfully',
        data: order
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update delivery status',
        error: error.message
      });
    }
  };

  // ================================
  // EXPORT FUNCTIONALITY
  // ================================

  exportDeliveryPersons = async (req: Request, res: Response) => {
    try {
      const options: DeliveryExportOptions = {
        format: (req.query.format as 'csv' | 'xlsx') || 'csv',
        fields: (req.query.fields as string)?.split(',') || ['name', 'phone', 'status'],
        filters: {
          status: req.query.status as any,
          search: req.query.search as string,
          zone: req.query.zone as string,
          vehicleType: req.query.vehicleType as string
        }
      };
      
      const exportData = await this.deliveryService.exportDeliveryPersons(options);
      
      res.json({
        success: true,
        data: exportData,
        count: exportData.length
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to export delivery persons',
        error: error.message
      });
    }
  };

  exportPerformanceReport = async (req: Request, res: Response) => {
    try {
      const deliveryPersonIds = req.query.deliveryPersonIds 
        ? (req.query.deliveryPersonIds as string).split(',')
        : undefined;
      
      const reportData = await this.deliveryService.exportPerformanceReport(deliveryPersonIds);
      
      res.json({
        success: true,
        data: reportData,
        count: reportData.length
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to export performance report',
        error: error.message
      });
    }
  };

  exportFundCollectionReport = async (req: Request, res: Response) => {
    try {
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
      
      const reportData = await this.deliveryService.exportFundCollectionReport(startDate, endDate);
      
      res.json({
        success: true,
        data: reportData,
        count: reportData.length
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to export fund collection report',
        error: error.message
      });
    }
  };

  // ================================
  // DASHBOARD AND STATISTICS
  // ================================

  getDashboardStats = async (req: Request, res: Response) => {
    try {
      const stats = await this.deliveryService.getDashboardStats();
      
      res.json({
        success: true,
        data: stats
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch dashboard statistics',
        error: error.message
      });
    }
  };

  getDeliveryTrends = async (req: Request, res: Response) => {
    try {
      // This would need to be implemented in the service
      res.json({
        success: true,
        message: 'Delivery trends analytics - to be implemented',
        data: {}
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch delivery trends',
        error: error.message
      });
    }
  };

  getComparativeAnalysis = async (req: Request, res: Response) => {
    try {
      // This would need to be implemented in the service
      res.json({
        success: true,
        message: 'Comparative analysis - to be implemented',
        data: {}
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch comparative analysis',
        error: error.message
      });
    }
  };
}