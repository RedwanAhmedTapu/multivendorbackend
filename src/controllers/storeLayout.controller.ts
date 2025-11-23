// controllers/storeLayout.controller.ts
import type { Request, Response } from "express";
import type {
  CreateStoreLayoutInput,
  CreateComponentInput,
  UpdateBannerCustomizationInput,
} from "../services/storeLayout.service.ts";
import { StoreLayoutService } from "../services/storeLayout.service.ts";

const storeLayoutService = new StoreLayoutService();

export class StoreLayoutController {
  // Store Layout Methods
  async createStoreLayout(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId; // Assuming vendor ID from auth middleware
      const data: CreateStoreLayoutInput = { ...req.body, vendorId };

      const layout = await storeLayoutService.createStoreLayout(data);
      res.status(201).json({
        success: true,
        data: layout,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getVendorLayouts(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const layouts = await storeLayoutService.getVendorLayouts(vendorId);

      res.json({
        success: true,
        data: layouts,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getStoreLayout(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const layout = await storeLayoutService.getStoreLayout(id);

      if (!layout) {
        return res.status(404).json({
          success: false,
          message: "Layout not found",
        });
      }

      res.json({
        success: true,
        data: layout,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }

  async setDefaultLayout(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const { layoutId } = req.body;

      const layout = await storeLayoutService.setDefaultLayout(
        vendorId,
        layoutId
      );

      res.json({
        success: true,
        data: layout,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async deleteStoreLayout(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await storeLayoutService.deleteStoreLayout(id);

      res.json({
        success: true,
        message: "Layout deleted successfully",
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  // Component Methods
  async addComponent(req: Request, res: Response) {
    try {
      const data: CreateComponentInput = req.body;
      const component = await storeLayoutService.addComponentToLayout(data);

      res.status(201).json({
        success: true,
        data: component,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async updateComponent(req: Request, res: Response) {
    try {
      const { componentId } = req.params;
      const data = req.body;

      const component = await storeLayoutService.updateComponent(
        componentId,
        data
      );

      res.json({
        success: true,
        data: component,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async deleteComponent(req: Request, res: Response) {
    try {
      const { componentId } = req.params;
      await storeLayoutService.deleteComponent(componentId);

      res.json({
        success: true,
        message: "Component deleted successfully",
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async updateComponentProducts(req: Request, res: Response) {
    try {
      const { componentId } = req.params;
      const { productIds } = req.body;

      const component = await storeLayoutService.updateComponentProducts(
        componentId,
        productIds
      );

      res.json({
        success: true,
        data: component,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async updateComponentCategories(req: Request, res: Response) {
    try {
      const { componentId } = req.params;
      const { categoryIds } = req.body;

      const component = await storeLayoutService.updateComponentCategories(
        componentId,
        categoryIds
      );

      res.json({
        success: true,
        data: component,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  // Banner Customization Methods
  async getBannerCustomization(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const customization = await storeLayoutService.getBannerCustomization(
        vendorId
      );

      res.json({
        success: true,
        data: customization,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }

  async updateBannerCustomization(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const data: UpdateBannerCustomizationInput = req.body;

      const customization = await storeLayoutService.updateBannerCustomization(
        vendorId,
        data
      );

      res.json({
        success: true,
        data: customization,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  // Template Methods
  async getTemplates(req: Request, res: Response) {
    try {
      const { category } = req.query;
      const templates = await storeLayoutService.getLayoutTemplates(
        category as string
      );

      res.json({
        success: true,
        data: templates,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }

  async applyTemplate(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const { templateId } = req.body;

      const layout = await storeLayoutService.applyTemplate(
        vendorId,
        templateId
      );

      res.status(201).json({
        success: true,
        data: layout,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
}
