// src/modules/hrm/services/bonusDeduction.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

export const bonusService = {
  async create(scope: HrScope, data: any, createdBy: string) {
    return prisma.hrBonus.create({ data: { ...data, vendorId: scope.vendorId, createdBy, status: "PENDING" } });
  },

  async list(scope: HrScope, filters: { employeeId?: string; status?: string }) {
    return prisma.hrBonus.findMany({
      where: { vendorId: scope.vendorId, ...filters },
      orderBy: { createdAt: "desc" },
    });
  },

  async actOn(scope: HrScope, id: string, status: "APPROVED" | "REJECTED", approvedBy: string) {
    const bonus = await prisma.hrBonus.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!bonus) throw new Error("Bonus not found");
    if (bonus.status !== "PENDING") throw new Error("Already acted on");
    // Separation of duties: whoever created the bonus shouldn't self-approve it.
    if (bonus.createdBy === approvedBy) throw new Error("Cannot approve your own bonus entry");
    return prisma.hrBonus.update({ where: { id }, data: { status, approvedBy } });
  },
};

export const deductionService = {
  async create(scope: HrScope, data: any) {
    return prisma.hrDeduction.create({ data: { ...data, vendorId: scope.vendorId, status: "ACTIVE" } });
  },

  async list(scope: HrScope, filters: { employeeId?: string; status?: string }) {
    return prisma.hrDeduction.findMany({
      where: { vendorId: scope.vendorId, ...filters },
      orderBy: { createdAt: "desc" },
    });
  },

  async stop(scope: HrScope, id: string) {
    const ded = await prisma.hrDeduction.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!ded) throw new Error("Deduction not found");
    return prisma.hrDeduction.update({ where: { id }, data: { status: "STOPPED" } });
  },
};
