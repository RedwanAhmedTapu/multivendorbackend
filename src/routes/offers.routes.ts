// offers.routes.ts
import { Router } from 'express';
import {
  AdminOfferController,
  VendorOfferController,
  CustomerOfferController,
  PublicOfferController
} from '../controllers/offers.controller.ts';
import { authenticateUser, authorizeRoles } from '../middlewares/auth.middleware.ts';
import { categoryimageUpload } from '../middlewares/up.middleware.ts';

const router = Router();

// Initialize controllers
const adminOfferController = new AdminOfferController();
const vendorOfferController = new VendorOfferController();
const customerOfferController = new CustomerOfferController();
const publicOfferController = new PublicOfferController();

// =========================== 
// PUBLIC ROUTES (No authentication required)
// ===========================

/**
 * @route   GET /api/offers/public
 * @desc    Get all public offers
 * @access  Public
 */
router.get(
  '/admin/vendor-permissions',
  adminOfferController.getAllVendorPermissions
);
router.get('/public', publicOfferController.getPublicOffers);

/**
 * @route   GET /api/offers/flash-sales
 * @desc    Get active flash sales and countdown deals
 * @access  Public
 */
router.get('/flash-sales', publicOfferController.getActiveFlashSales);

// =========================== 
// ADMIN ROUTES - OFFER MANAGEMENT
// ===========================

/**
 * @route   POST /api/offers/admin
 * @desc    Create a new offer (admin)
 * @access  Admin
 */
router.post(
  '/admin',
  authenticateUser,
  authorizeRoles("ADMIN"),
  categoryimageUpload("offer", "ADMIN", undefined, 1, "bannerImage"), 
  adminOfferController.createOffer
);

/**
 * @route   GET /api/offers/admin
 * @desc    Get all offers with filters (admin)
 * @access  Admin
 */
router.get(
  '/admin',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.getAllOffers
);

/**
 * @route   GET /api/offers/admin/:offerId
 * @desc    Get offer by ID (admin)
 * @access  Admin
 */
router.get(
  '/admin/:offerId',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.getOfferById
);

/**
 * @route   PUT /api/offers/admin/:offerId
 * @desc    Update offer (admin)
 * @access  Admin
 */
router.put(
  '/admin/:offerId',
  authenticateUser,
  authorizeRoles("ADMIN"),
  categoryimageUpload("offer", "ADMIN", undefined, 1, "bannerImage"), 
  adminOfferController.updateOffer
);

/**
 * @route   DELETE /api/offers/admin/:offerId
 * @desc    Delete offer (admin)
 * @access  Admin
 */
router.delete(
  '/admin/:offerId',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.deleteOffer
);

/**
 * @route   POST /api/offers/admin/flash-sale
 * @desc    Create flash sale (admin)
 * @access  Admin
 */
router.post(
  '/admin/flash-sale',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.createFlashSale
);

/**
 * @route   POST /api/offers/admin/system-voucher
 * @desc    Create system voucher (admin)
 * @access  Admin
 */
router.post(
  '/admin/system-voucher',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.createSystemVoucher
);

/**
 * @route   PATCH /api/offers/admin/:offerId/approve
 * @desc    Approve or reject vendor offer (admin)
 * @access  Admin
 */
router.patch(
  '/admin/:offerId/approve',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.approveVendorOffer
);

/**
 * @route   GET /api/offers/admin/analytics/:offerId
 * @desc    Get offer analytics by ID (admin)
 * @access  Admin
 */
router.get(
  '/admin/analytics/:offerId',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.getOfferAnalytics
);

/**
 * @route   GET /api/offers/admin/analytics
 * @desc    Get all offers analytics (admin)
 * @access  Admin
 */
router.get(
  '/admin/analytics',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.getAllOfferAnalytics
);

// =========================== 
// ADMIN ROUTES - VENDOR PERMISSION MANAGEMENT
// ===========================

/**
 * @route   GET /api/offers/admin/vendor-permissions
 * @desc    Get all vendor permissions with filters
 * @access  Admin
 */


/**
 * @route   GET /api/offers/admin/vendor-permissions/stats
 * @desc    Get vendor permission statistics
 * @access  Admin
 */
router.get(
  '/admin/vendor-permissions/stats',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.getVendorPermissionStats
);

/**
 * @route   GET /api/offers/admin/vendor-permissions/search
 * @desc    Search vendors for permission management
 * @access  Admin
 */
