// tests/hrm-letters.test.ts
//
// PHASE L regressions: letter status transitions (DRAFT → PREPARED →
// APPROVED → ISSUED, REJECTED), self-approval block, salary variable
// gating, template delete/update tenant isolation. DB-free. Run with:
//   npx tsx --test tests/hrm-letters.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { letterService, letterTemplateService } from "../src/modules/hrm/services/letter.service.ts";

type Spy = { calls: any[][]; callCount(): number; restore(): void };
function spyOn(obj: any, method: string, impl?: (...args: any[]) => unknown): Spy {
  const calls: any[][] = [];
  const original = obj[method];
  obj[method] = async (...args: any[]) => {
    calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  return { calls, callCount: () => calls.length, restore: () => { obj[method] = original; } };
}

const SCOPE_A = { vendorId: "VEN_A", actorUserId: "U_A", role: "VENDOR" };
const SCOPE_B = { vendorId: "VEN_B", actorUserId: "U_B", role: "VENDOR" };

function letterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "L1", vendorId: "VEN_A", employeeId: "P1", type: "APPOINTMENT",
    templateId: null, letterNumber: "LTR-0001", subject: "Test", content: "Test content",
    status: "DRAFT", issuedAt: null, approvedBy: null, createdBy: "U_PREPARER",
    createdAt: new Date(), ...overrides,
  };
}

// ── Status transitions ────────────────────────────────────────────────────

test("prepare: DRAFT → PREPARED", async () => {
  const find = spyOn(prisma.hrLetter, "findFirst", async () => letterRow({ status: "DRAFT" }));
  const update = spyOn(prisma.hrLetter, "update", ({ data }: any) => ({ id: "L1", ...data }));
  try {
    const r = await letterService.prepare(SCOPE_A, "L1", "U_A");
    assert.equal(r.status, "PREPARED");
    assert.equal(update.calls[0][0].data.status, "PREPARED");
  } finally { [find, update].forEach((m) => m.restore()); }
});

test("prepare rejects a non-DRAFT letter", async () => {
  const find = spyOn(prisma.hrLetter, "findFirst", async () => letterRow({ status: "APPROVED" }));
  try {
    await assert.rejects(() => letterService.prepare(SCOPE_A, "L1", "U_A"), /Only a DRAFT/);
  } finally { find.restore(); }
});

test("approve: PREPARED → APPROVED (non-preparer)", async () => {
  const find = spyOn(prisma.hrLetter, "findFirst", async () => letterRow({ status: "PREPARED", createdBy: "U_PREPARER" }));
  const update = spyOn(prisma.hrLetter, "update", ({ data }: any) => ({ id: "L1", ...data }));
  try {
    const r = await letterService.approve(SCOPE_A, "L1", "U_APPROVER");
    assert.equal(r.status, "APPROVED");
    assert.equal(update.calls[0][0].data.approvedBy, "U_APPROVER");
  } finally { [find, update].forEach((m) => m.restore()); }
});

test("approve: HR_REVIEW → APPROVED also works (backward compat)", async () => {
  const find = spyOn(prisma.hrLetter, "findFirst", async () => letterRow({ status: "HR_REVIEW", createdBy: "U_OTHER" }));
  const update = spyOn(prisma.hrLetter, "update", ({ data }: any) => ({ id: "L1", ...data }));
  try {
    const r = await letterService.approve(SCOPE_A, "L1", "U_APPROVER");
    assert.equal(r.status, "APPROVED");
  } finally { [find, update].forEach((m) => m.restore()); }
});

test("approve: SELF-APPROVAL blocked (preparer === approver)", async () => {
  const find = spyOn(prisma.hrLetter, "findFirst", async () => letterRow({ status: "PREPARED", createdBy: "U_A" }));
  const update = spyOn(prisma.hrLetter, "update", () => ({}));
  try {
    await assert.rejects(
      () => letterService.approve(SCOPE_A, "L1", "U_A"),
      /cannot approve a letter you prepared yourself/
    );
    assert.equal(update.callCount(), 0);
  } finally { [find, update].forEach((m) => m.restore()); }
});

