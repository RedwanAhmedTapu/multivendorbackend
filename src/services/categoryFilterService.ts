// services/categoryFilterService.ts
import { PrismaClient } from '@prisma/client';

// ===========================
// TYPE DEFINITIONS
// ===========================

export interface FilterableAttributeValue {
  id: string;
  value: string;
  productCount: number;
}

export interface FilterableAttribute {
  id: string;
  name: string;
  slug: string;
  type: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT';
  values: FilterableAttributeValue[];
}

export interface FilterableSpecificationValue {
  value: string | number;
  productCount: number;
}

export interface FilterableSpecification {
  id: string;
  name: string;
  slug: string;
  type: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT';
  unit?: string;
  values: FilterableSpecificationValue[];
  options?: Array<{ id: string; value: string }>;
}

export interface PriceRange {
  min: number;
  max: number;
}

export interface CategoryHierarchy {
  id: string;
  name: string;
  slug: string;
  level: number;
}

export interface CategoryFilterResponse {
  category: {
    id: string;
    name: string;
    slug: string;
    breadcrumb: CategoryHierarchy[];
  };
  filters: {
    attributes: FilterableAttribute[];
    specifications: FilterableSpecification[];
    priceRange: PriceRange;
  };
  meta: {
    totalProducts: number;
    hasFilters: boolean;
  };
}

const prisma = new PrismaClient();

export class CategoryFilterService {
  
  /**
   * Get all descendant category IDs (children, grandchildren, etc.)
   */
  private async getDescendantCategoryIds(categoryId: string): Promise<string[]> {
    const descendants: string[] = [];
    
    const findDescendants = async (parentId: string) => {
      const children = await prisma.category.findMany({
        where: { parentId },
        select: { id: true }
      });
      
      for (const child of children) {
        descendants.push(child.id);
        await findDescendants(child.id);
      }
    };
    
    await findDescendants(categoryId);
    return descendants;
  }

  /**
   * Get parent category hierarchy (breadcrumb)
   */
  private async getCategoryBreadcrumb(categoryId: string): Promise<CategoryHierarchy[]> {
    const breadcrumb: CategoryHierarchy[] = [];
    let currentId: string | null = categoryId;
    let level = 0;
    
    while (currentId) {
      const category: { id: string; name: string; slug: string; parentId: string | null } | null = await prisma.category.findUnique({
        where: { id: currentId },
        select: {
          id: true,
          name: true,
          slug: true,
          parentId: true
        }
      });
      
      if (!category) break;
      
      breadcrumb.unshift({
        id: category.id,
        name: category.name,
        slug: category.slug,
        level
      });
      
      currentId = category.parentId;
      level++;
    }
    
    return breadcrumb;
  }

  /**
   * Get ALL category IDs including the parent and ALL descendants
   */
  private async getAllCategoryIds(categoryId: string): Promise<string[]> {
    const allDescendants = await this.getDescendantCategoryIds(categoryId);
    return [categoryId, ...allDescendants];
  }

  /**
   * SIMPLIFIED: Get ALL filterable attributes for categories without product association checks
   */
  private async getFilterableAttributes(
    categoryIds: string[]
  ): Promise<FilterableAttribute[]> {
    try {
      // Get ALL category attributes for these categories
      const categoryAttributes = await prisma.categoryAttribute.findMany({
        where: {
          categoryId: { in: categoryIds },
        },
        include: {
          attribute: {
            include: {
              values: true
            }
          }
        }
      });

      // If no category attributes found, return empty array
      if (categoryAttributes.length === 0) {
        return [];
      }

      // Group by attribute to avoid duplicates
      const attributeMap = new Map<string, FilterableAttribute>();

      for (const ca of categoryAttributes) {
        const attr = ca.attribute;
        
        if (!attributeMap.has(attr.id)) {
          attributeMap.set(attr.id, {
            id: attr.id,
            name: attr.name,
            slug: attr.slug,
            type: attr.type as any,
            values: attr.values.map(av => ({
              id: av.id,
              value: av.value,
              productCount: 0 // Simplified: Don't count products
            }))
          });
        }
      }

      return Array.from(attributeMap.values());
    } catch (error) {
      console.error('Error in getFilterableAttributes:', error);
      return [];
    }
  }

