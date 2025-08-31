import type { Request, Response } from "express";
import { ProductService } from "../services/product.service.ts";
// import redis from "../config/redis.ts";

export const ProductController = {
  async getAll(req: Request, res: Response) {
    const products = await ProductService.getAll();
    // await redis.set("products", JSON.stringify(products), { EX: 60 }); // cache 1 min
    res.json(products);
  },

  async getById(req: Request, res: Response) {
    const id = req.params.id;
    const product = await ProductService.getById(id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(product);
  },

  async create(req: Request, res: Response) {
    const product = await ProductService.create(req.body);
    // await redis.del("products"); // clear cache
    res.status(201).json(product);
  },

  async update(req: Request, res: Response) {
    const id = req.params.id;
    const product = await ProductService.update(id, req.body);
    // await redis.del("products");
    res.json(product);
  },

  async remove(req: Request, res: Response) {
    const id = req.params.id;
    await ProductService.remove(id);
    // await redis.del("products");
    res.json({ message: "Product deleted" });
  },
};