test("reject: PREPARED → REJECTED (non-preparer)", async () => {
  const find = spyOn(prisma.hrLetter, "findFirst", async () => letterRow({ status: "PREPARED", createdBy: "U_OTHER" }));
  const update = spyOn(prisma.hrLetter, "update", ({ data }: any) => ({ id: "L1", ...data }));
  try {
    const r = await letterService.reject(SCOPE_A, "L1", "U_A");
    assert.equal(r.status, "REJECTED");
  } finally { [find, update].forEach((m) => m.restore()); }
});

test("reject: self-rejection blocked", async () => {
  const find = spyOn(prisma.hrLetter, "findFirst", async () => letterRow({ status: "PREPARED", createdBy: "U_A" }));
  try {
    await assert.rejects(
      () => letterService.reject(SCOPE_A, "L1", "U_A"),
      /cannot reject a letter you prepared yourself/
    );
  } finally { find.restore(); }
});

// ── Tenant isolation ──────────────────────────────────────────────────────

test("letter detail is 404-cloaked for cross-vendor access", async () => {
  const find = spyOn(prisma.hrLetter, "findFirst", async () => null);
  try {
    await assert.rejects(() => letterService.getById(SCOPE_A, "L1"), /Letter not found/);
    assert.equal(find.calls[0][0].where.vendorId, "VEN_A");
  } finally { find.restore(); }
});

test("letter list is vendor-scoped", async () => {
  const spy = spyOn(prisma.hrLetter, "findMany", async () => []);
  try {
    await letterService.list(SCOPE_A, {});
    assert.equal(spy.calls[0][0].where.vendorId, "VEN_A");
  } finally { spy.restore(); }
});

// ── Salary variable gating ────────────────────────────────────────────────

test("generate blocks salary variables without hrSalaryView", async () => {
  const empFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", fullName: "Rahim", code: "EMP-0001", joiningDate: "2026-01-01",
    probationMonths: 3, employmentType: "PERMANENT",
    designation: { name: "Manager" }, department: { name: "Sales" }, branch: { name: "HO" },
    manager: null,
  }));
  const tmplFind = spyOn(prisma.hrLetterTemplate, "findFirst", async () => ({
    id: "T1", type: "SALARY_CERT", name: "Salary Cert", requiresApproval: true,
    subject: "Salary Certificate", body: "Salary: {{salary}}, Basic: {{basic_salary}}",
  }));
  try {
    await assert.rejects(
      () => letterService.generate(SCOPE_A, { employeeId: "P1", templateId: "T1", type: "SALARY_CERT" }, "U_A", false),
      /hrSalaryView permission is required/
    );
  } finally { [empFind, tmplFind].forEach((m) => m.restore()); }
});

test("generate renders salary variables WITH hrSalaryView", async () => {
  const empFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", fullName: "Rahim", code: "EMP-0001", joiningDate: "2026-01-01",
    probationMonths: 3, employmentType: "PERMANENT",
    designation: { name: "Manager" }, department: { name: "Sales" }, branch: { name: "HO" },
    manager: { fullName: "Nazmul" },
  }));
  const tmplFind = spyOn(prisma.hrLetterTemplate, "findFirst", async () => ({
    id: "T1", type: "SALARY_CERT", name: "Salary Cert", requiresApproval: false,
    subject: "Salary Certificate — {{employee_name}}",
    body: "Salary: {{salary}}, Basic: {{basic_salary}}, Gross: {{gross_salary}}, Manager: {{manager_name}}",
  }));
  const structFind = spyOn(prisma.hrSalaryStructure, "findFirst", async () => ({
    basic: 20000, gross: 35000,
  }));
  const vendorFind = spyOn(prisma.vendor, "findUnique", async () => ({ storeName: "Test Vendor" }));
  const numFind = spyOn(prisma.hrLetter, "count", () => 0);
  const create = spyOn(prisma.hrLetter, "create", ({ data }: any) => ({ id: "L1", ...data }));
  try {
    const r = await letterService.generate(SCOPE_A, { employeeId: "P1", templateId: "T1", type: "SALARY_CERT" }, "U_A", true);
    assert.match(r.content, /Salary: 35,000/);
    assert.match(r.content, /Basic: 20,000/);
    assert.match(r.content, /Gross: 35,000/);
    assert.match(r.content, /Manager: Nazmul/);
    assert.match(r.subject, /Rahim/);
    assert.equal(r.status, "APPROVED"); // requiresApproval = false
  } finally {
    [empFind, tmplFind, structFind, vendorFind, numFind, create].forEach((m) => m.restore());
  }
});

