// services/category.service.ts
import { prisma } from "../config/prisma.ts";

export const CategoryService = {
  /**
   * Get all categories with unlimited nested layers
   * Attributes and specifications are included only at leaf categories
   */
  async getAll() {
    const categories = await prisma.category.findMany({
      where: { parentId: null },
      include: {
        children: true,
      },
    });

    // Recursive function to build hierarchy with attributes/specs only at leaf
    const buildHierarchy = async (category: any): Promise<any> => {
      const children = await prisma.category.findMany({
        where: { parentId: category.id },
      });

      let transformedCategory: any = { ...category, children: [] };

      if (children.length > 0) {
        // If not leaf, recursively add children
        transformedCategory.children = await Promise.all(children.map(buildHierarchy));
      } else {
        // If leaf, attach attributes and specifications
        const attributes = await prisma.categoryAttribute.findMany({
          where: { categoryId: category.id },
          include: { attribute: { include: { values: true } } },
        });

        const specifications = await prisma.categorySpecification.findMany({
          where: { categoryId: category.id },
          include: { specification: true },
        });

        transformedCategory.attributes = attributes.map(a => ({
          ...a.attribute,
          isRequired: a.isRequired,
          isForVariant: a.isForVariant,
          filterable: a.filterable,
        }));

        transformedCategory.specifications = specifications.map(s => ({
          ...s.specification,
          isRequired: s.isRequired,
          filterable: s.filterable,
        }));
      }

      return transformedCategory;
    };

    return await Promise.all(categories.map(buildHierarchy));
  },

  /**
   * Get a category by ID with unlimited nested layers
   * Attributes/specifications only on leaf nodes
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
          include: { attribute: { include: { values: true } } },
        });

        const specifications = await prisma.categorySpecification.findMany({
          where: { categoryId: cat.id },
          include: { specification: true },
        });

        transformedCat.attributes = attributes.map(a => ({
          ...a.attribute,
          isRequired: a.isRequired,
          isForVariant: a.isForVariant,
          filterable: a.filterable,
        }));

        transformedCat.specifications = specifications.map(s => ({
          ...s.specification,
          isRequired: s.isRequired,
          filterable: s.filterable,
        }));
      }

      return transformedCat;
    };

    return await buildHierarchy(category);
  },

  async create(data: any) {
    return prisma.category.create({
      data: {
        name: data.name,
        slug: data.slug.toLowerCase().replace(/\s+/g, "-"),
        image: data.image,
        parentId: data.parentId || null,
      },
    });
  },

  async update(id: string, data: any) {
    return prisma.category.update({
      where: { id },
      data: {
        name: data.name,
        slug: data.slug?.toLowerCase().replace(/\s+/g, "-"),
        image: data.image,
        parentId: data.parentId,
      },
    });
  },

  async remove(id: string) {
    const children = await prisma.category.findMany({ where: { parentId: id } });
    if (children.length > 0) throw new Error("Cannot delete category with subcategories");

    const products = await prisma.product.findMany({ where: { categoryId: id } });
    if (products.length > 0) throw new Error("Cannot delete category with products");

    return prisma.category.delete({ where: { id } });
  },

  async assignAttribute(categoryId: string, attributeId: string, options: { isRequired?: boolean; isForVariant?: boolean; filterable?: boolean } = {}) {
    return prisma.categoryAttribute.create({
      data: {
        categoryId,
        attributeId,
        isRequired: options.isRequired || false,
        isForVariant: options.isForVariant ?? true,
        filterable: options.filterable ?? true,
      },
    });
  },

  async assignSpecification(categoryId: string, specificationId: string, options: { isRequired?: boolean; filterable?: boolean } = {}) {
    return prisma.categorySpecification.create({
      data: {
        categoryId,
        specificationId,
        isRequired: options.isRequired || false,
        filterable: options.filterable ?? true,
      },
    });
  },
};
