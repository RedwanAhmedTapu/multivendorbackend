// routes/theme.routes.ts
import { Router } from 'express';
import { themeController } from '../controllers/theme.controller.ts';
import { homepageConfigController as homepageConfig } from '../controllers/homepage-config.controller.ts';
import { productCardConfigController as productCard } from '../controllers/product-card-config.controller.ts';
import { themePaletteController as palettes } from '../controllers/theme-palette.controller.ts';
import { VersionedSettingController } from '../controllers/versioned-setting.controller.ts';
import { vendorThemePolicyService } from '../services/theme-vendor-policy.service.ts';
import { authenticateUser, authorizeRoles } from '../middlewares/auth.middleware.ts';
import { blockVendorEmployees, requirePermission, requireVendorOwnerScope } from '../middlewares/permission.middleware.ts';

const router = Router();

// Write routes change the platform homepage layout — ADMIN only.
const adminOnly = [authenticateUser, authorizeRoles('ADMIN')];

// ── Theme palettes (Part 2 — THEME_MANAGEMENT_ARCHITECTURE.md §2.4) ─────────
// Palette management is platform-side staff power: ADMIN passes, EMPLOYEE
// needs the themeManagement grant, vendor staff are blocked (S-1 pattern).
const themeAdmin = [authenticateUser, authorizeRoles('ADMIN', 'EMPLOYEE'), blockVendorEmployees, requirePermission('themeManagement')];
// Vendor storefront theme: vendor OWNER only (StoreDecoration convention —
// Part 2 review decision, option a). Vendor employees are denied regardless
// of grants. vendorScope comes from the authenticated session only.
const vendorTheme = [authenticateUser, requireVendorOwnerScope];
// Vendor theme policy (draft/published/previous — shared versioned-setting handlers).
const vendorPolicy = new VersionedSettingController(vendorThemePolicyService, { noun: 'vendor theme policy' });

// Public: the live palette for a scope (published only; Neutral fallback).
router.get('/palette/active', palettes.getActivePalette.bind(palettes));

// Admin: palette CRUD + lifecycle.
router.get('/palettes', ...themeAdmin, palettes.listPalettes.bind(palettes));
router.post('/palettes', ...themeAdmin, palettes.createPalette.bind(palettes));
router.get('/palettes/:id', ...themeAdmin, palettes.getPalette.bind(palettes));
router.patch('/palettes/:id', ...themeAdmin, palettes.updatePalette.bind(palettes));
router.delete('/palettes/:id', ...themeAdmin, palettes.deletePalette.bind(palettes));
router.post('/palettes/:id/duplicate', ...themeAdmin, palettes.duplicatePalette.bind(palettes));
router.post('/palettes/:id/publish', ...themeAdmin, palettes.publishPalette.bind(palettes));
router.post('/palettes/:id/archive', ...themeAdmin, palettes.archivePalette.bind(palettes));
router.post('/palettes/:id/rollback', ...themeAdmin, palettes.rollbackPalette.bind(palettes));
router.post('/palettes/:id/restore-default', ...themeAdmin, palettes.restorePresetDefault.bind(palettes));
router.get('/palettes/:id/versions', ...themeAdmin, palettes.listVersions.bind(palettes));

// Admin: scope assignments.
router.get('/assignments', ...themeAdmin, palettes.listAssignments.bind(palettes));
router.put('/assignments', ...themeAdmin, palettes.upsertAssignment.bind(palettes));

// Admin: vendor theme policy (versioned setting).
router.get('/vendor-policy', ...themeAdmin, vendorPolicy.getPublished.bind(vendorPolicy));
router.get('/vendor-policy/draft', ...themeAdmin, vendorPolicy.getDraft.bind(vendorPolicy));
router.put('/vendor-policy/draft', ...themeAdmin, vendorPolicy.saveDraft.bind(vendorPolicy));
router.post('/vendor-policy/draft/discard', ...themeAdmin, vendorPolicy.discardDraft.bind(vendorPolicy));
router.post('/vendor-policy/publish', ...themeAdmin, vendorPolicy.publish.bind(vendorPolicy));
router.post('/vendor-policy/restore-previous', ...themeAdmin, vendorPolicy.restorePrevious.bind(vendorPolicy));

