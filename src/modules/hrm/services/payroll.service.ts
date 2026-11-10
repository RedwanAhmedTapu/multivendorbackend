// src/modules/hrm/services/payroll.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

function pad2(n: number) { return String(n).padStart(2, "0"); }

export const payrollService = {
  async createRun(scope: HrScope, periodMonth: number, periodYear: number, createdBy: string) {
    const existing = await prisma.hrPayrollRun.findUnique({
      where: { vendorId_periodYear_periodMonth: { vendorId: scope.vendorId as any, periodYear, periodMonth } },
    });
    if (existing) throw new Error("Payroll run for this period already exists");

    return prisma.hrPayrollRun.create({
      data: { vendorId: scope.vendorId, periodMonth, periodYear, createdBy, status: "DRAFT" },
    });
  },

  async list(scope: HrScope) {
    return prisma.hrPayrollRun.findMany({
      where: { vendorId: scope.vendorId },
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
    });
  },

  async getById(scope: HrScope, id: string) {
    const run = await prisma.hrPayrollRun.findFirst({
      where: { id, vendorId: scope.vendorId },
      include: { entries: { include: { employee: true } } },
    });
    if (!run) throw new Error("Payroll run not found");
    return run;
  },

  /**
   * Builds/refreshes HrPayrollEntry for every ACTIVE employee: pulls the
   * month's attendance summary, current salary, approved bonuses for the
   * period, active deductions for the month, and this month's due
   * installment on any ACTIVE loan/advance. Safe to re-run on a DRAFT run
   * (upserts), locked once the run leaves DRAFT.
   */
  async calculate(scope: HrScope, runId: string) {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: runId, vendorId: scope.vendorId } });
    if (!run) throw new Error("Payroll run not found");
    if (run.status !== "DRAFT") throw new Error("Only a DRAFT run can be (re)calculated");

    const fromDate = `${run.periodYear}-${pad2(run.periodMonth)}-01`;
    const lastDay = new Date(run.periodYear, run.periodMonth, 0).getDate();
    const toDate = `${run.periodYear}-${pad2(run.periodMonth)}-${pad2(lastDay)}`;

    const employees = await prisma.hrEmployeeProfile.findMany({
      where: { linkedVendorId: scope.vendorId, status: { in: ["ACTIVE", "PROBATION"] } },
    });

    let totalGross = 0, totalBonus = 0, totalDeduction = 0, totalNet = 0;

    for (const emp of employees) {
      const [salary, attendances, bonuses, deductions, activeLoans, activeAdvances] = await Promise.all([
        prisma.hrSalaryStructure.findFirst({ where: { employeeId: emp.id, status: "ACTIVE" } }),
        prisma.hrAttendance.findMany({ where: { employeeId: emp.id, date: { gte: fromDate, lte: toDate } } }),
        prisma.hrBonus.findMany({
          where: { employeeId: emp.id, periodMonth: run.periodMonth, periodYear: run.periodYear, status: "APPROVED" },
        }),
        prisma.hrDeduction.findMany({
          where: { employeeId: emp.id, month: run.periodMonth, year: run.periodYear, status: "ACTIVE" },
        }),
        prisma.hrLoan.findMany({ where: { employeeId: emp.id, status: "ACTIVE" } }),
        prisma.hrAdvance.findMany({ where: { employeeId: emp.id, status: "RECOVERING" } }),
      ]);

      const gross = salary ? Number(salary.gross) : 0;
      const presentDays = attendances.filter((a) => a.status === "PRESENT").length;
      const absentDays = attendances.filter((a) => a.status === "ABSENT").length;
      const leaveDays = attendances.filter((a) => a.status === "LEAVE").length;
      const otMinutes = attendances.reduce((s, a) => s + a.overtimeMinutes, 0);

      const bonusAmount = bonuses.reduce((s, b) => s + Number(b.amount), 0);
      const otherDeduction = deductions.reduce((s, d) => s + Number(d.amount), 0);
      const loanDeduction = activeLoans.reduce((s, l) => s + Number(l.installmentAmount), 0);
      const advanceDeduction = activeAdvances.reduce(
        (s, a) => s + Number(a.amount) / Math.max(1, a.installments),
        0
      );
      // Simple absence policy: one day's proration deducted per unpaid absent day.
      const perDay = gross / 30;
      const absenceDeduction = absentDays * perDay;

      const net = gross + bonusAmount - absenceDeduction - loanDeduction - advanceDeduction - otherDeduction;

      await prisma.hrPayrollEntry.upsert({
        where: { runId_employeeId: { runId, employeeId: emp.id } },
        create: {
          vendorId: scope.vendorId,
          runId,
          employeeId: emp.id,
          presentDays,
          absentDays,
          leaveDays,
          otMinutes,
          gross,
          bonus: bonusAmount,
          absenceDeduction,
          loanDeduction,
          advanceDeduction,
          otherDeduction,
          net,
          breakdownJson: { fromDate, toDate },
        },
        update: {
          presentDays,
          absentDays,
          leaveDays,
          otMinutes,
          gross,
          bonus: bonusAmount,
          absenceDeduction,
          loanDeduction,
          advanceDeduction,
          otherDeduction,
          net,
          breakdownJson: { fromDate, toDate },
        },
      });

      totalGross += gross;
      totalBonus += bonusAmount;
      totalDeduction += absenceDeduction + loanDeduction + advanceDeduction + otherDeduction;
      totalNet += net;
    }

    return prisma.hrPayrollRun.update({
      where: { id: runId },
      data: {
        status: "CALCULATED",
        employeeCount: employees.length,
        totalGross,
        totalBonus,
        totalDeduction,
        totalNet,
      },
    });
  },

  async approve(scope: HrScope, runId: string) {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: runId, vendorId: scope.vendorId } });
    if (!run) throw new Error("Payroll run not found");
    if (run.status !== "CALCULATED") throw new Error("Run must be CALCULATED before approval");
    return prisma.hrPayrollRun.update({ where: { id: runId }, data: { status: "APPROVED" } });
  },

  /** Marks the run PAID and settles the loan/advance installments it covered. */
  async markPaid(scope: HrScope, runId: string) {
    const run = await prisma.hrPayrollRun.findFirst({
      where: { id: runId, vendorId: scope.vendorId },
      include: { entries: true },
    });
    if (!run) throw new Error("Payroll run not found");
    if (run.status !== "APPROVED") throw new Error("Run must be APPROVED before marking paid");

    return prisma.$transaction(async (tx) => {
      for (const entry of run.entries) {
        if (Number(entry.loanDeduction) > 0) {
          const loans = await tx.hrLoan.findMany({ where: { employeeId: entry.employeeId, status: "ACTIVE" } });
          for (const loan of loans) {
            const newPaid = Number(loan.paidAmount) + Number(loan.installmentAmount);
            const newOutstanding = Math.max(0, Number(loan.principal) - newPaid);
            await tx.hrLoan.update({
              where: { id: loan.id },
              data: {
                paidAmount: newPaid,
                outstanding: newOutstanding,
                status: newOutstanding <= 0 ? "CLOSED" : "ACTIVE",
              },
            });
          }
        }
        if (Number(entry.advanceDeduction) > 0) {
          const advances = await tx.hrAdvance.findMany({ where: { employeeId: entry.employeeId, status: "RECOVERING" } });
          for (const adv of advances) {
            const perInstallment = Number(adv.amount) / Math.max(1, adv.installments);
            const newDeducted = Number(adv.deducted) + perInstallment;
            const newOutstanding = Math.max(0, Number(adv.amount) - newDeducted);
            await tx.hrAdvance.update({
              where: { id: adv.id },
              data: {
                deducted: newDeducted,
                outstanding: newOutstanding,
                status: newOutstanding <= 0 ? "RECOVERED" : "RECOVERING",
              },
            });
          }
        }
      }

      return tx.hrPayrollRun.update({
        where: { id: runId },
        data: { status: "PAID", paymentDate: new Date().toISOString().slice(0, 10) },
      });
    });
  },
};
