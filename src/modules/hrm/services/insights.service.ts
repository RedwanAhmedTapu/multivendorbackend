// src/modules/hrm/services/insights.service.ts
//
// Read-only aggregate endpoints (PHASE C2). Every query is tenant-scoped by
// the session's vendorId (null = platform) and uses groupBy/count — never
// loads the whole employee table into memory. Salary amounts on the
// lifecycle register are returned ONLY when the caller holds hrSalaryView.

import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

const todayIso = () => new Date().toISOString().slice(0, 10);
const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const period12 = (m: number) => MONTHS[m] ?? String(m);

export type LifecycleKind = "promotions" | "transfers" | "salary-revisions";

export const insightsService = {
  /** Employees per branch (grouped in the database). */
  async branchCounts(scope: HrScope) {
    const rows = await prisma.hrEmployeeProfile.groupBy({
      by: ["branchId"],
      _count: { _all: true },
      where: { linkedVendorId: scope.vendorId },
    });
    return {
      items: rows.map((r) => ({ branchId: r.branchId, count: r._count._all })),
    };
  },

  /** Employees per designation (grouped in the database). */
  async designationCounts(scope: HrScope) {
    const rows = await prisma.hrEmployeeProfile.groupBy({
      by: ["designationId"],
      _count: { _all: true },
      where: { linkedVendorId: scope.vendorId },
    });
    return {
      items: rows.map((r) => ({ designationId: r.designationId, count: r._count._all })),
    };
  },

  /** Employees whose joining date falls inside the last `days` days. */
  async newJoiners(scope: HrScope, days = 30) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const count = await prisma.hrEmployeeProfile.count({
      where: { linkedVendorId: scope.vendorId, joiningDate: { gte: cutoff } },
    });
    return { days, cutoff, count };
  },

  /**
   * Tenant-wide lifecycle register for ONE kind (the UI shows three tabs,
   * so each request queries a single table with native pagination).
   * Salary-revision amounts are stripped unless the caller holds
   * hrSalaryView — the caller passes the capability; the gate itself is
   * still enforced by the route middleware.
   */
  async lifecycle(
    scope: HrScope,
    kind: LifecycleKind,
    opts: { search?: string; page?: number; limit?: number; salaryView: boolean }
  ) {
    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20));

    const where: any = { vendorId: scope.vendorId };
    if (opts.search) {
      where.employee = {
        OR: [
          { fullName: { contains: opts.search, mode: "insensitive" as const } },
          { code: { contains: opts.search, mode: "insensitive" as const } },
        ],
      };
    }

    const delegates = {
      promotions: prisma.hrPromotion,
      transfers: prisma.hrTransfer,
      "salary-revisions": prisma.hrSalaryRevision,
    } as const;
    const delegate = delegates[kind];

    const [rows, total] = await Promise.all([
      delegate.findMany({
        where,
        include: {
          employee: {
            select: {
              id: true, code: true, fullName: true,
              department: { select: { name: true } },
              designation: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" as const },
        skip: (page - 1) * limit,
        take: limit,
      }),
      delegate.count({ where }),
    ]);

    const items = rows.map((r: any) => {
      const base = {
        id: r.id,
        employee: r.employee,
        effectiveDate: r.effectiveDate,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
      };
      if (kind === "promotions") {
        return { ...base, amount: r.newBasicSalary != null ? Number(r.newBasicSalary) : null };
      }
      if (kind === "transfers") {
        return { ...base, toBranchId: r.toBranchId ?? null, toDepartmentId: r.toDepartmentId ?? null };
      }
      // Salary revision — SENSITIVE: amounts only with hrSalaryView.
      if (opts.salaryView) {
        return {
          ...base,
          previousSalary: r.previousSalary != null ? Number(r.previousSalary) : null,
          newSalary: r.newSalary != null ? Number(r.newSalary) : null,
        };
      }
      return { ...base, amountConfidential: true };
    });

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  /** Manager → direct-report rollup (existing reportingManagerId field). */
  async reportingStructure(scope: HrScope) {
    const groups = await prisma.hrEmployeeProfile.groupBy({
      by: ["reportingManagerId"],
      _count: { _all: true },
      where: { linkedVendorId: scope.vendorId },
    });

    const managerIds = groups.map((g) => g.reportingManagerId).filter((id): id is string => Boolean(id));
    const managers = managerIds.length
      ? await prisma.hrEmployeeProfile.findMany({
          where: { id: { in: managerIds } },
          select: { id: true, code: true, fullName: true },
        })
      : [];

    const unassigned = await prisma.hrEmployeeProfile.count({
      where: { linkedVendorId: scope.vendorId, reportingManagerId: null },
    });

    return {
      managers: managerIds.map((id) => {
        const m = managers.find((x) => x.id === id);
        return {
          managerId: id,
          managerName: m?.fullName ?? null,
          managerCode: m?.code ?? null,
          reportCount: groups.find((g) => g.reportingManagerId === id)?._count._all ?? 0,
        };
      }),
      unassigned,
    };
  },

  /** Shifts with current assignment counts (read-only — no roster API yet). */
  async shiftsOverview(scope: HrScope) {
    const t = todayIso();
    const shifts = await prisma.hrShift.findMany({
      where: { vendorId: scope.vendorId },
      orderBy: { createdAt: "asc" },
    });
    const counts = await prisma.hrShiftAssignment.groupBy({
      by: ["shiftId"],
      _count: { _all: true },
      where: { vendorId: scope.vendorId, OR: [{ toDate: null }, { toDate: { gte: t } }] },
    });
    return {
      items: shifts.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        startTime: s.startTime,
        endTime: s.endTime,
        // Shift-rule fields — the Shifts tab renders Grace/Break/Min Hrs/OT
        // columns from these; they were previously missing from this payload
        // (the columns rendered unit suffixes with no numbers).
        graceMinutes: s.graceMinutes,
        breakMinutes: s.breakMinutes,
        minWorkingHours: s.minWorkingHours,
        otThresholdMinutes: s.otThresholdMinutes,
        otMultiplier: s.otMultiplier,
        branchId: s.branchId,
        weeklyOff: s.weeklyOff,
        active: s.active,
        currentAssignments: counts.find((c) => c.shiftId === s.id)?._count._all ?? 0,
      })),
    };
  },

  // == PHASE D2 - HR Reports / Analytics / Audit ==========================

  /**
   * Employee reports (register / biodata / contacts / joiners / exits).
   * All queries tenant-scoped + paginated. Biodata exposes only profile
   * personal fields - no salary structures, no bank data, no documents
   * (NID lives in documents, which are never included here).
   */
  async employeesReport(
    scope: HrScope,
    opts: {
      view?: "register" | "biodata" | "contacts";
      statuses?: string[];
      branchId?: string;
      departmentId?: string;
      search?: string;
      joiningFrom?: string;
      joiningTo?: string;
      page?: number;
      limit?: number;
    }
  ) {
    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));

    const where: any = { linkedVendorId: scope.vendorId };
    if (opts.statuses?.length) where.status = { in: opts.statuses };
    if (opts.branchId) where.branchId = opts.branchId;
    if (opts.departmentId) where.departmentId = opts.departmentId;
    if (opts.search) {
      where.OR = [
        { fullName: { contains: opts.search, mode: "insensitive" as const } },
        { code: { contains: opts.search, mode: "insensitive" as const } },
        { mobile: { contains: opts.search } },
      ];
    }
    if (opts.joiningFrom) where.joiningDate = { ...(where.joiningDate ?? {}), gte: opts.joiningFrom };
    if (opts.joiningTo) where.joiningDate = { ...(where.joiningDate ?? {}), lte: opts.joiningTo };

    const baseSelect = {
      id: true, code: true, fullName: true, mobile: true, employmentType: true,
      status: true, joiningDate: true,
      department: { select: { name: true } },
      branch: { select: { name: true } },
      designation: { select: { name: true } },
    };
    const select: any =
      opts.view === "biodata"
        ? {
            ...baseSelect,
            nameBn: true, fatherName: true, motherName: true, spouseName: true,
            dob: true, gender: true, bloodGroup: true, maritalStatus: true,
            nationality: true, religion: true,
            presentAddress: true, permanentAddress: true,
            emergencyName: true, emergencyRelation: true, emergencyMobile: true,
          }
        : opts.view === "contacts"
          ? {
              ...baseSelect,
              altMobile: true, personalEmail: true,
              emergencyName: true, emergencyRelation: true, emergencyMobile: true,
            }
          : baseSelect;

    const [rows, total] = await Promise.all([
      prisma.hrEmployeeProfile.findMany({
        where, select, orderBy: { joiningDate: "desc" as const },
        skip: (page - 1) * limit, take: limit,
      }),
      prisma.hrEmployeeProfile.count({ where }),
    ]);
    return { items: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  /** Attendance rows (register / late / absence / working hours). */
  async attendanceReport(
    scope: HrScope,
    opts: { fromDate?: string; toDate?: string; status?: string; employeeId?: string; page?: number; limit?: number }
  ) {
    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const where: any = { vendorId: scope.vendorId };
    if (opts.fromDate || opts.toDate) {
      where.date = {
        ...(opts.fromDate ? { gte: opts.fromDate } : {}),
        ...(opts.toDate ? { lte: opts.toDate } : {}),
      };
    }
    if (opts.status) where.status = opts.status;
    if (opts.employeeId) where.employeeId = opts.employeeId;

    const [rows, total] = await Promise.all([
      prisma.hrAttendance.findMany({
        where,
        include: { employee: { select: { id: true, code: true, fullName: true } } },
        orderBy: [{ date: "desc" as const }, { employeeId: "asc" as const }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.hrAttendance.count({ where }),
    ]);
    return { items: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  /** Leave requests register (employee + type resolved server-side). */
  async leaveReport(
    scope: HrScope,
    opts: { status?: string; fromDate?: string; toDate?: string; page?: number; limit?: number }
  ) {
    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const where: any = { vendorId: scope.vendorId };
    if (opts.status) where.status = opts.status;
    if (opts.fromDate || opts.toDate) {
      where.fromDate = {
        ...(opts.fromDate ? { gte: opts.fromDate } : {}),
        ...(opts.toDate ? { lte: opts.toDate } : {}),
      };
    }
    const [rows, total] = await Promise.all([
      prisma.hrLeaveRequest.findMany({
        where,
        include: {
          employee: { select: { id: true, code: true, fullName: true } },
          leaveType: { select: { id: true, name: true, paid: true } },
        },
        orderBy: { createdAt: "desc" as const },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.hrLeaveRequest.count({ where }),
    ]);
    return { items: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  /** Leave balances register (employee + type resolved server-side). */
  async leaveBalancesReport(scope: HrScope, opts: { year?: number; page?: number; limit?: number }) {
    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const where: any = { employee: { linkedVendorId: scope.vendorId } };
    if (opts.year) where.year = opts.year;
    const [rows, total] = await Promise.all([
      prisma.hrLeaveBalance.findMany({
        where,
        include: {
          employee: { select: { id: true, code: true, fullName: true } },
          leaveType: { select: { id: true, name: true } },
        },
        orderBy: [{ year: "desc" as const }, { employeeId: "asc" as const }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.hrLeaveBalance.count({ where }),
    ]);
    return { items: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  /** Employees per department (grouped in the database). */
  async departmentCounts(scope: HrScope) {
    const rows = await prisma.hrEmployeeProfile.groupBy({
      by: ["departmentId"],
      _count: { _all: true },
      where: { linkedVendorId: scope.vendorId },
    });
    return { items: rows.map((r) => ({ departmentId: r.departmentId, count: r._count._all })) };
  },

  /** Present-count trend for the last `days` days (single groupBy). */
  async attendanceTrend(scope: HrScope, days = 14) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows = await prisma.hrAttendance.groupBy({
      by: ["date"],
      _count: { _all: true },
      where: { vendorId: scope.vendorId, status: "PRESENT", date: { gte: cutoff } },
      orderBy: { date: "asc" as const },
    });
    return { days, items: rows.map((r) => ({ date: r.date, present: r._count._all })) };
  },

  /** Platform audit log - ADMIN only (no tenant column on AuditLog). */
  async auditList(opts: { page?: number; limit?: number; entity?: string; search?: string }) {
    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const where: any = {};
    if (opts.entity) where.entity = opts.entity;
    if (opts.search) where.entityId = { contains: opts.search };
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { name: true, email: true } } },
        orderBy: { createdAt: "desc" as const },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);
    return { items: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  // == PHASE D3 - HR Calendar ===========================================
  // Events derived ONLY from existing data (no custom-event model).
  // Tenant-scoped; payroll/loan events require hrSalaryView.
  async calendar(
    scope: HrScope,
    opts: { from: string; to: string; salaryView: boolean }
  ) {
    const { from, to } = opts;
    const md = (iso: string) => iso.slice(5, 10);
    const fromMD = md(from);
    const toMD = md(to);
    const crossesYear = fromMD > toMD;
    const mdInWindow = (m: string) => (crossesYear ? m >= fromMD || m <= toMD : m >= fromMD && m <= toMD);
    const yearOf = from.slice(0, 4);

    // Profiles: birthdays, anniversaries, probation end (projection only).
    const profiles = await prisma.hrEmployeeProfile.findMany({
      where: { linkedVendorId: scope.vendorId, status: { in: ['ACTIVE', 'PROBATION', 'ON_LEAVE'] } },
      select: { id: true, fullName: true, dob: true, joiningDate: true, probationMonths: true, confirmationDate: true },
    });

    const events: Array<{ date: string; type: string; title: string; employeeId?: string | null }> = [];
    for (const p of profiles) {
      if (p.dob && p.dob.length >= 10 && mdInWindow(md(p.dob))) {
        events.push({ date: `${yearOf}-${md(p.dob)}`, type: 'birthday', title: `Birthday - ${p.fullName}`, employeeId: p.id });
      }
      if (p.joiningDate && p.joiningDate.length >= 10 && mdInWindow(md(p.joiningDate))) {
        events.push({ date: `${yearOf}-${md(p.joiningDate)}`, type: 'anniversary', title: `Anniversary - ${p.fullName}`, employeeId: p.id });
      }
      // Probation end: explicit confirmationDate, else joiningDate + probationMonths.
      let probEnd: string | null = p.confirmationDate ?? null;
      if (!probEnd && p.joiningDate && p.joiningDate.length >= 10) {
        const d = new Date(p.joiningDate + 'T00:00:00Z');
        d.setUTCMonth(d.getUTCMonth() + (p.probationMonths ?? 3));
        probEnd = d.toISOString().slice(0, 10);
      }
      if (probEnd && probEnd >= from && probEnd <= to) {
        events.push({ date: probEnd, type: 'probation', title: `Probation ends - ${p.fullName}`, employeeId: p.id });
      }
    }

    // Leave (pending + approved) overlapping the window.
    const leave = await prisma.hrLeaveRequest.findMany({
      where: {
        vendorId: scope.vendorId,
        status: { in: ['PENDING', 'APPROVED'] },
        fromDate: { lte: to },
        toDate: { gte: from },
      },
      include: {
        employee: { select: { fullName: true } },
        leaveType: { select: { name: true } },
      },
    });
    for (const l of leave) {
      events.push({
        date: l.fromDate >= from ? l.fromDate : from,
        type: 'leave',
        title: `Leave (${l.status.toLowerCase()}) - ${l.employee.fullName} / ${l.leaveType?.name ?? 'Leave'}`,
        employeeId: l.employeeId,
      });
    }

    // Document expiry.
    const docs = await prisma.hrEmployeeDocument.findMany({
      where: { vendorId: scope.vendorId, expiryDate: { not: null, gte: from, lte: to } },
      include: { employee: { select: { fullName: true } } },
    });
    for (const d of docs) {
      events.push({ date: d.expiryDate as string, type: 'doc-expiry', title: `${d.docType} expiry - ${d.employee.fullName}`, employeeId: d.employeeId });
    }

    // Holidays.
    const holidays = await prisma.hrHoliday.findMany({
      where: { vendorId: scope.vendorId, date: { gte: from, lte: to } },
    });
    for (const h of holidays) {
      events.push({ date: h.date, type: 'holiday', title: h.name });
    }

    // Payroll payment + loan installments - SENSITIVE, hrSalaryView only.
    if (opts.salaryView) {
      const runs = await prisma.hrPayrollRun.findMany({
        where: { vendorId: scope.vendorId, paymentDate: { not: null, gte: from, lte: to } },
      });
      for (const r of runs) {
        events.push({ date: r.paymentDate as string, type: 'payroll', title: `Payroll (${r.status}) - ${period12(r.periodMonth)} ${r.periodYear}` });
      }
      const installments = await prisma.hrLoanInstallment.findMany({
        where: { loan: { vendorId: scope.vendorId }, dueDate: { gte: from, lte: to } },
        include: { loan: { include: { employee: { select: { fullName: true } } } } },
      });
      for (const i of installments) {
        events.push({ date: i.dueDate, type: 'loan', title: `Loan installment - ${i.loan.employee.fullName}`, employeeId: i.loan.employeeId });
      }
    }

    events.sort((a, b) => a.date.localeCompare(b.date));
    return { items: events };
  },


  /** Current shift assignments (toDate null or still future). */
  async shiftAssignments(scope: HrScope, page = 1, limit = 50) {
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
        orderBy: { fromDate: "desc" as const },
        skip: (p - 1) * take,
        take,
      }),
      prisma.hrShiftAssignment.count({ where }),
    ]);
    return { items: rows, total, page: p, limit: take, totalPages: Math.ceil(total / take) };
  },
};
