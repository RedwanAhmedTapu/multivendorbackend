// src/modules/hrm/services/department.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";
import type { CreateDepartmentInput, UpdateDepartmentInput } from "../types/hrm.types.ts";
import { hrBootstrapService } from "./hrBootstrap.service.ts";

export const departmentService = {
  async create(scope: HrScope, data: CreateDepartmentInput) {
    const existing = await prisma.hrDepartment.findFirst({
      where: { vendorId: scope.vendorId, code: data.code },
    });
    if (existing) throw new Error("Department code already exists");

    return prisma.hrDepartment.create({
      data: { ...data, vendorId: scope.vendorId },
    });
  },

  async list(scope: HrScope, branchId?: string) {
    await hrBootstrapService.ensureDefaults(scope);
    return prisma.hrDepartment.findMany({
      where: { vendorId: scope.vendorId, ...(branchId ? { branchId } : {}) },
      include: { branch: true },
      orderBy: { createdAt: "desc" },
    });
  },

  async getById(scope: HrScope, id: string) {
    const dept = await prisma.hrDepartment.findFirst({
      where: { id, vendorId: scope.vendorId },
      include: { branch: true, designations: true },
    });
    if (!dept) throw new Error("Department not found");
    return dept;
  },

  async update(scope: HrScope, id: string, data: UpdateDepartmentInput) {
    const existing = await prisma.hrDepartment.findFirst({
      where: { id, vendorId: scope.vendorId },
    });
    if (!existing) throw new Error("Department not found");

    return prisma.hrDepartment.update({ where: { id }, data });
  },

  async remove(scope: HrScope, id: string) {
    const existing = await prisma.hrDepartment.findFirst({
      where: { id, vendorId: scope.vendorId },
    });
    if (!existing) throw new Error("Department not found");

    // Reference guard (HRM-style): never orphan employees in this department.
    const employees = await prisma.hrEmployeeProfile.count({ where: { departmentId: id } });
    if (employees > 0) {
      throw new Error(`Cannot delete this department because ${employees} employee(s) are assigned to it.`);
    }

    return prisma.hrDepartment.update({ where: { id }, data: { status: "ARCHIVED" } });
  },
};
