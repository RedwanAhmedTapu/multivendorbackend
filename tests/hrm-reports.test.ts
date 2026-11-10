// tests/hrm-reports.test.ts
//
// PHASE D2 regressions: HR reports (employees/attendance/leave/balances),
// analytics aggregates, and the ADMIN-only audit trail. Tenant scope is
// asserted on every query; the audit gate is asserted at the middleware
// level (ADMIN passes, VENDOR/EMPLOYEE get 403). DB-free. Run with:
//   npx tsx --test tests/hrm-reports.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { insightsService } from "../src/modules/hrm/services/insights.service.ts";
import { authorizeRoles } from "../src/middlewares/auth.middleware.ts";

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

test("employees report is tenant-scoped, applies status list and joining window", async () => {
  const findMany = spyOn(prisma.hrEmployeeProfile, "findMany", async () => []);
  const count = spyOn(prisma.hrEmployeeProfile, "count", () => 0);
  try {
    await insightsService.employeesReport(SCOPE_A, {
      view: "register",
      statuses: ["ACTIVE", "PROBATION"],
      joiningFrom: "2026-09-01",
      search: "rahim",
      page: 1, limit: 50,
    });
    const where = findMany.calls[0][0].where;
    assert.equal(where.linkedVendorId, "VEN_A");
    assert.deepEqual(where.status.in, ["ACTIVE", "PROBATION"]);
    assert.equal(where.joiningDate.gte, "2026-09-01");
    assert.ok(where.OR, "search filter present");
    // Cross-tenant scope differs (isolation contract).
    await insightsService.employeesReport(SCOPE_B, { page: 1, limit: 50 });
    assert.equal(findMany.calls[1][0].where.linkedVendorId, "VEN_B");
  } finally { [findMany, count].forEach((m) => m.restore()); }
});

test("biodata view never selects salary/bank/document data", async () => {
  const findMany = spyOn(prisma.hrEmployeeProfile, "findMany", async () => []);
  const count = spyOn(prisma.hrEmployeeProfile, "count", () => 0);
  try {
    await insightsService.employeesReport(SCOPE_A, { view: "biodata", page: 1, limit: 50 });
    const select = JSON.stringify(findMany.calls[0][0].select);
    assert.doesNotMatch(select, /salaryStructure|bankAccount|documents|payrollEntry/);
    assert.match(select, /bloodGroup/); // personal fields ARE included
  } finally { [findMany, count].forEach((m) => m.restore()); }
});

test("attendance report includes employee names and applies date/status filters", async () => {
  const findMany = spyOn(prisma.hrAttendance, "findMany", async () => []);
  const count = spyOn(prisma.hrAttendance, "count", () => 0);
  try {
    await insightsService.attendanceReport(SCOPE_A, {
      fromDate: "2026-09-01", toDate: "2026-09-30", status: "LATE", page: 1, limit: 50,
    });
    const args = findMany.calls[0][0];
    assert.equal(args.where.vendorId, "VEN_A");
    assert.equal(args.where.date.gte, "2026-09-01");
    assert.equal(args.where.status, "LATE");
    assert.equal(args.include.employee.select.fullName, true, "employee name resolved server-side");
  } finally { [findMany, count].forEach((m) => m.restore()); }
});

test("leave report resolves employee and leave type server-side", async () => {
  const findMany = spyOn(prisma.hrLeaveRequest, "findMany", async () => []);
  const count = spyOn(prisma.hrLeaveRequest, "count", () => 0);
  try {
    await insightsService.leaveReport(SCOPE_A, { status: "APPROVED", page: 1, limit: 50 });
    const args = findMany.calls[0][0];
    assert.equal(args.where.vendorId, "VEN_A");
    assert.equal(args.where.status, "APPROVED");
    assert.equal(args.include.leaveType.select.name, true);
  } finally { [findMany, count].forEach((m) => m.restore()); }
});

test("leave balances report is tenant-scoped through the employee relation", async () => {
  const findMany = spyOn(prisma.hrLeaveBalance, "findMany", async () => []);
  const count = spyOn(prisma.hrLeaveBalance, "count", () => 0);
  try {
    await insightsService.leaveBalancesReport(SCOPE_A, { year: 2026, page: 1, limit: 50 });
    assert.equal(findMany.calls[0][0].where.employee.linkedVendorId, "VEN_A");
    assert.equal(findMany.calls[0][0].where.year, 2026);
  } finally { [findMany, count].forEach((m) => m.restore()); }
});

test("department counts and attendance trend are tenant-scoped aggregates", async () => {
  const dCount = spyOn(prisma.hrEmployeeProfile, "groupBy", async () => []);
  const trend = spyOn(prisma.hrAttendance, "groupBy", async () => [
    { date: "2026-09-29", _count: { _all: 4 } },
  ]);
  try {
    await insightsService.departmentCounts(SCOPE_A);
    assert.equal(dCount.calls[0][0].where.linkedVendorId, "VEN_A");

    const result = await insightsService.attendanceTrend(SCOPE_A, 14);
    const where = trend.calls[0][0].where;
    assert.equal(where.vendorId, "VEN_A");
    assert.equal(where.status, "PRESENT");
    assert.match(where.date.gte, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(result.items[0].present, 4);
  } finally { [dCount, trend].forEach((m) => m.restore()); }
});

// ── Audit trail gate: ADMIN only, read-only ──────────────────────────────

test("audit trail: ADMIN passes, VENDOR and EMPLOYEE are refused", async () => {
  const gate = authorizeRoles("ADMIN");

  const adminRes = mockRes();
  let adminNext = false;
  await gate({ user: { id: "A1", rawId: "U_ADMIN", role: "ADMIN" } } as any, adminRes, () => { adminNext = true; });
  assert.equal(adminNext, true);

  const vendorRes = mockRes();
  let vendorNext = false;
  await gate({ user: { id: "V1", rawId: "U_VENDOR", role: "VENDOR" } } as any, vendorRes, () => { vendorNext = true; });
  assert.equal(vendorNext, false);
  assert.equal(vendorRes.statusCode, 403);

  const empRes = mockRes();
  let empNext = false;
  await gate({ user: { id: "E1", rawId: "U_EMP", role: "EMPLOYEE" } } as any, empRes, () => { empNext = true; });
  assert.equal(empNext, false);
  assert.equal(empRes.statusCode, 403);
});

test("audit list is read-only pagination with actor names resolved", async () => {
  const findMany = spyOn(prisma.auditLog, "findMany", async () => [
    { id: "A1", action: "ORDER_CONFIRMED", entity: "Order", entityId: "O1", user: { name: "Nazmul", email: "n@x" }, createdAt: new Date() },
  ]);
  const count = spyOn(prisma.auditLog, "count", () => 1);
  try {
    const result = await insightsService.auditList({ page: 1, limit: 50 });
    assert.equal(result.items[0].user.name, "Nazmul");
    assert.equal(findMany.calls[0][0].orderBy.createdAt, "desc");
  } finally { [findMany, count].forEach((m) => m.restore()); }
});

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  return res;
}
