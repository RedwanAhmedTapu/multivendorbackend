import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Create
export const createProvider = async (data: any) => {
  return prisma.shippingProvider.create({
    data: {
      name: data.name,
      baseUrl: data.baseUrl,
      config: data.config,
    },
  });
};

// Read
export const getProviders = async () => {
  return prisma.shippingProvider.findMany();
};

// Get Active
export const getActiveProvider = async () => {
  return prisma.shippingProvider.findFirst({
    where: { isActive: true },
  });
};

// Update
export const updateProvider = async (id: string, data: any) => {
  return prisma.shippingProvider.update({
    where: { id },
    data: {
      name: data.name,
      baseUrl: data.baseUrl,
      config: data.config,
    },
  });
};

// Delete
export const deleteProvider = async (id: string) => {
  return prisma.shippingProvider.delete({
    where: { id },
  });
};

// Activate one provider (deactivate others)
export const activateProvider = async (id: string) => {
  await prisma.shippingProvider.updateMany({
    data: { isActive: false },
  });

  return prisma.shippingProvider.update({
    where: { id },
    data: { isActive: true },
  });
};
export const deactivateProvider = async (id: string) => {

  return prisma.shippingProvider.update({
    where: { id },
    data: { isActive: false },
  });
};
