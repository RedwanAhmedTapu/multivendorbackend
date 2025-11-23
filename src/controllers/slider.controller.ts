// controllers/slider.controller.ts
import type { Request, Response } from "express";
import { SliderService } from "../services/slider.service.ts";
import { 
  uploadToR2Admin, 
  deleteFromR2Admin, 
  generateSliderImageKey, 
  extractFileKeyFromUrl 
} from "../lib/r2-admin-config.ts";

const sliderService = new SliderService();

export class SliderController {
  async create(req: Request, res: Response) {
    try {
      const body = req.body;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "Image is required" });
      }

      // Upload to R2 - images will be stored in "admin/sliders/" folder
      const fileKey = generateSliderImageKey(file.originalname);
      
      const uploadResult = await uploadToR2Admin({
        file: file.buffer!,
        key: fileKey,
        contentType: file.mimetype,
      });

      // Save R2 URL in DB
      body.imageUrl = uploadResult.url;

      const slider = await sliderService.create(body);
      res.status(201).json(slider);
    } catch (error: any) {
      // Clean up uploaded file if creation fails
      if (req.file) {
        try {
          const fileKey = generateSliderImageKey(req.file.originalname);
          await deleteFromR2Admin(fileKey);
        } catch (cleanupError) {
          console.error("Cleanup error:", cleanupError);
        }
      }
      res.status(400).json({ error: error.message });
    }
  }

  async findAll(req: Request, res: Response) {
    try {
      const sliders = await sliderService.findAll();
      res.json(sliders);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async findOne(req: Request, res: Response) {
    try {
      const slider = await sliderService.findOne(req.params.id);
      if (!slider) return res.status(404).json({ error: "Slider not found" });
      res.json(slider);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const body = req.body;
      const file = req.file;

      // Get existing slider to check for old image
      const existingSlider = await sliderService.findOne(req.params.id);
      if (!existingSlider) {
        return res.status(404).json({ error: "Slider not found" });
      }

      let oldFileKey: string | null = null;

      if (file) {
        // Store old file key for cleanup
        if (existingSlider.imageUrl) {
          oldFileKey = extractFileKeyFromUrl(existingSlider.imageUrl);
        }

        // Upload new image to R2
        const newFileKey = generateSliderImageKey(file.originalname);
        
        const uploadResult = await uploadToR2Admin({
          file: file.buffer!,
          key: newFileKey,
          contentType: file.mimetype,
        });

        body.imageUrl = uploadResult.url;
      }

      const slider = await sliderService.update(req.params.id, body);

      // Delete old image from R2 after successful update
      if (oldFileKey) {
        try {
          await deleteFromR2Admin(oldFileKey);
        } catch (error) {
          console.error("Error deleting old image from R2:", error);
        }
      }

      res.json(slider);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  async remove(req: Request, res: Response) {
    try {
      const slider = await sliderService.remove(req.params.id);

      // Delete image from R2 if exists
      if (slider.imageUrl) {
        try {
          const fileKey = extractFileKeyFromUrl(slider.imageUrl);
          if (fileKey) {
            await deleteFromR2Admin(fileKey);
          }
        } catch (error) {
          console.error("Error deleting image from R2:", error);
        }
      }

      res.json({ message: "Slider deleted successfully" });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  // Upload image only, get URL (for frontend use)
  async uploadImage(req: Request, res: Response) {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const fileKey = generateSliderImageKey(req.file.originalname);
      
      const uploadResult = await uploadToR2Admin({
        file: req.file.buffer!,
        key: fileKey,
        contentType: req.file.mimetype,
      });

      res.json({ 
        success: true, 
        data: { 
          url: uploadResult.url,
          key: uploadResult.key
        } 
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}