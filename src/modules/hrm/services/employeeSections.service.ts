// src/modules/hrm/services/employeeSections.service.ts
//
// Tenant-scoped CRUD for the Employee 360 collection sections: family
// members, education, previous employment, and bank/MFS accounts.
//
// Every method starts by resolving the parent profile through
// employeeProfileService.findScopedProfile(scope, id) — a profile that
// doesn't exist OR belongs to another vendor yields the same
// "Employee profile not found" error (404), so cross-tenant probing is
// indistinguishable from a missing row. Child rows are additionally
// filtered by employeeId on read/update/delete.

import { prisma, prismaDirect } from "../../../config/prisma.ts";
import { employeeProfileService } from "./employeeProfile.service.ts";
import type { HrScope } from "../types/hrm.types.ts";

export class EmployeeNotFoundError extends Error {
  constructor() {
    super("Employee profile not found");
  }
}

export class SectionNotFoundError extends Error {
  constructor(label: string) {
    super(`${label} record not found`);
  }
}

async function assertEmployee(scope: HrScope, employeeId: string) {
  const profile = await employeeProfileService.findScopedProfile(scope, employeeId);
  if (!profile) throw new EmployeeNotFoundError();
  return profile;
}

export const employeeSectionsService = {
  // ── Family members ─────────────────────────────────────────────────────

  async listFamily(scope: HrScope, employeeId: string) {
    await assertEmployee(scope, employeeId);
    return prisma.hrFamilyMember.findMany({ where: { employeeId }, orderBy: { name: "asc" } });
  },

  async createFamilyMember(scope: HrScope, employeeId: string, data: {
    name: string; relationship: string; dob?: string; occupation?: string; mobile?: string; dependent?: boolean;
  }) {
    await assertEmployee(scope, employeeId);
    return prisma.hrFamilyMember.create({ data: { employeeId, ...data } });
  },

  async updateFamilyMember(scope: HrScope, employeeId: string, sectionId: string, data: Record<string, unknown>) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrFamilyMember.findFirst({ where: { id: sectionId, employeeId } });
    if (!existing) throw new SectionNotFoundError("Family member");
    return prisma.hrFamilyMember.update({ where: { id: sectionId }, data });
  },

  async removeFamilyMember(scope: HrScope, employeeId: string, sectionId: string) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrFamilyMember.findFirst({ where: { id: sectionId, employeeId } });
    if (!existing) throw new SectionNotFoundError("Family member");
    await prisma.hrFamilyMember.delete({ where: { id: sectionId } });
    return { removed: true };
  },

  // ── Education ──────────────────────────────────────────────────────────

  async listEducation(scope: HrScope, employeeId: string) {
    await assertEmployee(scope, employeeId);
    return prisma.hrEducation.findMany({ where: { employeeId }, orderBy: { degree: "asc" } });
  },

  async createEducation(scope: HrScope, employeeId: string, data: {
    degree: string; institution?: string; major?: string; passingYear?: string; result?: string;
  }) {
    await assertEmployee(scope, employeeId);
    return prisma.hrEducation.create({ data: { employeeId, ...data } });
  },

  async updateEducation(scope: HrScope, employeeId: string, sectionId: string, data: Record<string, unknown>) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrEducation.findFirst({ where: { id: sectionId, employeeId } });
    if (!existing) throw new SectionNotFoundError("Education");
    return prisma.hrEducation.update({ where: { id: sectionId }, data });
  },

  async removeEducation(scope: HrScope, employeeId: string, sectionId: string) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrEducation.findFirst({ where: { id: sectionId, employeeId } });
    if (!existing) throw new SectionNotFoundError("Education");
    await prisma.hrEducation.delete({ where: { id: sectionId } });
    return { removed: true };
  },

  // ── Previous employment ────────────────────────────────────────────────

  async listPreviousEmployment(scope: HrScope, employeeId: string) {
    await assertEmployee(scope, employeeId);
    return prisma.hrPreviousEmployment.findMany({ where: { employeeId }, orderBy: { createdAt: "desc" } });
  },

  async createPreviousEmployment(scope: HrScope, employeeId: string, data: {
    company: string; designation?: string; department?: string; joinDate?: string; leaveDate?: string;
    lastSalary?: number; reasonForLeaving?: string; supervisor?: string; contact?: string; notes?: string;
  }) {
    await assertEmployee(scope, employeeId);
    return prisma.hrPreviousEmployment.create({
      data: { employeeId, vendorId: scope.vendorId, ...data },
    });
  },

  async updatePreviousEmployment(scope: HrScope, employeeId: string, sectionId: string, data: Record<string, unknown>) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrPreviousEmployment.findFirst({ where: { id: sectionId, employeeId } });
    if (!existing) throw new SectionNotFoundError("Previous employment");
    return prisma.hrPreviousEmployment.update({ where: { id: sectionId }, data });
  },

  async removePreviousEmployment(scope: HrScope, employeeId: string, sectionId: string) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrPreviousEmployment.findFirst({ where: { id: sectionId, employeeId } });
    if (!existing) throw new SectionNotFoundError("Previous employment");
    await prisma.hrPreviousEmployment.delete({ where: { id: sectionId } });
    return { removed: true };
  },

  // ── Bank / MFS accounts ────────────────────────────────────────────────

  async listBankAccounts(scope: HrScope, employeeId: string) {
    await assertEmployee(scope, employeeId);
    return prisma.hrEmployeeBankAccount.findMany({ where: { employeeId }, orderBy: { createdAt: "desc" } });
  },

  async createBankAccount(scope: HrScope, employeeId: string, data: {
    holderName?: string; bank?: string; branch?: string; accountNumber?: string; routingNumber?: string;
    accountType?: string; mfsProvider?: string; mfsNumber?: string; paymentMethod?: string; isPrimary?: boolean;
  }) {
    await assertEmployee(scope, employeeId);
    const makePrimary = data.isPrimary === true;

    return prismaDirect.$transaction(async (tx) => {
      if (makePrimary) {
        await tx.hrEmployeeBankAccount.updateMany({ where: { employeeId }, data: { isPrimary: false } });
      }
      return tx.hrEmployeeBankAccount.create({
        data: {
          employeeId,
          vendorId: scope.vendorId,
          ...data,
          isPrimary: makePrimary,
        },
      });
    });
  },

  async updateBankAccount(scope: HrScope, employeeId: string, sectionId: string, data: Record<string, unknown>) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrEmployeeBankAccount.findFirst({ where: { id: sectionId, employeeId } });
    if (!existing) throw new SectionNotFoundError("Bank account");

    return prismaDirect.$transaction(async (tx) => {
      if (data.isPrimary === true) {
        await tx.hrEmployeeBankAccount.updateMany({ where: { employeeId }, data: { isPrimary: false } });
      }
      return tx.hrEmployeeBankAccount.update({ where: { id: sectionId }, data });
    });
  },

  async removeBankAccount(scope: HrScope, employeeId: string, sectionId: string) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrEmployeeBankAccount.findFirst({ where: { id: sectionId, employeeId } });
    if (!existing) throw new SectionNotFoundError("Bank account");
    await prisma.hrEmployeeBankAccount.delete({ where: { id: sectionId } });
    return { removed: true };
  },
};
