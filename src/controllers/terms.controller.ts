import type { Request, Response } from "express";
import { TermsService } from "../services/terms.service.ts";
import type { TermsType } from "@prisma/client";

export const TermsController = {
  async create(req: Request, res: Response) {
    try {
      const { title, slug, content, version, type, language, metaTitle, metaDesc } = req.body;
      const userId = req.user?.id; 

      const terms = await TermsService.create({
        title,
        slug,
        content,
        version,
        type,
        language,
        createdById: userId,
        metaTitle,
        metaDesc,
      });

      res.json(terms);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const userId = req.user?.id;

      const terms = await TermsService.update(id, req.body, userId);
      res.json(terms);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  async publish(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const userId = req.user?.id;

      const terms = await TermsService.publish(id, userId);
      res.json(terms);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  async setActive(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { type } = req.body;

      const terms = await TermsService.setActive(id, type as TermsType);
      res.json(terms);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  async getActive(req: Request, res: Response) {
    try {
      const type = req.query.type as TermsType;
      console.log(type)
      const terms = await TermsService.getActive(type);
      res.json(terms);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

 async list(req: Request, res: Response) {
  try {
    const { type, isPublished } = req.query;

    // Build filter object dynamically
    const filters: any = {};
    if (type) {
      filters.type = type as TermsType;
    }
    if (isPublished !== undefined) {
      filters.isPublished = isPublished === "true";
    }

    const terms = await TermsService.list(filters);
    res.json(terms);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
}
,

  async delete(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await TermsService.delete(id);
      res.json({ message: "Deleted successfully" });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },
};
