// services/product.service.ts
import { prisma } from "../config/prisma.ts";

export const ProductService = {
  async getAll() {
    return prisma.product.findMany({
      include: {
        vendor: true,
        category: true,
        variants: {
          include: {
            attributes: {
              include: {
                attributeValue: {
                  include: { attribute: true },
                },
              },
            },
          },
        },
        specifications: {
          include: {
            specification: true,
          },
        },
      },
    });
  },

  async getById(id: string) {
    return prisma.product.findUnique({
      where: { id },
      include: {
        vendor: true,
        category: true,
        variants: {
          include: {
            attributes: {
              include: {
                attributeValue: {
                  include: { attribute: true },
                },
              },
            },
          },
        },
        specifications: {
          include: {
            specification: true,
          },
        },
      },
    });
  },

  async create(data: any) {
    return prisma.product.create({
      data: {
        name: data.name,
        description: data.description,
        slug: data.name.toLowerCase().replace(/\s+/g, "-"),
        vendorId: data.vendorId,
        categoryId: data.categoryId,
        // You can extend here for variants, specifications, images, etc.
      },
    });
  },

  async update(id: string, data: any) {
    return prisma.product.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        slug: data.name?.toLowerCase().replace(/\s+/g, "-"),
        vendorId: data.vendorId,
        categoryId: data.categoryId,
      },
    });
  },

  async filterProducts(filters: any) {
    const { categoryId, attributes, specifications } = filters;

    return prisma.product.findMany({
      where: {
        categoryId,
        AND: [
          ...(attributes || []).map((attrValId: string) => ({
            variants: {
              some: {
                attributes: {
                  some: { attributeValueId: attrValId },
                },
              },
            },
          })),
          ...(specifications || []).map((spec: any) => ({
            specifications: {
              some: {
                specificationId: spec.id,
                OR: [
                  { valueString: spec.value },
                  { valueNumber: spec.value },
                ],
              },
            },
          })),
        ],
      },
      include: {
        variants: {
          include: {
            attributes: {
              include: {
                attributeValue: {
                  include: { attribute: true },
                },
              },
            },
          },
        },
        specifications: {
          include: {
            specification: true,
          },
        },
      },
    });
  },

  async remove(id: string) {
    return prisma.product.delete({
      where: { id },
    });
  },
};
