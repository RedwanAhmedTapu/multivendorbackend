// src/modules/hrm/services/designation.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";
import type { CreateDesignationInput, UpdateDesignationInput } from "../types/hrm.types.ts";
import { hrBootstrapService } from "./hrBootstrap.service.ts";

export const designationService = {
  async create(scope: HrScope, data: CreateDesignationInput) {
    const existing = await prisma.hrDesignation.findFirst({
      where: { vendorId: scope.vendorId, code: data.code },
    });
    if (existing) throw new Error("Designation code already exists");

    return prisma.hrDesignation.create({
      data: { ...data, vendorId: scope.vendorId },
    });
  },

  async list(scope: HrScope, departmentId?: string) {
    await hrBootstrapService.ensureDefaults(scope);
    return prisma.hrDesignation.findMany({
      where: { vendorId: scope.vendorId, ...(departmentId ? { departmentId } : {}) },
      include: { department: true },
      orderBy: { createdAt: "desc" },
    });
  },

  async getById(scope: HrScope, id: string) {
    const designation = await prisma.hrDesignation.findFirst({
      where: { id, vendorId: scope.vendorId },
      include: { department: true },
    });
    if (!designation) throw new Error("Designation not found");
    return designation;
  },

  async update(scope: HrScope, id: string, data: UpdateDesignationInput) {
    const existing = await prisma.hrDesignation.findFirst({
      where: { id, vendorId: scope.vendorId },
    });
    if (!existing) throw new Error("Designation not found");

    return prisma.hrDesignation.update({ where: { id }, data });
  },

  async remove(scope: HrScope, id: string) {
    const existing = await prisma.hrDesignation.findFirst({
      where: { id, vendorId: scope.vendorId },
    });
    if (!existing) throw new Error("Designation not found");

    // Reference guard (HRM-style): never orphan employees holding it.
    const employees = await prisma.hrEmployeeProfile.count({ where: { designationId: id } });
    if (employees > 0) {
      throw new Error(`Cannot delete this designation because ${employees} employee(s) are assigned to it.`);
    }

    return prisma.hrDesignation.update({ where: { id }, data: { status: "ARCHIVED" } });
  },
};
