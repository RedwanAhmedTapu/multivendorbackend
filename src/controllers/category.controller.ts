import type { Request, Response } from "express";
import { CategoryService } from "../services/category.service.ts";
import { getImageUrl } from "../middlewares/upload.middleware.ts";
import fs from "fs";
import path from "path";

export const CategoryController = {
  async getAll(req: Request, res: Response) {
    try {
      const categories = await CategoryService.getAll();
      res.json(categories);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const category = await CategoryService.getById(req.params.id);
      if (!category) return res.status(404).json({ message: "Category not found" });
      res.json(category);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  },

  async create(req: Request, res: Response) {
    try {
      let imageUrl: string | undefined;
      if (req.file) {
        imageUrl = getImageUrl(req, "category", req.file.filename);
      }

      const category = await CategoryService.create({
        ...req.body,
        image: imageUrl,
      });

      res.status(201).json(category);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const existingCategory = await CategoryService.getById(req.params.id);
      if (!existingCategory) return res.status(404).json({ message: "Category not found" });

      let imageUrl = existingCategory.image;

      if (req.file) {
        // delete old image
        if (existingCategory.image) {
          const oldPath = path.join("uploads", "categories", path.basename(existingCategory.image));
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        imageUrl = getImageUrl(req, "category", req.file.filename);
      }

      const category = await CategoryService.update(req.params.id, {
        ...req.body,
        image: imageUrl,
      });

      res.json(category);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },

  async remove(req: Request, res: Response) {
    try {
      const category = await CategoryService.getById(req.params.id);
      if (!category) return res.status(404).json({ message: "Category not found" });

      if (category.image) {
        const oldPath = path.join("uploads", "categories", path.basename(category.image));
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      await CategoryService.remove(req.params.id);
      res.json({ message: "Category deleted successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },

  // Upload image only, get URL
  async uploadImage(req: Request, res: Response) {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const url = getImageUrl(req, "category", req.file.filename);
      res.json({ success: true, data: { url } });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },
};
