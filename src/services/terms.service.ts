import { PrismaClient, TermsType } from "@prisma/client";

const prisma = new PrismaClient();

export const TermsService = {
  async create(data: {
    title: string;
    slug: string;
    content: string;
    version: string;
    type?: TermsType;
    language?: string;
    createdById: string;
    metaTitle?: string;
    metaDesc?: string;
  }) {
    // If marked active, deactivate others of same type
    if (data.type && data.type !== undefined) {
      await prisma.termsAndConditions.updateMany({
        where: { type: data.type, isActive: true },
        data: { isActive: false },
      });
    }

    return prisma.termsAndConditions.create({
      data,
    });
  },

  async update(id: string, data: any, updatedById: string) {
    return prisma.termsAndConditions.update({
      where: { id },
      data: { ...data, updatedById },
    });
  },

  async publish(id: string, updatedById: string) {
    return prisma.termsAndConditions.update({
      where: { id },
      data: {
        isPublished: true,
        publishedAt: new Date(),
        updatedById,
      },
    });
  },

  async setActive(id: string, type: TermsType) {
    // Deactivate all active terms of this type
    await prisma.termsAndConditions.updateMany({
      where: { type, isActive: true },
      data: { isActive: false },
    });

    return prisma.termsAndConditions.update({
      where: { id },
      data: { isActive: true },
    });
  },

  async getActive(type: TermsType = TermsType.GENERAL) {
    return prisma.termsAndConditions.findFirst({
      where: { type, isActive: true, isPublished: true },
    });
  },

  async list(params?: { type?: TermsType; isPublished?: boolean }) {
    return prisma.termsAndConditions.findMany({
      where: params,
      orderBy: { createdAt: "desc" },
    });
  },

  async delete(id: string) {
    return prisma.termsAndConditions.delete({ where: { id } });
  },
};
