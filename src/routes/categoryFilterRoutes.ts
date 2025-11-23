// routes/categoryFilterRoutes.ts
import express from 'express';
import { param, query } from 'express-validator';
import { categoryFilterController } from '../controllers/categoryFilterController.ts';

const router = express.Router();

/**
 * ========================================
 * MULTIPLE CATEGORIES ROUTES (Must come before parameterized routes)
 * ========================================
 */

/**
 * @route   GET /api/categories/filters/multiple-slugs
 * @desc    Get combined filter data for multiple categories by their slugs
 * @access  Public
 * @query   categorySlugs - Comma-separated category slugs (max 10)
 * @example GET /api/categories/filters/multiple-slugs?categorySlugs=laptops,desktops,tablets
 * @response
 * {
 *   "success": true,
 *   "data": {
 *     "filters": {
 *       "attributes": [
 *         {
 *           "id": "attr_123",
 *           "name": "Brand",
 *           "slug": "brand",
 *           "type": "SELECT",
 *           "values": [
 *             { "id": "val_1", "value": "Apple", "productCount": 45 },
 *             { "id": "val_2", "value": "Dell", "productCount": 32 }
 *           ]
 *         }
 *       ],
 *       "specifications": [
 *         {
 *           "id": "spec_456",
 *           "name": "RAM",
 *           "slug": "ram",
 *           "type": "NUMBER",
 *           "unit": "GB",
 *           "values": [
 *             { "value": 8, "productCount": 20 },
 *             { "value": 16, "productCount": 35 }
 *           ]
 *         }
 *       ],
 *       "priceRange": { "min": 500, "max": 100000 }
 *     },
 *     "meta": {
 *       "totalProducts": 453,
 *       "categoriesProcessed": 3,
 *       "hasFilters": true
 *     }
 *   }
 * }
 */
router.get(
  '/filters/multiple-slugs',
  [
    query('categorySlugs')
      .notEmpty()
      .withMessage('Category slugs are required')
      .custom((value) => {
        if (typeof value === 'string') {
          const slugs = value.split(',').filter(slug => slug.trim());
          if (slugs.length === 0) {
            throw new Error('At least one category slug is required');
          }
          if (slugs.length > 10) {
            throw new Error('Maximum 10 categories allowed');
          }
          return true;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) {
            throw new Error('At least one category slug is required');
          }
          if (value.length > 10) {
            throw new Error('Maximum 10 categories allowed');
          }
          return true;
        }
        throw new Error('Category slugs must be a string or array');
      })
  ],
  categoryFilterController.getMultipleCategoriesFiltersBySlugs.bind(categoryFilterController)
);

/**
 * @route   GET /api/categories/filters/multiple
 * @desc    Get combined filter data for multiple categories by IDs
 *          Useful for "All Products" or multi-category browsing pages
 * @access  Public
 * @query   categoryIds - Comma-separated category IDs or array (max 10)
 * @example GET /api/categories/filters/multiple?categoryIds=cat_1,cat_2,cat_3
 * @response
 * {
 *   "success": true,
 *   "data": {
 *     "filters": {
 *       "attributes": [...],
 *       "specifications": [...],
 *       "priceRange": { "min": 500, "max": 100000 }
 *     },
 *     "meta": {
 *       "totalProducts": 453,
 *       "categoriesProcessed": 3,
 *       "hasFilters": true
 *     }
 *   }
 * }
 */
router.get(
  '/filters/multiple',
  [
    query('categoryIds')
      .notEmpty()
      .withMessage('Category IDs are required')
      .custom((value) => {
        if (typeof value === 'string') {
          const ids = value.split(',').filter(id => id.trim());
          if (ids.length === 0) {
            throw new Error('At least one category ID is required');
          }
          if (ids.length > 10) {
            throw new Error('Maximum 10 categories allowed');
          }
          return true;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) {
            throw new Error('At least one category ID is required');
          }
          if (value.length > 10) {
            throw new Error('Maximum 10 categories allowed');
          }
          return true;
        }
        throw new Error('Category IDs must be a string or array');
      })
  ],
  categoryFilterController.getMultipleCategoriesFilters.bind(categoryFilterController)
);

/**
 * ========================================
 * SINGLE CATEGORY ROUTES (BY SLUG)
 * ========================================
 */

