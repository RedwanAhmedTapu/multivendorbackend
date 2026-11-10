// src/modules/hrm/services/resignation.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

const DEFAULT_CLEARANCE_CHECKLIST = [
  { department: "IT", item: "Return laptop / revoke system access", cleared: false },
  { department: "Admin", item: "Return ID card / access card", cleared: false },
  { department: "Finance", item: "Settle any dues / advances", cleared: false },
  { department: "HR", item: "Exit interview completed", cleared: false },
];

export const resignationService = {
  async submit(scope: HrScope, data: { employeeId: string; resignationDate: string; proposedLwd: string; reason: string; noticeDays?: number }) {
    return prisma.hrResignation.create({
      data: {
        vendorId: scope.vendorId,
        employeeId: data.employeeId,
        submissionDate: new Date().toISOString().slice(0, 10),
        resignationDate: data.resignationDate,
        proposedLwd: data.proposedLwd,
        reason: data.reason,
        noticeDays: data.noticeDays ?? 30,
        status: "SUBMITTED",
      },
    });
  },

  async list(scope: HrScope, filters: { employeeId?: string; status?: string }) {
    return prisma.hrResignation.findMany({ where: { vendorId: scope.vendorId, ...filters }, orderBy: { createdAt: "desc" } });
  },

  async getById(scope: HrScope, id: string) {
    const resignation = await prisma.hrResignation.findFirst({
      where: { id, vendorId: scope.vendorId },
      include: { clearance: true, settlement: true },
    });
    if (!resignation) throw new Error("Resignation not found");
    return resignation;
  },

  /** On ACCEPTED, auto-creates the exit clearance checklist. */
  async actOn(
    scope: HrScope,
    id: string,
    data: { status: "UNDER_REVIEW" | "ACCEPTED" | "REJECTED"; actualLwd?: string },
    actorUserId: string
  ) {
    const resignation = await prisma.hrResignation.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!resignation) throw new Error("Resignation not found");
    if (["ACCEPTED", "REJECTED", "COMPLETED"].includes(resignation.status)) {
      throw new Error("This resignation has already been finalized");
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.hrResignation.update({
        where: { id },
        data: { status: data.status, actualLwd: data.actualLwd, actedBy: actorUserId, actedAt: new Date() },
      });

      if (data.status === "ACCEPTED") {
        await tx.hrExitClearance.create({
          data: {
            vendorId: scope.vendorId,
            resignationId: id,
            checklistJson: DEFAULT_CLEARANCE_CHECKLIST,
            status: "PENDING",
          },
        });
        await tx.hrEmployeeHistory.create({
          data: {
            vendorId: scope.vendorId,
            employeeId: resignation.employeeId,
            eventType: "RESIGNATION",
            title: `Resignation accepted, last working day ${data.actualLwd ?? resignation.proposedLwd}`,
            createdBy: actorUserId,
          },
        });
      }

      return updated;
    });
  },

  async withdraw(scope: HrScope, id: string) {
    const resignation = await prisma.hrResignation.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!resignation) throw new Error("Resignation not found");
    if (resignation.status === "ACCEPTED") throw new Error("Cannot withdraw — already accepted; contact HR");
    return prisma.hrResignation.update({ where: { id }, data: { status: "WITHDRAWN" } });
  },
};

export const exitClearanceService = {
  async getByResignation(scope: HrScope, resignationId: string) {
    const clearance = await prisma.hrExitClearance.findFirst({ where: { resignationId, vendorId: scope.vendorId } });
    if (!clearance) throw new Error("Exit clearance not found — resignation may not be ACCEPTED yet");
    return clearance;
  },

  async updateChecklist(scope: HrScope, resignationId: string, checklistJson: Array<{ department: string; item: string; cleared: boolean; clearedBy?: string; notes?: string }>) {
    const clearance = await prisma.hrExitClearance.findFirst({ where: { resignationId, vendorId: scope.vendorId } });
    if (!clearance) throw new Error("Exit clearance not found");

    const allCleared = checklistJson.every((c) => c.cleared);
    return prisma.hrExitClearance.update({
      where: { id: clearance.id },
      data: {
        checklistJson,
        status: allCleared ? "CLEARED" : "IN_PROGRESS",
        clearedAt: allCleared ? new Date() : null,
      },
    });
  },
};

