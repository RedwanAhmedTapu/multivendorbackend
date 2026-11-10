// tests/hrm-employee-360.security.test.ts
//
// Tenant-isolation tests for the Employee 360 endpoints (Employee
// Management phase). Covers the mandatory matrix:
//   1. Vendor A cannot READ Vendor B's employee
//   2. Vendor A cannot UPDATE Vendor B's employee
//   3. Vendor A cannot add family/education/document/bank/previous-
//      employment/lifecycle data to Vendor B's employee
//   4. Employee A cannot act as Employee B in self-service
//   5. Employees without the hrManagement permission cannot manage
//   6. Platform scope (vendorId: null) keeps working
//
// DB-free: the shared Prisma singletons are patched with plain property
// spies (Prisma delegates are writable/configurable), so no database
// connection is ever made. Run with:
//   npx tsx --test tests/hrm-employee-360.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma, prismaDirect } from "../src/config/prisma.ts";
import { employeeProfileService } from "../src/modules/hrm/services/employeeProfile.service.ts";
import { employeeSectionsService, EmployeeNotFoundError } from "../src/modules/hrm/services/employeeSections.service.ts";
import { employeeLifecycleService } from "../src/modules/hrm/services/employeeLifecycle.service.ts";
import { employeeSectionController } from "../src/modules/hrm/controllers/employeeSections.controller.ts";
import { requirePermission } from "../src/middlewares/permission.middleware.ts";

const SCOPE_A = { vendorId: "VEN_A", actorUserId: "U_A", role: "VENDOR" };
const SCOPE_B = { vendorId: "VEN_B", actorUserId: "U_B", role: "VENDOR" };
const SCOPE_PLATFORM = { vendorId: null, actorUserId: "U_ADMIN", role: "ADMIN" };
const EMP_ID = "HRPROFILE_1";

// Prisma delegates are Proxy-ish objects that node:test's mock.method
// rejects — plain writable spies work fine (verified: writable+configurable).
type Spy = { calls: any[][]; callCount(): number; restore(): void };
function spyOn(obj: any, method: string, impl?: (...args: any[]) => unknown): Spy {
  const calls: any[][] = [];
  const original = obj[method];
  obj[method] = async (...args: any[]) => {
    calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  return {
    calls,
    callCount: () => calls.length,
    restore: () => { obj[method] = original; },
  };
}

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  return res;
}

function mockReq(scope: any, params: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  return { hrScope: scope, user: { rawId: scope.actorUserId }, params, body } as any;
}

/**
 * Scoped profile lookup spy: a profile row only "exists" for its own
 * vendor (or the platform scope) — the exact behaviour the real
 * linkedVendorId-filtered findFirst has in the database.
 */
function mockProfileLookup(rows: Array<{ id: string; vendorId: string | null; designationId?: string | null; branchId?: string | null; departmentId?: string | null }>) {
  return spyOn(prisma.hrEmployeeProfile, "findFirst", (args: any) => {
    const { id, linkedVendorId } = args?.where ?? {};
    const row = rows.find((r) => r.id === id && (r.vendorId ?? null) === (linkedVendorId ?? null));
    return row ? { ...row } : null;
  });
}

// ── 1+2. Read / update across tenants ────────────────────────────────────

test("Vendor B cannot READ Vendor A's employee (360 getById)", async () => {
  const m = mockProfileLookup([{ id: EMP_ID, vendorId: "VEN_A" }]);
  try {
    await assert.rejects(
      () => employeeProfileService.getById(SCOPE_B, EMP_ID),
      /Employee profile not found/
    );
  } finally {
    m.restore();
  }
});

test("Vendor B cannot UPDATE Vendor A's employee", async () => {
  const m = mockProfileLookup([{ id: EMP_ID, vendorId: "VEN_A" }]);
  try {
    await assert.rejects(
      () => employeeProfileService.update(SCOPE_B, EMP_ID, { fullName: "Hacked" }, "U_B"),
      /Employee profile not found/
    );
  } finally {
    m.restore();
  }
});

