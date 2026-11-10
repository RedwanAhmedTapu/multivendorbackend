// tests/hrm-p0.security.test.ts
//
// P0 regression coverage: granular HR permissions, sensitive-gate tiering
// (VENDOR does not auto-pass salary/bank), bank masking, employee archive +
// typed-confirmation hard delete, status whitelist, master-data delete
// guards, idempotent default master data, and leave-type deactivation.
//
// DB-free (plain property spies on the Prisma delegates). Run with:
//   npx tsx --test tests/hrm-p0.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma, prismaDirect } from "../src/config/prisma.ts";
import { requireHr, getHrCapabilities } from "../src/middlewares/permission.middleware.ts";
import { maskAccount, employeeProfileService } from "../src/modules/hrm/services/employeeProfile.service.ts";
import { employeeSectionsService } from "../src/modules/hrm/services/employeeSections.service.ts";
import { hrBootstrapService } from "../src/modules/hrm/services/hrBootstrap.service.ts";
import { branchService } from "../src/modules/hrm/services/branch.service.ts";
import { departmentService } from "../src/modules/hrm/services/department.service.ts";
import { designationService } from "../src/modules/hrm/services/designation.service.ts";
import { leaveService } from "../src/modules/hrm/services/leave.service.ts";
import { employeeSectionController } from "../src/modules/hrm/controllers/employeeSections.controller.ts";
import type { AuthRequest } from "../src/middlewares/auth.middleware.ts";

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

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  return res;
}

function runGate(user: Partial<AuthRequest["user"]> | undefined, grant: Parameters<typeof requireHr>[0]) {
  let nextCalled = false;
  return requireHr(grant)(
    { user } as any,
    mockRes(),
    () => { nextCalled = true; }
  ).then(() => nextCalled);
}

const emp = (permissions: Record<string, boolean>) => ({
  id: "EMP_ME", rawId: "U_ME", role: "EMPLOYEE", employeeId: "EMP_ME", vendorId: null, email: null, name: null,
});

// ── Granular permission gates ─────────────────────────────────────────────

test("EMPLOYEE with the hrManagement umbrella passes every granular gate", async () => {
  const find = spyOn(prisma.employee, "findUnique", () => ({ id: "E1", isActive: true, permissions: { hrManagement: true } }));
  try {
    assert.equal(await runGate(emp({}), "hrEmployeeView"), true);
    assert.equal(await runGate(emp({}), "hrSalaryEdit"), true);
    assert.equal(await runGate(emp({}), "hrBankView"), true);
  } finally { find.restore(); }
});

test("EMPLOYEE with a granular key passes only that gate (403 otherwise)", async () => {
  const find = spyOn(prisma.employee, "findUnique", () => ({ id: "E1", isActive: true, permissions: { hrDocsVerify: true } }));
  try {
    assert.equal(await runGate(emp({}), "hrDocsVerify"), true);
    const res = mockRes();
    await requireHr("hrEmployeeView")({ user: emp({}) } as any, res, () => assert.fail("must not pass"));
    assert.equal(res.statusCode, 403);
  } finally { find.restore(); }
});

test("VENDOR passes non-sensitive HR gates but NOT sensitive salary/bank gates", async () => {
  const vendor = { id: "VEN_1", rawId: "U_OWNER", role: "VENDOR", employeeId: null, vendorId: "VEN_1", email: null, name: null };
  assert.equal(await runGate(vendor, "hrEmployeeView"), true);
  assert.equal(await runGate(vendor, "hrOrgEdit"), true);
  const res = mockRes();
  await requireHr("hrSalaryView")( { user: vendor } as any, res, () => assert.fail("must not pass"));
  assert.equal(res.statusCode, 403);
  const res2 = mockRes();
  await requireHr("hrBankView")({ user: vendor } as any, res2, () => assert.fail("must not pass"));
  assert.equal(res2.statusCode, 403);
});

test("ADMIN passes sensitive gates (existing privileged behavior preserved)", async () => {
  const admin = { id: "A1", rawId: "U_ADMIN", role: "ADMIN", employeeId: "EMP_SHADOW", vendorId: null, email: null, name: null };
  assert.equal(await runGate(admin, "hrSalaryView"), true);
  assert.equal(await runGate(admin, "hrBankView"), true);
});

