// src/modules/hrm/services/attendance-correction.service.ts
//
// Attendance correction requests (PHASE AT1): an employee requests a
// correction, an approver approves/rejects it. Self-approval blocked.
// On approval, the attendance record is updated with the corrected times.

import { prisma, prismaDirect } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

export const attendanceCorrectionService = {
  /** Employee requests a correction for a specific date. */
  async request(
    scope: HrScope,
    data: { employeeId: string; date: string; requestedIn?: string; requestedOut?: string; reason: string },
    actorUserId: string
  ) {
    const profile = await prisma.hrEmployeeProfile.findFirst({
      where: { id: data.employeeId, linkedVendorId: scope.vendorId },
      select: { id: true },
    });
    if (!profile) throw new Error("Employee profile not found");

    // No self-approval: store the requester so the approver check can compare.
    return prisma.hrAttendanceCorrection.create({
      data: {
        vendorId: scope.vendorId,
        employeeId: data.employeeId,
        date: data.date,
        requestedIn: data.requestedIn,
        requestedOut: data.requestedOut,
        reason: data.reason,
        status: "PENDING",
        actedBy: null,
      },
    });
  },

  async list(scope: HrScope, filters: { status?: string; employeeId?: string }, page = 1, limit = 20) {
    const p = Math.max(1, page);
    const take = Math.min(100, Math.max(1, limit));
    const where: any = { vendorId: scope.vendorId };
    if (filters.status) where.status = filters.status;
    if (filters.employeeId) where.employeeId = filters.employeeId;
    const [items, total] = await Promise.all([
      prisma.hrAttendanceCorrection.findMany({
        where,
        include: { employee: { select: { id: true, code: true, fullName: true } } },
        orderBy: { createdAt: "desc" },
        skip: (p - 1) * take,
        take,
      }),
      prisma.hrAttendanceCorrection.count({ where }),
    ]);
    return { items, total, page: p, limit: take, totalPages: Math.ceil(total / take) };
  },

  /** Approve or reject a correction request. Self-approval blocked. */
  async act(
    scope: HrScope,
    id: string,
    status: "APPROVED" | "REJECTED",
    actorUserId: string,
    actorEmployeeId?: string | null
  ) {
    const correction = await prisma.hrAttendanceCorrection.findFirst({
      where: { id, vendorId: scope.vendorId },
    });
    if (!correction) throw new Error("Correction request not found");
    if (correction.status !== "PENDING") throw new Error("This correction has already been acted on");

    // No self-approval: if the actor's HR profile is the same employee who
    // requested the correction, reject the action.
    if (actorEmployeeId) {
      const actorProfile = await prisma.hrEmployeeProfile.findFirst({
        where: { linkedEmployeeId: actorEmployeeId, linkedVendorId: scope.vendorId },
        select: { id: true },
      });
      if (actorProfile && actorProfile.id === correction.employeeId) {
        throw new Error("You cannot approve or reject your own correction request");
      }
    }

    return prismaDirect.$transaction(async (tx) => {
      const updated = await tx.hrAttendanceCorrection.update({
        where: { id },
        data: { status, actedBy: actorUserId, actedAt: new Date() },
      });

      // On approval, apply the corrected times to the attendance record.
      if (status === "APPROVED" && (correction.requestedIn || correction.requestedOut)) {
        const existing = await tx.hrAttendance.findFirst({
          where: { employeeId: correction.employeeId, date: correction.date, vendorId: scope.vendorId },
        });
        if (existing) {
          await tx.hrAttendance.update({
            where: { id: existing.id },
            data: {
              ...(correction.requestedIn && { checkIn: correction.requestedIn }),
              ...(correction.requestedOut && { checkOut: correction.requestedOut }),
              source: "MANUAL",
            },
          });
        } else {
          await tx.hrAttendance.create({
            data: {
              vendorId: scope.vendorId,
              employeeId: correction.employeeId,
              date: correction.date,
              checkIn: correction.requestedIn,
              checkOut: correction.requestedOut,
              status: correction.requestedIn ? "PRESENT" : "ABSENT",
              source: "MANUAL",
            },
          });
        }
      }

      return updated;
    });
  },
};