  /**
   * SIMPLIFIED: Get ALL filterable specifications for categories without product association checks
   */
  private async getFilterableSpecifications(
    categoryIds: string[]
  ): Promise<FilterableSpecification[]> {
    try {
      // Get ALL category specifications for these categories
      const categorySpecs = await prisma.categorySpecification.findMany({
        where: {
          categoryId: { in: categoryIds },
        },
        include: {
          specification: {
            include: {
              options: true
            }
          }
        }
      });

      // If no category specifications found, return empty array
      if (categorySpecs.length === 0) {
        return [];
      }

      // Group by specification to avoid duplicates
      const specMap = new Map<string, FilterableSpecification>();

      for (const cs of categorySpecs) {
        const spec = cs.specification;
        
        if (!specMap.has(spec.id)) {
          specMap.set(spec.id, {
            id: spec.id,
            name: spec.name,
            slug: spec.slug,
            type: spec.type as any,
            unit: spec.unit || undefined,
            values: [], // Simplified: No product-specific values
            options: spec.type === 'SELECT' ? spec.options.map(opt => ({ 
              id: opt.id, 
              value: opt.value 
            })) : undefined
          });
        }
      }

      return Array.from(specMap.values());
    } catch (error) {
      console.error('Error in getFilterableSpecifications:', error);
      return [];
    }
  }

  /**
   * Get price range for products in categories
   */
  private async getPriceRange(categoryIds: string[]): Promise<PriceRange> {
    try {
      const priceData = await prisma.productVariant.aggregate({
        where: {
          product: {
            categoryId: { in: categoryIds },
            approvalStatus: 'ACTIVE'
          }
        },
        _min: { price: true },
        _max: { price: true }
      });

      return {
        min: Math.floor(priceData._min.price || 0),
        max: Math.ceil(priceData._max.price || 10000)
      };
    } catch (error) {
      console.error('Error in getPriceRange:', error);
      return {
        min: 0,
        max: 10000
      };
    }
  }

  /**
   * Get total product count
   */
  private async getProductCount(categoryIds: string[]): Promise<number> {
    try {
      return await prisma.product.count({
        where: {
          categoryId: { in: categoryIds },
          approvalStatus: 'ACTIVE'
        }
      });
    } catch (error) {
      console.error('Error in getProductCount:', error);
      return 0;
    }
  }

  /**
   * Main method: Get complete filter data for a category - SIMPLIFIED VERSION
   */
  async getCategoryFilterData(categoryId: string): Promise<CategoryFilterResponse> {
    try {
      // Verify category exists
      const category = await prisma.category.findUnique({
        where: { id: categoryId },
        select: { id: true, name: true, slug: true }
      });

      if (!category) {
        throw new Error('Category not found');
      }

      // Get ALL category IDs (including the selected category and ALL descendants)
      const allCategoryIds = await this.getAllCategoryIds(categoryId);
      
      // Get breadcrumb
      const breadcrumb = await this.getCategoryBreadcrumb(categoryId);

      // Fetch all filter data in parallel
      const [attributes, specifications, priceRange, totalProducts] = await Promise.all([
        this.getFilterableAttributes(allCategoryIds),
        this.getFilterableSpecifications(allCategoryIds),
        this.getPriceRange(allCategoryIds),
        this.getProductCount(allCategoryIds)
      ]);

      return {
        category: {
          id: category.id,
          name: category.name,
          slug: category.slug,
          breadcrumb
        },
        filters: {
          attributes,
          specifications,
          priceRange
        },
        meta: {
          totalProducts,
          hasFilters: attributes.length > 0 || specifications.length > 0
        }
      };
    } catch (error) {
      console.error('Error in getCategoryFilterData:', error);
      throw error;
    }
  }

  /**
   * Get filter data for multiple categories (for multi-category pages) - SIMPLIFIED VERSION
   */
  async getMultipleCategoriesFilterData(
    categoryIds: string[]
  ): Promise<{
    filters: {
      attributes: FilterableAttribute[];
      specifications: FilterableSpecification[];
      priceRange: PriceRange;
    };
    meta: {
      totalProducts: number;
      categoriesProcessed: number;
      hasFilters: boolean;
    };
  }> {
    try {
      // Get ALL category IDs for all provided categories
      const allCategoryIds = new Set<string>();
      
      for (const categoryId of categoryIds) {
        const categoryIdsForThis = await this.getAllCategoryIds(categoryId);
        categoryIdsForThis.forEach(id => allCategoryIds.add(id));
      }

      const allCategoryIdsArray = Array.from(allCategoryIds);

      if (allCategoryIdsArray.length === 0) {
        return {
          filters: {
            attributes: [],
            specifications: [],
            priceRange: { min: 0, max: 10000 }
          },
          meta: {
            totalProducts: 0,
            categoriesProcessed: categoryIds.length,
            hasFilters: false
          }
        };
      }

      // Fetch combined filter data
      const [attributes, specifications, priceRange, totalProducts] = await Promise.all([
        this.getFilterableAttributes(allCategoryIdsArray),
        this.getFilterableSpecifications(allCategoryIdsArray),
        this.getPriceRange(allCategoryIdsArray),
        this.getProductCount(allCategoryIdsArray)
      ]);

      return {
        filters: {
          attributes,
          specifications,
          priceRange
        },
        meta: {
          totalProducts,
          categoriesProcessed: categoryIds.length,
          hasFilters: attributes.length > 0 || specifications.length > 0
        }
      };
    } catch (error) {
      console.error('Error in getMultipleCategoriesFilterData:', error);
      throw error;
    }
  }

