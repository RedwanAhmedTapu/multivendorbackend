import { Router, type Request, type Response } from 'express';
import courierController from '../controllers/courier.controller.ts';
import { authenticateUser, authorizeRoles } from '../middlewares/auth.middleware.ts';
import { blockVendorEmployees, requireVendorScope } from '../middlewares/permission.middleware.ts';
// 1C-11 (B3): the real webhook pipeline — provider verification, provider
// payload normalization, then the admin status-processing handler.
import { verifyPathaoSignature, verifyRedxToken } from '../middlewares/webhook.middleware.ts';
import { normalizePathaoWebhook, normalizeRedxWebhook } from '../middlewares/courier-normalizer.middleware.ts';
import { AdminOrderController } from '../controllers/admin.order.controller.ts';

const router = Router();

/** Phase 0: bulk Steadfast booking is disabled (410) — it has no booking intent. */
function bulkBookingDisabled(_req: Request, res: Response) {
  res.status(410).json({
    success: false,
    code: 'BULK_BOOKING_DISABLED',
    message: 'Bulk courier booking is disabled. Each shipment must be booked through its own booking intent.',
  });
}

// ==================== 1C-11 (B1) ACCESS CONTROL ====================
// Classification of this router's surface:
//   - /webhook/pathao, /webhook/redx  → D. PROVIDER WEBHOOK (verified via
//     X-PATHAO-Signature / callback token against the DB-stored credential
//     secret — application JWTs do not apply to provider callbacks)
//   - everything else                 → C. ADMIN/EMPLOYEE ONLY
//     (provider config, credential management, courier booking ops, tracking)
// The single guard below enforces that for every non-webhook route; the two
// webhook routes opt out via the path check and carry their own provider
// verification middlewares at their definitions.
//
// Phase 0 (courier booking safety) — per-route groups on top of that guard:
//   A. admin only (33): `blockVendorEmployees` — vendor staff get 403
//      (provider/credential/area/store admin, Steadfast tools, quote,
//      tracking and order lookups, which have no vendor scoping)
//   B. vendor staff allowed (6): /admin/warehouse-pickups/* and /orders/create
//      — unchanged; their services/controllers enforce vendor ownership
//   C. vendor routes (3): `requireVendorScope` — vendor staff only, scoped to
//      the authenticated vendor (never a client-supplied vendorId)
//   D. webhooks (2): unchanged
router.use((req, res, next) => {
  if (req.path.startsWith('/webhook/')) return next();
  return authenticateUser(req, res, (err?: unknown) => {
    if (err) return next(err);
    authorizeRoles('ADMIN', 'EMPLOYEE')(req, res, next);
  });
});

// ==================== COURIER PROVIDER ROUTES ====================
/**
 * @route   GET /api/courier/admin/providers
 * @desc    Get all courier providers with credentials
 * @access  Platform Admin
 */
router.get(
  '/admin/providers',
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
  // authenticatePlatformAdmin,
  courierController.deleteServiceableArea.bind(courierController)
);

// ==================== COURIER PRICING RULES ROUTES ====================
/**
 * @route   GET /api/courier/admin/pricing-rules
 * @desc    Get courier pricing rules with filters and pagination
 * @access  Platform Admin
 */
