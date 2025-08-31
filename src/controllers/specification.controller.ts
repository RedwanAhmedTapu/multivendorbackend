// controllers/specification.controller.ts
import type { Request, Response } from "express";
import { SpecificationService } from "../services/specification.service.ts";

export const SpecificationController = {
  async getAll(req: Request, res: Response) {
    try {
      const specifications = await SpecificationService.getAll(req.params.categoryId);
      res.json(specifications);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  },

  async create(req: Request, res: Response) {
    try {
      const specification = await SpecificationService.create(req.body);
      res.status(201).json(specification);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const specification = await SpecificationService.update(req.params.id, req.body);
      res.json(specification);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },

  async delete(req: Request, res: Response) {
    try {
      await SpecificationService.delete(req.params.id);
      res.json({ message: "Specification deleted successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },
};