  /**
   * Get filter data for display categories (limited to 3 levels)
   */
  async getDisplayCategoryFilterData(categoryId: string, maxLevels: number = 3): Promise<CategoryFilterResponse> {
    try {
      // Verify category exists
      const category = await prisma.category.findUnique({
        where: { id: categoryId },
        select: { id: true, name: true, slug: true }
      });

      if (!category) {
        throw new Error('Category not found');
      }

      // Get categories up to the specified level depth
      const displayCategoryIds = await this.getCategoriesUpToLevel(categoryId, maxLevels);
      
      // Get breadcrumb
      const breadcrumb = await this.getCategoryBreadcrumb(categoryId);

      // Fetch all filter data in parallel
      const [attributes, specifications, priceRange, totalProducts] = await Promise.all([
        this.getFilterableAttributes(displayCategoryIds),
        this.getFilterableSpecifications(displayCategoryIds),
        this.getPriceRange(displayCategoryIds),
        this.getProductCount(displayCategoryIds)
      ]);

      return {
        category: {
          id: category.id,
          name: category.name,
          slug: category.slug,
          breadcrumb
        },
        filters: {
          attributes,
          specifications,
          priceRange
        },
        meta: {
          totalProducts,
          hasFilters: attributes.length > 0 || specifications.length > 0
        }
      };
    } catch (error) {
      console.error('Error in getDisplayCategoryFilterData:', error);
      throw error;
    }
  }

  /**
   * Get categories up to a specific level depth
   */
  private async getCategoriesUpToLevel(categoryId: string, maxLevels: number): Promise<string[]> {
    const categories: string[] = [categoryId];
    
    const findCategories = async (parentId: string, currentLevel: number) => {
      if (currentLevel >= maxLevels) return;
      
      const children = await prisma.category.findMany({
        where: { parentId },
        select: { id: true }
      });
      
      for (const child of children) {
        categories.push(child.id);
        await findCategories(child.id, currentLevel + 1);
      }
    };
    
    await findCategories(categoryId, 0);
    return categories;
  }

  /**
   * ULTRA SIMPLIFIED: Get only category-level filter data without any product checks
   * This is the fastest version - only returns what's defined at category level
   */
  async getCategoryLevelFilterData(categoryId: string): Promise<CategoryFilterResponse> {
    try {
      // Verify category exists
      const category = await prisma.category.findUnique({
        where: { id: categoryId },
        select: { id: true, name: true, slug: true }
      });

      if (!category) {
        throw new Error('Category not found');
      }

      // Get breadcrumb
      const breadcrumb = await this.getCategoryBreadcrumb(categoryId);

      // Get ALL category IDs (including the selected category and ALL descendants)
      const allCategoryIds = await this.getAllCategoryIds(categoryId);

      // Fetch only category-level data (no product checks)
      const [attributes, specifications, totalProducts] = await Promise.all([
        this.getFilterableAttributes(allCategoryIds),
        this.getFilterableSpecifications(allCategoryIds),
        this.getProductCount(allCategoryIds)
      ]);

      // Use default price range for performance
      const priceRange: PriceRange = {
        min: 0,
        max: 10000
      };

      return {
        category: {
          id: category.id,
          name: category.name,
          slug: category.slug,
          breadcrumb
        },
        filters: {
          attributes,
          specifications,
          priceRange
        },
        meta: {
          totalProducts,
          hasFilters: attributes.length > 0 || specifications.length > 0
        }
      };
    } catch (error) {
      console.error('Error in getCategoryLevelFilterData:', error);
      throw error;
    }
  }

  /**
   * Cleanup Prisma client connection
   */
  async disconnect(): Promise<void> {
    await prisma.$disconnect();
  }
}

export const categoryFilterService = new CategoryFilterService();