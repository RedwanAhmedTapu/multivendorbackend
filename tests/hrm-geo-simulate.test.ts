// tests/hrm-geo-simulate.test.ts
//
// Geo-fence simulator (management-side): tenant isolation (vendor-scoped
// employee + branch lookups, 404-cloak), hrEmployeeEdit gate, no attendance
// record written, inside/outside evaluation. DB-free spies. Run with:
//   npx tsx --test tests/hrm-geo-simulate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { attendanceService } from "../src/modules/hrm/services/attendance.service.ts";
import { requireHr } from "../src/middlewares/permission.middleware.ts";
import type { AuthRequest } from "../src/middlewares/auth.middleware.ts";

type Spy = { calls: any[][]; callCount(): number; restore(): void };
function spyOn(obj: any, method: string, impl?: (...args: any[]) => unknown): Spy {
  const calls: any[][] = [];
  const original = obj[method];
  obj[method] = async (...args: any[]) => { calls.push(args); return impl ? impl(...args) : undefined; };
  return { calls, callCount: () => calls.length, restore: () => { obj[method] = original; } };
}

const SCOPE_A = { vendorId: "VEN_A", actorUserId: "U_A", role: "VENDOR" };
const BRANCH = { latitude: 23.7925, longitude: 90.4078, name: "Head Office — Banani" };

function mockRes(): any {
  return {
    statusCode: 0,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
}
async function runGate(user: Partial<AuthRequest["user"]> | undefined, grant: Parameters<typeof requireHr>[0]) {
  let nextCalled = false;
  await requireHr(grant)({ user } as any, mockRes(), () => { nextCalled = true; });
  return nextCalled;
}

const BASE_INPUT = {
  employeeId: "P1", mode: "CHECK_IN" as const,
  latitude: 23.7925, longitude: 90.4078, accuracy: 25,
};

// ── Tenant isolation ─────────────────────────────────────────────────────

test("geo-simulate resolves the employee through a vendor-scoped lookup", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: null, departmentId: null,
  }));
  try {
    await attendanceService.geoSimulate(SCOPE_A, { ...BASE_INPUT, latitude: 23.7925 + 0.0005 });
    const where = profFind.calls[0][0].where;
    assert.equal(where.id, "P1");
    assert.equal(where.linkedVendorId, "VEN_A");
  } finally { profFind.restore(); }
});

test("geo-simulate 404-cloaks an employee of another vendor", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => null);
  try {
    await assert.rejects(
      () => attendanceService.geoSimulate(SCOPE_A, BASE_INPUT),
      /Employee profile not found/
    );
  } finally { profFind.restore(); }
});

test("geo-simulate loads the employee's branch tenant-scoped and 404-cloaks cross-vendor branches", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: "BR_X", departmentId: null,
  }));
  const branchFind = spyOn(prisma.hrBranch, "findFirst", async () => null);
  try {
    await assert.rejects(
      () => attendanceService.geoSimulate(SCOPE_A, BASE_INPUT),
      /Employee profile not found/
    );
    const where = branchFind.calls[0][0].where;
    assert.equal(where.id, "BR_X");
    assert.equal(where.vendorId, "VEN_A");
  } finally { [profFind, branchFind].forEach((m) => m.restore()); }
});

// ── Gate: hrEmployeeEdit ─────────────────────────────────────────────────

test("geo-simulate gate: ADMIN and VENDOR pass hrEmployeeEdit", async () => {
  assert.equal(
    await runGate({ id: "U1", rawId: "U1", role: "ADMIN", employeeId: null, vendorId: null, email: null, name: null }, "hrEmployeeEdit"),
    true
  );
  assert.equal(
    await runGate({ id: "V1", rawId: "V1", role: "VENDOR", employeeId: null, vendorId: "VEN_A", email: null, name: null }, "hrEmployeeEdit"),
    true
  );
});

test("geo-simulate gate: EMPLOYEE with the umbrella passes; without it is 403", async () => {
  const emp = { id: "EMP_ME", rawId: "U_ME", role: "EMPLOYEE", employeeId: "EMP_ME", vendorId: null, email: null, name: null };
  const find = spyOn(prisma.employee, "findUnique", () => ({ id: "E1", isActive: true, permissions: { hrManagement: true } }));
  try {
    assert.equal(await runGate(emp, "hrEmployeeEdit"), true);
  } finally { find.restore(); }

  const find2 = spyOn(prisma.employee, "findUnique", () => ({ id: "E1", isActive: true, permissions: {} }));
  const res = mockRes();
  try {
    await requireHr("hrEmployeeEdit")({ user: emp } as any, res, () => assert.fail("must not pass"));
    assert.equal(res.statusCode, 403);
  } finally { find2.restore(); }
});

