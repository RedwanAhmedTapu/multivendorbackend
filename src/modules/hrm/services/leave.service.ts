// src/modules/hrm/services/leave.service.ts
import { prisma } from "../../../config/prisma.ts";
import { hrBootstrapService } from "./hrBootstrap.service.ts";
import type { HrScope } from "../types/hrm.types.ts";
import type {
  CreateLeaveTypeInput,
  CreateLeaveRequestInput,
  ActOnLeaveInput,
  LeaveFilters,
} from "../types/hrm.types.ts";

export const leaveService = {
  // ── Leave types (admin/vendor config, e.g. "Casual Leave", "Sick Leave") ──
  async createType(scope: HrScope, data: CreateLeaveTypeInput) {
    return prisma.hrLeaveType.create({ data: { ...data, vendorId: scope.vendorId } });
  },

  /** Edit policy fields / toggle active. No hard delete for leave types —
   *  balances and requests reference them; deactivation is the off switch. */
  async updateType(scope: HrScope, id: string, data: Partial<CreateLeaveTypeInput> & { active?: boolean }) {
    const existing = await prisma.hrLeaveType.findFirst({
      where: { id, vendorId: scope.vendorId },
    });
    if (!existing) throw new Error("Leave type not found");

    if (data.active === false) {
      const used = await prisma.hrLeaveRequest.count({
        where: { leaveTypeId: id, status: { in: ["PENDING", "APPROVED"] } },
      });
      if (used > 0) {
        throw new Error(
          `Cannot deactivate this leave type while ${used} leave request(s) are pending or approved`
        );
      }
    }

    return prisma.hrLeaveType.update({ where: { id }, data });
  },

  async listTypes(scope: HrScope, includeInactive = false) {
    // Bootstrap the 8 statutory leave types the first time a tenant lists
    // them (idempotent — no-ops once any type exists).
    await hrBootstrapService.ensureDefaults(scope);
    return prisma.hrLeaveType.findMany({
      where: { vendorId: scope.vendorId, ...(includeInactive ? {} : { active: true }) },
    });
  },

  // ── Leave requests ──
  async createRequest(scope: HrScope, data: CreateLeaveRequestInput) {
    // Simple overlap guard: same employee can't have two pending/approved
    // requests covering the same date range.
    const overlapping = await prisma.hrLeaveRequest.findFirst({
      where: {
        employeeId: data.employeeId,
        status: { in: ["PENDING", "APPROVED"] },
        OR: [{ fromDate: { lte: data.toDate }, toDate: { gte: data.fromDate } }],
      },
    });
    if (overlapping) throw new Error("Overlapping leave request already exists");

    return prisma.hrLeaveRequest.create({
      data: { ...data, vendorId: scope.vendorId },
    });
  },

  async list(scope: HrScope, filters: LeaveFilters) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));

    const where: any = { vendorId: scope.vendorId };
    if (filters.employeeId) where.employeeId = filters.employeeId;
    if (filters.status) where.status = filters.status;
    if (filters.leaveTypeId) where.leaveTypeId = filters.leaveTypeId;

    const [items, total] = await Promise.all([
      prisma.hrLeaveRequest.findMany({
        where,
        include: { leaveType: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.hrLeaveRequest.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  async getById(scope: HrScope, id: string) {
    const req = await prisma.hrLeaveRequest.findFirst({
      where: { id, vendorId: scope.vendorId },
      include: { leaveType: true },
    });
    if (!req) throw new Error("Leave request not found");
    return req;
  },

  /** Approve/reject — updates the balance's `used`/`pending` counters on approval. */
  async actOn(scope: HrScope, id: string, input: ActOnLeaveInput, actorUserId: string, actorEmployeeId?: string | null) {
    const request = await prisma.hrLeaveRequest.findFirst({
      where: { id, vendorId: scope.vendorId },
    });
    if (!request) throw new Error("Leave request not found");
    if (request.status !== "PENDING") throw new Error("This request has already been acted on");

    // Separation of duties: the requester can never approve/reject their own
    // request. The actor's HR profile is resolved server-side from the
    // authenticated session (never from the client).
    if (actorEmployeeId) {
      const actorProfile = await prisma.hrEmployeeProfile.findFirst({
        where: { linkedEmployeeId: actorEmployeeId, linkedVendorId: scope.vendorId },
        select: { id: true },
      });
      if (actorProfile && actorProfile.id === request.employeeId) {
        throw new Error("You cannot approve or reject your own leave request");
      }
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.hrLeaveRequest.update({
        where: { id },
        data: { status: input.status, actedBy: actorUserId, actedAt: new Date() },
      });

      if (input.status === "APPROVED") {
        const year = new Date(request.fromDate).getFullYear();
        await tx.hrLeaveBalance.upsert({
          where: {
            employeeId_leaveTypeId_year: {
              employeeId: request.employeeId,
              leaveTypeId: request.leaveTypeId,
              year,
            },
          },
          create: {
            vendorId: scope.vendorId,
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year,
            used: request.days,
          },
          update: { used: { increment: request.days } },
        });

        await tx.hrEmployeeHistory.create({
          data: {
            vendorId: scope.vendorId,
            employeeId: request.employeeId,
            eventType: "LEAVE",
            title: `Leave approved: ${request.fromDate} to ${request.toDate}`,
            createdBy: actorUserId,
          },
        });
      }

      return updated;
    });
  },

  async myBalances(scope: HrScope, employeeId: string, year = new Date().getFullYear()) {
    return prisma.hrLeaveBalance.findMany({
      where: { employeeId, year },
      include: { leaveType: true },
    });
  },
};