test("generate renders non-salary variables without hrSalaryView", async () => {
  const empFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", fullName: "Rahim", code: "EMP-0001", joiningDate: "2026-01-01",
    probationMonths: 3, employmentType: "PERMANENT",
    designation: { name: "Manager" }, department: { name: "Sales" }, branch: { name: "HO" },
    manager: null,
  }));
  const tmplFind = spyOn(prisma.hrLetterTemplate, "findFirst", async () => ({
    id: "T1", type: "APPOINTMENT", name: "Appointment", requiresApproval: true,
    subject: "Appointment — {{employee_name}}",
    body: "Dear {{employee_name}}, Code: {{employee_id}}, Dept: {{department}}, Type: {{employment_type}}, Probation: {{probation_months}} months",
  }));
  const vendorFind = spyOn(prisma.vendor, "findUnique", async () => ({ storeName: "Test Co" }));
  const numFind = spyOn(prisma.hrLetter, "count", () => 0);
  const create = spyOn(prisma.hrLetter, "create", ({ data }: any) => ({ id: "L1", ...data }));
  try {
    const r = await letterService.generate(SCOPE_A, { employeeId: "P1", templateId: "T1", type: "APPOINTMENT" }, "U_A", false);
    assert.match(r.content, /Dear Rahim/);
    assert.match(r.content, /Code: EMP-0001/);
    assert.match(r.content, /Dept: Sales/);
    assert.match(r.content, /Type: PERMANENT/);
    assert.match(r.content, /Probation: 3 months/);
    assert.match(r.subject, /Rahim/);
    assert.equal(r.status, "PREPARED"); // requiresApproval = true
  } finally {
    [empFind, tmplFind, vendorFind, numFind, create].forEach((m) => m.restore());
  }
});

// ── Template delete ──────────────────────────────────────────────────────

test("template delete: soft-deletes when referenced by letters", async () => {
  const find = spyOn(prisma.hrLetterTemplate, "findFirst", async () => ({ id: "T1", active: true }));
  const count = spyOn(prisma.hrLetter, "count", () => 3);
  const update = spyOn(prisma.hrLetterTemplate, "update", ({ data }: any) => ({ id: "T1", ...data }));
  const del = spyOn(prisma.hrLetterTemplate, "delete", () => ({}));
  try {
    const r = await letterTemplateService.remove(SCOPE_A, "T1");
    assert.equal(r.deleted, false);
    assert.equal(r.deactivated, true);
    assert.equal(del.callCount(), 0); // no hard delete
  } finally { [find, count, update, del].forEach((m) => m.restore()); }
});

test("template delete: hard-deletes when unreferenced", async () => {
  const find = spyOn(prisma.hrLetterTemplate, "findFirst", async () => ({ id: "T1", active: true }));
  const count = spyOn(prisma.hrLetter, "count", () => 0);
  const del = spyOn(prisma.hrLetterTemplate, "delete", () => ({}));
  try {
    const r = await letterTemplateService.remove(SCOPE_A, "T1");
    assert.equal(r.deleted, true);
    assert.equal(del.callCount(), 1);
  } finally { [find, count, del].forEach((m) => m.restore()); }
});

test("template delete is tenant-scoped", async () => {
  const find = spyOn(prisma.hrLetterTemplate, "findFirst", async () => null);
  try {
    await assert.rejects(
      () => letterTemplateService.remove(SCOPE_B, "T1"),
      /Letter template not found/
    );
  } finally { find.restore(); }
});

test("template update is tenant-scoped", async () => {
  const find = spyOn(prisma.hrLetterTemplate, "findFirst", async () => null);
  try {
    await assert.rejects(
      () => letterTemplateService.update(SCOPE_B, "T1", { name: "Hacked" }),
      /Letter template not found/
    );
  } finally { find.restore(); }
});
