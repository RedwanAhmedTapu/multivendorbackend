// controllers/categoryFilterController.ts
import type { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import { 
  categoryFilterService,
   
} from '../services/categoryFilterService.ts';
import type { CategoryFilterResponse } from '../services/categoryFilterService.ts';

const prisma = new PrismaClient();

// ===========================
// RESPONSE TYPE DEFINITIONS
// ===========================

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
}

interface ApiErrorResponse {
  success: false;
  error: string;
  message?: string;
  details?: any;
}

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export class CategoryFilterController {
  
  /**
   * Get filter data for a specific category
   * @route GET /api/categories/:id/filters
   */
  async getCategoryFilters(req: Request, res: Response): Promise<void> {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const response: ApiErrorResponse = {
          success: false,
          error: 'Validation failed',
          details: errors.array()
        };
        res.status(400).json(response);
        return;
      }

      const { id } = req.params;

      // Get filter data
      const filterData = await categoryFilterService.getCategoryFilterData(id);

      const response: ApiSuccessResponse<CategoryFilterResponse> = {
        success: true,
        data: filterData,
        message: 'Filter data retrieved successfully'
      };

      res.json(response);

    } catch (error: any) {
      console.error('Get category filters error:', error);

      let statusCode = 500;
      let errorMessage = 'Failed to retrieve filter data';

      // Handle specific errors
      if (error.message === 'Category not found') {
        statusCode = 404;
        errorMessage = 'Category not found';
      }

      // Handle Prisma errors
      if (error.code === 'P2025') {
        statusCode = 404;
        errorMessage = 'Category not found';
      }

      const response: ApiErrorResponse = {
        success: false,
        error: errorMessage,
        ...(process.env.NODE_ENV === 'development' && { 
          message: error.message,
          details: error.stack 
        })
      };

      res.status(statusCode).json(response);
    }
  }

  /**
   * Get filter data by category slug
   * @route GET /api/categories/slug/:slug/filters
   */
  async getCategoryFiltersBySlug(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const response: ApiErrorResponse = {
          success: false,
          error: 'Validation failed',
          details: errors.array()
        };
        res.status(400).json(response);
        return;
      }

      const { slug } = req.params;
      console.log(slug,"null")

      // First, find the category by slug
      const category = await prisma.category.findUnique({
        where: { slug },
        select: { id: true }
      });

      if (!category) {
        const response: ApiErrorResponse = {
          success: false,
          error: 'Category not found'
        };
        res.status(404).json(response);
        return;
      }

      // Get filter data using category ID
      const filterData = await categoryFilterService.getCategoryFilterData(category.id);

      const response: ApiSuccessResponse<CategoryFilterResponse> = {
        success: true,
        data: filterData,
        message: 'Filter data retrieved successfully'
      };

      res.json(response);

    } catch (error: any) {
      console.error('Get category filters by slug error:', error);

      const response: ApiErrorResponse = {
        success: false,
        error: 'Failed to retrieve filter data',
        ...(process.env.NODE_ENV === 'development' && { 
          message: error.message 
        })
      };

      res.status(500).json(response);
    }
  }

  /**
   * Get combined filter data for multiple categories
   * @route GET /api/categories/filters/multiple
   * @query categoryIds - Comma-separated category IDs or array
   */
  async getMultipleCategoriesFilters(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const response: ApiErrorResponse = {
          success: false,
          error: 'Validation failed',
          details: errors.array()
        };
        res.status(400).json(response);
        return;
      }

      const { categoryIds } = req.query;

      // Parse category IDs
      let categoryIdsArray: string[] = [];
      
      if (typeof categoryIds === 'string') {
        categoryIdsArray = categoryIds
          .split(',')
          .map(id => id.trim())
          .filter(id => id.length > 0);
      } else if (Array.isArray(categoryIds)) {
        categoryIdsArray = categoryIds
          .filter(id => typeof id === 'string')
          .map(id => id.trim())
          .filter(id => id.length > 0);
      }

      // Validate category IDs
      if (categoryIdsArray.length === 0) {
        const response: ApiErrorResponse = {
          success: false,
          error: 'No valid category IDs provided',
          message: 'Please provide at least one category ID'
        };
        res.status(400).json(response);
        return;
      }

      if (categoryIdsArray.length > 10) {
        const response: ApiErrorResponse = {
          success: false,
          error: 'Too many categories',
          message: 'Maximum 10 categories allowed per request'
        };
        res.status(400).json(response);
        return;
      }

      // Get combined filter data
      const filterData = await categoryFilterService.getMultipleCategoriesFilterData(
        categoryIdsArray
      );

      const response: ApiSuccessResponse<typeof filterData> = {
        success: true,
        data: filterData,
        message: 'Combined filter data retrieved successfully'
      };

      res.json(response);

    } catch (error: any) {
      console.error('Get multiple categories filters error:', error);

      const response: ApiErrorResponse = {
        success: false,
        error: 'Failed to retrieve filter data',
        ...(process.env.NODE_ENV === 'development' && { 
          message: error.message 
        })
      };

      res.status(500).json(response);
    }
  }

  /**
   * Get available filter counts (for UI hints)
   * @route GET /api/categories/:id/filters/summary
   */
  async getFilterSummary(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const filterData = await categoryFilterService.getCategoryFilterData(id);

      const summary = {
        attributeCount: filterData.filters.attributes.length,
        specificationCount: filterData.filters.specifications.length,
        totalFilterOptions: 
          filterData.filters.attributes.reduce((sum, attr) => sum + attr.values.length, 0) +
          filterData.filters.specifications.reduce((sum, spec) => sum + spec.values.length, 0),
        priceRange: filterData.filters.priceRange,
        totalProducts: filterData.meta.totalProducts,
        hasFilters: filterData.meta.hasFilters
      };

      const response: ApiSuccessResponse<typeof summary> = {
        success: true,
        data: summary,
        message: 'Filter summary retrieved successfully'
      };

      res.json(response);

    } catch (error: any) {
      console.error('Get filter summary error:', error);

      let statusCode = 500;
      let errorMessage = 'Failed to retrieve filter summary';

      if (error.message === 'Category not found') {
        statusCode = 404;
        errorMessage = 'Category not found';
      }

      const response: ApiErrorResponse = {
        success: false,
        error: errorMessage,
        ...(process.env.NODE_ENV === 'development' && { 
          message: error.message 
        })
      };

      res.status(statusCode).json(response);
    }
  }

  /**
   * Get filter data for multiple categories by slugs
   * @route GET /api/categories/filters/multiple-slugs
   * @query categorySlugs - Comma-separated category slugs
   */
  async getMultipleCategoriesFiltersBySlugs(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const response: ApiErrorResponse = {
          success: false,
          error: 'Validation failed',
          details: errors.array()
        };
        res.status(400).json(response);
        return;
      }

      const { categorySlugs } = req.query;

      // Parse category slugs
      let categorySlugsArray: string[] = [];
      
      if (typeof categorySlugs === 'string') {
        categorySlugsArray = categorySlugs
          .split(',')
          .map(slug => slug.trim())
          .filter(slug => slug.length > 0);
      } else if (Array.isArray(categorySlugs)) {
        categorySlugsArray = categorySlugs
          .filter(slug => typeof slug === 'string')
          .map(slug => slug.trim())
          .filter(slug => slug.length > 0);
      }

      if (categorySlugsArray.length === 0) {
        const response: ApiErrorResponse = {
          success: false,
          error: 'No valid category slugs provided'
        };
        res.status(400).json(response);
        return;
      }

      if (categorySlugsArray.length > 10) {
        const response: ApiErrorResponse = {
          success: false,
          error: 'Too many categories',
          message: 'Maximum 10 categories allowed per request'
        };
        res.status(400).json(response);
        return;
      }

      // Find categories by slugs
      const categories = await prisma.category.findMany({
        where: { slug: { in: categorySlugsArray } },
        select: { id: true, slug: true }
      });

      if (categories.length === 0) {
        const response: ApiErrorResponse = {
          success: false,
          error: 'No categories found with provided slugs'
        };
        res.status(404).json(response);
        return;
      }

      const categoryIds = categories.map(cat => cat.id);

      // Get combined filter data
      const filterData = await categoryFilterService.getMultipleCategoriesFilterData(
        categoryIds
      );

      const response: ApiSuccessResponse<typeof filterData> = {
        success: true,
        data: filterData,
        message: 'Combined filter data retrieved successfully'
      };

      res.json(response);

    } catch (error: any) {
      console.error('Get multiple categories filters by slugs error:', error);

      const response: ApiErrorResponse = {
        success: false,
        error: 'Failed to retrieve filter data',
        ...(process.env.NODE_ENV === 'development' && { 
          message: error.message 
        })
      };

      res.status(500).json(response);
    }
  }
}

export const categoryFilterController = new CategoryFilterController();