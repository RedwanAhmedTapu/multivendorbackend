// tests/hrm-permissions.test.ts
//
// PHASE F item 5: the permissions editor contract.
// - GET /employees/employees/:id/permissions returns the GRANTED SET itself
//   (previously it returned the whole employee row, so the modal could never
//   pre-check anything).
// - PUT merges the changed keys over the stored set (the modal sends ONLY
//   the diff — untouched grants must survive).
// - A VENDOR actor cannot grant keys it does not hold (sensitive
//   salary/bank gates are never auto-passed for vendors). Run with:
//   npx tsx --test tests/hrm-permissions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { employeeService } from "../src/services/employee.service.ts";
import { EmployeeController } from "../src/controllers/employee.controller.ts";

const employeeController = new EmployeeController();

type Spy = { calls: any[][]; callCount(): number; restore(): void };
function spyOn(obj: any, method: string, impl?: (...args: any[]) => unknown): Spy {
  const calls: any[][] = [];
  const original = obj[method];
  obj[method] = async (...args: any[]) => { calls.push(args); return impl ? impl(...args) : undefined; };
  return { calls, callCount: () => calls.length, restore: () => { obj[method] = original; } };
}

function mockRes(): any {
  return {
    statusCode: 0,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
}

// ── GET shape ────────────────────────────────────────────────────────────

test("permissions GET returns the granted set itself — the shape the editor modal pre-checks", async () => {
  const granted = { hrManagement: true, hrEmployeeView: true, hrEmployeeEdit: true };
  const find = spyOn(prisma.employee, "findUnique", async () => ({
    id: "E1",
    permissions: granted,
    user: { name: "Rahim", email: "rahim@x.tld" },
  }));
  try {
    const result = await employeeService.getEmployeePermissions("E1", "VEN_A");
    // The modal does data.data[key] — it MUST be the permission map, not the row.
    assert.deepEqual(result, granted);
    assert.equal((result as any).user, undefined, "must not leak the employee row");
    // Tenant scope preserved.
    assert.equal(find.calls[0][0].where.vendorId, "VEN_A");
  } finally { find.restore(); }
});

test("permissions GET is tenant-scoped (vendorId null → platform tenant)", async () => {
  const find = spyOn(prisma.employee, "findUnique", async () => ({
    id: "E1", permissions: { hrEmployeeView: true },
  }));
  try {
    await employeeService.getEmployeePermissions("E1", undefined);
    assert.equal(find.calls[0][0].where.vendorId, null);
  } finally { find.restore(); }
});

// ── PUT merge semantics ──────────────────────────────────────────────────

test("permissions PUT merges the diff over the stored set (modal sends only changes)", async () => {
  const find = spyOn(prisma.employee, "findUnique", async () => ({
    id: "E1",
    permissions: { hrEmployeeView: true, hrDocsDownload: true },
  }));
  const update = spyOn(prisma.employee, "update", ({ data }: any) => ({ id: "E1", permissions: data.permissions }));
  try {
    // Modal diff: hrEmployeeEdit ON, hrDocsDownload OFF — hrEmployeeView untouched.
    await employeeService.updateEmployeePermissions(
      "E1",
      { hrEmployeeEdit: true, hrDocsDownload: false },
      "VEN_A"
    );
    const sent = update.calls[0][0].data.permissions;
    assert.deepEqual(sent, {
      hrEmployeeView: true,   // untouched grant SURVIVES the merge
      hrDocsDownload: false,  // explicit revoke applied
      hrEmployeeEdit: true,   // new grant applied
    });
  } finally { [find, update].forEach((m) => m.restore()); }
});

// ── Never grant more than you hold ───────────────────────────────────────

// The exact set the backend requireHr() treats as sensitive (mirrored by the
// editor modal's SENSITIVE_GRANT_KEYS lock for non-ADMIN actors).
const SENSITIVE_KEYS = ["hrSalaryView", "hrSalaryEdit", "hrBankView"];

test("controller: VENDOR actor cannot grant ANY key it does not hold (each sensitive key → 403, service never called)", async () => {
  for (const key of SENSITIVE_KEYS) {
    const serviceSpy = spyOn(employeeService, "updateEmployeePermissions", async () => ({}));
    const res = mockRes();
    try {
      await employeeController.updateEmployeePermissions(
        {
          params: { employeeId: "E1" },
          body: { permissions: { [key]: true } },
          user: { role: "VENDOR", vendorId: "VEN_A", id: "V1" },
        } as any,
        res
      );
      assert.equal(res.statusCode, 403, `${key} must be rejected for VENDOR actors`);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, new RegExp(key), "the message must name the offending key");
      assert.equal(serviceSpy.callCount(), 0, `${key}: the write must be rejected before the service`);
    } finally { serviceSpy.restore(); }
  }
});

test("controller: VENDOR actor CAN grant keys it holds (non-sensitive proceeds to service)", async () => {
  const serviceSpy = spyOn(employeeService, "updateEmployeePermissions", async () => ({ id: "E1", permissions: {} }));
  const res = mockRes();
  try {
    await employeeController.updateEmployeePermissions(
      {
        params: { employeeId: "E1" },
        body: { permissions: { hrOrgEdit: true } },
        user: { role: "VENDOR", vendorId: "VEN_A", id: "V1" },
      } as any,
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(serviceSpy.callCount(), 1);
  } finally { serviceSpy.restore(); }
});

test("controller: VENDOR revoking (false) a sensitive key is allowed — the rule blocks GRANTING only", async () => {
  const serviceSpy = spyOn(employeeService, "updateEmployeePermissions", async () => ({ id: "E1", permissions: {} }));
  const res = mockRes();
  try {
    await employeeController.updateEmployeePermissions(
      {
        params: { employeeId: "E1" },
        body: { permissions: { hrSalaryView: false } },
        user: { role: "VENDOR", vendorId: "VEN_A", id: "V1" },
      } as any,
      res
    );
    assert.equal(res.statusCode, 200, "revoking someone else's sensitive grant is not granting");
    assert.equal(serviceSpy.callCount(), 1);
  } finally { serviceSpy.restore(); }
});

test("controller: VENDOR actor cannot grant sensitive keys (403, service never called)", async () => {
  const serviceSpy = spyOn(employeeService, "updateEmployeePermissions", async () => ({}));
  const res = mockRes();
  try {
    await employeeController.updateEmployeePermissions(
      {
        params: { employeeId: "E1" },
        body: { permissions: { hrSalaryView: true } },
        user: { role: "VENDOR", vendorId: "VEN_A", id: "V1" },
      } as any,
      res
    );
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /hrSalaryView/);
    assert.equal(serviceSpy.callCount(), 0, "the write must be rejected before the service");
  } finally { serviceSpy.restore(); }
});

test("controller: ADMIN actor may grant sensitive keys (proceeds to the service)", async () => {
  const serviceSpy = spyOn(employeeService, "updateEmployeePermissions", async () => ({
    id: "E1", permissions: { hrSalaryView: true },
  }));
  const res = mockRes();
  try {
    await employeeController.updateEmployeePermissions(
      {
        params: { employeeId: "E1" },
        body: { permissions: { hrSalaryView: true } },
        user: { role: "ADMIN", vendorId: null, id: "A1" },
      } as any,
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(serviceSpy.callCount(), 1);
    assert.equal(res.body.success, true);
  } finally { serviceSpy.restore(); }
});