test("getHrCapabilities: umbrella expands, granular maps per key, VENDOR sensitive=false", async () => {
  assert.deepEqual(await getHrCapabilities({ role: "ADMIN" } as any), {
    hrEmployeeView: true, hrEmployeeCreate: true, hrEmployeeEdit: true, hrEmployeeDelete: true,
    hrSalaryView: true, hrSalaryEdit: true, hrDocsUpload: true, hrDocsVerify: true,
    hrDocsDownload: true, hrDocsDelete: true, hrBankView: true, hrOrgEdit: true,
    hrLeaveTypesEdit: true,
  });

  const vendorCaps = await getHrCapabilities({ role: "VENDOR" } as any);
  assert.equal(vendorCaps.hrSalaryView, false);
  assert.equal(vendorCaps.hrBankView, false);
  assert.equal(vendorCaps.hrEmployeeView, true);

  const find = spyOn(prisma.employee, "findUnique", () => ({ id: "E1", isActive: true, permissions: { hrDocsVerify: true } }));
  try {
    const caps = await getHrCapabilities(emp({}) as any);
    assert.equal(caps.hrDocsVerify, true);
    assert.equal(caps.hrSalaryView, false);
    assert.equal(caps.hrEmployeeView, false);
  } finally { find.restore(); }
});

// ── Bank masking ──────────────────────────────────────────────────────────

test("maskAccount hides everything but the last 4 characters", () => {
  assert.equal(maskAccount("1234567890"), "••••7890");
  assert.equal(maskAccount("••••7890"), "••••7890"); // idempotent
  assert.equal(maskAccount("ab"), "••••ab");
  assert.equal(maskAccount(null), null);
  assert.equal(maskAccount(undefined), null);
});

test("bank list is masked for a viewer without hrBankView and unmasked for ADMIN", async () => {
  const scoped = spyOn(prisma.hrEmployeeProfile, "findFirst", () => ({ id: "PROF_1" }));
  const rows = spyOn(prisma.hrEmployeeBankAccount, "findMany", () => [
    { id: "B1", accountNumber: "1234567890", mfsNumber: "01712345678" },
  ]);
  try {
    const vendorRes = mockRes();
    await employeeSectionController.listBankAccounts(
      { hrScope: { vendorId: "VEN_A", actorUserId: "U_A", role: "VENDOR" }, user: { role: "VENDOR" }, params: { id: "PROF_1" } } as any,
      vendorRes
    );
    assert.equal(vendorRes.body.data[0].accountNumber, "••••7890");
    assert.equal(vendorRes.body.data[0].mfsNumber, "••••5678");

    const adminRes = mockRes();
    await employeeSectionController.listBankAccounts(
      { hrScope: { vendorId: "VEN_A", actorUserId: "U_ADMIN", role: "ADMIN" }, user: { role: "ADMIN" }, params: { id: "PROF_1" } } as any,
      adminRes
    );
    assert.equal(adminRes.body.data[0].accountNumber, "1234567890");
  } finally {
    [scoped, rows].forEach((m) => m.restore());
  }
});

test("getById strips salary structures and masks bank rows without capabilities", async () => {
  const find = spyOn(prisma.hrEmployeeProfile, "findFirst", () => ({
    id: "PROF_1",
    shiftAssignments: [],
    bankAccounts: [{ id: "B1", accountNumber: "1234567890", mfsNumber: null }],
  }));
  try {
    const shaped: any = await employeeProfileService.getById(
      { vendorId: null, actorUserId: "U", role: "ADMIN" },
      "PROF_1",
      { salaryView: false, bankFull: false }
    );
    assert.equal(shaped.salaryHidden, true);
    assert.deepEqual(shaped.salaryStructures, []);
    assert.equal(shaped.bankAccounts[0].accountNumber, "••••7890");

    const shaped2: any = await employeeProfileService.getById(
      { vendorId: null, actorUserId: "U", role: "ADMIN" },
      "PROF_1",
      { salaryView: true, bankFull: true }
    );
    assert.equal(shaped2.salaryHidden, false);
    assert.equal(shaped2.bankAccounts[0].accountNumber, "1234567890");
  } finally { find.restore(); }
});

