// src/modules/hrm/services/letter.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

function renderTemplate(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

async function nextLetterNumber(vendorId: string | null): Promise<string> {
  const count = await prisma.hrLetter.count({ where: { vendorId } });
  return `LTR-${String(count + 1).padStart(4, "0")}`;
}

/** All statuses in the letter lifecycle flow: DRAFT → PREPARED → APPROVED → ISSUED */
export const LETTER_STATUSES = ["DRAFT", "PREPARED", "HR_REVIEW", "APPROVED", "ISSUED", "REJECTED"] as const;

export const letterTemplateService = {
  async create(scope: HrScope, data: { type: string; name: string; subject: string; body: string; requiresApproval?: boolean }) {
    return prisma.hrLetterTemplate.create({ data: { ...data, vendorId: scope.vendorId } });
  },
  async list(scope: HrScope) {
    return prisma.hrLetterTemplate.findMany({ where: { vendorId: scope.vendorId, active: true } });
  },
  /** Management list — includes deactivated templates (hrOrgEdit/hrLeaveTypesEdit gate). */
  async listAll(scope: HrScope) {
    return prisma.hrLetterTemplate.findMany({ where: { vendorId: scope.vendorId }, orderBy: { createdAt: "asc" } });
  },
  async update(scope: HrScope, id: string, data: any) {
    const existing = await prisma.hrLetterTemplate.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!existing) throw new Error("Letter template not found");
    return prisma.hrLetterTemplate.update({ where: { id }, data });
  },
  /**
   * Soft-delete if letters reference the template (preserve audit trail);
   * hard-delete if unreferenced. Returns what happened.
   */
  async remove(scope: HrScope, id: string) {
    const existing = await prisma.hrLetterTemplate.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!existing) throw new Error("Letter template not found");

    const referenced = await prisma.hrLetter.count({ where: { templateId: id } });
    if (referenced > 0) {
      // Soft-delete: set inactive so historical letters stay valid.
      await prisma.hrLetterTemplate.update({ where: { id }, data: { active: false } });
      return { deleted: false, deactivated: true, message: `Template deactivated (referenced by ${referenced} letter(s)).` };
    }
    await prisma.hrLetterTemplate.delete({ where: { id } });
    return { deleted: true, deactivated: false, message: "Template deleted." };
  },
};

