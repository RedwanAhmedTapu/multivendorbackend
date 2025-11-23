// controllers/category.controller.ts
import type { Request, Response } from "express";
import { CategoryService } from "../services/category.service.ts";
import { 
  uploadToR2Admin, 
  deleteFromR2Admin, 
  generateCategoryImageKey, 
  extractFileKeyFromUrl 
} from "../lib/r2-admin-config.ts";

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
        // Upload to R2 without quota checks
        const fileKey = generateCategoryImageKey(req.file.originalname);
        
        const uploadResult = await uploadToR2Admin({
          file: req.file.buffer!,
          key: fileKey,
          contentType: req.file.mimetype,
        });

        imageUrl = uploadResult.url;
      }

      const category = await CategoryService.create({
        ...req.body,
        image: imageUrl,
      });

      res.status(201).json(category);
    } catch (error: any) {
      // Clean up uploaded file if category creation fails
      if (req.file) {
        try {
          const fileKey = generateCategoryImageKey(req.file.originalname);
          await deleteFromR2Admin(fileKey);
        } catch (cleanupError) {
          console.error("Cleanup error:", cleanupError);
        }
      }
      res.status(400).json({ message: error.message });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const existingCategory = await CategoryService.getById(req.params.id);
      if (!existingCategory) {
        return res.status(404).json({ message: "Category not found" });
      }

      let imageUrl = existingCategory.image;
      let oldFileKey: string | null = null;

      if (req.file) {
        // Store old file key for cleanup
        if (existingCategory.image) {
          oldFileKey = extractFileKeyFromUrl(existingCategory.image);
        }

        // Upload new image to R2
        const newFileKey = generateCategoryImageKey(req.file.originalname);
        
        const uploadResult = await uploadToR2Admin({
          file: req.file.buffer!,
          key: newFileKey,
          contentType: req.file.mimetype,
        });

        imageUrl = uploadResult.url;
      }

      const category = await CategoryService.update(req.params.id, {
        ...req.body,
        image: imageUrl,
      });

      // Delete old image after successful update
      if (oldFileKey) {
        try {
          await deleteFromR2Admin(oldFileKey);
        } catch (error) {
          console.error("Error deleting old image:", error);
        }
      }

      res.json(category);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },

  async remove(req: Request, res: Response) {
    try {
      const category = await CategoryService.getById(req.params.id);
      if (!category) {
        return res.status(404).json({ message: "Category not found" });
      }

      // Delete image from R2 if exists
      if (category.image) {
        try {
          const fileKey = extractFileKeyFromUrl(category.image);
          if (fileKey) {
            await deleteFromR2Admin(fileKey);
          }
        } catch (error) {
          console.error("Error deleting image:", error);
        }
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

      const fileKey = generateCategoryImageKey(req.file.originalname);
      
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
      res.status(400).json({ message: error.message });
    }
  },
};