test("getById resolves shift via shiftAssignments (no nonexistent `shift` relation) — FK/include regression", async () => {
  let capturedInclude: any;
  const find = spyOn(prisma.hrEmployeeProfile, "findFirst", (args: any) => {
    capturedInclude = args.include;
    return {
      id: "PROF_1",
      // Latest first: an expired assignment, then the current one — the
      // service must pick the still-current shift.
      shiftAssignments: [
        {
          fromDate: "2026-01-01", toDate: "2026-06-30",
          shift: { id: "SH_OLD", name: "Morning Store Shift", startTime: "08:00", endTime: "16:00" },
        },
        {
          fromDate: "2026-07-01", toDate: null,
          shift: { id: "SH_NOW", name: "General (9-5)", startTime: "09:00", endTime: "18:00" },
        },
      ],
      bankAccounts: [],
    };
  });
  try {
    const shaped: any = await employeeProfileService.getById(
      { vendorId: null, actorUserId: "U", role: "ADMIN" },
      "PROF_1",
      { salaryView: false, bankFull: false }
    );
    // The include must use the ONLY real relation path — never `shift`.
    assert.ok(capturedInclude.shiftAssignments, "include must use shiftAssignments");
    assert.equal(capturedInclude.shift, undefined, "include must not reference a nonexistent shift relation");
    // Derived from the still-current assignment, not the expired one.
    assert.equal(shaped.shift.id, "SH_NOW");
    assert.equal(shaped.shift.name, "General (9-5)");
    // Raw assignments are stripped — response contract unchanged.
    assert.equal(shaped.shiftAssignments, undefined);
  } finally { find.restore(); }
});

test("getById yields shift null when the employee has no assignments", async () => {
  const find = spyOn(prisma.hrEmployeeProfile, "findFirst", () => ({
    id: "PROF_1", shiftAssignments: [], bankAccounts: [],
  }));
  try {
    const shaped: any = await employeeProfileService.getById(
      { vendorId: null, actorUserId: "U", role: "ADMIN" }, "PROF_1",
      { salaryView: false, bankFull: false }
    );
    assert.equal(shaped.shift, null);
  } finally { find.restore(); }
});

// ── Archive + hard delete ─────────────────────────────────────────────────

test("archive writes a STATUS_CHANGE history event and sets INACTIVE", async () => {
  const find = spyOn(prisma.hrEmployeeProfile, "findFirst", () => ({ id: "P1", status: "ACTIVE", code: "EMP-0001" }));
  const update = spyOn(prisma.hrEmployeeProfile, "update", ({ data }: any) => ({ id: "P1", ...data }));
  const hist = spyOn(prisma.hrEmployeeHistory, "create", ({ data }: any) => ({ id: "H1", ...data }));
  try {
    await employeeProfileService.remove({ vendorId: null, actorUserId: "U_A", role: "ADMIN" }, "P1", "U_A");
    assert.equal(update.calls[0][0].data.status, "INACTIVE");
    assert.equal(hist.calls[0][0].data.eventType, "STATUS_CHANGE");
    assert.match(hist.calls[0][0].data.title, /INACTIVE/);
  } finally {
    [find, update, hist].forEach((m) => m.restore());
  }
});

test("hard delete refuses a wrong typed code", async () => {
  const find = spyOn(prisma.hrEmployeeProfile, "findFirst", () => ({ id: "P1", code: "EMP-0007", fullName: "X" }));
  const del = spyOn(prisma.hrEmployeeProfile, "delete", () => ({}));
  try {
    await assert.rejects(
      () => employeeProfileService.hardDelete({ vendorId: null, actorUserId: "U", role: "ADMIN" }, "P1", "WRONG", "U"),
      /Confirmation required/
    );
    assert.equal(del.callCount(), 0);
  } finally { [find, del].forEach((m) => m.restore()); }
});