test("Platform (vendorId null) still resolves platform-owned employees", async () => {
  const m = mockProfileLookup([{ id: EMP_ID, vendorId: null }]);
  try {
    const profile = await employeeProfileService.findScopedProfile(SCOPE_PLATFORM, EMP_ID);
    assert.equal(profile?.id, EMP_ID);
  } finally {
    m.restore();
  }
});

// ── 3. Writes into every nested section across tenants ───────────────────

test("Vendor B cannot add FAMILY data to Vendor A's employee", async () => {
  const m = mockProfileLookup([{ id: EMP_ID, vendorId: "VEN_A" }]);
  try {
    await assert.rejects(
      () => employeeSectionsService.createFamilyMember(SCOPE_B, EMP_ID, { name: "X", relationship: "Brother" }),
      EmployeeNotFoundError
    );
  } finally {
    m.restore();
  }
});

test("Vendor B cannot add EDUCATION data to Vendor A's employee", async () => {
  const m = mockProfileLookup([{ id: EMP_ID, vendorId: "VEN_A" }]);
  try {
    await assert.rejects(
      () => employeeSectionsService.createEducation(SCOPE_B, EMP_ID, { degree: "BSc" }),
      EmployeeNotFoundError
    );
  } finally {
    m.restore();
  }
});

test("Vendor B cannot add BANK/MFS data to Vendor A's employee", async () => {
  const m = mockProfileLookup([{ id: EMP_ID, vendorId: "VEN_A" }]);
  try {
    await assert.rejects(
      () => employeeSectionsService.createBankAccount(SCOPE_B, EMP_ID, { accountNumber: "123", bank: "X" }),
      EmployeeNotFoundError
    );
  } finally {
    m.restore();
  }
});

test("Vendor B cannot add PREVIOUS EMPLOYMENT data to Vendor A's employee", async () => {
  const m = mockProfileLookup([{ id: EMP_ID, vendorId: "VEN_A" }]);
  try {
    await assert.rejects(
      () => employeeSectionsService.createPreviousEmployment(SCOPE_B, EMP_ID, { company: "OldCo" }),
      EmployeeNotFoundError
    );
  } finally {
    m.restore();
  }
});

test("Vendor B cannot add a PROMOTION to Vendor A's employee", async () => {
  const lookup = mockProfileLookup([{ id: EMP_ID, vendorId: "VEN_A", designationId: "D1" }]);
  const create = spyOn(prisma.hrPromotion, "create", {});
  try {
    await assert.rejects(
      () => employeeLifecycleService.createPromotion(SCOPE_B, EMP_ID, { newDesignationId: "D2", effectiveDate: "2026-01-01" }, "U_B"),
      EmployeeNotFoundError
    );
    assert.equal(create.callCount(), 0);
  } finally {
    lookup.restore();
    create.restore();
  }
});

test("Sections controller maps a cross-tenant read to 404 (not 403)", async () => {
  const m = mockProfileLookup([{ id: EMP_ID, vendorId: "VEN_A" }]);
  try {
    const res = mockRes();
    await employeeSectionController.listFamily(mockReq(SCOPE_B, { id: EMP_ID }), res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body?.message ?? "", /Employee profile not found/);
  } finally {
    m.restore();
  }
});

// ── Vendor A CAN manage its own employee (positive path) ─────────────────

test("Vendor A can add family data to its OWN employee", async () => {
  const lookup = mockProfileLookup([{ id: EMP_ID, vendorId: "VEN_A" }]);
  const create = spyOn(prisma.hrFamilyMember, "create", ({ data }: any) => ({ id: "F1", ...data }));
  try {
    const member = await employeeSectionsService.createFamilyMember(
      SCOPE_A, EMP_ID, { name: "Karim", relationship: "Brother" }
    );
    assert.equal(member.employeeId, EMP_ID);
    assert.equal(create.callCount(), 1);
  } finally {
    lookup.restore();
    create.restore();
  }
});

