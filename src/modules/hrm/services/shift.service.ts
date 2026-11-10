// src/modules/hrm/services/shift.service.ts
//
// Shift CRUD + shift assignments (PHASE AT1). Tenant-scoped. Delete is
// blocked with a clear message when employees reference the shift.

import { prisma, prismaDirect } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

const todayIso = () => new Date().toISOString().slice(0, 10);

export const shiftService = {
  async list(scope: HrScope, search?: string) {
    const where: any = { vendorId: scope.vendorId };
    if (search) where.name = { contains: search, mode: "insensitive" };
    const shifts = await prisma.hrShift.findMany({ where, orderBy: { createdAt: "asc" } });
    // Assignment counts per shift (current only).
    const counts = await prisma.hrShiftAssignment.groupBy({
      by: ["shiftId"],
      _count: { _all: true },
      where: { vendorId: scope.vendorId, OR: [{ toDate: null }, { toDate: { gte: todayIso() } }] },
    });
    return shifts.map((s) => ({
      ...s,
      currentAssignments: counts.find((c) => c.shiftId === s.id)?._count._all ?? 0,
    }));
  },

  async create(scope: HrScope, data: {
    name: string; type?: string; startTime: string; endTime: string;
    graceMinutes?: number; breakMinutes?: number; minWorkingHours?: number;
    otThresholdMinutes?: number; otMultiplier?: number; weeklyOff?: string;
    branchId?: string;
  }) {
    const dup = await prisma.hrShift.findFirst({ where: { vendorId: scope.vendorId, name: data.name } });
    if (dup) throw new Error("A shift with this name already exists");
    return prisma.hrShift.create({
      data: {
        vendorId: scope.vendorId,
        name: data.name,
        type: data.type ?? "FIXED",
        startTime: data.startTime,
        endTime: data.endTime,
        graceMinutes: data.graceMinutes ?? 10,
        breakMinutes: data.breakMinutes ?? 60,
        minWorkingHours: data.minWorkingHours ?? 8,
        otThresholdMinutes: data.otThresholdMinutes ?? 30,
        otMultiplier: data.otMultiplier ?? 1.5,
        weeklyOff: data.weeklyOff ?? "FRIDAY",
        branchId: data.branchId || undefined,
        active: true,
      },
    });
  },

  async update(scope: HrScope, id: string, data: Record<string, unknown>) {
    const existing = await prisma.hrShift.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!existing) throw new Error("Shift not found");
    return prisma.hrShift.update({ where: { id }, data });
  },

  /** Deactivate (not hard-delete) if assignments exist, otherwise delete. */
  async remove(scope: HrScope, id: string) {
    const existing = await prisma.hrShift.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!existing) throw new Error("Shift not found");
    const assignments = await prisma.hrShiftAssignment.count({ where: { shiftId: id } });
    if (assignments > 0) {
      await prisma.hrShift.update({ where: { id }, data: { active: false } });
      return { deleted: false, deactivated: true, message: `Shift deactivated (${assignments} assignment(s) exist — historical references preserved).` };
    }
    await prisma.hrShift.delete({ where: { id } });
    return { deleted: true, deactivated: false, message: "Shift deleted." };
  },

  // ── Shift assignments ──
  async listAssignments(scope: HrScope, page = 1, limit = 50) {
    const p = Math.max(1, page);
    const take = Math.min(200, Math.max(1, limit));
    const t = todayIso();
    const where = {
      vendorId: scope.vendorId,
      OR: [{ toDate: null }, { toDate: { gte: t } }],
    };
    const [rows, total] = await Promise.all([
      prisma.hrShiftAssignment.findMany({
        where,
        include: {
          shift: true,
          employee: { select: { id: true, code: true, fullName: true } },
        },
        orderBy: { fromDate: "desc" },
        skip: (p - 1) * take,
        take,
      }),
      prisma.hrShiftAssignment.count({ where }),
    ]);
    return { items: rows, total, page: p, limit: take, totalPages: Math.ceil(total / take) };
  },

  async assign(scope: HrScope, data: { employeeId: string; shiftId: string; fromDate: string; toDate?: string; note?: string }, actorUserId: string) {
    // Tenant boundary.
    const profile = await prisma.hrEmployeeProfile.findFirst({
      where: { id: data.employeeId, linkedVendorId: scope.vendorId },
      select: { id: true },
    });
    if (!profile) throw new Error("Employee profile not found");
    const shift = await prisma.hrShift.findFirst({ where: { id: data.shiftId, vendorId: scope.vendorId } });
    if (!shift) throw new Error("Shift not found");

    return prismaDirect.$transaction(async (tx) => {
      // Close any existing current assignment for this employee.
      await tx.hrShiftAssignment.updateMany({
        where: { employeeId: data.employeeId, vendorId: scope.vendorId, toDate: null },
        data: { toDate: data.fromDate },
      });
      return tx.hrShiftAssignment.create({
        data: {
          vendorId: scope.vendorId,
          employeeId: data.employeeId,
          shiftId: data.shiftId,
          fromDate: data.fromDate,
          toDate: data.toDate || null,
          note: data.note,
          createdBy: actorUserId,
        },
      });
    });
  },
};