// ── No attendance record is ever written ─────────────────────────────────

test("geo-simulate (inside) writes no attendance record", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: "BR1", departmentId: null,
  }));
  const branchFind = spyOn(prisma.hrBranch, "findFirst", async () => ({ id: "BR1" }));
  const branchUnique = spyOn(prisma.hrBranch, "findUnique", async () => BRANCH);
  const attCreate = spyOn(prisma.hrAttendance, "create");
  const attUpdate = spyOn(prisma.hrAttendance, "update");
  try {
    const r = await attendanceService.geoSimulate(SCOPE_A, { ...BASE_INPUT, latitude: 23.7925 + 0.0005 });
    assert.equal(r.allowed, true);
    assert.equal(attCreate.callCount(), 0);
    assert.equal(attUpdate.callCount(), 0);
  } finally { [profFind, branchFind, branchUnique, attCreate, attUpdate].forEach((m) => m.restore()); }
});

test("geo-simulate (outside) writes no attendance record", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: "BR1", departmentId: null,
  }));
  const branchFind = spyOn(prisma.hrBranch, "findFirst", async () => ({ id: "BR1" }));
  const branchUnique = spyOn(prisma.hrBranch, "findUnique", async () => BRANCH);
  const attCreate = spyOn(prisma.hrAttendance, "create");
  const attUpdate = spyOn(prisma.hrAttendance, "update");
  try {
    const r = await attendanceService.geoSimulate(SCOPE_A, { ...BASE_INPUT, latitude: 23.7925 + 0.09 });
    assert.equal(r.allowed, false);
    assert.equal(attCreate.callCount(), 0);
    assert.equal(attUpdate.callCount(), 0);
  } finally { [profFind, branchFind, branchUnique, attCreate, attUpdate].forEach((m) => m.restore()); }
});

// ── Inside / outside evaluation (same function as the real punch) ────────

test("geo-simulate inside the radius returns allowed with exact distance", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: "BR1", departmentId: null,
  }));
  const branchFind = spyOn(prisma.hrBranch, "findFirst", async () => ({ id: "BR1" }));
  const branchUnique = spyOn(prisma.hrBranch, "findUnique", async () => BRANCH);
  try {
    // ~55 m from the branch center (within the 200 m radius)
    const r = await attendanceService.geoSimulate(SCOPE_A, { ...BASE_INPUT, latitude: 23.7925 + 0.0005 });
    assert.deepEqual(Object.keys(r).sort(), ["allowed", "branchName", "distanceMeters", "message", "radiusMeters"]);
    assert.equal(r.allowed, true);
    assert.equal(r.radiusMeters, 200);
    assert.ok(r.distanceMeters != null && r.distanceMeters < 200);
    assert.equal(r.branchName, "Head Office — Banani");
    assert.match(r.message, /Inside radius/);
  } finally { [profFind, branchFind, branchUnique].forEach((m) => m.restore()); }
});

test("geo-simulate outside the radius returns allowed=false with exact distance", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: "BR1", departmentId: null,
  }));
  const branchFind = spyOn(prisma.hrBranch, "findFirst", async () => ({ id: "BR1" }));
  const branchUnique = spyOn(prisma.hrBranch, "findUnique", async () => BRANCH);
  try {
    // ~10 km from the branch center
    const r = await attendanceService.geoSimulate(SCOPE_A, { ...BASE_INPUT, latitude: 23.7925 + 0.09 });
    assert.equal(r.allowed, false);
    assert.equal(r.radiusMeters, 200);
    assert.ok(r.distanceMeters != null && r.distanceMeters > 200);
    assert.match(r.message, /Outside radius/);
    assert.match(r.message, /Head Office — Banani/);
  } finally { [profFind, branchFind, branchUnique].forEach((m) => m.restore()); }
});

test("geo-simulate without a configured fence reports allowed with no distance", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: null, departmentId: null,
  }));
  try {
    const r = await attendanceService.geoSimulate(SCOPE_A, BASE_INPUT);
    assert.equal(r.allowed, true);
    assert.equal(r.distanceMeters, null);
    assert.equal(r.radiusMeters, null);
    assert.equal(r.branchName, null);
    assert.match(r.message, /no geo-fence/i);
  } finally { profFind.restore(); }
});
