// services/brand.service.vendor.ts
import { prisma } from "../config/prisma.ts";
import type {
  CreateBrandData,
  UpdateBrandData,
  GetMyBrandsOptions,
} from "@/types/brand.ts";

/**
 * Vendor Brand Service
 * Handles vendor-specific brand operations.
 * Every mutation is scoped to the vendor's own brands (ownership verified).
 */
export const VendorBrandService = {
  // ======================
  // Get vendor's own brands (paginated)
  // ======================
  async getMyBrands(vendorId: string, options: GetMyBrandsOptions = {}) {
    const {
      status,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      page = 1,
      limit = 10,
    } = options;

    const where: any = { vendorId };

    if (status) {
      where.status = status;
    }

    if (search) {
      where.name = { contains: search, mode: "insensitive" };
    }

    const validSortFields = ["createdAt", "updatedAt", "name", "status"];
    const orderBy: any = {
      [validSortFields.includes(sortBy) ? sortBy : "createdAt"]: sortOrder,
    };

    const total = await prisma.brand.count({ where });
    const skip = (page - 1) * limit;
    const totalPages = Math.ceil(total / limit);

    const brands = await prisma.brand.findMany({
      where,
      include: {
        links: true,
      },
      orderBy,
      skip,
      take: limit,
    });

    return {
      brands,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  },

  // ======================
  // Get single brand (ownership verified)
  // ======================
  async getById(id: string, vendorId: string) {
    return prisma.brand.findFirst({
      where: { id, vendorId },
      include: {
        links: true,
        vendor: {
          select: { id: true, storeName: true, avatar: true },
        },
      },
    });
  },

  // ======================
  // Create brand
  // ======================
  async create(
    vendorId: string,
    data: CreateBrandData & { userId?: string }
  ) {
    // Enforce the same-vendor/same-name uniqueness proactively for a clean error message
    const existing = await prisma.brand.findUnique({
      where: { vendorId_name: { vendorId, name: data.name } },
    });

    if (existing) {
      throw new Error("You have already registered a brand with this name");
    }

    const brand = await prisma.brand.create({
      data: {
        vendorId,
        name: data.name,
        relationship: data.relationship,
        authorizationStart: new Date(data.authorizationStart),
        authorizationEnd: data.authorizationEnd
          ? new Date(data.authorizationEnd)
          : null,
        hasEndDate: data.hasEndDate ?? false,
        authenticationDoc: data.authenticationDoc ?? null,
        status: "PENDING",

        links: data.links?.length
          ? {
              create: data.links.map((link) => ({
                type: link.type,
                title: link.title ?? null,
                url: link.url,
              })),
            }
          : undefined,
      },
      include: {
        links: true,
      },
    });

    if (data.userId) {
      await prisma.auditLog.create({
        data: {
          userId: data.userId,
          action: "CREATE",
          entity: "Brand",
          entityId: brand.id,
          newData: {
            name: brand.name,
            vendorId: brand.vendorId,
            relationship: brand.relationship,
          },
        },
      });
    }

    return brand;
  },

  // ======================
  // Update brand
  // ======================
  async update(
    id: string,
    vendorId: string,
    data: UpdateBrandData & { userId?: string }
  ) {
    const existingBrand = await prisma.brand.findFirst({
      where: { id, vendorId },
      select: { name: true, status: true, relationship: true },
    });

    if (!existingBrand) {
      throw new Error("Brand not found or unauthorized");
    }

    // If renaming, guard against duplicate (vendorId, name) pairs
    if (data.name && data.name !== existingBrand.name) {
      const duplicate = await prisma.brand.findUnique({
        where: { vendorId_name: { vendorId, name: data.name } },
      });
      if (duplicate) {
        throw new Error("You have already registered a brand with this name");
      }
    }

    const updateData: any = { updatedAt: new Date() };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.relationship !== undefined)
      updateData.relationship = data.relationship;
    if (data.authorizationStart !== undefined)
      updateData.authorizationStart = new Date(data.authorizationStart);
    if (data.authorizationEnd !== undefined)
      updateData.authorizationEnd = data.authorizationEnd
        ? new Date(data.authorizationEnd)
        : null;
    if (data.hasEndDate !== undefined) updateData.hasEndDate = data.hasEndDate;
    if (data.authenticationDoc !== undefined)
      updateData.authenticationDoc = data.authenticationDoc;

    // Any substantive edit sends the brand back for re-approval
    updateData.status = "PENDING";

    if (data.links) {
      updateData.links = {
        deleteMany: { brandId: id },
        create: data.links.map((link) => ({
          type: link.type,
          title: link.title ?? null,
          url: link.url,
        })),
      };
    }

    const updatedBrand = await prisma.brand.update({
      where: { id },
      data: updateData,
      include: {
        links: true,
      },
    });

    if (data.userId) {
      await prisma.auditLog.create({
        data: {
          userId: data.userId,
          action: "UPDATE",
          entity: "Brand",
          entityId: id,
          oldData: existingBrand,
          newData: {
            name: updatedBrand.name,
            status: updatedBrand.status,
            relationship: updatedBrand.relationship,
          },
        },
      });
    }

    return updatedBrand;
  },

  // ======================
  // Delete brand
  // ======================
  async remove(id: string, vendorId: string, userId?: string) {
    const brand = await prisma.brand.findFirst({
      where: { id, vendorId },
      select: { name: true, vendorId: true },
    });

    if (!brand) {
      throw new Error("Brand not found or unauthorized");
    }

    // BrandLink has onDelete: Cascade in the schema, so it's cleaned up
    // automatically — the explicit deleteMany is kept for clarity/safety
    // in case the cascade is ever changed.
    await prisma.brandLink.deleteMany({ where: { brandId: id } });

    const deletedBrand = await prisma.brand.delete({ where: { id } });

    if (userId) {
      await prisma.auditLog.create({
        data: {
          userId,
          action: "DELETE",
          entity: "Brand",
          entityId: id,
          oldData: brand,
        },
      });
    }

    return deletedBrand;
  },
};