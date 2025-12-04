// routes/theme.routes.ts
import { Router } from 'express';
import { themeController } from '../controllers/theme.controller.ts';

const router = Router();

// Get all themes
router.get('/', themeController.getAllThemes.bind(themeController));

// Get active theme
router.get('/active', themeController.getActiveTheme.bind(themeController));

// Get layout options
router.get('/layout-options', themeController.getLayoutOptions.bind(themeController));

// Get theme by layout type
router.get('/layout/:layoutType', themeController.getThemeByLayoutType.bind(themeController));

// Create new theme
router.post('/', themeController.createTheme.bind(themeController));

// Initialize themes
router.post('/initialize', themeController.initializeThemes.bind(themeController));

// Activate theme
router.post('/:layoutType/activate', themeController.activateTheme.bind(themeController));

// Deactivate theme
router.post('/:layoutType/deactivate', themeController.deactivateTheme.bind(themeController));

// Toggle theme status
router.post('/:layoutType/toggle', themeController.toggleThemeStatus.bind(themeController));

export default router;