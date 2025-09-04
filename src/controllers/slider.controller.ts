import type { Request, Response } from "express";
import { SliderService } from "../services/slider.service.ts";

const sliderService = new SliderService();

export class SliderController {
  async create(req: Request, res: Response) {
    try {
      const body = req.body;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "Image is required" });
      }

      // Save file path in DB
      body.imageUrl = file.path.replace(/\\/g, "/"); // normalize slashes

      const slider = await sliderService.create(body);
      res.status(201).json(slider);
    } catch (error: any) {
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

      if (file) {
        body.imageUrl = file.path.replace(/\\/g, "/");
      }

      const slider = await sliderService.update(req.params.id, body);
      res.json(slider);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  async remove(req: Request, res: Response) {
    try {
      await sliderService.remove(req.params.id);
      res.json({ message: "Slider deleted successfully" });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}
