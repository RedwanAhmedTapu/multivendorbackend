// controllers/product.controller.vendor.ts
import type { Request, Response } from "express";
import { VendorProductService } from "../services/product.service.ts";
import type { AuthRequest } from "../middlewares/auth.middleware.ts";

/**
 * Vendor Product Controller
 * Handles vendor-specific product operations
 * All operations include ownership verification
 */
export const VendorProductController = {
  // ======================
  // Get vendor's own products
  // ======================
async getMyProducts(req: AuthRequest, res: Response) {
  try {
    // Get vendorId from authenticated user
    const vendorId = req.user?.vendorId;

    if (!vendorId) {
      return res.status(403).json({
        success: false,
        message: "User is not associated with a vendor account"
      });
    }

    // Extract query parameters
    const { 
      status, 
      search,
      category,
      minPrice,
      maxPrice,
      sortBy = "createdAt",
      sortOrder = "desc",
      page = "1",
      limit = "10"
    } = req.query;

    // Validate status if provided
    const validStatuses = ["PENDING", "ACTIVE", "REJECTED", "DRAFT"];
    if (status && !validStatuses.includes(status as string)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`
      });
    }

    // Validate sortBy options
    const validSortFields = ["createdAt", "updatedAt", "name", "price", "stock"];
    if (sortBy && !validSortFields.includes(sortBy as string)) {
      return res.status(400).json({
        success: false,
        message: `Invalid sort field. Must be one of: ${validSortFields.join(", ")}`
      });
    }

    // Validate sortOrder
    const validSortOrders = ["asc", "desc"];
    if (sortOrder && !validSortOrders.includes(sortOrder as string)) {
      return res.status(400).json({
        success: false,
        message: "Invalid sort order. Must be 'asc' or 'desc'"
      });
    }

    // Parse pagination
    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    
    if (pageNum < 1 || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({
        success: false,
        message: "Invalid pagination parameters. Page must be >= 1, limit between 1 and 100"
      });
    }

    // Parse price filters
    const minPriceNum = minPrice ? parseFloat(minPrice as string) : undefined;
    const maxPriceNum = maxPrice ? parseFloat(maxPrice as string) : undefined;

    // Build options for service
    const options = {
      status: status as "PENDING" | "ACTIVE" | "REJECTED" | "DRAFT",
      search: search as string,
      category: category as string,
      minPrice: minPriceNum,
      maxPrice: maxPriceNum,
      sortBy: sortBy as string,
      sortOrder: sortOrder as "asc" | "desc",
      page: pageNum,
      limit: limitNum
    };

    const result = await VendorProductService.getMyProducts(vendorId, options);

    return res.json({ 
      success: true, 
      data: result.products,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
        hasNext: result.hasNext,
        hasPrev: result.hasPrev
      },
      filters: {
        applied: Object.keys(options).filter(key => options[key] !== undefined),
        status: options.status,
        search: options.search,
        category: options.category
      }
    });
  } catch (error: any) {
    console.error("Error fetching vendor products:", error);
    return res.status(500).json({ 
      success: false, 
      message: error.message || "Failed to fetch vendor products" 
    });
  }
},

  // ======================
  // Get single product (ownership verified)
  // ======================
  async getById(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account"
        });
      }

      const product = await VendorProductService.getById(id, vendorId);

      if (!product) {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found or access denied" 
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
  // Get vendor statistics
  // ======================
  async getStatistics(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account"
        });
      }

      const stats = await VendorProductService.getStatistics(vendorId);

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
  async getContentScoreOfVendorProduct(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account"
        });
      }

      const productcontentsummary = await VendorProductService.getProductsContentSummary(vendorId);

      return res.json({ 
        success: true, 
        data: productcontentsummary 
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
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account"
        });
      }

      const { images, shippingWarranty, ...productData } = req.body;

      // Validate required fields
      if (!productData.name || !productData.categoryId) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields: name, categoryId"
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

      const product = await VendorProductService.create({
        ...productData,
        vendorId, // Use vendorId from authenticated user
        images: formattedImages,
        shippingWarranty,
        userId: req.user?.id,
      });

      return res.status(201).json({ 
        success: true, 
        data: product,
        message: "Product created successfully and is pending approval" 
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
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account"
        });
      }

      const { images, shippingWarranty, ...updateData } = req.body;

      // Format images if provided
      const formattedImages = images && Array.isArray(images)
        ? images.map((img: any, idx: number) => ({
            url: typeof img === "string" ? img : img?.url,
            altText: img?.altText ?? `Product image ${idx + 1}`,
            sortOrder: img?.sortOrder ?? idx,
          }))
        : undefined;

      const product = await VendorProductService.update(id, vendorId, {
        ...updateData,
        images: formattedImages,
        shippingWarranty,
        userId: req.user?.id,
      });

      return res.json({ 
        success: true, 
        data: product,
        message: "Product updated successfully and is pending approval" 
      });
    } catch (error: any) {
      console.error("Error updating product:", error);
      
      if (error.message === "Product not found or unauthorized") {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found or access denied" 
        });
      }

      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to update product" 
      });
    }
  },

  // ======================
  // Delete product
  // ======================
  async remove(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account"
        });
      }

      await VendorProductService.remove(id, vendorId, req.user?.id);
      
      return res.json({ 
        success: true, 
        message: "Product deleted successfully",
        data: null 
      });
    } catch (error: any) {
      console.error("Error deleting product:", error);
      
      if (error.message === "Product not found or unauthorized") {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found or access denied" 
        });
      }

      return res.status(400).json({ 
        success: false, 
        message: error.message || "Failed to delete product" 
      });
    }
  },

  // ======================
  // Update product stock
  // ======================
  async updateStock(req: AuthRequest, res: Response) {
    try {
      const { id, variantId } = req.params;
      const { stock } = req.body;
      const vendorId = req.user?.vendorId;

      if (!vendorId) {
        return res.status(403).json({
          success: false,
          message: "User is not associated with a vendor account"
        });
      }

      if (stock === undefined || stock < 0) {
        return res.status(400).json({
          success: false,
          message: "Stock must be a non-negative number"
        });
      }

      const updatedVariant = await VendorProductService.updateStock(
        id,
        vendorId,
        variantId,
        stock
      );

      return res.json({
        success: true,
        data: updatedVariant,
        message: "Stock updated successfully"
      });
    } catch (error: any) {
      console.error("Error updating stock:", error);
      
      if (error.message === "Product not found or unauthorized") {
        return res.status(404).json({ 
          success: false, 
          message: "Product not found or access denied" 
        });
      }

      return res.status(400).json({
        success: false,
        message: error.message || "Failed to update stock"
      });
    }
  },
  async updatePrice(req: AuthRequest, res: Response) {
  try {
    const { id, variantId } = req.params;
    const { price, autoCalculateDiscount = true } = req.body;
    const vendorId = req.user?.vendorId;

    if (!vendorId) {
      return res.status(403).json({
        success: false,
        message: "User is not associated with a vendor account"
      });
    }

    if (price === undefined || typeof price !== 'number') {
      return res.status(400).json({
        success: false,
        message: "Price is required and must be a number"
      });
    }

    if (price < 0) {
      return res.status(400).json({
        success: false,
        message: "Price cannot be negative"
      });
    }

    const updatedVariant = await VendorProductService.updatePrice(
      id,
      vendorId,
      variantId,
      price,
      autoCalculateDiscount
    );

    return res.json({
      success: true,
      data: updatedVariant,
      message: "Price updated successfully"
    });
  } catch (error: any) {
    console.error("Error updating price:", error);
    
    if (error.message === "Product not found or unauthorized") {
      return res.status(404).json({ 
        success: false, 
        message: "Product not found or access denied" 
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message || "Failed to update price"
    });
  }
},
async updateSpecialPrice(req: AuthRequest, res: Response) {
  try {
    const { id, variantId } = req.params;
    const { specialPrice, autoCalculateDiscount = true } = req.body;
    const vendorId = req.user?.vendorId;

    if (!vendorId) {
      return res.status(403).json({
        success: false,
        message: "User is not associated with a vendor account"
      });
    }

    // Validate specialPrice (can be null to remove discount)
    if (specialPrice !== undefined && specialPrice !== null) {
      if (typeof specialPrice !== 'number') {
        return res.status(400).json({
          success: false,
          message: "Special price must be a number or null"
        });
      }

      if (specialPrice < 0) {
        return res.status(400).json({
          success: false,
          message: "Special price cannot be negative"
        });
      }
    }

    const updatedVariant = await VendorProductService.updateSpecialPrice(
      id,
      vendorId,
      variantId,
      specialPrice,
      autoCalculateDiscount
    );

    const message = specialPrice === null 
      ? "Special price removed successfully"
      : "Special price updated successfully";

    return res.json({
      success: true,
      data: updatedVariant,
      message
    });
  } catch (error: any) {
    console.error("Error updating special price:", error);
    
    if (error.message === "Product not found or unauthorized") {
      return res.status(404).json({ 
        success: false, 
        message: "Product not found or access denied" 
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message || "Failed to update special price"
    });
  }
}
};