// services/specification.service.ts
import { prisma } from "../config/prisma.ts";

export const SpecificationService = {
   async getAllGlobal() {
    return prisma.specification.findMany({
      include: { options: true },
      orderBy: { name: "asc" },
    });
  },
  async getAll(categoryId: string) {
    return prisma.categorySpecification.findMany({
      where: { categoryId },
      include: {
        specification: {
          include: {
            options: true,
          },
        },
      },
    });
  },

  async create(data: any) {
    const { categoryId, name, type, unit, filterable, required, options = [] } = data;
    console.log(type)

    const slug = name.toLowerCase().replace(/\s+/g, "-");

    return prisma.$transaction(async (tx) => {
      // 1. Find or create global specification
      let specification = await tx.specification.findUnique({ where: { slug } });

      if (!specification) {
        specification = await tx.specification.create({
          data: {
            name,
            slug,
            type,
            unit: unit || null,
          },
        });
      }

      // 2. Link specification to category
      const categorySpec = await tx.categorySpecification.upsert({
        where: {
          categoryId_specificationId: {
            categoryId,
            specificationId: specification.id,
          },
        },
        update: {
          isRequired: required,
          filterable,
        },
        create: {
          categoryId,
          specificationId: specification.id,
          isRequired: required,
          filterable,
        },
      });

      // 3. Add options if provided & not already existing
      if (options.length && type === "SELECT") {
        const existingOptions = await tx.specificationOption.findMany({
          where: { specificationId: specification.id },
        });

        const existingSet = new Set(existingOptions.map((o) => o.value.toLowerCase()));

        await Promise.all(
          options
            .filter((val: string) => !existingSet.has(val.trim().toLowerCase()))
            .map((val: string) =>
              tx.specificationOption.create({
                data: { specificationId: specification.id, value: val.trim() },
              })
            )
        );
      }

      return tx.categorySpecification.findUnique({
        where: { id: categorySpec.id },
        include: { specification: { include: { options: true } } },
      });
    });
  },

  async update(id: string, data: any) {
    const categorySpec = await prisma.categorySpecification.findUnique({
      where: { id },
      include: { specification: true },
    });

    if (!categorySpec) throw new Error("CategorySpecification not found");

    const slug = data.name.toLowerCase().replace(/\s+/g, "-");

    await prisma.specification.update({
      where: { id: categorySpec.specificationId },
      data: {
        name: data.name,
        slug,
        type: data.type,
        unit: data.unit || null,
      },
    });

    return prisma.categorySpecification.update({
      where: { id },
      data: {
        isRequired: data.required,
        filterable: data.filterable,
      },
      include: { specification: { include: { options: true } } },
    });
  },

  async delete(id: string) {
    const categorySpec = await prisma.categorySpecification.findUnique({
      where: { id },
      include: { specification: true },
    });

    if (!categorySpec) throw new Error("CategorySpecification not found");

    return prisma.$transaction(async (tx) => {
      // Remove category-specification link
      await tx.categorySpecification.delete({ where: { id } });

      // Check if spec is still linked to other categories
      const otherLinks = await tx.categorySpecification.findMany({
        where: { specificationId: categorySpec.specificationId },
      });

      if (otherLinks.length === 0) {
        // Safe to delete options + spec globally
        await tx.specificationOption.deleteMany({
          where: { specificationId: categorySpec.specificationId },
        });

        return tx.specification.delete({
          where: { id: categorySpec.specificationId },
        });
      }

      return { success: true, message: "Unlinked from category but kept globally" };
    });
  },

  async addOption(specificationId: string, value: string) {
    return prisma.specificationOption.create({
      data: { specificationId, value: value.trim() },
    });
  },

  async getOptions(specificationId: string) {
    return prisma.specificationOption.findMany({
      where: { specificationId },
    });
  },

  async deleteOption(id: string) {
    return prisma.specificationOption.delete({ where: { id } });
  },
};