// Vendor: own storefront theme (policy-approved palettes, whitelisted overrides).
router.get('/vendor/palettes', ...vendorTheme, palettes.listVendorPalettes.bind(palettes));
router.get('/vendor/storefront-palette', ...vendorTheme, palettes.getVendorStorefront.bind(palettes));
router.put('/vendor/storefront-palette', ...vendorTheme, palettes.putVendorStorefront.bind(palettes));
router.post('/vendor/storefront-palette/reset', ...vendorTheme, palettes.resetVendorStorefront.bind(palettes));
router.get('/vendor/preview', ...vendorTheme, palettes.getVendorPreview.bind(palettes));

// Customer: own appearance preference only.
router.get('/me/preference', authenticateUser, palettes.getMyPreference.bind(palettes));
router.put('/me/preference', authenticateUser, palettes.putMyPreference.bind(palettes));
router.delete('/me/preference', authenticateUser, palettes.deleteMyPreference.bind(palettes));

// Get all themes
router.get('/', themeController.getAllThemes.bind(themeController));

// Get active theme
router.get('/active', themeController.getActiveTheme.bind(themeController));

// Get layout options
router.get('/layout-options', themeController.getLayoutOptions.bind(themeController));

// Get theme by layout type
router.get('/layout/:layoutType', themeController.getThemeByLayoutType.bind(themeController));

// ── Homepage configuration (settings: homepage.draft / .published / .published.previous)
// Public: published config (falls back to built-in defaults). Everything else ADMIN only.
router.get('/homepage-config', homepageConfig.getPublished.bind(homepageConfig));
router.get('/homepage-config/draft', ...adminOnly, homepageConfig.getDraft.bind(homepageConfig));
router.put('/homepage-config/draft', ...adminOnly, homepageConfig.saveDraft.bind(homepageConfig));
router.post('/homepage-config/draft/discard', ...adminOnly, homepageConfig.discardDraft.bind(homepageConfig));
router.post('/homepage-config/draft/reset-defaults', ...adminOnly, homepageConfig.resetDraftToDefaults.bind(homepageConfig));
router.post('/homepage-config/publish', ...adminOnly, homepageConfig.publish.bind(homepageConfig));
router.post('/homepage-config/restore-previous', ...adminOnly, homepageConfig.restorePrevious.bind(homepageConfig));

// ── Global product card design (settings: product-card.draft / .published / .published.previous)
// One design for every customer-facing listing. Public: published (or defaults). Everything else ADMIN only.
router.get('/product-card', productCard.getPublished.bind(productCard));
router.get('/product-card/draft', ...adminOnly, productCard.getDraft.bind(productCard));
router.put('/product-card/draft', ...adminOnly, productCard.saveDraft.bind(productCard));
router.post('/product-card/draft/discard', ...adminOnly, productCard.discardDraft.bind(productCard));
router.post('/product-card/draft/reset-defaults', ...adminOnly, productCard.resetDraftToDefaults.bind(productCard));
router.post('/product-card/publish', ...adminOnly, productCard.publish.bind(productCard));
router.post('/product-card/restore-previous', ...adminOnly, productCard.restorePrevious.bind(productCard));

// Create new theme
router.post('/', ...adminOnly, themeController.createTheme.bind(themeController));

// Initialize themes
router.post('/initialize', ...adminOnly, themeController.initializeThemes.bind(themeController));

// Activate theme
router.post('/:layoutType/activate', ...adminOnly, themeController.activateTheme.bind(themeController));

// Deactivate theme
router.post('/:layoutType/deactivate', ...adminOnly, themeController.deactivateTheme.bind(themeController));

// Toggle theme status
router.post('/:layoutType/toggle', ...adminOnly, themeController.toggleThemeStatus.bind(themeController));

export default router;