// src/services/user-address.service.ts
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface CreateAddressInput {
  userId: string;
  locationId: string;
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  landmark?: string;
  isDefault?: boolean;
  addressType?: string;
}

interface UpdateAddressInput {
  locationId?: string;
  fullName?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  landmark?: string;
  isDefault?: boolean;
  addressType?: string;
}

interface UpsertAddressInput {
  id?: string;
  locationId: string;
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  landmark?: string;
  isDefault?: boolean;
  addressType?: string;
}

export class UserAddressService {
  private readonly MAX_ADDRESSES = 5;

  async createAddress(data: CreateAddressInput) {
    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: data.userId },
    });

    if (!user) {
      const error = new Error('User not found');
      (error as any).statusCode = 404;
      throw error;
    }

    // Verify location exists
    const location = await prisma.locations.findUnique({
      where: { id: data.locationId },
    });

    if (!location) {
      const error = new Error('Location not found');
      (error as any).statusCode = 404;
      throw error;
    }

    // Check address limit
    const addressCount = await prisma.userAddress.count({
      where: { userId: data.userId },
    });

    if (addressCount >= this.MAX_ADDRESSES) {
      const error = new Error(`Maximum ${this.MAX_ADDRESSES} addresses allowed per user`);
      (error as any).statusCode = 400;
      throw error;
    }

    // If this is the first address or marked as default, set it as default
    const shouldBeDefault = addressCount === 0 || data.isDefault === true;

    // If setting as default, unset other default addresses
    if (shouldBeDefault) {
      await prisma.userAddress.updateMany({
        where: {
          userId: data.userId,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }

    const address = await prisma.userAddress.create({
      data: {
        userId: data.userId,
        locationId: data.locationId,
        fullName: data.fullName,
        phone: data.phone,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        landmark: data.landmark,
        isDefault: shouldBeDefault,
        addressType: data.addressType,
      },
      include: {
        locations: true,
        users: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    return address;
  }

  async getAddressesByUser(userId: string, filters: { isDefault?: boolean } = {}) {
    const where: Prisma.UserAddressWhereInput = { userId };

    if (filters.isDefault !== undefined) {
      where.isDefault = filters.isDefault;
    }

    const addresses = await prisma.userAddress.findMany({
      where,
      include: {
        locations: true,
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    return addresses;
  }

  async getAddressById(id: string, userId?: string) {
    const where: Prisma.UserAddressWhereUniqueInput = { id };

    const address = await prisma.userAddress.findUnique({
      where,
      include: {
        locations: true,
        users: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    if (!address) {
      const error = new Error('Address not found');
      (error as any).statusCode = 404;
      throw error;
    }

    // Verify ownership if userId is provided
    if (userId && address.userId !== userId) {
      const error = new Error('Unauthorized access to this address');
      (error as any).statusCode = 403;
      throw error;
    }

    return address;
  }

  async updateAddress(id: string, userId: string, data: UpdateAddressInput) {
    const existing = await prisma.userAddress.findUnique({
      where: { id },
    });

    if (!existing) {
      const error = new Error('Address not found');
      (error as any).statusCode = 404;
      throw error;
    }

    // Verify ownership
    if (existing.userId !== userId) {
      const error = new Error('Unauthorized access to this address');
      (error as any).statusCode = 403;
      throw error;
    }

    // Verify location if being updated
    if (data.locationId) {
      const location = await prisma.locations.findUnique({
        where: { id: data.locationId },
      });

      if (!location) {
        const error = new Error('Location not found');
        (error as any).statusCode = 404;
        throw error;
      }
    }

    // If setting as default, unset other default addresses
    if (data.isDefault === true) {
      await prisma.userAddress.updateMany({
        where: {
          userId: userId,
          isDefault: true,
          id: { not: id },
        },
        data: { isDefault: false },
      });
    }

    const address = await prisma.userAddress.update({
      where: { id },
      data,
      include: {
        locations: true,
        users: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    return address;
  }

  async upsertAddress(userId: string, data: UpsertAddressInput) {
    if (data.id) {
      // Update existing address
      return this.updateAddress(data.id, userId, {
        locationId: data.locationId,
        fullName: data.fullName,
        phone: data.phone,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        landmark: data.landmark,
        isDefault: data.isDefault,
        addressType: data.addressType,
      });
    } else {
      // Create new address
      return this.createAddress({
        userId,
        locationId: data.locationId,
        fullName: data.fullName,
        phone: data.phone,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        landmark: data.landmark,
        isDefault: data.isDefault,
        addressType: data.addressType,
      });
    }
  }

  async deleteAddress(id: string, userId: string) {
    const address = await prisma.userAddress.findUnique({
      where: { id },
    });

    if (!address) {
      const error = new Error('Address not found');
      (error as any).statusCode = 404;
      throw error;
    }

    // Verify ownership
    if (address.userId !== userId) {
      const error = new Error('Unauthorized access to this address');
      (error as any).statusCode = 403;
      throw error;
    }

    const wasDefault = address.isDefault;

    await prisma.userAddress.delete({
      where: { id },
    });

    // If deleted address was default, set another address as default
    if (wasDefault) {
      const remainingAddresses = await prisma.userAddress.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });

      if (remainingAddresses) {
        await prisma.userAddress.update({
          where: { id: remainingAddresses.id },
          data: { isDefault: true },
        });
      }
    }

    return { success: true };
  }

  async setDefaultAddress(id: string, userId: string) {
    const address = await prisma.userAddress.findUnique({
      where: { id },
    });

    if (!address) {
      const error = new Error('Address not found');
      (error as any).statusCode = 404;
      throw error;
    }

    // Verify ownership
    if (address.userId !== userId) {
      const error = new Error('Unauthorized access to this address');
      (error as any).statusCode = 403;
      throw error;
    }

    // Unset other default addresses
    await prisma.userAddress.updateMany({
      where: {
        userId: userId,
        isDefault: true,
        id: { not: id },
      },
      data: { isDefault: false },
    });

    // Set this address as default
    const updated = await prisma.userAddress.update({
      where: { id },
      data: { isDefault: true },
      include: {
        locations: true,
        users: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    return updated;
  }

  async toggleDefaultAddress(id: string, userId: string) {
    const address = await prisma.userAddress.findUnique({
      where: { id },
    });

    if (!address) {
      const error = new Error('Address not found');
      (error as any).statusCode = 404;
      throw error;
    }

    // Verify ownership
    if (address.userId !== userId) {
      const error = new Error('Unauthorized access to this address');
      (error as any).statusCode = 403;
      throw error;
    }

    // If already default, cannot toggle off (at least one must be default)
    if (address.isDefault) {
      const error = new Error('Cannot unset default address. Set another address as default instead.');
      (error as any).statusCode = 400;
      throw error;
    }

    // Set this address as default (will unset others)
    return this.setDefaultAddress(id, userId);
  }

  async getDefaultAddress(userId: string) {
    const address = await prisma.userAddress.findFirst({
      where: {
        userId,
        isDefault: true,
      },
      include: {
        locations: true,
      },
    });

    if (!address) {
      const error = new Error('No default address found');
      (error as any).statusCode = 404;
      throw error;
    }

    return address;
  }

  async getAddressCount(userId: string): Promise<number> {
    return prisma.userAddress.count({
      where: { userId },
    });
  }
}