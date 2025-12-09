import { prisma } from "../config/prisma.ts";

export const CategoryService = {
  /**
   * Get all categories with unlimited nested layers
   * Attributes (unified) are included only at leaf categories
   */
  async getAll() {
    const categories = await prisma.category.findMany({
      where: { parentId: null },
    });

    const buildHierarchy = async (category: any): Promise<any> => {
      const children = await prisma.category.findMany({
        where: { parentId: category.id },
      });

      let transformedCategory: any = { ...category, children: [] };

      if (children.length > 0) {
        // Not leaf - has children
        transformedCategory.children = await Promise.all(children.map(buildHierarchy));
      } else {
        // Leaf category: include unified attributes with their values
        const attributes = await prisma.categoryAttribute.findMany({
          where: { categoryId: category.id },
          include: { 
            attribute: { 
              include: { values: true } 
            } 
          },
          orderBy: { sortOrder: 'asc' }, // ✅ NEW: Order by sortOrder
        });

        transformedCategory.attributes = attributes.map(a => ({
          ...a.attribute,
          categoryAttributeId: a.id,
          isRequired: a.isRequired,
          filterable: a.filterable,
          sortOrder: a.sortOrder, // ✅ NEW
        }));
      }

      return transformedCategory;
    };

    return await Promise.all(categories.map(buildHierarchy));
  },

  /**
   * Get a category by ID with unlimited nested layers
   * Attributes only on leaf nodes
   */
  async getById(id: string) {
    const category = await prisma.category.findUnique({ where: { id } });
    if (!category) return null;

    const buildHierarchy = async (cat: any): Promise<any> => {
      const children = await prisma.category.findMany({ where: { parentId: cat.id } });
      let transformedCat: any = { ...cat, children: [] };

      if (children.length > 0) {
        transformedCat.children = await Promise.all(children.map(buildHierarchy));
      } else {
        const attributes = await prisma.categoryAttribute.findMany({
          where: { categoryId: cat.id },
          include: { 
            attribute: { 
              include: { values: true } 
            } 
          },
          orderBy: { sortOrder: 'asc' },
        });

        transformedCat.attributes = attributes.map(a => ({
          ...a.attribute,
          isRequired: a.isRequired,
          filterable: a.filterable,
          sortOrder: a.sortOrder,
        }));
      }

      return transformedCat;
    };

    return await buildHierarchy(category);
  },

  /**
   * Create a new category with tags and keywords
   */
  async create(data: any) {
    console.log(data);
    return prisma.category.create({
      data: {
        name: data.name,
        slug: data.slug.toLowerCase().replace(/\s+/g, "-"),
        image: data.image,
        parentId: data.parentId || null,
        // ✅ NEW: Tags and keywords support
        keywords: data.keywords || [], // Array of strings
        tags: data.tags || [], // Array of strings
      },
    });
  },

  /**
   * Update category with tags and keywords
   */
  async update(id: string, data: any) {
    const updateData: any = {
      name: data.name,
      slug: data.slug?.toLowerCase().replace(/\s+/g, "-"),
      image: data.image,
      parentId: data.parentId,
    };

    if (data.keywords !== undefined) updateData.keywords = data.keywords;
    if (data.tags !== undefined) updateData.tags = data.tags;

    return prisma.category.update({
      where: { id },
      data: updateData,
    });
  },

  /**
   * Delete category
   */
  async remove(id: string) {
    const children = await prisma.category.findMany({ where: { parentId: id } });
    if (children.length > 0) throw new Error("Cannot delete category with subcategories");

    const products = await prisma.product.findMany({ where: { categoryId: id } });
    if (products.length > 0) throw new Error("Cannot delete category with products");

    return prisma.category.delete({ where: { id } });
  },

  /**
   * Assign a unified attribute to a category
   * Reuses existing attributes globally if present
   */
  async assignAttribute(
    categoryId: string,
    attributeData: { 
      id?: string; 
      name?: string; 
      slug?: string; 
      type: string;
      unit?: string; // ✅ NEW: For specifications like "kg", "inches"
    },
    options: { 
      isRequired?: boolean; 
      filterable?: boolean; 
      sortOrder?: number; // ✅ NEW
    } = {}
  ) {
    // Find or create global attribute
    let attribute;
    if (attributeData.id) {
      attribute = await prisma.attribute.findUnique({ where: { id: attributeData.id } });
    } else if (attributeData.slug) {
      attribute = await prisma.attribute.findUnique({ where: { slug: attributeData.slug } });
    }

    if (!attribute) {
      attribute = await prisma.attribute.create({
        data: {
          name: attributeData.name!,
          slug: attributeData.slug!.toLowerCase().replace(/\s+/g, "-"),
          type: attributeData.type as any,
          unit: attributeData.unit || null, // ✅ NEW
        },
      });
    }

    // Link attribute to category (junction table)
    return prisma.categoryAttribute.upsert({
      where: { categoryId_attributeId: { categoryId, attributeId: attribute.id } },
      update: {
        isRequired: options.isRequired ?? false,
        filterable: options.filterable ?? true,
        sortOrder: options.sortOrder ?? 0, // ✅ NEW
      },
      create: {
        categoryId,
        attributeId: attribute.id,
        isRequired: options.isRequired ?? false,
        filterable: options.filterable ?? true,
        sortOrder: options.sortOrder ?? 0, // ✅ NEW
      },
    });
  },

  /**
   * ❌ REMOVED: assignSpecification method
   * (Now merged into assignAttribute)
   */

  /**
   * ✅ NEW: Search categories by keywords/tags
   */
  async search(query: string) {
    return prisma.category.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { keywords: { has: query } },
          { tags: { has: query } },
        ],
      },
      include: {
        parent: true,
      },
    });
  },

  /**
   * ✅ NEW: Get categories by tag
   */
  async getByTag(tag: string) {
    return prisma.category.findMany({
      where: {
        tags: { has: tag },
      },
      include: {
        parent: true,
      },
    });
  },

  /**
   * ✅ NEW: Get categories by keyword
   */
  async getByKeyword(keyword: string) {
    return prisma.category.findMany({
      where: {
        keywords: { has: keyword },
      },
      include: {
        parent: true,
      },
    });
  },
};