test("hard delete refuses when transactional records exist (Restrict references)", async () => {
  const find = spyOn(prisma.hrEmployeeProfile, "findFirst", () => ({ id: "P1", code: "EMP-0007", fullName: "X" }));
  const att = spyOn(prisma.hrAttendance, "count", () => 3);
  const del = spyOn(prisma.hrEmployeeProfile, "delete", () => ({}));
  try {
    await assert.rejects(
      () => employeeProfileService.hardDelete({ vendorId: null, actorUserId: "U", role: "ADMIN" }, "P1", "EMP-0007", "U"),
      /3 attendance record\(s\)/
    );
    assert.equal(del.callCount(), 0);
  } finally { [find, att, del].forEach((m) => m.restore()); }
});

test("hard delete with a matching code and no blockers deletes the profile", async () => {
  const find = spyOn(prisma.hrEmployeeProfile, "findFirst", () => ({ id: "P1", code: "EMP-0007", fullName: "X" }));
  const counts = ["hrAttendance", "hrLeaveRequest", "hrShiftAssignment", "hrSalaryStructure", "hrPayrollEntry",
    "hrBonus", "hrDeduction", "hrLoan", "hrAdvance", "hrExpenseClaim", "hrKpiAssignment",
    "hrPerformanceReview", "hrResignation", "hrLetter"].map((m) => spyOn((prisma as any)[m], "count", () => 0));
  const docs = spyOn(prisma.hrEmployeeDocument, "findMany", () => [{ fileUrl: "hr/x/doc.pdf" }]);
  const del = spyOn(prisma.hrEmployeeProfile, "delete", () => ({}));
  const tx = spyOn(prismaDirect, "$transaction", (fn: (tx: any) => Promise<unknown>) => fn(prisma));
  try {
    const result = await employeeProfileService.hardDelete({ vendorId: null, actorUserId: "U", role: "ADMIN" }, "P1", "EMP-0007", "U");
    assert.equal(result.deleted, true);
    assert.equal(result.documentKeys[0], "hr/x/doc.pdf");
    assert.equal(del.callCount(), 1);
  } finally {
    [find, docs, del, tx, ...counts].forEach((m) => m.restore());
  }
});

// ── Status whitelist ──────────────────────────────────────────────────────

test("profile update rejects an unknown status and accepts RETIRED", async () => {
  const find = spyOn(prisma.hrEmployeeProfile, "findFirst", () => ({ id: "P1", status: "ACTIVE" }));
  const update = spyOn(prisma.hrEmployeeProfile, "update", ({ data }: any) => ({ id: "P1", ...data }));
  const hist = spyOn(prisma.hrEmployeeHistory, "create", ({ data }: any) => ({ id: "H1", ...data }));
  try {
    await assert.rejects(
      () => employeeProfileService.update({ vendorId: null, actorUserId: "U", role: "ADMIN" }, "P1", { status: "SUPERSTAR" }, "U"),
      /Invalid employee status/
    );
    await employeeProfileService.update({ vendorId: null, actorUserId: "U", role: "ADMIN" }, "P1", { status: "RETIRED" }, "U");
    assert.equal(update.calls[0][0].data.status, "RETIRED");
    assert.equal(hist.calls[0][0].data.eventType, "STATUS_CHANGE"); // transition history preserved
  } finally { [find, update, hist].forEach((m) => m.restore()); }
});

// ── Master-data delete guards ─────────────────────────────────────────────

test("branch with assigned employees cannot be deleted", async () => {
  const find = spyOn(prisma.hrBranch, "findFirst", () => ({ id: "B1", active: true }));
  const count = spyOn(prisma.hrEmployeeProfile, "count", () => 4);
  try {
    await assert.rejects(
      () => branchService.remove({ vendorId: "VEN_A", actorUserId: "U", role: "VENDOR" }, "B1"),
      /Cannot delete this branch because 4 employee\(s\)/
    );
  } finally { [find, count].forEach((m) => m.restore()); }
});

