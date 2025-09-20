// controllers/attribute.controller.ts
import type { Request, Response } from "express";
import { AttributeService } from "../services/attribute.service.ts";

export const AttributeController = {
  async getAllGlobal(req: Request, res: Response) {
    try {
      const attributes = await AttributeService.getAllGlobal();
      res.json(attributes);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  },
  async getAll(req: Request, res: Response) {
    try {
      const attributes = await AttributeService.getAll(req.params.categoryId);
      res.json(attributes);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  },

  async create(req: Request, res: Response) {
    try {
      const attribute = await AttributeService.create(req.body);
      res.status(201).json(attribute);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const attribute = await AttributeService.update(req.params.id, req.body);
      res.json(attribute);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },

  async delete(req: Request, res: Response) {
    console.log(req.params.id);
    try {
      await AttributeService.delete(req.params.id);
      res.json({ message: "Attribute deleted successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },

  async addValue(req: Request, res: Response) {
    try {
      const { value } = req.body;
      const attributeValue = await AttributeService.addValue(req.params.attributeId, value);
      res.status(201).json(attributeValue);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },

  async deleteValue(req: Request, res: Response) {
    try {
      await AttributeService.deleteValue(req.params.id);
      res.json({ message: "Attribute value deleted successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  },
};