test("Lifecycle approval applies to the profile in the SAME tenant only", async () => {
  const lookup = mockProfileLookup([{ id: EMP_ID, vendorId: "VEN_A", designationId: "D1" }]);
  const findFirst = spyOn(prisma.hrPromotion, "findFirst", ({ where }: any) =>
    where?.id === "P1" && where?.employeeId === EMP_ID
      ? { id: "P1", employeeId: EMP_ID, newDesignationId: "D2", newBasicSalary: 50000, effectiveDate: "2026-01-01", reason: null, status: "PENDING" }
      : null);
  const update = spyOn(prisma.hrPromotion, "update", ({ data }: any) => ({ id: "P1", ...data }));
  const profileUpdate = spyOn(prisma.hrEmployeeProfile, "update", () => ({}));
  const historyCreate = spyOn(prisma.hrEmployeeHistory, "create", () => ({}));
  const tx = spyOn(prismaDirect, "$transaction", (fn: (tx: any) => Promise<unknown>) =>
    fn({ hrEmployeeProfile: prisma.hrEmployeeProfile, hrEmployeeHistory: prisma.hrEmployeeHistory }));
  try {
    const result = await employeeLifecycleService.actOn(SCOPE_A, "promotions", EMP_ID, "P1", "APPROVED", "U_A");
    assert.equal(result.status, "APPROVED");
    // Profile designation applied + history written exactly once.
    const applied = profileUpdate.calls[0][0];
    assert.equal(applied.where.id, EMP_ID);
    assert.equal(applied.data.designationId, "D2");
    assert.equal(historyCreate.callCount(), 1);
  } finally {
    [lookup, findFirst, update, profileUpdate, historyCreate, tx].forEach((m) => m.restore());
  }
});

// ── 4. Self-service identity stays server-resolved ───────────────────────

test("getMyProfile resolves from the session employeeId, never from the body", async () => {
  const { employeeProfileController } = await import("../src/modules/hrm/controllers/employeeProfile.controller.ts");
  const spy = spyOn(employeeProfileService, "getMyProfile", (_scope: any, employeeId: string) => ({ employeeId }));
  try {
    const res = mockRes();
    const req = mockReq(SCOPE_A);
    (req as any).user = { employeeId: "EMP_ME", role: "EMPLOYEE" };
    (req as any).body = { employeeId: "EMP_VICTIM" };
    await employeeProfileController.getMyProfile(req, res);
    assert.equal(res.statusCode, 200);
    // The session identity was used — the body value was never consulted.
    assert.equal(spy.calls[0][1], "EMP_ME");
  } finally {
    spy.restore();
  }
});

// ── 5. hrManagement permission gate ──────────────────────────────────────

test("EMPLOYEE without hrManagement is rejected by requirePermission", async () => {
  const find = spyOn(prisma.employee, "findUnique", () => ({
    id: "EMP_ME",
    isActive: true,
    permissions: { hrManagement: false },
  }));
  try {
    const res = mockRes();
    let nextCalled = false;
    await requirePermission("hrManagement")(
      { user: { id: "EMP_ME", rawId: "U_ME", role: "EMPLOYEE", employeeId: "EMP_ME", vendorId: null } } as any,
      res,
      () => { nextCalled = true; }
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  } finally {
    find.restore();
  }
});

test("EMPLOYEE with hrManagement passes requirePermission", async () => {
  const find = spyOn(prisma.employee, "findUnique", () => ({
    id: "EMP_ME",
    isActive: true,
    permissions: { hrManagement: true },
  }));
  try {
    let nextCalled = false;
    await requirePermission("hrManagement")(
      { user: { id: "EMP_ME", rawId: "U_ME", role: "EMPLOYEE", employeeId: "EMP_ME", vendorId: null } } as any,
      mockRes(),
      () => { nextCalled = true; }
    );
    assert.equal(nextCalled, true);
  } finally {
    find.restore();
  }
});
