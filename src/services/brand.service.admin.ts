// services/brand.service.admin.ts
import { prisma } from "../config/prisma.ts";
import type { BrandStatus } from "@/types/brand.ts";

/**
 * Admin Brand Service
 * Handles administrative brand operations (cross-vendor visibility + approval workflow)
 */
export const AdminBrandService = {
  // ======================
  // Get all brands (any status), optionally filtered
  // ======================
  async getAll(options?: {
    status?: BrandStatus;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const { status, search, page = 1, limit = 20 } = options ?? {};

    const where: any = {};
    if (status) where.status = status;
    if (search) where.name = { contains: search, mode: "insensitive" };

    const total = await prisma.brand.count({ where });
    const skip = (page - 1) * limit;
    const totalPages = Math.ceil(total / limit);

    const brands = await prisma.brand.findMany({
      where,
      include: {
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
            verificationStatus: true,
          },
        },
        links: true,
      },
      orderBy: { createdAt: "desc" },
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
  // Get brands pending approval
  // ======================
  async getPendingApproval() {
    return prisma.brand.findMany({
      where: { status: "PENDING" },
      include: {
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
            verificationStatus: true,
          },
        },
        links: true,
      },
      orderBy: { createdAt: "asc" },
    });
  },

  // ======================
  // Get brand by ID (any status)
  // ======================
  async getById(id: string) {
    return prisma.brand.findUnique({
      where: { id },
      include: {
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
            verificationStatus: true,
          },
        },
        links: true,
      },
    });
  },

  // ======================
  // Get brands by vendor ID (admin view)
  // ======================
  async getByVendorId(vendorId: string, status?: BrandStatus) {
    const where: any = { vendorId };
    if (status) where.status = status;

    return prisma.brand.findMany({
      where,
      include: {
        links: true,
      },
      orderBy: { createdAt: "desc" },
    });
  },

  // ======================
  // Approve brand
  // ======================
  async approveBrand(id: string, adminId: string) {
    const brand = await prisma.brand.findUnique({
      where: { id },
      select: { name: true, status: true },
    });

    if (!brand) {
      throw new Error("Brand not found");
    }

    if (brand.status === "APPROVED") {
      throw new Error("Brand is already approved");
    }

    const updatedBrand = await prisma.brand.update({
      where: { id },
      data: { status: "APPROVED" },
      include: {
        vendor: { select: { id: true, storeName: true, avatar: true } },
        links: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: adminId,
        action: "APPROVE",
        entity: "Brand",
        entityId: id,
        oldData: { status: brand.status },
        newData: { status: "APPROVED" },
      },
    });

    return updatedBrand;
  },

  // ======================
  // Reject brand
  // ======================
  async rejectBrand(id: string, adminId: string, reason?: string) {
    const brand = await prisma.brand.findUnique({
      where: { id },
      select: { name: true, status: true },
    });

    if (!brand) {
      throw new Error("Brand not found");
    }

    const updatedBrand = await prisma.brand.update({
      where: { id },
      data: { status: "REJECTED" },
      include: {
        vendor: { select: { id: true, storeName: true, avatar: true } },
        links: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: adminId,
        action: "REJECT",
        entity: "Brand",
        entityId: id,
        oldData: { status: brand.status },
        newData: { status: "REJECTED", rejectionReason: reason },
      },
    });

    return updatedBrand;
  },
  // ======================
  // Search / list brand names (used by the vendor's searchable dropdown)
  // ======================
  async getAllBrandsnames(options?: { search?: string; limit?: number }) {
    const { search, limit = 50 } = options ?? {};
 
    return prisma.brandCatalog.findMany({
      where: search
        ? { name: { contains: search, mode: "insensitive" } }
        : undefined,
      orderBy: { name: "asc" },
      take: Math.min(limit, 200),
    });
  },
 
  // ======================
  // Add a single brand name (admin)
  // ======================
  async create(name: string, adminId?: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Brand name is required");
    }
 
    const existing = await prisma.brandCatalog.findUnique({
      where: { name: trimmed },
    });
    if (existing) {
      throw new Error("This brand name already exists in the catalog");
    }
 
    return prisma.brandCatalog.create({
      data: { name: trimmed, createdBy: adminId },
    });
  },
 
  // ======================
  // Bulk add brand names (admin)
  // Accepts a raw array of strings; dedupes case-sensitively against
  // itself and skips anything already in the catalog. Uses createMany
  // with skipDuplicates so a partially-overlapping list doesn't fail
  // the whole batch.
  // ======================
  async bulkCreate(names: string[], adminId?: string) {
    const cleaned = Array.from(
      new Set(
        names
          .map((n) => (typeof n === "string" ? n.trim() : ""))
          .filter((n) => n.length > 0)
      )
    );
 
    if (cleaned.length === 0) {
      throw new Error("No valid brand names provided");
    }
 
    const result = await prisma.brandCatalog.createMany({
      data: cleaned.map((name) => ({ name, createdBy: adminId })),
      skipDuplicates: true,
    });
 
    return {
      submitted: names.length,
      uniqueSubmitted: cleaned.length,
      created: result.count,
      skipped: cleaned.length - result.count,
    };
  },
 
  // ======================
  // Remove a brand name (admin)
  // ======================
  async remove(id: string) {
    const existing = await prisma.brandCatalog.findUnique({ where: { id } });
    if (!existing) {
      throw new Error("Brand catalog entry not found");
    }
    return prisma.brandCatalog.delete({ where: { id } });
  },
};