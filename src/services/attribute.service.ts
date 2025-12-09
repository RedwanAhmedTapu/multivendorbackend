// services/AttributeService.ts
import { prisma } from "../config/prisma.ts";

export const AttributeService = {
  async getAllGlobal() {
    return prisma.attribute.findMany({
      include: { values: true },
      orderBy: { name: "asc" },
    });
  },

  async getAll(categoryId: string) {
    return prisma.categoryAttribute.findMany({
      where: { categoryId },
      include: {
        attribute: { include: { values: true } },
      },
      orderBy: { sortOrder: "asc" },
    });
  },

  async create(data: any) {
    const { categoryId, name, type, filterable, required, values = [], unit } = data;

    const slug = name.toLowerCase().replace(/\s+/g, "-");

    return prisma.$transaction(async (tx) => {
      // Find or create global attribute
      let attribute = await tx.attribute.findUnique({ where: { slug } });

      if (!attribute) {
        attribute = await tx.attribute.create({
          data: { name, slug, type, unit },
        });
      }

      // Get the next sort order for this category
      const maxOrder = await tx.categoryAttribute.findFirst({
        where: { categoryId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });

      const nextSortOrder = (maxOrder?.sortOrder ?? -1) + 1;

      // Link attribute to category
      const categoryAttribute = await tx.categoryAttribute.upsert({
        where: {
          categoryId_attributeId: {
            categoryId,
            attributeId: attribute.id,
          },
        },
        update: {
          isRequired: required,
          filterable,
          sortOrder: nextSortOrder,
        },
        create: {
          categoryId,
          attributeId: attribute.id,
          isRequired: required,
          filterable,
          sortOrder: nextSortOrder,
        },
      });

      // Add values only if attribute is SELECT/MULTISELECT and they don't already exist
      if (values.length && (type === "SELECT" || type === "MULTISELECT")) {
        const existingValues = await tx.attributeValue.findMany({
          where: { attributeId: attribute.id },
        });

        const existingSet = new Set(existingValues.map((v) => v.value.toLowerCase()));

        await Promise.all(
          values
            .filter((val: string) => !existingSet.has(val.trim().toLowerCase()))
            .map((val: string) =>
              tx.attributeValue.create({
                data: { attributeId: attribute.id, value: val.trim() },
              })
            )
        );
      }

      return tx.categoryAttribute.findUnique({
        where: { id: categoryAttribute.id },
        include: { attribute: { include: { values: true } } },
      });
    });
  },

  async update(categoryAttributeId: string, data: any) {
    const categoryAttribute = await prisma.categoryAttribute.findUnique({
      where: { id: categoryAttributeId },
      include: { attribute: true },
    });

    if (!categoryAttribute) throw new Error("CategoryAttribute not found");

    let slug = categoryAttribute.attribute.slug;
    if (data.name && data.name !== categoryAttribute.attribute.name) {
      slug = data.name.toLowerCase().replace(/\s+/g, "-");
    }

    return prisma.$transaction(async (tx) => {
      // Update global attribute
      await tx.attribute.update({
        where: { id: categoryAttribute.attributeId },
        data: { 
          name: data.name, 
          slug, 
          type: data.type,
          unit: data.unit 
        },
      });

      // Update category-attribute link
      return tx.categoryAttribute.update({
        where: { id: categoryAttributeId },
        data: { 
          isRequired: data.required, 
          filterable: data.filterable,
          sortOrder: data.sortOrder,
        },
        include: { attribute: { include: { values: true } } },
      });
    });
  },

  async updateSortOrder(categoryId: string, attributeOrders: { id: string; sortOrder: number }[]) {
    return prisma.$transaction(
      attributeOrders.map(({ id, sortOrder }) =>
        prisma.categoryAttribute.update({
          where: { id, categoryId },
          data: { sortOrder },
        })
      )
    );
  },

  async delete(categoryAttributeId: string) {
    const categoryAttribute = await prisma.categoryAttribute.findUnique({
      where: { id: categoryAttributeId },
      include: { attribute: true },
    });

    if (!categoryAttribute) throw new Error("CategoryAttribute not found");

    // Check if attribute is used in product attributes (specs or variants)
    const productAttributes = await prisma.productAttribute.findFirst({
      where: { attributeId: categoryAttribute.attributeId },
    });

    if (productAttributes) {
      throw new Error("Cannot delete attribute: it's being used in products");
    }

    // Check if attribute is used in product variants
    const variantAttributes = await prisma.productVariantAttribute.findFirst({
      where: {
        attributeValue: {
          attributeId: categoryAttribute.attributeId,
        },
      },
    });

    if (variantAttributes) {
      throw new Error("Cannot delete attribute: it's being used in product variants");
    }

    return prisma.$transaction(async (tx) => {
      // Remove category-attribute link
      await tx.categoryAttribute.delete({
        where: { id: categoryAttributeId },
      });

      // Check if this attribute is still linked to other categories
      const otherLinks = await tx.categoryAttribute.findMany({
        where: { attributeId: categoryAttribute.attributeId },
      });

      if (otherLinks.length === 0) {
        // Safe to delete values + attribute globally
        await tx.attributeValue.deleteMany({
          where: { attributeId: categoryAttribute.attributeId },
        });

        return tx.attribute.delete({
          where: { id: categoryAttribute.attributeId },
        });
      }

      return { success: true, message: "Unlinked from category but kept globally" };
    });
  },

  async addValue(attributeId: string, value: string) {
    // Check if value already exists
    const existing = await prisma.attributeValue.findUnique({
      where: {
        attributeId_value: {
          attributeId,
          value: value.trim(),
        },
      },
    });

    if (existing) {
      throw new Error("Value already exists for this attribute");
    }

    return prisma.attributeValue.create({
      data: { attributeId, value: value.trim() },
    });
  },

  async deleteValue(id: string) {
    // Check if value is used in product attributes
    const productAttributes = await prisma.productAttribute.findFirst({
      where: { attributeValueId: id },
    });

    if (productAttributes) {
      throw new Error("Cannot delete value: it's being used in product attributes");
    }

    // Check if value is used in variants
    const variantAttributes = await prisma.productVariantAttribute.findFirst({
      where: { attributeValueId: id },
    });

    if (variantAttributes) {
      throw new Error("Cannot delete value: it's being used in product variants");
    }

    return prisma.attributeValue.delete({ where: { id } });
  },
};