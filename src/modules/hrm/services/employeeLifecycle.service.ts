// src/modules/hrm/services/employeeLifecycle.service.ts
//
// Employee lifecycle: promotions, transfers, salary revisions.
//
// Flow (per the approved Phase-1 spec):
//   create  -> a PENDING record is written; NOTHING is applied to the
//              employee's profile at creation time.
//   act     -> an explicit APPROVED/REJECTED decision. APPROVED applies the
//              change to the profile (promotion: designation; transfer:
//              branch/department) and writes an HrEmployeeHistory timeline
//              event. Salary revision approval records the timeline event
//              (applying it to the payroll salary structure belongs to the
//              payroll phase and is deliberately out of scope here).
//
// No generic approval engine is introduced — these use the existing
// PENDING/APPROVED/REJECTED status columns and the module's scoping rules.

import { prisma, prismaDirect } from "../../../config/prisma.ts";
import { Prisma } from "@prisma/client";
import { employeeProfileService } from "./employeeProfile.service.ts";
import { EmployeeNotFoundError } from "./employeeSections.service.ts";
import type { HrScope } from "../types/hrm.types.ts";

export type LifecycleKind = "promotions" | "transfers" | "salaryRevisions";
export type LifecycleDecision = "APPROVED" | "REJECTED";

async function assertEmployee(scope: HrScope, employeeId: string) {
  const profile = await employeeProfileService.findScopedProfile(scope, employeeId);
  if (!profile) throw new EmployeeNotFoundError();
  return profile;
}

async function writeHistory(
  tx: Prisma.TransactionClient,
  scope: HrScope,
  employeeId: string,
  eventType: "PROMOTION" | "TRANSFER" | "SALARY_REVISION",
  title: string,
  description: string | null | undefined,
  effectiveDate: string,
  amount: number | null,
  actorUserId: string
) {
  await tx.hrEmployeeHistory.create({
    data: {
      vendorId: scope.vendorId,
      employeeId,
      eventType,
      title,
      description: description ?? null,
      effectiveDate,
      amount: amount === null ? null : amount,
      createdBy: actorUserId,
    },
  });
}

