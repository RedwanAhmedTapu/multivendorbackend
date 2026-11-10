// src/modules/hrm/services/loan.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

function addMonths(dateIso: string, months: number) {
  const d = new Date(dateIso);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

export const loanService = {
  async apply(scope: HrScope, data: { employeeId: string; type?: string; principal: number; installments: number; startDate: string; purpose?: string }) {
    const installmentAmount = data.principal / Math.max(1, data.installments);
    return prisma.hrLoan.create({
      data: {
        vendorId: scope.vendorId,
        employeeId: data.employeeId,
        type: data.type || "PERSONAL",
        principal: data.principal,
        installments: data.installments,
        installmentAmount,
        startDate: data.startDate,
        purpose: data.purpose,
        outstanding: data.principal,
        status: "PENDING",
      },
    });
  },

  async list(scope: HrScope, filters: { employeeId?: string; status?: string }) {
    return prisma.hrLoan.findMany({
      where: { vendorId: scope.vendorId, ...filters },
      orderBy: { createdAt: "desc" },
    });
  },

  async getById(scope: HrScope, id: string) {
    const loan = await prisma.hrLoan.findFirst({
      where: { id, vendorId: scope.vendorId },
      include: { installments_: { orderBy: { no: "asc" } } },
    });
    if (!loan) throw new Error("Loan not found");
    return loan;
  },

  /** Approving generates the full installment schedule (one row per month). */
  async actOn(scope: HrScope, id: string, status: "APPROVED" | "REJECTED", approvedBy: string) {
    const loan = await prisma.hrLoan.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!loan) throw new Error("Loan not found");
    if (loan.status !== "PENDING") throw new Error("Already acted on");

    if (status === "REJECTED") {
      return prisma.hrLoan.update({ where: { id }, data: { status: "REJECTED", approvedBy, actedAt: new Date() } });
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.hrLoan.update({
        where: { id },
        data: { status: "ACTIVE", approvedBy, actedAt: new Date() },
      });

      const rows = Array.from({ length: loan.installments }, (_, i) => ({
        loanId: id,
        no: i + 1,
        dueDate: addMonths(loan.startDate, i + 1),
        amount: loan.installmentAmount,
      }));
      await tx.hrLoanInstallment.createMany({ data: rows });

      await tx.hrEmployeeHistory.create({
        data: {
          vendorId: scope.vendorId,
          employeeId: loan.employeeId,
          eventType: "LOAN",
          title: `Loan approved: ${loan.principal} over ${loan.installments} installments`,
          amount: loan.principal,
          createdBy: approvedBy,
        },
      });

      return updated;
    });
  },

  /** Manual/off-cycle installment payment (payroll.markPaid also settles these automatically). */
  async recordPayment(scope: HrScope, loanId: string, installmentNo: number, amount: number) {
    const loan = await prisma.hrLoan.findFirst({ where: { id: loanId, vendorId: scope.vendorId } });
    if (!loan) throw new Error("Loan not found");

    return prisma.$transaction(async (tx) => {
      const installment = await tx.hrLoanInstallment.update({
        where: { loanId_no: { loanId, no: installmentNo } },
        data: { paidAmount: { increment: amount }, paidAt: new Date(), status: "PAID" },
      });

      const newPaid = Number(loan.paidAmount) + amount;
      const newOutstanding = Math.max(0, Number(loan.principal) - newPaid);
      await tx.hrLoan.update({
        where: { id: loanId },
        data: { paidAmount: newPaid, outstanding: newOutstanding, status: newOutstanding <= 0 ? "CLOSED" : "ACTIVE" },
      });

      return installment;
    });
  },
};
