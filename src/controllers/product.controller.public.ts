// controllers/product.controller.public.ts
import type { Request, Response } from "express";
import { PublicProductService } from "../services/product.service.ts";

/**
 * Public Product Controller
 * Handles customer-facing product operations
 * All endpoints return only ACTIVE products
 */
export const PublicProductController = {
  // ======================
  // Get all products
  // ======================
  async getAll(req: Request, res: Response) {
    try {
      const products = await PublicProductService.getAll();
      return res.json({ 
        success: true, 
        data: products,
        count: products.length 
      });
    } catch (error: any) {
      console.error("Error fetching all products:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch products" 
      });
    }
  },

  // ======================
  // Get product by ID
  // ======================
  async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const product = await PublicProductService.getById(id);

      if (!product) {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found" 
        });
      }

      return res.json({ success: true, data: product });
    } catch (error: any) {
      console.error("Error fetching product by ID:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch product" 
      });
    }
  },

  // ======================
  // Get products by category
  // ======================
  async getByCategoryId(req: Request, res: Response) {
    try {
      const { categoryId } = req.params;
      const products = await PublicProductService.getByCategoryId(categoryId);

      return res.json({ 
        success: true, 
        data: products,
        count: products.length 
      });
    } catch (error: any) {
      console.error("Error fetching products by category:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch category products" 
      });
    }
  },

  // ======================
  // Get featured products
  // ======================
  async getFeatured(req: Request, res: Response) {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;

      if (limit < 1 || limit > 100) {
        return res.status(400).json({
          success: false,
          message: "Limit must be between 1 and 100"
        });
      }

      const products = await PublicProductService.getFeatured(limit);

      return res.json({ 
        success: true, 
        data: products,
        count: products.length 
      });
    } catch (error: any) {
      console.error("Error fetching featured products:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch featured products" 
      });
    }
  },

  // ======================
  // Filter products
  // ======================
  async filter(req: Request, res: Response) {
    try {
      const filters = req.body;

      // Validate filter parameters
      if (filters.minPrice !== undefined && filters.minPrice < 0) {
        return res.status(400).json({
          success: false,
          message: "minPrice must be a positive number"
        });
      }

      if (filters.maxPrice !== undefined && filters.maxPrice < 0) {
        return res.status(400).json({
          success: false,
          message: "maxPrice must be a positive number"
        });
      }

      if (filters.minPrice && filters.maxPrice && filters.minPrice > filters.maxPrice) {
        return res.status(400).json({
          success: false,
          message: "minPrice cannot be greater than maxPrice"
        });
      }

      const products = await PublicProductService.filterProducts(filters);
      
      return res.json({ 
        success: true, 
        data: products,
        count: products.length,
        filters: filters 
      });
    } catch (error: any) {
      console.error("Error filtering products:", error);
      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to filter products" 
      });
    }
  },

  // ======================
  // Search products
  // ======================
  async search(req: Request, res: Response) {
    try {
      const { q, vendorId, categoryId, minPrice, maxPrice, inStock, limit } = req.query;

      if (!q || typeof q !== "string" || q.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Search query 'q' is required and must be a non-empty string"
        });
      }

      const searchLimit = limit ? parseInt(limit as string) : 20;

      if (searchLimit < 1 || searchLimit > 100) {
        return res.status(400).json({
          success: false,
          message: "Limit must be between 1 and 100"
        });
      }

      const products = await PublicProductService.search(q.trim(), searchLimit);

      // Apply additional filters if provided
      let filteredProducts = products;

      if (vendorId) {
        filteredProducts = filteredProducts.filter(p => p.vendor.id === vendorId);
      }

      if (categoryId) {
        filteredProducts = filteredProducts.filter(p => p.category?.id === categoryId);
      }

      if (minPrice) {
        const min = parseFloat(minPrice as string);
        filteredProducts = filteredProducts.filter(p => 
          p.variants.some(v => v.price >= min)
        );
      }

      if (maxPrice) {
        const max = parseFloat(maxPrice as string);
        filteredProducts = filteredProducts.filter(p => 
          p.variants.some(v => v.price <= max)
        );
      }

      if (inStock === "true") {
        filteredProducts = filteredProducts.filter(p => 
          p.variants.some(v => v.stock > 0)
        );
      }

      return res.json({
        success: true,
        data: filteredProducts,
        count: filteredProducts.length,
        query: q
      });
    } catch (error: any) {
      console.error("Error searching products:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to search products"
      });
    }
  },
};