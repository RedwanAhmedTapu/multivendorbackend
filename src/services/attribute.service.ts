// AttributeService.ts
import { prisma } from "../config/prisma.ts";

export const AttributeService = {
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

    let slug = name.toLowerCase().replace(/\s+/g, "-");
    let counter = 1;
    const originalSlug = slug;

    while (await prisma.attribute.findUnique({ where: { slug } })) {
      slug = `${originalSlug}-${counter++}`;
    }

    return prisma.$transaction(async (tx) => {
      const attribute = await tx.attribute.create({ data: { name, slug, type } });

      const categoryAttribute = await tx.categoryAttribute.create({
        data: {
          categoryId,
          attributeId: attribute.id,
          isRequired: required,
          isForVariant: true,
          filterable,
        },
      });

      if (values.length && type === "SELECT") {
        await Promise.all(
          values.map((value: string) =>
            tx.attributeValue.create({ data: { attributeId: attribute.id, value: value.trim() } })
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
      let counter = 1;
      const originalSlug = slug;

      while (
        await prisma.attribute.findFirst({
          where: { slug, id: { not: categoryAttribute.attributeId } },
        })
      ) {
        slug = `${originalSlug}-${counter++}`;
      }
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

    // Check if this attribute is used in any products
    const variantAttributes = await prisma.productVariantAttribute.findFirst({
      where: {
        attributeValue: {
          attributeId: categoryAttribute.attributeId
        }
      }
    });

    if (variantAttributes) {
      throw new Error("Cannot delete attribute: it's being used in products");
    }

    return prisma.$transaction(async (tx) => {
      // Delete attribute values first
      await tx.attributeValue.deleteMany({ 
        where: { attributeId: categoryAttribute.attributeId } 
      });
      
      // Delete the category-attribute relationship
      await tx.categoryAttribute.delete({ 
        where: { id: categoryAttributeId } 
      });
      
      // Delete the attribute itself
      return tx.attribute.delete({ 
        where: { id: categoryAttribute.attributeId } 
      });
    });
  },

  async addValue(attributeId: string, value: string) {
    return prisma.attributeValue.create({ data: { attributeId, value: value.trim() } });
  },

  async deleteValue(id: string) {
    return prisma.attributeValue.delete({ where: { id } });
  },
};