export const letterService = {
  async generate(
    scope: HrScope,
    data: { employeeId: string; templateId?: string; type: string; subject?: string; body?: string; effectiveDate?: string },
    createdBy: string,
    salaryView = false
  ) {
    const employee = await prisma.hrEmployeeProfile.findFirst({
      where: { id: data.employeeId, linkedVendorId: scope.vendorId },
      include: {
        designation: true,
        department: true,
        branch: true,
        manager: { select: { fullName: true } },
      },
    });
    if (!employee) throw new Error("Employee not found");

    let subject = data.subject;
    let bodyTemplate = data.body;
    let requiresApproval = true;

    if (data.templateId) {
      const template = await prisma.hrLetterTemplate.findFirst({
        where: { id: data.templateId, vendorId: scope.vendorId },
      });
      if (!template) throw new Error("Letter template not found");
      subject = template.subject;
      bodyTemplate = template.body;
      requiresApproval = template.requiresApproval;
    }
    if (!subject || !bodyTemplate) throw new Error("subject/body or templateId is required");

    // Resolve vendor name for {{company_name}}.
    const vendor = scope.vendorId
      ? await prisma.vendor.findUnique({ where: { id: scope.vendorId }, select: { storeName: true } })
      : null;

    // Salary variables — SENSITIVE: only resolved when the caller holds hrSalaryView.
    let salaryVars: Record<string, string> = {};
    const needsSalary = /\{\{(salary|basic_salary|gross_salary)\}\}/.test(bodyTemplate + subject);
    if (needsSalary && !salaryView) {
      throw new Error("This template contains salary variables — hrSalaryView permission is required.");
    }
    if (needsSalary && salaryView) {
      const structure = await prisma.hrSalaryStructure.findFirst({
        where: { employeeId: data.employeeId, status: "ACTIVE" },
        select: { basic: true, gross: true },
      });
      salaryVars = {
        salary: structure ? String(Number(structure.gross ?? 0).toLocaleString()) : "—",
        basic_salary: structure ? String(Number(structure.basic ?? 0).toLocaleString()) : "—",
        gross_salary: structure ? String(Number(structure.gross ?? 0).toLocaleString()) : "—",
      };
    }

    const vars: Record<string, string> = {
      // snake_case names (per the approved variable list)
      employee_name: employee.fullName,
      employee_id: employee.code,
      designation: employee.designation?.name ?? "",
      department: employee.department?.name ?? "",
      branch: employee.branch?.name ?? "",
      joining_date: employee.joiningDate ?? "",
      probation_months: String(employee.probationMonths ?? 3),
      employment_type: employee.employmentType ?? "",
      manager_name: employee.manager?.fullName ?? "",
      company_name: vendor?.storeName ?? "FinixMart",
      effective_date: data.effectiveDate ?? "-",
      date: new Date().toISOString().slice(0, 10),
      // camelCase aliases (backward compatibility with existing templates)
      fullName: employee.fullName,
      code: employee.code,
      joiningDate: employee.joiningDate ?? "",
      // salary vars (only present when hrSalaryView)
      ...salaryVars,
    };

    const content = renderTemplate(bodyTemplate, vars);
    const letterNumber = await nextLetterNumber(scope.vendorId);

    return prisma.hrLetter.create({
      data: {
        vendorId: scope.vendorId,
        employeeId: data.employeeId,
        type: data.type,
        templateId: data.templateId,
        letterNumber,
        subject: renderTemplate(subject, vars),
        content,
        status: requiresApproval ? "PREPARED" : "APPROVED",
        createdBy,
      },
    });
  },

  async list(scope: HrScope, filters: { employeeId?: string; status?: string }) {
    return prisma.hrLetter.findMany({
      where: { vendorId: scope.vendorId, ...filters },
      include: { employee: { select: { id: true, code: true, fullName: true } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async getById(scope: HrScope, id: string) {
    const letter = await prisma.hrLetter.findFirst({
      where: { id, vendorId: scope.vendorId },
      include: { employee: { select: { id: true, code: true, fullName: true } } },
    });
    if (!letter) throw new Error("Letter not found");
    return letter;
  },

  /** DRAFT → PREPARED (submitted for approval). */
  async prepare(scope: HrScope, id: string, actorUserId: string) {
    const letter = await prisma.hrLetter.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!letter) throw new Error("Letter not found");
    if (letter.status !== "DRAFT") throw new Error("Only a DRAFT letter can be prepared");
    return prisma.hrLetter.update({ where: { id }, data: { status: "PREPARED" } });
  },

  async approve(scope: HrScope, id: string, approvedBy: string) {
    const letter = await prisma.hrLetter.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!letter) throw new Error("Letter not found");
    if (letter.status !== "PREPARED" && letter.status !== "HR_REVIEW") {
      throw new Error("Only a PREPARED or HR_REVIEW letter can be approved");
    }
    // Separation of duties: the preparer can never approve their own letter.
    if (letter.createdBy === approvedBy) {
      throw new Error("You cannot approve a letter you prepared yourself");
    }
    return prisma.hrLetter.update({ where: { id }, data: { status: "APPROVED", approvedBy } });
  },

  async reject(scope: HrScope, id: string, rejectedBy: string) {
    const letter = await prisma.hrLetter.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!letter) throw new Error("Letter not found");
    if (letter.status !== "PREPARED" && letter.status !== "HR_REVIEW") {
      throw new Error("Only a PREPARED or HR_REVIEW letter can be rejected");
    }
    if (letter.createdBy === rejectedBy) {
      throw new Error("You cannot reject a letter you prepared yourself");
    }
    return prisma.hrLetter.update({ where: { id }, data: { status: "REJECTED", approvedBy: rejectedBy } });
  },

  async issue(scope: HrScope, id: string) {
    const letter = await prisma.hrLetter.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!letter) throw new Error("Letter not found");
    if (letter.status !== "APPROVED") throw new Error("Only an APPROVED letter can be issued");

    return prisma.$transaction(async (tx) => {
      const issued = await tx.hrLetter.update({ where: { id }, data: { status: "ISSUED", issuedAt: new Date() } });
      await tx.hrEmployeeHistory.create({
        data: {
          vendorId: scope.vendorId,
          employeeId: letter.employeeId,
          eventType: "LETTER",
          title: `Letter issued: ${letter.subject}`,
        },
      });
      return issued;
    });
  },
};
