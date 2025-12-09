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
  unit?: string;
  values: FilterableAttributeValue[];
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
      const category = await prisma.category.findUnique({
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
   * Get filterable attributes with product counts based on unified structure
   */
  private async getFilterableAttributes(
    categoryIds: string[],
    includeProductCounts: boolean = false
  ): Promise<FilterableAttribute[]> {
    try {
      // Get category attributes configuration
      const categoryAttributes = await prisma.categoryAttribute.findMany({
        where: {
          categoryId: { in: categoryIds },
          filterable: true
        },
        include: {
          attribute: {
            include: {
              values: true // For SELECT type attributes
            }
          }
        },
        orderBy: {
          sortOrder: 'asc'
        }
      });

      if (categoryAttributes.length === 0) {
        return [];
      }

      const attributeIds = categoryAttributes.map(ca => ca.attributeId);

      // Get all product attributes for these categories and attributes
      const productAttributes = includeProductCounts ? await prisma.productAttribute.findMany({
        where: {
          attributeId: { in: attributeIds },
          product: {
            categoryId: { in: categoryIds },
            approvalStatus: 'ACTIVE'
          }
        },
        include: {
          product: {
            select: { id: true }
          },
          attribute: {
            include: {
              values: true
            }
          },
          attributeValue: true // For SELECT type
        }
      }) : [];

      // Build attribute map
      const attributeMap = new Map<string, FilterableAttribute>();

      for (const ca of categoryAttributes) {
        const attr = ca.attribute;

        // Initialize attribute structure
        const filterableAttr: FilterableAttribute = {
          id: attr.id,
          name: attr.name,
          slug: attr.slug,
          type: attr.type as any,
          unit: attr.unit || undefined,
          values: []
        };

        if (includeProductCounts) {
          // Count products by attribute values
          const valueCounts = new Map<string, { id: string; displayValue: string; count: Set<string> }>();

          const relevantProductAttrs = productAttributes.filter(
            pa => pa.attributeId === attr.id
          );

          for (const pa of relevantProductAttrs) {
            let displayValue: string;
            let valueId: string;

            // Extract value based on attribute type
            switch (attr.type) {
              case 'SELECT':
                if (pa.attributeValue) {
                  displayValue = pa.attributeValue.value;
                  valueId = pa.attributeValue.id;
                } else {
                  continue;
                }
                break;
              
              case 'TEXT':
                if (pa.valueString) {
                  displayValue = pa.valueString;
                  valueId = pa.valueString.toLowerCase().replace(/\s+/g, '-');
                } else {
                  continue;
                }
                break;
              
              case 'NUMBER':
                if (pa.valueNumber !== null && pa.valueNumber !== undefined) {
                  displayValue = pa.valueNumber.toString();
                  if (attr.unit) displayValue += ` ${attr.unit}`;
                  valueId = pa.valueNumber.toString();
                } else {
                  continue;
                }
                break;
              
              case 'BOOLEAN':
                if (pa.valueBoolean !== null && pa.valueBoolean !== undefined) {
                  displayValue = pa.valueBoolean ? 'Yes' : 'No';
                  valueId = pa.valueBoolean.toString();
                } else {
                  continue;
                }
                break;
              
              default:
                continue;
            }

            // Track unique products for this value
            if (!valueCounts.has(valueId)) {
              valueCounts.set(valueId, { 
                id: valueId,
                displayValue: displayValue,
                count: new Set<string>() 
              });
            }
            valueCounts.get(valueId)!.count.add(pa.product.id);
          }

          // Convert to filterable values
          filterableAttr.values = Array.from(valueCounts.entries())
            .map(([_, data]) => ({
              id: data.id,
              value: data.displayValue,
              productCount: data.count.size
            }))
            .filter(v => v.productCount > 0)
            .sort((a, b) => b.productCount - a.productCount);

        } else {
          // Simple mode: just return available attribute values without counts
          if (attr.type === 'SELECT' && attr.values.length > 0) {
            filterableAttr.values = attr.values.map(av => ({
              id: av.id,
              value: av.value,
              productCount: 0
            }));
          } else {
            // For other types, we'll populate values dynamically from products
            // In simple mode, just set empty array
            filterableAttr.values = [];
          }
        }

        // Only add attributes that have values (or in simple mode, add all)
        if (filterableAttr.values.length > 0 || !includeProductCounts) {
          attributeMap.set(attr.id, filterableAttr);
        }
      }

      return Array.from(attributeMap.values());

    } catch (error) {
      console.error('Error in getFilterableAttributes:', error);
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
   * Main method: Get complete filter data for a category
   * @param includeProductCounts - Whether to count products for each filter value (slower but more accurate)
   */
  async getCategoryFilterData(
    categoryId: string, 
    includeProductCounts: boolean = false
  ): Promise<CategoryFilterResponse> {
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
      const [attributes, priceRange, totalProducts] = await Promise.all([
        this.getFilterableAttributes(allCategoryIds, includeProductCounts),
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
          priceRange
        },
        meta: {
          totalProducts,
          hasFilters: attributes.length > 0
        }
      };
    } catch (error) {
      console.error('Error in getCategoryFilterData:', error);
      throw error;
    }
  }

  /**
   * Get filter data for multiple categories (for multi-category pages)
   */
  async getMultipleCategoriesFilterData(
    categoryIds: string[],
    includeProductCounts: boolean = false
  ): Promise<{
    filters: {
      attributes: FilterableAttribute[];
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
      const [attributes, priceRange, totalProducts] = await Promise.all([
        this.getFilterableAttributes(allCategoryIdsArray, includeProductCounts),
        this.getPriceRange(allCategoryIdsArray),
        this.getProductCount(allCategoryIdsArray)
      ]);

      return {
        filters: {
          attributes,
          priceRange
        },
        meta: {
          totalProducts,
          categoriesProcessed: categoryIds.length,
          hasFilters: attributes.length > 0
        }
      };
    } catch (error) {
      console.error('Error in getMultipleCategoriesFilterData:', error);
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
   * Get filter data for display categories (limited to 3 levels)
   */
  async getDisplayCategoryFilterData(
    categoryId: string, 
    maxLevels: number = 3,
    includeProductCounts: boolean = false
  ): Promise<CategoryFilterResponse> {
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
      const [attributes, priceRange, totalProducts] = await Promise.all([
        this.getFilterableAttributes(displayCategoryIds, includeProductCounts),
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
          priceRange
        },
        meta: {
          totalProducts,
          hasFilters: attributes.length > 0
        }
      };
    } catch (error) {
      console.error('Error in getDisplayCategoryFilterData:', error);
      throw error;
    }
  }

  /**
   * ULTRA SIMPLIFIED: Get only category-level filter data without product checks
   * This is the fastest version - only returns what's defined at category level
   */
  async getCategoryLevelFilterData(categoryId: string): Promise<CategoryFilterResponse> {
    return this.getCategoryFilterData(categoryId, false);
  }

  /**
   * Cleanup Prisma client connection
   */
  async disconnect(): Promise<void> {
    await prisma.$disconnect();
  }
}

export const categoryFilterService = new CategoryFilterService();