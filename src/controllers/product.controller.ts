import type { Request, Response } from "express";
import { ProductService } from "../services/product.service.ts";
import type { AuthRequest } from "../middlewares/auth.middleware.ts";

export const ProductController = {
  // ======================
  // Get all products
  // ======================
  async getAll(req: Request, res: Response) {
    try {
      const products = await ProductService.getAll();
      return res.json({ success: true, data: products });
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
      const product = await ProductService.getById(id);
      console.log(product)

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
  // Get products by vendor ID
  // ======================
  async getByVendorId(req: AuthRequest, res: Response) {
    try {
      const { vendorId } = req.params;
      const { status } = req.query;

      // Validate status if provided
      const validStatuses = ["PENDING", "ACTIVE", "REJECTED"];
      if (status && !validStatuses.includes(status as string)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status. Must be one of: PENDING, ACTIVE, REJECTED"
        });
      }

      const options = status ? { status: status as "PENDING" | "ACTIVE" | "REJECTED" } : undefined;
      const products = await ProductService.getByVendorId(vendorId, options);

      return res.json({ 
        success: true, 
        data: products,
        count: products.length 
      });
    } catch (error: any) {
      console.error("Error fetching products by vendor ID:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch vendor products" 
      });
    }
  },

  // ======================
  // Get vendor statistics
  // ======================
  async getStatistics(req: AuthRequest, res: Response) {
    try {
      const { vendorId } = req.params;
      const stats = await ProductService.getStatistics(vendorId);

      return res.json({ 
        success: true, 
        data: stats 
      });
    } catch (error: any) {
      console.error("Error fetching product statistics:", error);
      return res.status(500).json({ 
        success: false, 
        message: error.message || "Failed to fetch product statistics" 
      });
    }
  },

  // ======================
  // Create new product
  // ======================
  async create(req: AuthRequest, res: Response) {
    try {
      const { images, shippingWarranty, ...productData } = req.body;

      // Validate required fields
      if (!productData.name || !productData.vendorId || !productData.categoryId) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields: name, vendorId, categoryId"
        });
      }

      // Format images
      const formattedImages = Array.isArray(images)
        ? images.map((img: any, idx: number) => ({
            url: typeof img === "string" ? img : img?.url,
            altText: img?.altText ?? `${productData.name || "Product"} image ${idx + 1}`,
            sortOrder: img?.sortOrder ?? idx,
          }))
        : [];

      // Validate variants if provided
      if (productData.variants && Array.isArray(productData.variants)) {
        for (const variant of productData.variants) {
          if (!variant.sku || !variant.price) {
            return res.status(400).json({
              success: false,
              message: "Each variant must have sku and price"
            });
          }
        }
      }

      const product = await ProductService.create({
        ...productData,
        images: formattedImages,
        shippingWarranty,
        userId: req.user?.id,
      });

      return res.status(201).json({ 
        success: true, 
        data: product,
        message: "Product created successfully" 
      });
    } catch (error: any) {
      console.error("Error creating product:", error);
      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to create product" 
      });
    }
  },

  // ======================
  // Update product
  // ======================
  async update(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { images, shippingWarranty, ...updateData } = req.body;

      // Check if product exists
      const existingProduct = await ProductService.getById(id);
      if (!existingProduct) {
        return res.status(404).json({
          success: false,
          message: "Product not found"
        });
      }

      // Format images if provided
      const formattedImages = images && Array.isArray(images)
        ? images.map((img: any, idx: number) => ({
            url: typeof img === "string" ? img : img?.url,
            altText: img?.altText ?? `Product image ${idx + 1}`,
            sortOrder: img?.sortOrder ?? idx,
          }))
        : undefined;

      const product = await ProductService.update(id, {
        ...updateData,
        images: formattedImages,
        shippingWarranty,
        userId: req.user?.id,
      });

      return res.json({ 
        success: true, 
        data: product,
        message: "Product updated successfully" 
      });
    } catch (error: any) {
      console.error("Error updating product:", error);
      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to update product" 
      });
    }
  },

  // ======================
  // Update product status (Approve/Reject)
  // ======================
  async updateStatus(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      // Validate status
      const validStatuses = ["PENDING", "ACTIVE", "REJECTED"];
      if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status. Must be one of: PENDING, ACTIVE, REJECTED"
        });
      }

      // Check if product exists
      const existingProduct = await ProductService.getById(id);
      if (!existingProduct) {
        return res.status(404).json({
          success: false,
          message: "Product not found"
        });
      }

      const product = await ProductService.update(id, {
        status: status as "PENDING" | "ACTIVE" | "REJECTED",
        approvedById: status === "ACTIVE" ? req.user?.id : undefined,
        userId: req.user?.id,
      });

      const statusMessages = {
        ACTIVE: "Product approved successfully",
        REJECTED: "Product rejected",
        PENDING: "Product status set to pending"
      };

      return res.json({ 
        success: true, 
        data: product,
        message: statusMessages[status as keyof typeof statusMessages]
      });
    } catch (error: any) {
      console.error("Error updating product status:", error);
      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to update product status" 
      });
    }
  },

  // ======================
  // Delete product
  // ======================
  async remove(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;

      // Check if product exists
      const existingProduct = await ProductService.getById(id);
      if (!existingProduct) {
        return res.status(404).json({
          success: false,
          message: "Product not found"
        });
      }

      await ProductService.remove(id, req.user?.id);
      
      return res.json({ 
        success: true, 
        message: "Product deleted successfully",
        data: null 
      });
    } catch (error: any) {
      console.error("Error deleting product:", error);
      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to delete product" 
      });
    }
  },

  // ======================
  // Filter products
  // ======================
  async filter(req: Request, res: Response) {
    try {
      const filters = req.body;
      console.log(req.body,"tall")
      
      

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

      const products = await ProductService.filterProducts(filters);
      console.log(products)
      
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
      const { q, vendorId, categoryId, minPrice, maxPrice, inStock } = req.query;

      if (!q || typeof q !== "string" || q.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Search query 'q' is required and must be a non-empty string"
        });
      }

      const filters: any = {
        search: q.trim(),
      };

      if (vendorId) filters.vendorId = vendorId as string;
      if (categoryId) filters.categoryId = categoryId as string;
      if (minPrice) filters.minPrice = parseFloat(minPrice as string);
      if (maxPrice) filters.maxPrice = parseFloat(maxPrice as string);
      if (inStock === "true") filters.inStock = true;

      const products = await ProductService.filterProducts(filters);

      return res.json({
        success: true,
        data: products,
        count: products.length,
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