test("branch with no employees soft-archives", async () => {
  const find = spyOn(prisma.hrBranch, "findFirst", () => ({ id: "B1", active: true }));
  const count = spyOn(prisma.hrEmployeeProfile, "count", () => 0);
  const update = spyOn(prisma.hrBranch, "update", ({ data }: any) => ({ id: "B1", ...data }));
  try {
    const r = await branchService.remove({ vendorId: "VEN_A", actorUserId: "U", role: "VENDOR" }, "B1");
    assert.equal(r.active, false);
  } finally { [find, count, update].forEach((m) => m.restore()); }
});

test("department and designation reference guards fire", async () => {
  const dFind = spyOn(prisma.hrDepartment, "findFirst", () => ({ id: "D1", status: "ACTIVE" }));
  const dCount = spyOn(prisma.hrEmployeeProfile, "count", ({ where }: any) => (where.departmentId ? 2 : 0));
  try {
    await assert.rejects(
      () => departmentService.remove({ vendorId: "VEN_A", actorUserId: "U", role: "VENDOR" }, "D1"),
      /Cannot delete this department because 2 employee\(s\)/
    );
  } finally { [dFind, dCount].forEach((m) => m.restore()); }

  const gFind = spyOn(prisma.hrDesignation, "findFirst", () => ({ id: "G1", status: "ACTIVE" }));
  const gCount = spyOn(prisma.hrEmployeeProfile, "count", () => 1);
  try {
    await assert.rejects(
      () => designationService.remove({ vendorId: "VEN_A", actorUserId: "U", role: "VENDOR" }, "G1"),
      /Cannot delete this designation because 1 employee\(s\)/
    );
  } finally { [gFind, gCount].forEach((m) => m.restore()); }
});

// ── Default master data ───────────────────────────────────────────────────

test("ensureDefaults creates nothing when every seeded record already exists", async () => {
  // Every per-record existence check finds its row → no create happens.
  const findFirst = spyOn(prisma.hrBranch, "findFirst", () => ({ id: "B1" }));
  const dFind = spyOn(prisma.hrDepartment, "findFirst", () => ({ id: "D1" }));
  const gFind = spyOn(prisma.hrDesignation, "findFirst", () => ({ id: "G1" }));
  const sFind = spyOn(prisma.hrShift, "findMany", () => [
    { name: "General (9-5)" }, { name: "Morning Store Shift" },
    { name: "Evening Store Shift" }, { name: "Night Warehouse Shift" },
  ]);
  const ltFind = spyOn(prisma.hrLeaveType, "findMany", () =>
    ["CASUAL", "SICK", "ANNUAL", "EARNED", "EMERGENCY", "MATERNITY", "PATERNITY", "UNPAID"].map((code) => ({ code })));
  const creates = [
    spyOn(prisma.hrLeaveType, "create", () => ({})),
    spyOn(prisma.hrBranch, "create", () => ({})),
    spyOn(prisma.hrDepartment, "create", () => ({})),
    spyOn(prisma.hrDesignation, "create", () => ({})),
    spyOn(prisma.hrShift, "create", () => ({})),
  ];
  try {
    const created = await hrBootstrapService.ensureDefaults({ vendorId: "VEN_A", actorUserId: "U", role: "VENDOR" });
    assert.deepEqual(created, {}); // nothing seeded
    creates.forEach((c) => assert.equal(c.callCount(), 0, "no create calls expected"));
  } finally {
    [findFirst, dFind, gFind, sFind, ltFind, ...creates].forEach((m) => m.restore());
  }
});

