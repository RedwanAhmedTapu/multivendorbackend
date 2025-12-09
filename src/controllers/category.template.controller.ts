import type { Request, Response } from "express";
import { CategoryTemplateGenerator } from "../utils/excelTemplates/categoryTemplateGenerator.ts";
import type { TemplateOptions } from "../utils/excelTemplates/categoryTemplateGenerator.ts";

export const TemplateController = {
  /**
   * Download standard category template
   */
  async downloadStandardTemplate(req: Request, res: Response) {
    try {
      const options: TemplateOptions = {
        templateType: 'standard',
        maxLevels: req.query.maxLevels ? parseInt(req.query.maxLevels as string) : 5,
        includeAttributes: req.query.includeAttributes ? parseInt(req.query.includeAttributes as string) : 3,
      };

      // Generate workbook buffer
      const buffer = CategoryTemplateGenerator.generateWorkbookBuffer(options);
      
      // Set headers for file download
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="category_template_standard.xlsx"');
      res.setHeader('Content-Length', buffer.length);
      
      // Send the buffer
      res.send(buffer);
    } catch (error: any) {
      console.error("Error generating template:", error);
      res.status(500).json({ 
        success: false, 
        message: "Failed to generate template", 
        error: error.message 
      });
    }
  },

  /**
   * Download custom category template
   */
  async downloadCustomTemplate(req: Request, res: Response) {
    try {
      const options: TemplateOptions = {
        templateType: 'custom',
        maxLevels: req.query.maxLevels ? parseInt(req.query.maxLevels as string) : 10,
        includeAttributes: req.query.includeAttributes ? parseInt(req.query.includeAttributes as string) : 2,
      };

      // Validate max levels
      if (options.maxLevels && (options.maxLevels < 1 || options.maxLevels > 15)) {
        return res.status(400).json({
          success: false,
          message: "maxLevels must be between 1 and 15"
        });
      }

      // Generate workbook buffer
      const buffer = CategoryTemplateGenerator.generateWorkbookBuffer(options);
      
      // Set headers for file download
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="category_template_${options.maxLevels}levels.xlsx"`);
      res.setHeader('Content-Length', buffer.length);
      
      // Send the buffer
      res.send(buffer);
    } catch (error: any) {
      console.error("Error generating template:", error);
      res.status(500).json({ 
        success: false, 
        message: "Failed to generate template", 
        error: error.message 
      });
    }
  },

  /**
   * Get template information/metadata
   */
  async getTemplateInfo(req: Request, res: Response) {
    try {
      const info = {
        description: "Category Bulk Upload Template",
        rules: {
          image: "Applied to ROOT (Level 1) category only",
          keywords: "Applied to LEAF (deepest/last) category only",
          tags: "Applied to LEAF (deepest/last) category only",
          attributes: "Linked to LEAF (deepest/last) category only"
        },
        availableTemplates: [
          {
            name: "Standard Template",
            endpoint: "/api/templates/download/standard",
            description: "Includes 5 examples with 3-5 levels and 3 attributes each",
            parameters: {
              maxLevels: "?maxLevels=5 (1-10, default: 5)",
              includeAttributes: "?includeAttributes=3 (1-5, default: 3)"
            }
          },
          {
            name: "Custom Template",
            endpoint: "/api/templates/download/custom",
            description: "Customizable template with specified number of levels",
            parameters: {
              maxLevels: "?maxLevels=10 (1-15, default: 10)",
              includeAttributes: "?includeAttributes=2 (1-5, default: 2)"
            }
          }
        ]
      };

      res.json({
        success: true,
        data: info
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to get template info",
        error: error.message
      });
    }
  }
};