export const finalSettlementService = {
  /** Unused days (entitled − used − pending) across leave types marked
   * encashmentAllowed, priced at (gross / 30) per day — same per-day rate
   * payroll.service.ts uses for absence proration, so the two stay consistent. */
  async computeLeaveEncashment(employeeId: string, gross: number) {
    const year = new Date().getFullYear();
    const balances = await prisma.hrLeaveBalance.findMany({
      where: { employeeId, year },
      include: { leaveType: true },
    });

    const perDay = gross / 30;
    let encashableDays = 0;
    for (const balance of balances) {
      if (!balance.leaveType.encashmentAllowed) continue;
      const remaining = Math.max(0, balance.entitled - balance.used - balance.pending);
      encashableDays += remaining;
    }

    return { days: encashableDays, amount: encashableDays * perDay };
  },

  /** Simple computation: last active salary + leave encashment − outstanding loans/advances. */
  async compute(scope: HrScope, resignationId: string) {
    const resignation = await prisma.hrResignation.findFirst({ where: { id: resignationId, vendorId: scope.vendorId } });
    if (!resignation) throw new Error("Resignation not found");

    const [salary, loans, advances] = await Promise.all([
      prisma.hrSalaryStructure.findFirst({ where: { employeeId: resignation.employeeId, status: "ACTIVE" } }),
      prisma.hrLoan.findMany({ where: { employeeId: resignation.employeeId, status: "ACTIVE" } }),
      prisma.hrAdvance.findMany({ where: { employeeId: resignation.employeeId, status: "RECOVERING" } }),
    ]);

    const finalSalary = salary ? Number(salary.gross) : 0;
    const loanDue = loans.reduce((s, l) => s + Number(l.outstanding), 0);
    const advanceDue = advances.reduce((s, a) => s + Number(a.outstanding), 0);
    const encashment = await this.computeLeaveEncashment(resignation.employeeId, finalSalary);
    const leaveEncashment = encashment.amount;
    const netPayable = finalSalary + leaveEncashment - loanDue - advanceDue;

    const computationJson = {
      finalSalary,
      leaveEncashment,
      leaveEncashmentDays: encashment.days,
      loanDue,
      advanceDue,
      netPayable,
    };

    return prisma.hrFinalSettlement.upsert({
      where: { resignationId },
      create: { vendorId: scope.vendorId, resignationId, computationJson, netPayable, status: "CALCULATED" },
      update: { computationJson, netPayable, status: "CALCULATED" },
    });
  },

  async approve(scope: HrScope, resignationId: string, approvedBy: string) {
    const settlement = await prisma.hrFinalSettlement.findFirst({ where: { resignationId, vendorId: scope.vendorId } });
    if (!settlement) throw new Error("Settlement not computed yet");
    if (settlement.status !== "CALCULATED") throw new Error("Must be CALCULATED before approval");
    return prisma.hrFinalSettlement.update({ where: { id: settlement.id }, data: { status: "APPROVED", approvedBy } });
  },

  async markPaid(scope: HrScope, resignationId: string) {
    const settlement = await prisma.hrFinalSettlement.findFirst({ where: { resignationId, vendorId: scope.vendorId } });
    if (!settlement) throw new Error("Settlement not found");
    if (settlement.status !== "APPROVED") throw new Error("Must be APPROVED before marking paid");

    return prisma.$transaction(async (tx) => {
      const paid = await tx.hrFinalSettlement.update({
        where: { id: settlement.id },
        data: { status: "PAID", paidAt: new Date() },
      });
      await tx.hrResignation.update({ where: { id: resignationId }, data: { status: "COMPLETED" } });
      const resignation = await tx.hrResignation.findUnique({ where: { id: resignationId } });
      if (resignation) {
        await tx.hrEmployeeProfile.update({ where: { id: resignation.employeeId }, data: { status: "RESIGNED" } });
      }
      return paid;
    });
  },
};
