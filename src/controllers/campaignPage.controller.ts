// controllers/campaignPage.controller.ts
import type { Request, Response } from "express";
import { CampaignPageService } from "../services/campaignPage.service.ts";
import { uploadToR2Admin, generateCampaignImageKey } from "../lib/r2-admin-config.ts";

const service = new CampaignPageService();

export class CampaignPageController {
  // ── Admin: campaign CRUD ────────────────────

  async create(req: Request, res: Response) {
    try {
      const page = await service.create(req.body);
      res.status(201).json({ success: true, data: page });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async list(req: Request, res: Response) {
    try {
      const pages = await service.list();
      res.json({ success: true, data: pages });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const page = await service.getById(req.params.id);
      if (!page) return res.status(404).json({ success: false, message: "Campaign not found" });
      res.json({ success: true, data: page });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const page = await service.update(req.params.id, req.body, (req as any).user?.rawId);
      res.json({ success: true, data: page });
    } catch (error: any) {
      // Vendor-programme date rules answer 409/422 with details; anything else stays 400.
      res.status(error?.statusCode ?? 400).json({ success: false, message: error.message, details: error?.details });
    }
  }

  async publish(req: Request, res: Response) {
    try {
      const page = await service.publish(req.params.id);
      res.json({ success: true, message: "Campaign published", data: page });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async unpublish(req: Request, res: Response) {
    try {
      const page = await service.unpublish(req.params.id);
      res.json({ success: true, message: "Campaign moved back to draft", data: page });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async remove(req: Request, res: Response) {
    try {
      await service.delete(req.params.id);
      res.json({ success: true, message: "Campaign deleted" });
    } catch (error: any) {
      res.status(error?.statusCode ?? 400).json({ success: false, message: error.message });
    }
  }

  // ── Admin: components ────────────────────────

  async addComponent(req: Request, res: Response) {
    try {
      const campaignPageId = req.params.id;
      const component = await service.addComponent({ ...req.body, campaignPageId });
      res.status(201).json({ success: true, data: component });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async updateComponent(req: Request, res: Response) {
    try {
      const component = await service.updateComponent(req.params.componentId, req.body);
      res.json({ success: true, data: component });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async deleteComponent(req: Request, res: Response) {
    try {
      await service.deleteComponent(req.params.componentId);
      res.json({ success: true, message: "Component removed" });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async reorderComponents(req: Request, res: Response) {
    try {
      const { orderedIds } = req.body as { orderedIds: string[] };
      await service.reorderComponents(req.params.id, orderedIds);
      res.json({ success: true, message: "Reordered" });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async setComponentProducts(req: Request, res: Response) {
    try {
      const { productIds } = req.body as { productIds: string[] };
      const component = await service.setComponentProducts(req.params.componentId, productIds);
      res.json({ success: true, data: component });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  // ── Public ────────────────────────────────────

  async getPublicBySlug(req: Request, res: Response) {
    try {
      const page = await service.getPublishedBySlug(req.params.slug);
      if (!page) {
        return res.status(404).json({ success: false, message: "Campaign not found or not live" });
      }
      res.json({ success: true, data: page });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  // ── Image upload (hero banner / component banner images) ────

  async uploadImage(req: Request, res: Response) {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ success: false, message: "No image uploaded" });

      const fileKey = generateCampaignImageKey(file.originalname);
      const uploadResult = await uploadToR2Admin({
        file: file.buffer!,
        key: fileKey,
        contentType: file.mimetype,
      });

      res.json({ success: true, data: { url: uploadResult.url } });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }
}