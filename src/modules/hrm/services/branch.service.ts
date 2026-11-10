// src/modules/hrm/services/branch.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";
import type { CreateBranchInput, UpdateBranchInput } from "../types/hrm.types.ts";
import { hrBootstrapService } from "./hrBootstrap.service.ts";

export const branchService = {
  async create(scope: HrScope, data: CreateBranchInput) {
    const existing = await prisma.hrBranch.findFirst({
      where: { vendorId: scope.vendorId, code: data.code },
    });
    if (existing) throw new Error("Branch code already exists");

    return prisma.hrBranch.create({
      data: { ...data, vendorId: scope.vendorId },
    });
  },

  async list(scope: HrScope) {
    // Bootstrap starter branches the first time a tenant looks at org data
    // (idempotent — no-ops once any branch exists).
    await hrBootstrapService.ensureDefaults(scope);
    return prisma.hrBranch.findMany({
      where: { vendorId: scope.vendorId },
      orderBy: { createdAt: "desc" },
    });
  },

  async getById(scope: HrScope, id: string) {
    const branch = await prisma.hrBranch.findFirst({
      where: { id, vendorId: scope.vendorId },
      include: { departments: true },
    });
    if (!branch) throw new Error("Branch not found");
    return branch;
  },

  async update(scope: HrScope, id: string, data: UpdateBranchInput) {
    const existing = await prisma.hrBranch.findFirst({
      where: { id, vendorId: scope.vendorId },
    });
    if (!existing) throw new Error("Branch not found");

    return prisma.hrBranch.update({ where: { id }, data });
  },

  async remove(scope: HrScope, id: string) {
    const existing = await prisma.hrBranch.findFirst({
      where: { id, vendorId: scope.vendorId },
    });
    if (!existing) throw new Error("Branch not found");

    // Reference guard (HRM-style): never orphan employees that point at
    // this branch. The soft-archive below stays reversible.
    const employees = await prisma.hrEmployeeProfile.count({ where: { branchId: id } });
    if (employees > 0) {
      throw new Error(`Cannot delete this branch because ${employees} employee(s) are assigned to it.`);
    }

    // Soft-disable instead of hard delete — branches are referenced by
    // employees/attendance/shifts, deleting would cascade-restrict.
    return prisma.hrBranch.update({ where: { id }, data: { active: false } });
  },
};
