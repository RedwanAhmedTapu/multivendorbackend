// services/category.service.ts
import { prisma } from "../config/prisma.ts";

export const CategoryService = {
  /**
   * Get all categories with unlimited nested layers
   * Attributes and specifications (with options) are included only at leaf categories
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
        // Not leaf
        transformedCategory.children = await Promise.all(children.map(buildHierarchy));
      } else {
        // Leaf category: include attributes & specifications
        const attributes = await prisma.categoryAttribute.findMany({
          where: { categoryId: category.id },
          include: { attribute: { include: { values: true } } },
        });

        const specifications = await prisma.categorySpecification.findMany({
          where: { categoryId: category.id },
          include: { specification: { include: { options: true } } },
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
   * Attributes/specifications (with options) only on leaf nodes
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
          include: { specification: { include: { options: true } } },
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
    console.log(data);
    return prisma.category.create({
      data: {
        name: data.name,
        slug: data.slug.toLowerCase().replace(/\s+/g, "-"), // do NOT append number
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
        slug: data.slug?.toLowerCase().replace(/\s+/g, "-"), // do NOT append number
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

  /**
   * Assign an attribute to a category
   * Reuses existing attributes globally if present
   */
  async assignAttribute(
    categoryId: string,
    attributeData: { id?: string; name?: string; slug?: string; type: string },
    options: { isRequired?: boolean; isForVariant?: boolean; filterable?: boolean } = {}
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
        },
      });
    }

    // Link attribute to category (junction table)
    return prisma.categoryAttribute.upsert({
      where: { categoryId_attributeId: { categoryId, attributeId: attribute.id } },
      update: {
        isRequired: options.isRequired ?? false,
        isForVariant: options.isForVariant ?? true,
        filterable: options.filterable ?? true,
      },
      create: {
        categoryId,
        attributeId: attribute.id,
        isRequired: options.isRequired ?? false,
        isForVariant: options.isForVariant ?? true,
        filterable: options.filterable ?? true,
      },
    });
  },

  /**
   * Assign a specification to a category
   * Reuses existing specifications globally if present
   */
  async assignSpecification(
    categoryId: string,
    specificationData: { id?: string; name?: string; slug?: string; type: string },
    options: { isRequired?: boolean; filterable?: boolean } = {}
  ) {
    // Find or create global specification
    let specification;
    if (specificationData.id) {
      specification = await prisma.specification.findUnique({ where: { id: specificationData.id } });
    } else if (specificationData.slug) {
      specification = await prisma.specification.findUnique({ where: { slug: specificationData.slug } });
    }

    if (!specification) {
      specification = await prisma.specification.create({
        data: {
          name: specificationData.name!,
          slug: specificationData.slug!.toLowerCase().replace(/\s+/g, "-"),
          type: specificationData.type as any,
        },
      });
    }

    // Link specification to category (junction table)
    return prisma.categorySpecification.upsert({
      where: { categoryId_specificationId: { categoryId, specificationId: specification.id } },
      update: {
        isRequired: options.isRequired ?? false,
        filterable: options.filterable ?? true,
      },
      create: {
        categoryId,
        specificationId: specification.id,
        isRequired: options.isRequired ?? false,
        filterable: options.filterable ?? true,
      },
    });
  },
};