/**
 * @route   GET /api/categories/slug/:slug/filters
 * @desc    Get filter data using category slug instead of ID (SEO-friendly)
 * @access  Public
 * @example GET /api/categories/slug/laptops/filters
 * @response
 * {
 *   "success": true,
 *   "data": {
 *     "category": {
 *       "id": "cat_abc123",
 *       "name": "Laptops",
 *       "slug": "laptops",
 *       "breadcrumb": [
 *         { "id": "cat_root", "name": "Electronics", "slug": "electronics", "level": 2 },
 *         { "id": "cat_parent", "name": "Computers", "slug": "computers", "level": 1 },
 *         { "id": "cat_abc123", "name": "Laptops", "slug": "laptops", "level": 0 }
 *       ]
 *     },
 *     "filters": {
 *       "attributes": [...],
 *       "specifications": [...],
 *       "priceRange": { "min": 45000, "max": 250000 }
 *     },
 *     "meta": {
 *       "totalProducts": 127,
 *       "hasFilters": true
 *     }
 *   }
 * }
 */
router.get(
  '/slug/:slug/filters',
  [
    param('slug')
      .notEmpty()
      .withMessage('Category slug is required')
      .isString()
      .withMessage('Category slug must be a string')
      .matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .withMessage('Invalid slug format')
  ],
  categoryFilterController.getCategoryFiltersBySlug.bind(categoryFilterController)
);

/**
 * ========================================
 * SINGLE CATEGORY ROUTES (BY ID)
 * ========================================
 */

/**
 * @route   GET /api/categories/:id/filters/summary
 * @desc    Get a summary of available filters (lightweight endpoint for UI hints)
 *          Returns only counts and meta info, not the full filter data
 * @access  Public
 * @example GET /api/categories/cat_abc123/filters/summary
 * @response
 * {
 *   "success": true,
 *   "data": {
 *     "attributeCount": 5,
 *     "specificationCount": 8,
 *     "totalFilterOptions": 67,
 *     "priceRange": { "min": 45000, "max": 250000 },
 *     "totalProducts": 127,
 *     "hasFilters": true
 *   }
 * }
 */
router.get(
  '/:id/filters/summary',
  [
    param('id')
      .notEmpty()
      .withMessage('Category ID is required')
      .isString()
      .withMessage('Category ID must be a string')
  ],
  categoryFilterController.getFilterSummary.bind(categoryFilterController)
);

/**
 * @route   GET /api/categories/:id/filters
 * @desc    Get complete filterable attributes, specifications, and price range for a category
 *          Includes all products from the category and its descendants (leaf categories)
 *          This is the main endpoint for building filter UI on product listing pages
 * @access  Public
 * @example GET /api/categories/cat_abc123/filters
 * @response
 * {
 *   "success": true,
 *   "data": {
 *     "category": {
 *       "id": "cat_abc123",
 *       "name": "Laptops",
 *       "slug": "laptops",
 *       "breadcrumb": [
 *         { "id": "cat_root", "name": "Electronics", "slug": "electronics", "level": 2 },
 *         { "id": "cat_parent", "name": "Computers", "slug": "computers", "level": 1 },
 *         { "id": "cat_abc123", "name": "Laptops", "slug": "laptops", "level": 0 }
 *       ]
 *     },
 *     "filters": {
 *       "attributes": [
 *         {
 *           "id": "attr_123",
 *           "name": "Brand",
 *           "slug": "brand",
 *           "type": "SELECT",
 *           "values": [
 *             { "id": "val_1", "value": "Apple", "productCount": 45 },
 *             { "id": "val_2", "value": "Dell", "productCount": 32 }
 *           ]
 *         }
 *       ],
 *       "specifications": [
 *         {
 *           "id": "spec_456",
 *           "name": "RAM",
 *           "slug": "ram",
 *           "type": "SELECT",
 *           "unit": "GB",
 *           "values": [
 *             { "value": 8, "productCount": 20 },
 *             { "value": 16, "productCount": 35 }
 *           ],
 *           "options": [
 *             { "id": "opt_1", "value": "8" },
 *             { "id": "opt_2", "value": "16" }
 *           ]
 *         }
 *       ],
 *       "priceRange": {
 *         "min": 45000,
 *         "max": 250000
 *       }
 *     },
 *     "meta": {
 *       "totalProducts": 127,
 *       "hasFilters": true
 *     }
 *   }
 * }
 */
router.get(
  '/:id/filters',
  [
    param('id')
      .notEmpty()
      .withMessage('Category ID is required')
      .isString()
      .withMessage('Category ID must be a string')
  ],
  categoryFilterController.getCategoryFilters.bind(categoryFilterController)
);

export default router;