router.get(
  '/admin/vendor-permissions/search',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.searchVendorsForPermissions
);

/**
 * @route   GET /api/offers/admin/vendor-permissions/:vendorId
 * @desc    Get specific vendor permissions
 * @access  Admin
 */
router.get(
  '/admin/vendor-permissions/:vendorId',
  authenticateUser,
  adminOfferController.getVendorPermissions
);

/**
 * @route   PUT /api/offers/admin/vendor-permissions/:vendorId
 * @desc    Update vendor permissions
 * @access  Admin
 */
router.put(
  '/admin/vendor-permissions/:vendorId',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.updateVendorPermissions
);

/**
 * @route   POST /api/offers/admin/vendor-permissions/bulk-update
 * @desc    Bulk update vendor permissions
 * @access  Admin
 */
router.post(
  '/admin/vendor-permissions/bulk-update',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.bulkUpdateVendorPermissions
);

/**
 * @route   POST /api/offers/admin/vendor-permissions/:vendorId/reset
 * @desc    Reset vendor permissions to defaults
 * @access  Admin
 */
router.post(
  '/admin/vendor-permissions/:vendorId/reset',
  authenticateUser,
  authorizeRoles("ADMIN"),
  adminOfferController.resetVendorPermissions
);

// =========================== 
// VENDOR ROUTES
// ===========================

/**
 * @route   POST /api/offers/vendor
 * @desc    Create vendor offer
 * @access  Vendor
 */
router.post(
  '/vendor',
  authenticateUser,
  authorizeRoles("VENDOR"),
  vendorOfferController.createVendorOffer
);

/**
 * @route   GET /api/offers/vendor
 * @desc    Get all vendor offers
 * @access  Vendor
 */
router.get(
  '/vendor',
  authenticateUser,
  authorizeRoles("VENDOR"),
  vendorOfferController.getVendorOffers
);

/**
 * @route   POST /api/offers/vendor/voucher
 * @desc    Create vendor voucher
 * @access  Vendor
 */
router.post(
  '/vendor/voucher',
  authenticateUser,
  authorizeRoles("VENDOR"),
  vendorOfferController.createVendorVoucher
);

/**
 * @route   PUT /api/offers/vendor/:offerId
 * @desc    Update vendor offer
 * @access  Vendor
 */
router.put(
  '/vendor/:offerId',
  authenticateUser,
  authorizeRoles("VENDOR"),
  vendorOfferController.updateVendorOffer
);

/**
 * @route   PATCH /api/offers/vendor/:offerId/deactivate
 * @desc    Deactivate vendor offer
 * @access  Vendor
 */
router.patch(
  '/vendor/:offerId/deactivate',
  authenticateUser,
  authorizeRoles("VENDOR"),
  vendorOfferController.deactivateVendorOffer
);

/**
 * @route   GET /api/offers/vendor/analytics/:offerId
 * @desc    Get vendor offer analytics
 * @access  Vendor
 */
router.get(
  '/vendor/analytics/:offerId',
  authenticateUser,
  authorizeRoles("VENDOR"),
  vendorOfferController.getVendorOfferAnalytics
);

/**
 * @route   GET /api/offers/vendor/permissions
 * @desc    Get vendor offer permissions
 * @access  Vendor
 */
router.get(
  '/vendor/permissions',
  authenticateUser,
  authorizeRoles("VENDOR"),
  vendorOfferController.getVendorPermissions
);

// =========================== 
// CUSTOMER ROUTES
// ===========================

/**
 * @route   GET /api/offers
 * @desc    Get available offers for customer
 * @access  Private (Customer)
 */
router.get(
  '/',
  authenticateUser,
  customerOfferController.getAvailableOffers
);

/**
 * @route   POST /api/offers/apply-voucher
 * @desc    Apply voucher code to order
 * @access  Private (Customer)
 */
router.post(
  '/apply-voucher',
  authenticateUser,
  customerOfferController.applyVoucherCode
);

/**
 * @route   GET /api/offers/countdown
 * @desc    Get active countdown offers
 * @access  Private (Customer)
 */
router.get(
  '/countdown',
  authenticateUser,
  customerOfferController.getActiveCountdownOffers
);

/**
 * @route   POST /api/offers/validate
 * @desc    Validate offer for order
 * @access  Private (Customer)
 */
router.post(
  '/validate',
  authenticateUser,
  customerOfferController.validateOfferForOrder
);

export default router;