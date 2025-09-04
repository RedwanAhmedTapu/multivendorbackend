import type { Request, Response } from "express";
import { ProductService } from "../services/product.service.ts";
// import redis from "../config/redis.ts";

export const ProductController = {
  async getAll(req: Request, res: Response) {
    try {
      const products = await ProductService.getAll();
      // await redis.set("products", JSON.stringify(products), { EX: 60 }); // cache 1 min
      res.json({ success: true, data: products });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const id = req.params.id;
      const product = await ProductService.getById(id);

      if (!product) {
        return res.status(404).json({ success: false, message: "Product not found" });
      }

      res.json({ success: true, data: product });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async create(req: Request, res: Response) {
    try {
      const product = await ProductService.create(req.body);
      // await redis.del("products"); // clear cache
      res.status(201).json({ success: true, data: product });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const id = req.params.id;
      const product = await ProductService.update(id, req.body);
      // await redis.del("products");
      res.json({ success: true, data: product });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async remove(req: Request, res: Response) {
    try {
      const id = req.params.id;
      await ProductService.remove(id);
      // await redis.del("products");
      res.json({ success: true, message: "Product deleted" });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async filter(req: Request, res: Response) {
    try {
      const filters = req.body; // { categoryId, attributes: [], specifications: [] }
      const products = await ProductService.filterProducts(filters);
      res.json({ success: true, data: products });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
