// src/modules/hrm/services/employeeProfile.service.ts
import { prisma, prismaDirect } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";
import type {
  CreateHrProfileInput,
  UpdateHrProfileInput,
  HrProfileFilters,
} from "../types/hrm.types.ts";

/** Complete employee-status whitelist (P0). Any other value is rejected. */
export const EMPLOYEE_STATUSES = [
  "ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED",
  "RESIGNED", "TERMINATED", "RETIRED", "INACTIVE",
] as const;

export interface HrViewCapabilities {
  salaryView: boolean;
  bankFull: boolean;
}

/** Mask an account/MFS number to ••••last4. Already-masked values pass through. */
export function maskAccount(value?: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("••••")) return value;
  const last4 = value.replace(/\s+/g, "").slice(-4);
  return `••••${last4 || "••••"}`;
}

async function nextEmployeeCode(vendorId: string | null): Promise<string> {
  const count = await prisma.hrEmployeeProfile.count({ where: { linkedVendorId: vendorId } });
  return `EMP-${String(count + 1).padStart(4, "0")}`;
}

export const employeeProfileService = {
  /**
   * Call this right after your existing createAdminEmployee /
   * createVendorEmployee finishes — see the README for the exact hook.
   * Idempotent: if a profile already exists for this Employee, returns it
   * instead of throwing, so it's safe to call defensively.
   *
   * Pre-fills everything the create-employee form already collected
   * (name, phone, email, designation, department as free text) so the HR
   * profile editor opens already populated — the admin/vendor only adds
   * NEW information (branch/department/designation as structured links,
   * DOB, address, etc.), never retypes what they just typed seconds ago.
   */
  async ensureProfile(
    scope: HrScope,
    input: {
      linkedUserId: string;
      linkedEmployeeId: string;
      fullName: string;
      mobile?: string | null;
      personalEmail?: string | null;
      /** free-text from the legacy Employee.designation/department fields —
       *  used only to try to auto-link to a matching HrDesignation/
       *  HrDepartment row by name; if no match exists yet, left null and
       *  the admin picks one later (structured org data has to exist first). */
      designationText?: string | null;
      departmentText?: string | null;
    }
  ) {
    const existing = await prisma.hrEmployeeProfile.findUnique({
      where: { linkedEmployeeId: input.linkedEmployeeId },
    });
    if (existing) return existing;

    const code = await nextEmployeeCode(scope.vendorId);

    // Best-effort auto-link: if a branch/department/designation already
    // exists with a matching name (case-insensitive), wire it up now so
    // the drawer doesn't ask again. If nothing matches (first time using
    // the HR module, org structure not set up yet), these stay null and
    // the admin picks properly once branches/departments are created.
    const [matchedDepartment, matchedDesignation] = await Promise.all([
      input.departmentText
        ? prisma.hrDepartment.findFirst({
            where: { vendorId: scope.vendorId, name: { equals: input.departmentText, mode: "insensitive" } },
          })
        : Promise.resolve(null),
      input.designationText
        ? prisma.hrDesignation.findFirst({
            where: { vendorId: scope.vendorId, name: { equals: input.designationText, mode: "insensitive" } },
          })
        : Promise.resolve(null),
    ]);

    return prisma.hrEmployeeProfile.create({
      data: {
        linkedUserId: input.linkedUserId,
        linkedEmployeeId: input.linkedEmployeeId,
        linkedVendorId: scope.vendorId,
        code,
        fullName: input.fullName,
        mobile: input.mobile ?? undefined,
        personalEmail: input.personalEmail ?? undefined,
        departmentId: matchedDepartment?.id,
        designationId: matchedDesignation?.id,
        joiningDate: new Date().toISOString().slice(0, 10),
      },
    });
  },

  async create(scope: HrScope, data: CreateHrProfileInput) {
    const existing = await prisma.hrEmployeeProfile.findUnique({
      where: { linkedEmployeeId: data.linkedEmployeeId },
    });
    if (existing) throw new Error("HR profile already exists for this employee");

    return prisma.hrEmployeeProfile.create({
      data: { ...data, linkedVendorId: scope.vendorId },
    });
  },

  async list(scope: HrScope, filters: HrProfileFilters) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));

    const where: any = { linkedVendorId: scope.vendorId };
    if (filters.branchId) where.branchId = filters.branchId;
    if (filters.departmentId) where.departmentId = filters.departmentId;
    if (filters.designationId) where.designationId = filters.designationId;
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { fullName: { contains: filters.search, mode: "insensitive" } },
        { code: { contains: filters.search, mode: "insensitive" } },
        { mobile: { contains: filters.search } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.hrEmployeeProfile.findMany({
        where,
        include: { branch: true, department: true, designation: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.hrEmployeeProfile.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  async getById(scope: HrScope, id: string, caps: HrViewCapabilities = { salaryView: false, bankFull: false }) {
    const profile = await prisma.hrEmployeeProfile.findFirst({
      where: { id, linkedVendorId: scope.vendorId },
      include: {
        branch: true,
        department: true,
        designation: true,
        // HrEmployeeProfile has shiftId but NO direct `shift` relation in the
        // schema — the shift is resolved through shiftAssignments (the only
        // existing relation path), latest assignment first.
        shiftAssignments: {
          include: { shift: true },
          orderBy: { fromDate: "desc" as const },
          take: 1,
        },
        manager: { include: { designation: true, department: true } },
        familyMembers: true,
        education: true,
        documents: true,
        bankAccounts: true,
        previousEmployments: true,
        promotions: { orderBy: { createdAt: "desc" as const } },
        transfers: { orderBy: { createdAt: "desc" as const } },
        salaryRevisions: { orderBy: { createdAt: "desc" as const } },
        history: { orderBy: { createdAt: "desc" as const }, take: 50 },
        // Salary structures are appended only when the viewer holds
        // hrSalaryView — never sent to callers without it.
        ...(caps.salaryView ? { salaryStructures: { orderBy: { createdAt: "desc" as const } } } : {}),
      },
    });
    if (!profile) throw new Error("Employee profile not found");

    // Derive `shift` from the latest assignment that is still current
    // (toDate null or not yet passed), then drop the raw assignments so the
    // response shape stays exactly what the Employee 360 UI consumes.
    const today = new Date().toISOString().slice(0, 10);
    const currentAssignment =
      profile.shiftAssignments.find((a) => !a.toDate || a.toDate >= today) ??
      profile.shiftAssignments[0] ??
      null;

    // Bank/MFS numbers are masked server-side for viewers without
    // hrBankView — the UI never receives full numbers to hide with CSS.
    const shaped: any = {
      ...profile,
      shift: currentAssignment?.shift ?? null,
      bankAccounts: profile.bankAccounts.map((b) => ({
        ...b,
        accountNumber: caps.bankFull ? b.accountNumber : maskAccount(b.accountNumber),
        mfsNumber: caps.bankFull ? b.mfsNumber : maskAccount(b.mfsNumber),
      })),
      salaryHidden: !caps.salaryView,
    };
    delete shaped.shiftAssignments;
    if (!caps.salaryView) shaped.salaryStructures = [];
    return shaped;
  },

  /**
   * Tenant-scoped profile fetch used by every nested employee resource
   * (family / education / documents / bank / previous employment /
   * lifecycle). Returns null when the profile doesn't exist OR belongs to
   * another vendor — callers turn that into a 404 so cross-tenant probing
   * is indistinguishable from a missing row.
   */
  async findScopedProfile(scope: HrScope, id: string) {
    return prisma.hrEmployeeProfile.findFirst({
      where: { id, linkedVendorId: scope.vendorId },
      select: { id: true, linkedVendorId: true, designationId: true, branchId: true, departmentId: true },
    });
  },

  async getByLinkedEmployeeId(scope: HrScope, linkedEmployeeId: string) {
    const profile = await prisma.hrEmployeeProfile.findFirst({
      where: { linkedEmployeeId, linkedVendorId: scope.vendorId },
      include: {
        branch: true,
        department: true,
        designation: true,
      },
    });
    if (!profile) throw new Error("Employee profile not found");
    return profile;
  },

  /** "My profile" — for the logged-in employee themself. */
  async getMyProfile(scope: HrScope, myEmployeeId: string) {
    return this.getByLinkedEmployeeId(scope, myEmployeeId);
  },

  async update(scope: HrScope, id: string, data: UpdateHrProfileInput, actorUserId: string) {
    const existing = await prisma.hrEmployeeProfile.findFirst({
      where: { id, linkedVendorId: scope.vendorId },
    });
    if (!existing) throw new Error("Employee profile not found");

    // Status whitelist — arbitrary client strings are rejected (P0).
    if (data.status && !(EMPLOYEE_STATUSES as readonly string[]).includes(data.status)) {
      throw new Error(`Invalid employee status '${data.status}'`);
    }

    const updated = await prisma.hrEmployeeProfile.update({ where: { id }, data });

    // Log any status change as a career-timeline event.
    if (data.status && data.status !== existing.status) {
      await prisma.hrEmployeeHistory.create({
        data: {
          vendorId: scope.vendorId,
          employeeId: id,
          eventType: "STATUS_CHANGE",
          title: `Status changed: ${existing.status} → ${data.status}`,
          createdBy: actorUserId,
        },
      });
    }

    return updated;
  },

  /** Archive (soft delete) — marks INACTIVE and writes a history event. */
  async remove(scope: HrScope, id: string, actorUserId?: string) {
    const existing = await prisma.hrEmployeeProfile.findFirst({
      where: { id, linkedVendorId: scope.vendorId },
    });
    if (!existing) throw new Error("Employee profile not found");

    // Never hard-delete an employee's HR history — mark inactive instead.
    const archived = await prisma.hrEmployeeProfile.update({
      where: { id },
      data: { status: "INACTIVE" },
    });

    await prisma.hrEmployeeHistory.create({
      data: {
        vendorId: scope.vendorId,
        employeeId: id,
        eventType: "STATUS_CHANGE",
        title: `Archived — status changed: ${existing.status} → INACTIVE`,
        createdBy: actorUserId,
      },
    });

    return archived;
  },

  /**
   * Permanent delete. Restricted by hrEmployeeDelete AND a typed employee
   * code that the server re-verifies (the client confirmation alone is
   * never trusted).
   *
   * Safety model per the approved P0 spec — no destructive cascading beyond
   * what the schema already defines: rows the schema CASCADE-deletes
   * (family, education, documents, history, attendance corrections, leave
   * balances, tasks, promotions/transfers/salary revisions, bank accounts,
   * previous employments) go with the profile. Tables with Restrict
   * references (attendance, leave requests, shift assignments, salary
   * structures, payroll entries, bonuses, deductions, loans, advances,
   * expense claims, KPI assignments, reviews, resignations, letters) BLOCK
   * the deletion with a clear error — archive is the answer for employees
   * with transactional history.
   */
  async hardDelete(scope: HrScope, id: string, confirm: string | undefined, actorUserId: string) {
    const profile = await prisma.hrEmployeeProfile.findFirst({
      where: { id, linkedVendorId: scope.vendorId },
      select: { id: true, code: true, fullName: true },
    });
    if (!profile) throw new Error("Employee profile not found");

    if (!confirm || confirm.trim() !== profile.code) {
      throw new Error(
        `Confirmation required — type the employee code (${profile.code}) to permanently delete`
      );
    }

    const blockers: Array<[string, number]> = [];
    const checks: Array<[string, Promise<number>]> = [
      ["attendance record(s)", prisma.hrAttendance.count({ where: { employeeId: id } })],
      ["leave request(s)", prisma.hrLeaveRequest.count({ where: { employeeId: id } })],
      ["shift assignment(s)", prisma.hrShiftAssignment.count({ where: { employeeId: id } })],
      ["salary structure(s)", prisma.hrSalaryStructure.count({ where: { employeeId: id } })],
      ["payroll entry(ies)", prisma.hrPayrollEntry.count({ where: { employeeId: id } })],
      ["bonus record(s)", prisma.hrBonus.count({ where: { employeeId: id } })],
      ["deduction record(s)", prisma.hrDeduction.count({ where: { employeeId: id } })],
      ["loan(s)", prisma.hrLoan.count({ where: { employeeId: id } })],
      ["advance(s)", prisma.hrAdvance.count({ where: { employeeId: id } })],
      ["expense claim(s)", prisma.hrExpenseClaim.count({ where: { employeeId: id } })],
      ["KPI assignment(s)", prisma.hrKpiAssignment.count({ where: { employeeId: id } })],
      ["performance review(s)", prisma.hrPerformanceReview.count({ where: { employeeId: id } })],
      ["resignation record(s)", prisma.hrResignation.count({ where: { employeeId: id } })],
      ["letter(s)", prisma.hrLetter.count({ where: { employeeId: id } })],
    ];
    for (const [label, p] of checks) {
      const n = await p;
      if (n > 0) blockers.push(`${n} ${label}`);
    }
    if (blockers.length > 0) {
      throw new Error(
        `Cannot permanently delete ${profile.code}: employee has ${blockers.join(", ")}. Archive the employee instead.`
      );
    }

    // Collect document storage keys BEFORE the cascade removes the rows, so
    // the R2 objects can be cleaned up best-effort afterwards.
    const docs = await prisma.hrEmployeeDocument.findMany({
      where: { employeeId: id },
      select: { fileUrl: true },
    });

    await prismaDirect.$transaction(async (tx) => {
      // Everything the schema CASCADE-deletes goes with this one call.
      await tx.hrEmployeeProfile.delete({ where: { id } });
    });

    return { deleted: true, code: profile.code, fullName: profile.fullName, documentKeys: docs.map((d) => d.fileUrl).filter(Boolean) };
  },
};