router.get(
  '/admin/pricing-rules',
  blockVendorEmployees,
  courierController.listPricingRules.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/pricing-rules
 * @desc    Create new platform courier pricing rule
 * @access  Platform Admin
 */
router.post(
  '/admin/pricing-rules',
  blockVendorEmployees,
  courierController.createPricingRule.bind(courierController)
);

/**
 * @route   PUT /api/courier/admin/pricing-rules/:id
 * @desc    Update courier pricing rule
 * @access  Platform Admin
 */
router.put(
  '/admin/pricing-rules/:id',
  blockVendorEmployees,
  courierController.updatePricingRule.bind(courierController)
);

/**
 * @route   PATCH /api/courier/admin/pricing-rules/:id/toggle
 * @desc    Toggle courier pricing rule active status
 * @access  Platform Admin
 */
router.patch(
  '/admin/pricing-rules/:id/toggle',
  blockVendorEmployees,
  courierController.togglePricingRule.bind(courierController)
);

/**
 * @route   DELETE /api/courier/admin/pricing-rules/:id
 * @desc    Delete courier pricing rule
 * @access  Platform Admin
 */
router.delete(
  '/admin/pricing-rules/:id',
  blockVendorEmployees,
  courierController.deletePricingRule.bind(courierController)
);

// ==================== PATHAO SPECIFIC ROUTES ====================
/**
 * @route   GET /api/courier/admin/pathao/cities
 * @desc    Get Pathao cities for area mapping
 * @access  Platform Admin
 */
router.get(
  '/admin/pathao/cities',
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
  // authenticatePlatformAdmin,
  courierController.redxCreatePickupStore.bind(courierController)
);

// ==================== WAREHOUSE COURIER PICKUP MAPPING ====================
// Warehouse → provider pickup store (Pathao store / RedX pickup store).
// Admin/employee only (router-level guard above); vendor-scoped employees are
// restricted to their own vendor's warehouses inside the service.
/**
 * @route   GET /api/courier/admin/warehouse-pickups
 * @desc    List warehouse pickup mappings (filters: warehouseId, vendorId, courierProviderId, courierCredentialId, status)
 * @access  Admin/Employee
 */
router.get(
  '/admin/warehouse-pickups',
  courierController.listWarehousePickups.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/warehouse-pickups/link
 * @desc    Link an existing provider store to a warehouse (verified against the provider; PENDING_APPROVAL)
 * @access  Admin/Employee
 */
router.post(
  '/admin/warehouse-pickups/link',
  courierController.linkWarehousePickup.bind(courierController)
);

/**
 * @route   GET /api/courier/admin/warehouse-pickups/:mappingId
 * @desc    Get one warehouse pickup mapping
 * @access  Admin/Employee
 */
router.get(
  '/admin/warehouse-pickups/:mappingId',
  courierController.getWarehousePickup.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/warehouse-pickups/:mappingId/activate
 * @desc    Re-verify with the provider and activate (replaces the warehouse's previous active store)
 * @access  Admin/Employee
 */
router.post(
  '/admin/warehouse-pickups/:mappingId/activate',
  courierController.activateWarehousePickup.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/warehouse-pickups/:mappingId/deactivate
 * @desc    Deactivate a warehouse pickup mapping
 * @access  Admin/Employee
 */
router.post(
  '/admin/warehouse-pickups/:mappingId/deactivate',
  courierController.deactivateWarehousePickup.bind(courierController)
);

// ==================== STEADFAST SPECIFIC ROUTES ====================
/**
 * @route   GET /api/courier/admin/steadfast/status
 * @desc    Check live delivery status by consignmentId, invoice, or trackingCode
 * @access  Platform Admin
 */
router.get(
  '/admin/steadfast/status',
  blockVendorEmployees,
  // authenticatePlatformAdmin,
  courierController.steadfastCheckStatus.bind(courierController)
);

/**
 * @route   GET /api/courier/admin/steadfast/balance
 * @desc    Check current Steadfast COD balance
 * @access  Platform Admin
 */
router.get(
  '/admin/steadfast/balance',
  blockVendorEmployees,
  // authenticatePlatformAdmin,
  courierController.steadfastGetBalance.bind(courierController)
);

/**
 * @route   POST /api/courier/admin/steadfast/bulk-order
 * @desc    Create up to 500 Steadfast orders in one call
 * @access  Platform Admin
 */
router.post(
  '/admin/steadfast/bulk-order',
  blockVendorEmployees,
  // Phase 0: disabled — bulk creation bypasses booking intents, claims and
  // duplicate protection. Answered here; the handler below is never reached.
  bulkBookingDisabled,
  // authenticatePlatformAdmin,
  courierController.steadfastBulkOrder.bind(courierController)
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
  blockVendorEmployees,
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
  requireVendorScope,
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
  requireVendorScope,
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
  requireVendorScope,
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
  blockVendorEmployees,
  courierController.trackOrder.bind(courierController)
);

/**
 * @route   GET /api/courier/orders/:orderId
 * @desc    Get courier orders by order ID (Internal)
 * @access  Internal/Platform
 */
router.get(
  '/orders/:orderId',
  blockVendorEmployees,
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
  blockVendorEmployees,
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
  blockVendorEmployees,
  // authenticate,
  courierController.redxTrackParcel.bind(courierController)
);

// ==================== WEBHOOK ROUTES (1C-11 B3: REAL PIPELINE) ====================
// Previously these two routes called log-only stubs that could never update
// the database. They are now aliases of the canonical /api/webhooks routes:
// provider verification → provider payload normalization → the admin
// status-processing handler (processCourierStatusUpdate).
router.post(
  '/webhook/pathao',
  verifyPathaoSignature,
  normalizePathaoWebhook,
  AdminOrderController.handleCourierWebhook.bind(AdminOrderController)
);

router.post(
  '/webhook/redx',
  verifyRedxToken,
  normalizeRedxWebhook,
  AdminOrderController.handleCourierWebhook.bind(AdminOrderController)
);

export default router;