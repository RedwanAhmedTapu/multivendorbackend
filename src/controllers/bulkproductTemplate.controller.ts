import type { Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { TemplateService } from '../services/bulkproductTemplate.service.ts';

const prisma = new PrismaClient();

export class TemplateController {
  private templateService: TemplateService;

  constructor() {
    this.templateService = new TemplateService();
  }

  async generateTemplate(req: Request, res: Response) {
    try {
      const { categoryId } = req.params;

      if (!categoryId) {
        return res.status(400).json({ message: 'Category ID is required' });
      }

      const { filePath, templateRecord } = await this.templateService.generateExcelTemplate(categoryId);

      res.status(200).json({
        message: 'Template generated successfully',
        filePath,
        templateRecord,
      });
    } catch (error: any) {
      console.error('Error in generateTemplate:', error);
      
      if (error.message.includes('not found')) {
        return res.status(404).json({ message: error.message });
      }
      
      if (error.message.includes('not a leaf category')) {
        return res.status(400).json({ message: error.message });
      }

      res.status(500).json({ 
        message: 'Error generating template', 
        error: error.message 
      });
    }
  }

  async downloadTemplate(req: Request, res: Response) {
    try {
      const { categoryId } = req.params;

      if (!categoryId) {
        return res.status(400).json({ message: 'Category ID is required' });
      }

      // Validate category exists and is a leaf category
      const category = await prisma.category.findUnique({
        where: { id: categoryId },
        include: { children: true },
      });

      if (!category) {
        return res.status(404).json({ message: 'Category not found' });
      }

      if (category.children && category.children.length > 0) {
        return res.status(400).json({ 
          message: 'Cannot download template for parent category. Please select a leaf category (one without sub-categories).' 
        });
      }

      // Find the template for this category
      const template = await prisma.categoryTemplate.findUnique({
        where: { categoryId },
      });

      if (!template || !template.filePath) {
        return res.status(404).json({ 
          message: 'Template not found. Please generate the template first.' 
        });
      }

      // Check if file exists on disk
      try {
        await fs.access(template.filePath);
      } catch {
        return res.status(404).json({ 
          message: 'Template file not found on server. Please regenerate the template.' 
        });
      }

      // Get file name from path
      const fileName = path.basename(template.filePath);

      // Set response headers for file download
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );
      res.setHeader(
        'Cache-Control',
        'no-cache, no-store, must-revalidate'
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      // Read and send the file
      const fileBuffer = await fs.readFile(template.filePath);
      res.send(fileBuffer);
      
    } catch (error: any) {
      console.error('Error in downloadTemplate:', error);
      res.status(500).json({ 
        message: 'Error downloading template', 
        error: error.message 
      });
    } finally {
      await prisma.$disconnect();
    }
  }

  async deleteTemplate(req: Request, res: Response) {
    try {
      const { categoryId } = req.params;

      if (!categoryId) {
        return res.status(400).json({ message: 'Category ID is required' });
      }

      const template = await prisma.categoryTemplate.findUnique({
        where: { categoryId },
      });

      if (!template) {
        return res.status(404).json({ message: 'Template not found' });
      }

      // Delete file from disk if it exists
      try {
        await fs.unlink(template.filePath);
      } catch (error) {
        console.warn('File not found on disk, continuing with database deletion:', error);
      }

      // Delete database record
      await prisma.categoryTemplate.delete({
        where: { categoryId },
      });

      res.status(200).json({ 
        message: 'Template deleted successfully' 
      });
      
    } catch (error: any) {
      console.error('Error in deleteTemplate:', error);
      res.status(500).json({ 
        message: 'Error deleting template', 
        error: error.message 
      });
    } finally {
      await prisma.$disconnect();
    }
  }

  async listTemplates(req: Request, res: Response) {
    try {
      const templates = await prisma.categoryTemplate.findMany({
        include: {
          category: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
        orderBy: {
          updatedAt: 'desc',
        },
      });

      res.status(200).json({ 
        message: 'Templates retrieved successfully',
        templates 
      });
      
    } catch (error: any) {
      console.error('Error in listTemplates:', error);
      res.status(500).json({ 
        message: 'Error retrieving templates', 
        error: error.message 
      });
    } finally {
      await prisma.$disconnect();
    }
  }
}