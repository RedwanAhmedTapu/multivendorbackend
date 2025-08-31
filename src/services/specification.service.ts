// services/specification.service.ts
import { prisma } from "../config/prisma.ts";

export const SpecificationService = {
  async getAll(categoryId: string) {
    return prisma.categorySpecification.findMany({
      where: { categoryId },
      include: {
        specification: true,
      },
    });
  },

  async create(data: any) {
    const { categoryId, name, type, unit, filterable, required } = data;
    
    const specification = await prisma.specification.create({
      data: {
        name,
        slug: name.toLowerCase().replace(/\s+/g, '-'),
        type,
        unit: unit || null,
      },
    });

    return prisma.categorySpecification.create({
      data: {
        categoryId,
        specificationId: specification.id,
        isRequired: required,
        filterable,
      },
      include: {
        specification: true,
      },
    });
  },

  async update(id: string, data: any) {
    const categorySpec = await prisma.categorySpecification.findUnique({
      where: { id },
      include: { specification: true },
    });

    if (!categorySpec) {
      throw new Error("CategorySpecification not found");
    }

    await prisma.specification.update({
      where: { id: categorySpec.specificationId },
      data: {
        name: data.name,
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
      include: {
        specification: true,
      },
    });
  },

  async delete(id: string) {
    const categorySpec = await prisma.categorySpecification.findUnique({
      where: { id },
      include: { specification: true },
    });

    if (!categorySpec) {
      throw new Error("CategorySpecification not found");
    }

    await prisma.categorySpecification.delete({
      where: { id },
    });

    return prisma.specification.delete({
      where: { id: categorySpec.specificationId },
    });
  },
};