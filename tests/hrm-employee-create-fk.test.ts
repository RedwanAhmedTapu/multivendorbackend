// tests/hrm-employee-create-fk.test.ts
//
// Regression test for the employees_createdById_fkey crash:
// Employee.createdById references User.id (relation "EmployeeCreator"), but
// the VENDOR creation path passed req.user.id — which authenticateUser sets
// to the role-specific EFFECTIVE id (Vendor.id) for VENDOR sessions — so
// prisma.employee.create() violated the FK.
//
// These tests drive the REAL controller handlers (validation + hashing +
// service call) with an authenticated req.user and assert the service
// receives rawId (the actual User.id) as createdById.
//
// DB-free: the EmployeeService prototype method is spied, so no database
// row is created. Run with:
//   npx tsx --test tests/hrm-employee-create-fk.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { EmployeeController } from "../src/controllers/employee.controller.ts";

// The controller class is instantiated by the router (routes/employee.routes.ts)
// — the tests exercise the same instance methods through the real handlers.
const controller = new EmployeeController();
import { EmployeeService } from "../src/services/employee.service.ts";

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

const VALID_BODY = {
  name: "Rahim Miah",
  email: "rahim@example.com",
  password: "Pass@123",
  designation: "Store Manager",
  department: "Sales",
  permissions: { productManagement: true },
};

test("VENDOR create-employee passes rawId (User.id) as createdById — not the Vendor effective id", async () => {
  const spy = spyOn(EmployeeService.prototype, "createVendorEmployee", () => ({ id: "EMP_NEW" }));
  try {
    const res = mockRes();
    await controller.createVendorEmployee(
      {
        // Exactly what authenticateUser builds for a VENDOR session:
        // id = Vendor.id (role-specific), rawId = the real User.id.
        user: { id: "VEN_1", rawId: "USER_OWNER", role: "VENDOR", vendorId: "VEN_1" },
        body: { ...VALID_BODY },
      } as any,
      res
    );
    assert.equal(res.statusCode, 201);
    assert.equal(spy.callCount(), 1);
    const [data, vendorId, createdById] = spy.calls[0];
    // FK target is User.id → must be rawId, never the Vendor id.
    assert.equal(createdById, "USER_OWNER");
    assert.notEqual(createdById, "VEN_1");
    // Tenant scope preserved: vendor scoping still comes from the session.
    assert.equal(vendorId, "VEN_1");
    assert.equal(data.name, "Rahim Miah");
  } finally {
    spy.restore();
  }
});

test("ADMIN create-employee passes rawId (User.id) as createdById — not the shadow Employee id", async () => {
  const spy = spyOn(EmployeeService.prototype, "createAdminEmployee", () => ({ id: "EMP_NEW" }));
  try {
    const res = mockRes();
    await controller.createAdminEmployee(
      {
        // ADMIN sessions get an auto-provisioned Employee row (id) for chat
        // FKs — createdById must still be the User.id (rawId).
        user: { id: "EMP_SHADOW", rawId: "USER_ADMIN", role: "ADMIN" },
        body: { ...VALID_BODY },
      } as any,
      res
    );
    assert.equal(res.statusCode, 201);
    const [data, createdById] = spy.calls[0];
    assert.equal(createdById, "USER_ADMIN");
    assert.notEqual(createdById, "EMP_SHADOW");
  } finally {
    spy.restore();
  }
});

test("missing authenticated user context is rejected with 401 and never reaches the service", async () => {
  const admin = spyOn(EmployeeService.prototype, "createAdminEmployee", () => ({}));
  const vendor = spyOn(EmployeeService.prototype, "createVendorEmployee", () => ({}));
  try {
    const res1 = mockRes();
    await controller.createAdminEmployee({ user: undefined, body: { ...VALID_BODY } } as any, res1);
    assert.equal(res1.statusCode, 401);

    const res2 = mockRes();
    await controller.createVendorEmployee({ user: undefined, body: { ...VALID_BODY } } as any, res2);
    assert.equal(res2.statusCode, 401);

    const res3 = mockRes();
    // A VENDOR session whose rawId is somehow absent must also be refused —
    // an empty/foreign createdById must never reach prisma.employee.create.
    await controller.createVendorEmployee(
      { user: { id: "VEN_1", rawId: undefined, role: "VENDOR", vendorId: "VEN_1" }, body: { ...VALID_BODY } } as any,
      res3
    );
    assert.equal(res3.statusCode, 401);

    assert.equal(admin.callCount(), 0);
    assert.equal(vendor.callCount(), 0);
  } finally {
    admin.restore();
    vendor.restore();
  }
});

test("service maps createdById straight into prisma.employee.create data (no remapping)", async () => {
  // Static contract check mirroring employee.service.ts: both create paths
  // pass the controller-supplied User.id through untouched. Guarded by the
  // controller tests above; re-asserted here so a future signature change
  // (e.g. swapping the argument order) fails loudly.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync("src/services/employee.service.ts", "utf8")
  );
  const vendorMatch = src.match(
    /async createVendorEmployee\([^)]*\)\s*{[\s\S]*?createdById: createdById/
  );
  const adminMatch = src.match(
    /async createAdminEmployee\([^)]*\)\s*{[\s\S]*?createdById: createdById/
  );
  assert.ok(adminMatch, "createAdminEmployee must pass createdById through to employee.create");
  assert.ok(vendorMatch, "createVendorEmployee must pass createdById through to employee.create");
});
