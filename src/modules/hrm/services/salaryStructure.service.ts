// src/modules/hrm/services/salaryStructure.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

export interface AssignSalaryInput {
  employeeId: string;
  basic: number;
  houseRent?: number;
  medical?: number;
  conveyance?: number;
  otherAllowance?: number;
  effectiveFrom?: string;
}

export const salaryStructureService = {
  /** Assigns a new salary, automatically superseding the previous ACTIVE one. */
  async assign(scope: HrScope, data: AssignSalaryInput, createdBy: string) {
    const houseRent = data.houseRent ?? 0;
    const medical = data.medical ?? 0;
    const conveyance = data.conveyance ?? 0;
    const otherAllowance = data.otherAllowance ?? 0;
    const gross = data.basic + houseRent + medical + conveyance + otherAllowance;
    const effectiveFrom = data.effectiveFrom || new Date().toISOString().slice(0, 10);

    return prisma.$transaction(async (tx) => {
      const prevActive = await tx.hrSalaryStructure.findFirst({
        where: { employeeId: data.employeeId, status: "ACTIVE" },
      });
      if (prevActive) {
        await tx.hrSalaryStructure.update({
          where: { id: prevActive.id },
          data: { status: "SUPERSEDED", effectiveTo: effectiveFrom },
        });
      }

      const created = await tx.hrSalaryStructure.create({
        data: {
          vendorId: scope.vendorId,
          employeeId: data.employeeId,
          effectiveFrom,
          basic: data.basic,
          houseRent,
          medical,
          conveyance,
          otherAllowance,
          gross,
          status: "ACTIVE",
          createdBy,
        },
      });

      if (prevActive) {
        await tx.hrEmployeeHistory.create({
          data: {
            vendorId: scope.vendorId,
            employeeId: data.employeeId,
            eventType: "SALARY_REVISION",
            title: `Salary revised: ${prevActive.gross} → ${gross}`,
            amount: gross,
            createdBy,
          },
        });
      }

      return created;
    });
  },

  async getCurrent(scope: HrScope, employeeId: string) {
    return prisma.hrSalaryStructure.findFirst({
      where: { employeeId, vendorId: scope.vendorId, status: "ACTIVE" },
    });
  },

  async history(scope: HrScope, employeeId: string) {
    return prisma.hrSalaryStructure.findMany({
      where: { employeeId, vendorId: scope.vendorId },
      orderBy: { createdAt: "desc" },
    });
  },
};
