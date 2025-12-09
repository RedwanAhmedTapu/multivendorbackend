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
        const fileKey = generateCategoryImageKey(req.file.originalname);
        
        const uploadResult = await uploadToR2Admin({
          file: req.file.buffer!,
          key: fileKey,
          contentType: req.file.mimetype,
        });

        imageUrl = uploadResult.url;
      }

      // ✅ Parse tags and keywords if they come as strings
      const categoryData = {
        ...req.body,
        image: imageUrl,
        keywords: Array.isArray(req.body.keywords) 
          ? req.body.keywords 
          : req.body.keywords 
            ? JSON.parse(req.body.keywords) 
            : [],
        tags: Array.isArray(req.body.tags) 
          ? req.body.tags 
          : req.body.tags 
            ? JSON.parse(req.body.tags) 
            : [],
      };

      const category = await CategoryService.create(categoryData);

      res.status(201).json(category);
    } catch (error: any) {
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
        if (existingCategory.image) {
          oldFileKey = extractFileKeyFromUrl(existingCategory.image);
        }

        const newFileKey = generateCategoryImageKey(req.file.originalname);
        
        const uploadResult = await uploadToR2Admin({
          file: req.file.buffer!,
          key: newFileKey,
          contentType: req.file.mimetype,
        });

        imageUrl = uploadResult.url;
      }

      // ✅ FIXED: Handle keywords and tags properly
      const updateData: any = {
        ...req.body,
        image: imageUrl,
      };

      // Handle keywords - convert comma-separated string to array
      if (req.body.keywords !== undefined) {
        if (typeof req.body.keywords === 'string') {
          if (req.body.keywords.trim() === '') {
            updateData.keywords = [];
          } else {
            // Split by comma and trim each keyword
            updateData.keywords = req.body.keywords
              .split(',')
              .map((k: string) => k.trim())
              .filter((k: string) => k.length > 0);
          }
        } else if (Array.isArray(req.body.keywords)) {
          updateData.keywords = req.body.keywords;
        }
        // If it's already an array, keep it as is
      }

      // Handle tags - convert comma-separated string to array
      if (req.body.tags !== undefined) {
        if (typeof req.body.tags === 'string') {
          if (req.body.tags.trim() === '') {
            updateData.tags = [];
          } else {
            // Split by comma and trim each tag
            updateData.tags = req.body.tags
              .split(',')
              .map((t: string) => t.trim())
              .filter((t: string) => t.length > 0);
          }
        } else if (Array.isArray(req.body.tags)) {
          updateData.tags = req.body.tags;
        }
        // If it's already an array, keep it as is
      }

      console.log("Update data being sent to service:", updateData);

      const category = await CategoryService.update(req.params.id, updateData);

      if (oldFileKey) {
        try {
          await deleteFromR2Admin(oldFileKey);
        } catch (error) {
          console.error("Error deleting old image:", error);
        }
      }

      res.json(category);
    } catch (error: any) {
      console.log("Update error:", error);
      res.status(400).json({ message: error.message });
    }
  },

  async remove(req: Request, res: Response) {
    try {
      const category = await CategoryService.getById(req.params.id);
      if (!category) {
        return res.status(404).json({ message: "Category not found" });
      }

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

  // ✅ NEW: Search categories
  async search(req: Request, res: Response) {
    try {
      const { q } = req.query;
      if (!q || typeof q !== 'string') {
        return res.status(400).json({ message: "Query parameter 'q' is required" });
      }

      const categories = await CategoryService.search(q);
      res.json(categories);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  },

  // ✅ NEW: Get categories by tag
  async getByTag(req: Request, res: Response) {
    try {
      const { tag } = req.params;
      const categories = await CategoryService.getByTag(tag);
      res.json(categories);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  },

  // ✅ NEW: Get categories by keyword
  async getByKeyword(req: Request, res: Response) {
    try {
      const { keyword } = req.params;
      const categories = await CategoryService.getByKeyword(keyword);
      res.json(categories);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  },
};