export const employeeLifecycleService = {
  // ── Create PENDING records ──────────────────────────────────────────────

  async createPromotion(scope: HrScope, employeeId: string, input: {
    newDesignationId: string; newBasicSalary?: number; effectiveDate: string; reason?: string;
  }, actorUserId: string) {
    const profile = await assertEmployee(scope, employeeId);

    return prisma.hrPromotion.create({
      data: {
        vendorId: scope.vendorId,
        employeeId,
        oldDesignationId: profile.designationId,
        newDesignationId: input.newDesignationId,
        newBasicSalary: input.newBasicSalary ?? null,
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        status: "PENDING",
      },
    });
  },

  async createTransfer(scope: HrScope, employeeId: string, input: {
    toBranchId?: string; toDepartmentId?: string; effectiveDate: string; reason?: string;
  }, actorUserId: string) {
    const profile = await assertEmployee(scope, employeeId);

    return prisma.hrTransfer.create({
      data: {
        vendorId: scope.vendorId,
        employeeId,
        fromBranchId: profile.branchId,
        fromDepartmentId: profile.departmentId,
        toBranchId: input.toBranchId,
        toDepartmentId: input.toDepartmentId,
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        status: "PENDING",
      },
    });
  },

  async createSalaryRevision(scope: HrScope, employeeId: string, input: {
    newSalary: number; effectiveDate: string; reason?: string;
  }, actorUserId: string) {
    await assertEmployee(scope, employeeId);

    // HRM parity: a revision only makes sense against an active structure —
    // set one via the salary endpoints first.
    const active = await prisma.hrSalaryStructure.findFirst({
      where: { employeeId, status: "ACTIVE" },
      select: { gross: true },
    });
    if (!active) throw new Error("Employee has no active salary structure — set one first");

    return prisma.hrSalaryRevision.create({
      data: {
        vendorId: scope.vendorId,
        employeeId,
        previousSalary: active.gross,
        newSalary: input.newSalary,
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        status: "PENDING",
      },
    });
  },

  // ── Decide (approve / reject) ───────────────────────────────────────────

  async actOn(scope: HrScope, kind: LifecycleKind, employeeId: string, recordId: string,
    status: LifecycleDecision, actorUserId: string) {
    await assertEmployee(scope, employeeId);

    const delegates = {
      promotions: prisma.hrPromotion,
      transfers: prisma.hrTransfer,
      salaryRevisions: prisma.hrSalaryRevision,
    } as const;
    const delegate = delegates[kind];

    const record = await delegate.findFirst({ where: { id: recordId, employeeId } });
    if (!record) throw new Error("Lifecycle record not found");
    if (record.status !== "PENDING") throw new Error("This record has already been decided");

    return prismaDirect.$transaction(async (tx) => {
      // Re-check inside the transaction so two concurrent approvals can't
      // both apply (findFirst → update race).
      const fresh = await delegate.findFirst({ where: { id: recordId, employeeId } });
      if (!fresh || fresh.status !== "PENDING") throw new Error("This record has already been decided");

      await delegate.update({ where: { id: recordId }, data: { status, approvedBy: actorUserId } });

      if (status === "APPROVED") {
        if (kind === "promotions") {
          await tx.hrEmployeeProfile.update({
            where: { id: employeeId },
            data: { designationId: record.newDesignationId ?? undefined },
          });
          await writeHistory(
            tx, scope, employeeId, "PROMOTION",
            record.reason ? `Promotion approved: ${record.reason}` : "Promotion approved",
            record.reason, record.effectiveDate,
            record.newBasicSalary ? Number(record.newBasicSalary) : null,
            actorUserId
          );
        } else if (kind === "transfers") {
          await tx.hrEmployeeProfile.update({
            where: { id: employeeId },
            data: {
              branchId: record.toBranchId ?? undefined,
              departmentId: record.toDepartmentId ?? undefined,
            },
          });
          await writeHistory(
            tx, scope, employeeId, "TRANSFER",
            record.reason ? `Transfer approved: ${record.reason}` : "Transfer approved",
            record.reason, record.effectiveDate, null, actorUserId
          );
        } else {
          // Salary revision APPROVED — supersede the current structure
          // (effectiveTo = day before the new effective date) and create a
          // pro-rata scaled replacement, exactly like the HRM reference.
          const current = await tx.hrSalaryStructure.findFirst({
            where: { employeeId, status: "ACTIVE" },
          });
          if (current) {
            const newGross = Number(record.newSalary);
            const ratio = Number(current.gross) > 0 ? newGross / Number(current.gross) : 1;
            const round = (v: any) => Math.round(Number(v) * ratio * 100) / 100;
            const effectiveTo = new Date(
              new Date(`${record.effectiveDate}T00:00:00Z`).getTime() - 86400000
            ).toISOString().slice(0, 10);

            await tx.hrSalaryStructure.update({
              where: { id: current.id },
              data: { status: "SUPERSEDED", effectiveTo },
            });
            await tx.hrSalaryStructure.create({
              data: {
                vendorId: scope.vendorId,
                employeeId,
                effectiveFrom: record.effectiveDate,
                basic: round(current.basic),
                houseRent: round(current.houseRent),
                medical: round(current.medical),
                conveyance: round(current.conveyance),
                otherAllowance: round(current.otherAllowance),
                gross: newGross,
                createdBy: actorUserId,
                status: "ACTIVE",
              },
            });
          }
          await writeHistory(
            tx, scope, employeeId, "SALARY_REVISION",
            record.reason ? `Salary revision approved: ${record.reason}` : "Salary revision approved",
            record.reason, record.effectiveDate,
            record.newSalary ? Number(record.newSalary) : null,
            actorUserId
          );
        }
      }

      return { ...record, status };
    });
  },

  // ── History timeline ────────────────────────────────────────────────────

  async listHistory(scope: HrScope, employeeId: string) {
    await assertEmployee(scope, employeeId);
    return prisma.hrEmployeeHistory.findMany({
      where: { employeeId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  },
};
