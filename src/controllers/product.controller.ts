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
      return res.status(500).json({ success: false, message: error.message || "Failed to fetch products" });
    }
  },

  // ======================
  // Get product by ID
  // ======================
  async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const product = await ProductService.getById(id);

      if (!product) {
        return res.status(404).json({ success: false, message: "Product not found" });
      }

      return res.json({ success: true, data: product });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message || "Failed to fetch product" });
    }
  },

  // ======================
  // Create new product
  // ======================
async create( req: AuthRequest, res: Response) {
  try {
    const { images, shippingWarranty, ...productData } = req.body;

    const formattedImages = Array.isArray(images)
      ? images.map((img: any, idx: number) => ({
          url: typeof img === "string" ? img : img?.url,
          altText: img?.altText ?? `${productData.name || "Product"} image ${idx + 1}`,
          sortOrder: img?.sortOrder ?? idx,
        }))
      : [];

    const product = await ProductService.create({
      ...productData,
      images: formattedImages,
      shippingWarranty,               
      userId: req.user?.id,    
    });

    return res.status(201).json({ success: true, data: product });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message || "Failed to create product" });
  }
}
,

  // ======================
  // Update product
  // ======================
  async update(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const product = await ProductService.update(id, req.body);
      return res.json({ success: true, data: product });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message || "Failed to update product" });
    }
  },

  // ======================
  // Delete product
  // ======================
  async remove(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await ProductService.remove(id);
      return res.json({ success: true, message: "Product deleted successfully" });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message || "Failed to delete product" });
    }
  },

  // ======================
  // Filter products
  // ======================
  async filter(req: Request, res: Response) {
    try {
      const filters = req.body;
      // const products = await ProductService.filterProducts(filters);
      // return res.json({ success: true, data: products });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message || "Failed to filter products" });
    }
  },
};
