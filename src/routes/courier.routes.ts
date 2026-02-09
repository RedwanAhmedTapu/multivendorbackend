import { Router } from 'express';
import courierController from '../controllers/courier.controller.ts';
// import { authenticateVendor, authenticatePlatformAdmin } from '../middlewares/auth.middleware.ts';

const router = Router();

// ==================== COURIER PROVIDER ROUTES ====================
/**
 * @route   GET /api/courier/admin/providers
 * @desc    Get all courier providers with credentials
 * @access  Platform Admin
 */
router.get(
  '/admin/providers',
  // authenticatePlatformAdmin,
  courierController.getCourierProviders.bind(courierController)
);

/**
 * @route   GET /api/courier/admin/providers/:providerId
 * @desc    Get single courier provider by ID
 * @access  Platform Admin
 */
router.get(
  '/admin/providers/:providerId',
  // authenticatePlatformAdmin,
  courierController.getCourierProviderById.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/providers
 * @desc    Create new courier provider
 * @access  Platform Admin
 */
router.post(
  '/admin/providers',
  // authenticatePlatformAdmin,
  courierController.createCourierProvider.bind(courierController)
);

/**
 * @route   PUT /api/courier/admin/providers/:providerId
 * @desc    Update courier provider
 * @access  Platform Admin
 */
router.put(
  '/admin/providers/:providerId',
  // authenticatePlatformAdmin,
  courierController.updateCourierProvider.bind(courierController)
);

/**
 * @route   DELETE /api/courier/admin/providers/:providerId
 * @desc    Delete courier provider
 * @access  Platform Admin
 */
router.delete(
  '/admin/providers/:providerId',
  // authenticatePlatformAdmin,
  courierController.deleteCourierProvider.bind(courierController)
);

/**
 * @route   PATCH /api/courier/admin/providers/:providerId/toggle
 * @desc    Toggle courier provider active status
 * @access  Platform Admin
 */
router.patch(
  '/admin/providers/:providerId/toggle',
  // authenticatePlatformAdmin,
  courierController.toggleProviderStatus.bind(courierController)
);

// ==================== COURIER CREDENTIALS ROUTES ====================
/**
 * @route   GET /api/courier/admin/credentials
 * @desc    Get all courier credentials
 * @access  Platform Admin
 */
router.get(
  '/admin/credentials',
  // authenticatePlatformAdmin,
  courierController.getAllCredentials.bind(courierController)
);

/**
 * @route   GET /api/courier/admin/credentials/:credentialId
 * @desc    Get single credential by ID
 * @access  Platform Admin
 */
router.get(
  '/admin/credentials/:credentialId',
  // authenticatePlatformAdmin,
  courierController.getCredentialById.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/credentials
 * @desc    Create platform courier credentials
 * @access  Platform Admin
 */
router.post(
  '/admin/credentials',
  // authenticatePlatformAdmin,
  courierController.createCourierCredentials.bind(courierController)
);

/**
 * @route   PUT /api/courier/admin/credentials/:credentialId
 * @desc    Update platform courier credentials
 * @access  Platform Admin
 */
router.put(
  '/admin/credentials/:credentialId',
  // authenticatePlatformAdmin,
  courierController.updateCourierCredentials.bind(courierController)
);

/**
 * @route   DELETE /api/courier/admin/credentials/:credentialId
 * @desc    Delete platform courier credentials
 * @access  Platform Admin
 */
router.delete(
  '/admin/credentials/:credentialId',
  // authenticatePlatformAdmin,
  courierController.deleteCourierCredentials.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/credentials/:credentialId/test
 * @desc    Test courier credentials
 * @access  Platform Admin
 */
router.post(
  '/admin/credentials/:credentialId/test',
  // authenticatePlatformAdmin,
  courierController.testCourierCredentials.bind(courierController)
);

/**
 * @route   PATCH /api/courier/admin/credentials/:credentialId/toggle
 * @desc    Toggle credential active status
 * @access  Platform Admin
 */
router.patch(
  '/admin/credentials/:credentialId/toggle',
  // authenticatePlatformAdmin,
  courierController.toggleCredentialStatus.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/credentials/:credentialId/refresh-token
 * @desc    Refresh OAuth token for credential
 * @access  Platform Admin
 */
router.post(
  '/admin/credentials/:credentialId/refresh-token',
  // authenticatePlatformAdmin,
  courierController.refreshCredentialToken.bind(courierController)
);

// ==================== SERVICEABLE AREAS ROUTES ====================
/**
 * @route   POST /api/courier/admin/serviceable-areas/sync
 * @desc    Sync serviceable areas for a courier provider
 * @access  Platform Admin
 */
router.post(
  '/admin/serviceable-areas/sync',
  // authenticatePlatformAdmin,
  courierController.syncServiceableAreas.bind(courierController)
);

/**
 * @route   GET /api/courier/admin/serviceable-areas
 * @desc    Get serviceable areas with filters
 * @access  Platform Admin
 */
router.get(
  '/admin/serviceable-areas',
  // authenticatePlatformAdmin,
  courierController.getServiceableAreas.bind(courierController)
);

/**
 * @route   DELETE /api/courier/admin/serviceable-areas/:areaId
 * @desc    Delete serviceable area
 * @access  Platform Admin
 */
router.delete(
  '/admin/serviceable-areas/:areaId',
  // authenticatePlatformAdmin,
  courierController.deleteServiceableArea.bind(courierController)
);

// ==================== PATHAO SPECIFIC ROUTES ====================
/**
 * @route   GET /api/courier/admin/pathao/cities
 * @desc    Get Pathao cities for area mapping
 * @access  Platform Admin
 */
router.get(
  '/admin/pathao/cities',
  // authenticatePlatformAdmin,
  courierController.pathaoGetCities.bind(courierController)
);

/**
 * @route   GET /api/courier/admin/pathao/cities/:cityId/zones
 * @desc    Get Pathao zones for a city
 * @access  Platform Admin
 */
router.get(
  '/admin/pathao/cities/:cityId/zones',
  // authenticatePlatformAdmin,
  courierController.pathaoGetZones.bind(courierController)
);

/**
 * @route   GET /api/courier/admin/pathao/zones/:zoneId/areas
 * @desc    Get Pathao areas for a zone
 * @access  Platform Admin
 */
router.get(
  '/admin/pathao/zones/:zoneId/areas',
  // authenticatePlatformAdmin,
  courierController.pathaoGetAreas.bind(courierController)
);

/**
 * @route   GET /api/courier/admin/pathao/stores
 * @desc    Get Pathao stores
 * @access  Platform Admin
 */
router.get(
  '/admin/pathao/stores',
  // authenticatePlatformAdmin,
  courierController.pathaoGetStores.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/pathao/stores
 * @desc    Create Pathao store
 * @access  Platform Admin
 */
router.post(
  '/admin/pathao/stores',
  // authenticatePlatformAdmin,
  courierController.pathaoCreateStore.bind(courierController)
);

// ==================== REDX SPECIFIC ROUTES ====================
/**
 * @route   GET /api/courier/admin/redx/areas
 * @desc    Get RedX delivery areas
 * @access  Platform Admin
 */
router.get(
  '/admin/redx/areas',
  // authenticatePlatformAdmin,
  courierController.redxGetAreas.bind(courierController)
);

/**
 * @route   GET /api/courier/admin/redx/stores
 * @desc    Get RedX pickup stores
 * @access  Platform Admin
 */
router.get(
  '/admin/redx/stores',
  // authenticatePlatformAdmin,
  courierController.redxGetPickupStores.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/redx/stores
 * @desc    Create RedX pickup store
 * @access  Platform Admin
 */
router.post(
  '/admin/redx/stores',
  // authenticatePlatformAdmin,
  courierController.redxCreatePickupStore.bind(courierController)
);

// ==================== ORDER PLACEMENT ROUTES ====================
/**
 * @route   POST /api/courier/orders/create
 * @desc    Create courier order (Platform automatically creates when customer orders)
 * @access  Internal/Platform
 */
router.post(
  '/orders/create',
  // authenticatePlatform,
  courierController.createCourierOrder.bind(courierController)
);

/**
 * @route   POST /api/courier/quote
 * @desc    Get courier pricing quote for checkout
 * @access  Public (during checkout)
 */
router.post(
  '/quote',
  courierController.getCourierQuote.bind(courierController)
);

// ==================== VENDOR ROUTES ====================
/**
 * @route   POST /api/courier/vendor/orders/:orderId/ready
 * @desc    Vendor marks order as ready for pickup
 * @access  Vendor
 */
router.post(
  '/vendor/orders/:orderId/ready',
  // authenticateVendor,
  courierController.vendorMarkReadyForPickup.bind(courierController)
);

/**
 * @route   GET /api/courier/vendor/orders/:orderId/label
 * @desc    Get shipping label for vendor to print
 * @access  Vendor
 */
router.get(
  '/vendor/orders/:orderId/label',
  // authenticateVendor,
  courierController.getShippingLabel.bind(courierController)
);

/**
 * @route   GET /api/courier/vendor/orders
 * @desc    Get vendor's courier orders
 * @access  Vendor
 */
router.get(
  '/vendor/orders',
  // authenticateVendor,
  courierController.getVendorCourierOrders.bind(courierController)
);

// ==================== TRACKING ROUTES ====================
/**
 * @route   GET /api/courier/track/:trackingId
 * @desc    Track order by tracking ID (Public)
 * @access  Public
 */
router.get(
  '/track/:trackingId',
  courierController.trackOrder.bind(courierController)
);

/**
 * @route   GET /api/courier/orders/:orderId
 * @desc    Get courier orders by order ID (Internal)
 * @access  Internal/Platform
 */
router.get(
  '/orders/:orderId',
  // authenticate,
  courierController.getCourierOrdersByOrderId.bind(courierController)
);

/**
 * @route   GET /api/courier/orders/pathao/:consignmentId
 * @desc    Get detailed Pathao order info
 * @access  Internal/Platform
 */
router.get(
  '/orders/pathao/:consignmentId',
  // authenticate,
  courierController.pathaoGetOrderInfo.bind(courierController)
);

/**
 * @route   GET /api/courier/orders/redx/:trackingId/track
 * @desc    Get detailed RedX tracking info
 * @access  Internal/Platform
 */
router.get(
  '/orders/redx/:trackingId/track',
  // authenticate,
  courierController.redxTrackParcel.bind(courierController)
);

// ==================== WEBHOOK ROUTES ====================
/**
 * @route   POST /api/courier/webhook/pathao
 * @desc    Webhook endpoint for Pathao status updates
 * @access  Public (with signature verification)
 */
router.post(
  '/webhook/pathao',
  courierController.pathaoWebhook.bind(courierController)
);

/**
 * @route   POST /api/courier/webhook/redx
 * @desc    Webhook endpoint for RedX status updates
 * @access  Public (with signature verification)
 */
router.post(
  '/webhook/redx',
  courierController.redxWebhook.bind(courierController)
);

export default router;