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
      orderBy: { attribute: { name: "asc" } },
    });
  },

  async create(data: any) {
    const { categoryId, name, type, filterable, required, values = [] } = data;

    const slug = name.toLowerCase().replace(/\s+/g, "-");

    return prisma.$transaction(async (tx) => {
      // Find or create global attribute
      let attribute = await tx.attribute.findUnique({ where: { slug } });

      if (!attribute) {
        attribute = await tx.attribute.create({
          data: { name, slug, type },
        });
      }

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
          isForVariant: true,
          filterable,
        },
        create: {
          categoryId,
          attributeId: attribute.id,
          isRequired: required,
          isForVariant: true,
          filterable,
        },
      });

      // Add values only if attribute is SELECT and they don’t already exist
      if (values.length && type === "SELECT") {
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

    await prisma.attribute.update({
      where: { id: categoryAttribute.attributeId },
      data: { name: data.name, slug, type: data.type },
    });

    return prisma.categoryAttribute.update({
      where: { id: categoryAttributeId },
      data: { isRequired: data.required, filterable: data.filterable },
      include: { attribute: { include: { values: true } } },
    });
  },

  async delete(categoryAttributeId: string) {
    const categoryAttribute = await prisma.categoryAttribute.findUnique({
      where: { id: categoryAttributeId },
      include: { attribute: true },
    });

    if (!categoryAttribute) throw new Error("CategoryAttribute not found");

    // Check if attribute is used in product variants
    const variantAttributes = await prisma.productVariantAttribute.findFirst({
      where: {
        attributeValue: {
          attributeId: categoryAttribute.attributeId,
        },
      },
    });

    if (variantAttributes) {
      throw new Error("Cannot delete attribute: it's being used in products");
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
    return prisma.attributeValue.create({
      data: { attributeId, value: value.trim() },
    });
  },

  async deleteValue(id: string) {
    return prisma.attributeValue.delete({ where: { id } });
  },
};
