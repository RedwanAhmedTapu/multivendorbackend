// routes/storeLayout.routes.ts
import { Router } from 'express';
import { StoreLayoutController } from '../controllers/storeLayout.controller.ts';

const router = Router();
const controller = new StoreLayoutController();


// Store Layout Routes
router.post('/layouts', controller.createStoreLayout.bind(controller));
router.get('/layouts', controller.getVendorLayouts.bind(controller));
router.get('/layouts/:id', controller.getStoreLayout.bind(controller));
router.put('/layouts/default', controller.setDefaultLayout.bind(controller));
router.delete('/layouts/:id', controller.deleteStoreLayout.bind(controller));

// Component Routes
router.post('/components', controller.addComponent.bind(controller));
router.put('/components/:componentId', controller.updateComponent.bind(controller));
router.delete('/components/:componentId', controller.deleteComponent.bind(controller));
router.put('/components/:componentId/products', controller.updateComponentProducts.bind(controller));
router.put('/components/:componentId/categories', controller.updateComponentCategories.bind(controller));

// Banner Customization Routes
router.get('/banner-customization', controller.getBannerCustomization.bind(controller));
router.put('/banner-customization', controller.updateBannerCustomization.bind(controller));

// Template Routes
router.get('/templates', controller.getTemplates.bind(controller));
router.post('/templates/apply', controller.applyTemplate.bind(controller));

export const storeLayoutRoutes = router;