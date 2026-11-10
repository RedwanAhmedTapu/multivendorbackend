// src/modules/hrm/services/advanceExpense.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

export const advanceService = {
  async apply(scope: HrScope, data: { employeeId: string; amount: number; reason?: string; requestDate: string; installments?: number }) {
    return prisma.hrAdvance.create({
      data: {
        vendorId: scope.vendorId,
        employeeId: data.employeeId,
        amount: data.amount,
        reason: data.reason,
        requestDate: data.requestDate,
        installments: data.installments || 1,
        outstanding: data.amount,
        status: "PENDING",
      },
    });
  },

  async list(scope: HrScope, filters: { employeeId?: string; status?: string }) {
    return prisma.hrAdvance.findMany({ where: { vendorId: scope.vendorId, ...filters }, orderBy: { createdAt: "desc" } });
  },

  async actOn(scope: HrScope, id: string, status: "APPROVED" | "REJECTED", approvedBy: string) {
    const adv = await prisma.hrAdvance.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!adv) throw new Error("Advance not found");
    if (adv.status !== "PENDING") throw new Error("Already acted on");
    return prisma.hrAdvance.update({
      where: { id },
      data: { status: status === "APPROVED" ? "RECOVERING" : "REJECTED", approvedBy, actedAt: new Date() },
    });
  },

  /** Manual/off-cycle recovery (payroll.markPaid also settles these automatically). */
  async recordRecovery(scope: HrScope, id: string, amount: number) {
    const adv = await prisma.hrAdvance.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!adv) throw new Error("Advance not found");
    const newDeducted = Number(adv.deducted) + amount;
    const newOutstanding = Math.max(0, Number(adv.amount) - newDeducted);
    return prisma.hrAdvance.update({
      where: { id },
      data: { deducted: newDeducted, outstanding: newOutstanding, status: newOutstanding <= 0 ? "RECOVERED" : "RECOVERING" },
    });
  },
};

export const expenseService = {
  async submit(scope: HrScope, data: { employeeId: string; category: string; title: string; amount: number; date: string; description?: string; receiptUrl?: string }) {
    return prisma.hrExpenseClaim.create({ data: { ...data, vendorId: scope.vendorId, status: "PENDING" } });
  },

  async list(scope: HrScope, filters: { employeeId?: string; status?: string }) {
    return prisma.hrExpenseClaim.findMany({ where: { vendorId: scope.vendorId, ...filters }, orderBy: { createdAt: "desc" } });
  },

  async actOn(scope: HrScope, id: string, status: "APPROVED" | "REJECTED", approvedAmount: number | undefined, approvedBy: string) {
    const claim = await prisma.hrExpenseClaim.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!claim) throw new Error("Expense claim not found");
    if (claim.status !== "PENDING") throw new Error("Already acted on");
    return prisma.hrExpenseClaim.update({
      where: { id },
      data: {
        status,
        approvedAmount: status === "APPROVED" ? (approvedAmount ?? claim.amount) : null,
        approvedBy,
        actedAt: new Date(),
      },
    });
  },

  async markReimbursed(scope: HrScope, id: string) {
    const claim = await prisma.hrExpenseClaim.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!claim) throw new Error("Expense claim not found");
    if (claim.status !== "APPROVED") throw new Error("Only an APPROVED claim can be reimbursed");
    return prisma.hrExpenseClaim.update({ where: { id }, data: { status: "REIMBURSED" } });
  },
};
