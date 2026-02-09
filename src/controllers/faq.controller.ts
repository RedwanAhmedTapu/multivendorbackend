// ==================== controllers/faq.controller.ts ====================
import type { Request, Response } from 'express';
import { FaqService } from '../services/faq.service.ts';

const faqService = new FaqService();

export class FaqController {
  // Get all FAQs
  async getAllFaqs(req: Request, res: Response) {
    try {
      const query = {
        category: req.query.category as string,
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
        search: req.query.search as string,
        page: parseInt(req.query.page as string) || 1,
        limit: parseInt(req.query.limit as string) || 10
      };

      const result = await faqService.getAllFaqs(query);
      console.log(query,"q")

      console.log(result,"r")

      return res.status(200).json({
        success: true,
        data: result.faqs,
        pagination: result.pagination
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch FAQs',
        error: error.message
      });
    }
  }

  // Get FAQ by ID
  async getFaqById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const faq = await faqService.getFaqById(id);

      return res.status(200).json({
        success: true,
        data: faq
      });
    } catch (error: any) {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get FAQs by category
  async getFaqsByCategory(req: Request, res: Response) {
    try {
      const { category } = req.params;
      const faqs = await faqService.getFaqsByCategory(category);

      return res.status(200).json({
        success: true,
        data: faqs
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch FAQs by category',
        error: error.message
      });
    }
  }

  // Get all categories
  async getCategories(req: Request, res: Response) {
    try {
      const categories = await faqService.getCategories();

      return res.status(200).json({
        success: true,
        data: categories
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch categories',
        error: error.message
      });
    }
  }

  // Create FAQ
  async createFaq(req: Request, res: Response) {
    try {
      const { category, question, answer, isActive, orderIndex } = req.body;

      // Validation
      if (!category || !question || !answer || isActive === undefined) {
        return res.status(400).json({
          success: false,
          message: 'Category, question, answer, and isActive are required'
        });
      }

      const faq = await faqService.createFaq({
        category,
        question,
        answer,
        isActive,
        orderIndex
      });

      return res.status(201).json({
        success: true,
        message: 'FAQ created successfully',
        data: faq
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to create FAQ',
        error: error.message
      });
    }
  }

  // Update FAQ
  async updateFaq(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const updateData = req.body;

      const faq = await faqService.updateFaq(id, updateData);

      return res.status(200).json({
        success: true,
        message: 'FAQ updated successfully',
        data: faq
      });
    } catch (error: any) {
      return res.status(error.message === 'FAQ not found' ? 404 : 500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Delete FAQ
  async deleteFaq(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await faqService.deleteFaq(id);

      return res.status(200).json({
        success: true,
        message: 'FAQ deleted successfully'
      });
    } catch (error: any) {
      return res.status(error.message === 'FAQ not found' ? 404 : 500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Bulk update order
  async updateFaqOrder(req: Request, res: Response) {
    try {
      const { updates } = req.body;

      if (!Array.isArray(updates)) {
        return res.status(400).json({
          success: false,
          message: 'Updates must be an array'
        });
      }

      await faqService.updateFaqOrder(updates);

      return res.status(200).json({
        success: true,
        message: 'FAQ order updated successfully'
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to update FAQ order',
        error: error.message
      });
    }
  }

  // Toggle FAQ status
  async toggleFaqStatus(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const faq = await faqService.toggleFaqStatus(id);

      return res.status(200).json({
        success: true,
        message: 'FAQ status toggled successfully',
        data: faq
      });
    } catch (error: any) {
      return res.status(error.message === 'FAQ not found' ? 404 : 500).json({
        success: false,
        message: error.message
      });
    }
  }
}