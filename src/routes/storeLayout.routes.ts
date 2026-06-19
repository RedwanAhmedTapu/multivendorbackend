import { Router } from 'express';
import { StoreDecorationController } from '../controllers/storeLayout.controller.ts';
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const router = Router();
const ctrl = new StoreDecorationController();

// ─────────────────────────────────────────────
// PUBLIC  (no auth)
// ─────────────────────────────────────────────

/** Storefront renderer fetches the live published decoration */
router.get('/storefront/:vendorId', ctrl.getStorefront.bind(ctrl));

/** Template browser — anyone can browse */
router.get('/templates', ctrl.listTemplates.bind(ctrl));

// ─────────────────────────────────────────────
// VENDOR-AUTHENTICATED
// All routes below require: authenticate, requireVendor
// Uncomment the middleware imports above and apply:
  router.use(authenticateUser, authorizeRoles('VENDOR'));
// ─────────────────────────────────────────────

// ── Decoration management ──────────────────
router.post('/',               ctrl.createDecoration.bind(ctrl));
router.get('/',                ctrl.listDecorations.bind(ctrl));
router.get('/:id',             ctrl.getDecoration.bind(ctrl));
router.patch('/:id',           ctrl.updateDecoration.bind(ctrl));
router.delete('/:id',          ctrl.deleteDecoration.bind(ctrl));

// ── Lifecycle actions ──────────────────────
router.post('/:id/publish',    ctrl.publishDecoration.bind(ctrl));
router.post('/:id/archive',    ctrl.archiveDecoration.bind(ctrl));
router.post('/:id/duplicate',  ctrl.duplicateDecoration.bind(ctrl));

// ── Component management ───────────────────
router.post('/:id/components',                                    ctrl.addComponent.bind(ctrl));
router.put('/:id/components/reorder',                             ctrl.reorderComponents.bind(ctrl));   // PUT before /:componentId
router.patch('/:id/components/:componentId',                      ctrl.updateComponent.bind(ctrl));
router.delete('/:id/components/:componentId',                     ctrl.deleteComponent.bind(ctrl));
router.put('/:id/components/:componentId/products',               ctrl.setComponentProducts.bind(ctrl));
router.put('/:id/components/:componentId/categories',             ctrl.setComponentCategories.bind(ctrl));

// ── Banner customization ───────────────────
router.get('/banner-customization',  ctrl.getBannerCustomization.bind(ctrl));
router.put('/banner-customization',  ctrl.upsertBannerCustomization.bind(ctrl));

// ── Apply template to create a new decoration ─
router.post('/templates/apply', ctrl.applyTemplate.bind(ctrl));

export const storeDecorationRoutes = router;