test("ensureDefaults seeds the 8 statutory leave types + starter org tree for an empty tenant", async () => {
  const ltFind = spyOn(prisma.hrLeaveType, "findMany", () => []);
  const ltCreate = spyOn(prisma.hrLeaveType, "create", ({ data }: any) => ({ id: data.code, ...data }));
  const bCreate = spyOn(prisma.hrBranch, "create", ({ data }: any) => ({ id: data.code, ...data }));
  const dFind = spyOn(prisma.hrDepartment, "findFirst", () => null);
  const dCreate = spyOn(prisma.hrDepartment, "create", ({ data }: any) => ({ id: data.code, ...data }));
  const gFind = spyOn(prisma.hrDesignation, "findFirst", () => null);
  const gCreate = spyOn(prisma.hrDesignation, "create", ({ data }: any) => ({ id: data.code, ...data }));
  const sFind = spyOn(prisma.hrShift, "findMany", () => []);
  const sCreate = spyOn(prisma.hrShift, "create", ({ data }: any) => ({ id: data.name, ...data }));
  try {
    const created = await hrBootstrapService.ensureDefaults({ vendorId: "VEN_A", actorUserId: "U", role: "VENDOR" });
    assert.equal(created.leaveTypes, 8);
    assert.equal(created.branches, 4);
    assert.equal(created.departments, 12);
    assert.equal(created.designations, 15);
    assert.equal(created.shifts, 4);
    // The 8 statutory codes, in order.
    const codes = ltCreate.calls.map((c) => c[0].data.code);
    assert.deepEqual(codes, ["CASUAL", "SICK", "ANNUAL", "EARNED", "EMERGENCY", "MATERNITY", "PATERNITY", "UNPAID"]);
    assert.equal(ltCreate.calls[0][0].data.paid, true);
    assert.equal(ltCreate.calls[7][0].data.paid, false); // UNPAID
  } finally {
    [ltFind, ltCreate, bCreate, dFind, dCreate, gFind, gCreate, sFind, sCreate].forEach((m) => m.restore());
  }
});

test("ensureDefaults tolerates unique-constraint races (P2002 is swallowed)", async () => {
  const ltFind = spyOn(prisma.hrLeaveType, "findMany", () => []);
  const ltCreate = spyOn(prisma.hrLeaveType, "create", () => { const e: any = new Error("dup"); e.code = "P2002"; throw e; });
  const bCreate = spyOn(prisma.hrBranch, "create", () => { const e: any = new Error("dup"); e.code = "P2002"; throw e; });
  const dFind = spyOn(prisma.hrDepartment, "findFirst", () => null);
  const dCreate = spyOn(prisma.hrDepartment, "create", () => { const e: any = new Error("dup"); e.code = "P2002"; throw e; });
  const gFind = spyOn(prisma.hrDesignation, "findFirst", () => null);
  const gCreate = spyOn(prisma.hrDesignation, "create", () => { const e: any = new Error("dup"); e.code = "P2002"; throw e; });
  const sFind = spyOn(prisma.hrShift, "findMany", () => []);
  const sCreate = spyOn(prisma.hrShift, "create", () => { const e: any = new Error("dup"); e.code = "P2002"; throw e; });
  try {
    // Must not throw despite every create racing.
    await hrBootstrapService.ensureDefaults({ vendorId: "VEN_A", actorUserId: "U", role: "VENDOR" });
  } finally {
    [ltFind, ltCreate, bCreate, dFind, dCreate, gFind, gCreate, sFind, sCreate].forEach((m) => m.restore());
  }
});

// ── Leave-type deactivation ───────────────────────────────────────────────

test("leave type cannot be deactivated while requests are pending/approved", async () => {
  const find = spyOn(prisma.hrLeaveType, "findFirst", () => ({ id: "LT1", active: true }));
  const reqCount = spyOn(prisma.hrLeaveRequest, "count", () => 2);
  try {
    await assert.rejects(
      () => leaveService.updateType({ vendorId: "VEN_A", actorUserId: "U", role: "VENDOR" }, "LT1", { active: false }),
      /Cannot deactivate this leave type while 2 leave request\(s\)/
    );
  } finally { [find, reqCount].forEach((m) => m.restore()); }
});

test("leave type deactivates cleanly when unused (no hard delete exists)", async () => {
  const find = spyOn(prisma.hrLeaveType, "findFirst", () => ({ id: "LT1", active: true }));
  const reqCount = spyOn(prisma.hrLeaveRequest, "count", () => 0);
  const update = spyOn(prisma.hrLeaveType, "update", ({ data }: any) => ({ id: "LT1", ...data }));
  try {
    const r = await leaveService.updateType({ vendorId: "VEN_A", actorUserId: "U", role: "VENDOR" }, "LT1", { active: false });
    assert.equal(r.active, false);
  } finally { [find, reqCount, update].forEach((m) => m.restore()); }
});
