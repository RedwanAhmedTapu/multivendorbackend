// controllers/theme.controller.ts
import type { Request, Response } from 'express';
import { themeService } from '../services/theme.service.ts';
import type { CreateThemeDto, LayoutType } from '../types/theme.types.ts';

export class ThemeController {
  /**
   * Get all themes
   * GET /api/themes
   */
  async getAllThemes(req: Request, res: Response) {
    try {
      const themes = await themeService.getAllThemes();
      res.json({
        success: true,
        data: themes,
      });
    } catch (error) {
      console.error('Error fetching themes:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch themes',
      });
    }
  }

  /**
   * Get active theme
   * GET /api/themes/active
   */
  async getActiveTheme(req: Request, res: Response) {
    try {
      const activeTheme = await themeService.getActiveTheme();
      
      if (!activeTheme) {
        return res.status(404).json({
          success: false,
          error: 'No active theme found',
        });
      }

      res.json({
        success: true,
        data: activeTheme,
      });
    } catch (error) {
      console.error('Error fetching active theme:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch active theme',
      });
    }
  }

  /**
   * Get theme by layout type
   * GET /api/themes/layout/:layoutType
   */
  async getThemeByLayoutType(req: Request, res: Response) {
    try {
      const { layoutType } = req.params;

      if (!['layout_1', 'layout_2', 'layout_3'].includes(layoutType)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid layout type. Must be layout_1, layout_2, or layout_3',
        });
      }

      const theme = await themeService.getThemeByLayoutType(layoutType as LayoutType);
      
      if (!theme) {
        return res.status(404).json({
          success: false,
          error: 'Theme not found',
        });
      }

      res.json({
        success: true,
        data: theme,
      });
    } catch (error) {
      console.error('Error fetching theme:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch theme',
      });
    }
  }

  /**
   * Create a new theme
   * POST /api/themes
   */
  async createTheme(req: Request, res: Response) {
    try {
      const data: CreateThemeDto = req.body;

      // Validate required fields
      if (!data.name || !data.layoutType) {
        return res.status(400).json({
          success: false,
          error: 'Name and layoutType are required',
        });
      }

      // Validate layout type
      if (!['layout_1', 'layout_2', 'layout_3'].includes(data.layoutType)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid layout type. Must be layout_1, layout_2, or layout_3',
        });
      }

      const theme = await themeService.createTheme(data);
      
      res.status(201).json({
        success: true,
        data: theme,
        message: 'Theme created successfully',
      });
    } catch (error: any) {
      console.error('Error creating theme:', error);
      
      if (error.message.includes('already exists')) {
        return res.status(409).json({
          success: false,
          error: error.message,
        });
      }

      res.status(500).json({
        success: false,
        error: 'Failed to create theme',
      });
    }
  }

  /**
   * Activate a theme
   * POST /api/themes/:layoutType/activate
   */
  async activateTheme(req: Request, res: Response) {
    try {
      const { layoutType } = req.params;

      if (!['layout_1', 'layout_2', 'layout_3'].includes(layoutType)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid layout type',
        });
      }

      const theme = await themeService.activateTheme(layoutType as LayoutType);
      
      res.json({
        success: true,
        data: theme,
        message: `Theme "${layoutType}" activated successfully`,
      });
    } catch (error: any) {
      console.error('Error activating theme:', error);
      
      if (error.message === 'Theme not found') {
        return res.status(404).json({
          success: false,
          error: error.message,
        });
      }

      res.status(500).json({
        success: false,
        error: 'Failed to activate theme',
      });
    }
  }

  /**
   * Deactivate a theme
   * POST /api/themes/:layoutType/deactivate
   */
  async deactivateTheme(req: Request, res: Response) {
    try {
      const { layoutType } = req.params;

      if (!['layout_1', 'layout_2', 'layout_3'].includes(layoutType)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid layout type',
        });
      }

      const theme = await themeService.deactivateTheme(layoutType as LayoutType);
      
      res.json({
        success: true,
        data: theme,
        message: `Theme "${layoutType}" deactivated successfully`,
      });
    } catch (error: any) {
      console.error('Error deactivating theme:', error);
      
      if (error.message === 'Theme not found') {
        return res.status(404).json({
          success: false,
          error: error.message,
        });
      }

      res.status(500).json({
        success: false,
        error: 'Failed to deactivate theme',
      });
    }
  }

  /**
   * Toggle theme status
   * POST /api/themes/:layoutType/toggle
   */
  async toggleThemeStatus(req: Request, res: Response) {
    try {
      const { layoutType } = req.params;

      if (!['layout_1', 'layout_2', 'layout_3'].includes(layoutType)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid layout type',
        });
      }

      const theme = await themeService.toggleThemeStatus(layoutType as LayoutType);
      
      res.json({
        success: true,
        data: theme,
        message: `Theme "${layoutType}" ${theme.status === 'active' ? 'activated' : 'deactivated'} successfully`,
      });
    } catch (error: any) {
      console.error('Error toggling theme status:', error);
      
      if (error.message === 'Theme not found') {
        return res.status(404).json({
          success: false,
          error: error.message,
        });
      }

      res.status(500).json({
        success: false,
        error: 'Failed to toggle theme status',
      });
    }
  }

  /**
   * Get layout options
   * GET /api/themes/layout-options
   */
  async getLayoutOptions(req: Request, res: Response) {
    try {
      const options = await themeService.getLayoutOptions();
      res.json({
        success: true,
        data: options,
      });
    } catch (error) {
      console.error('Error fetching layout options:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch layout options',
      });
    }
  }

  /**
   * Initialize themes (for admin/startup)
   * POST /api/themes/initialize
   */
  async initializeThemes(req: Request, res: Response) {
    try {
      await themeService.initializeThemes();
      const themes = await themeService.getAllThemes();
      
      res.json({
        success: true,
        data: themes,
        message: 'Themes initialized successfully',
      });
    } catch (error) {
      console.error('Error initializing themes:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to initialize themes',
      });
    }
  }
}

export const themeController = new ThemeController();