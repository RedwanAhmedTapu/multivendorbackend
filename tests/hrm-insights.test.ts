// tests/hrm-insights.test.ts
//
// PHASE C2 aggregate endpoints: tenant-scoped grouped counts, new-joiner
// cutoff, lifecycle register with SALARY MASKING, reporting rollup, and
// shift assignment reads. DB-free (plain property spies on Prisma
// delegates). Run with:
//   npx tsx --test tests/hrm-insights.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { insightsService } from "../src/modules/hrm/services/insights.service.ts";

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
const SCOPE_PLATFORM = { vendorId: null, actorUserId: "U_ADMIN", role: "ADMIN" };

// ── Branch / designation counts: tenant-scoped groupBy ───────────────────

test("branchCounts groups by branchId inside the caller's tenant only", async () => {
  const spy = spyOn(prisma.hrEmployeeProfile, "groupBy", async () => [
    { branchId: "BR1", _count: { _all: 5 } },
    { branchId: null, _count: { _all: 2 } },
  ]);
  try {
    const result = await insightsService.branchCounts(SCOPE_A);
    const where = spy.calls[0][0].where;
    assert.equal(where.linkedVendorId, "VEN_A"); // tenant scope present
    const resultB = await insightsService.branchCounts(SCOPE_B);
    assert.equal(spy.calls[1][0].where.linkedVendorId, "VEN_B"); // isolation
    assert.equal(result.items[0].count, 5);
    assert.equal(result.items[1].count, 2);
    void resultB;
  } finally { spy.restore(); }
});

test("designationCounts uses the same tenant scope", async () => {
  const spy = spyOn(prisma.hrEmployeeProfile, "groupBy", async () => [
    { designationId: "D1", _count: { _all: 3 } },
  ]);
  try {
    const result = await insightsService.designationCounts(SCOPE_PLATFORM);
    assert.equal(spy.calls[0][0].where.linkedVendorId, null);
    assert.equal(result.items[0].count, 3);
  } finally { spy.restore(); }
});

// ── New joiners (30d) ─────────────────────────────────────────────────────

test("newJoiners counts profiles with a joining date inside the cutoff window", async () => {
  const spy = spyOn(prisma.hrEmployeeProfile, "count", () => 7);
  try {
    const result = await insightsService.newJoiners(SCOPE_A, 30);
    const where = spy.calls[0][0].where;
    assert.equal(where.linkedVendorId, "VEN_A");
    assert.match(where.joiningDate.gte, /^\d{4}-\d{2}-\d{2}$/);
    // cutoff ≈ today-30d (allow 1-day tolerance for midnight timing)
    const cutoff = new Date(where.joiningDate.gte + "T00:00:00Z").getTime();
    const expected = Date.now() - 30 * 86400000;
    assert.ok(Math.abs(cutoff - expected) < 2 * 86400000, "cutoff must be ~30 days back");
    assert.equal(result.count, 7);
    assert.equal(result.days, 30);
  } finally { spy.restore(); }
});

// ── Lifecycle register: tenant scope, search, SALARY MASKING ─────────────

function salaryRow() {
  return {
    id: "SR1",
    effectiveDate: "2026-01-01",
    reason: "annual",
    status: "PENDING",
    createdAt: new Date(),
    previousSalary: 50000,
    newSalary: 65000,
    employee: { id: "P1", code: "EMP-0001", fullName: "Rahim", department: { name: "Sales" }, designation: { name: "SE" } },
  };
}

test("lifecycle register masks salary amounts WITHOUT hrSalaryView", async () => {
  const findMany = spyOn(prisma.hrSalaryRevision, "findMany", async () => [salaryRow()]);
  const count = spyOn(prisma.hrSalaryRevision, "count", () => 1);
  try {
    const result = await insightsService.lifecycle(
      SCOPE_A, "salary-revisions",
      { salaryView: false, search: "rahim", page: 1, limit: 20 }
    );
    // Tenant + relational search filter present in the where clause.
    const where = findMany.calls[0][0].where;
    assert.equal(where.vendorId, "VEN_A");
    assert.ok(where.employee.OR, "search must filter via the employee relation");
    // Amounts stripped, confidential flag set.
    assert.equal(result.items[0].amountConfidential, true);
    assert.equal("newSalary" in result.items[0], false);
    assert.equal("previousSalary" in result.items[0], false);
  } finally { [findMany, count].forEach((m) => m.restore()); }
});

test("lifecycle register returns salary amounts WITH hrSalaryView", async () => {
  const findMany = spyOn(prisma.hrSalaryRevision, "findMany", async () => [salaryRow()]);
  const count = spyOn(prisma.hrSalaryRevision, "count", () => 1);
  try {
    const result = await insightsService.lifecycle(
      SCOPE_A, "salary-revisions", { salaryView: true, page: 1, limit: 20 }
    );
    assert.equal(result.items[0].previousSalary, 50000);
    assert.equal(result.items[0].newSalary, 65000);
    assert.equal(result.items[0].employee.code, "EMP-0001");
  } finally { [findMany, count].forEach((m) => m.restore()); }
});

test("lifecycle register is per-kind with native pagination", async () => {
  const findMany = spyOn(prisma.hrPromotion, "findMany", async () => []);
  const count = spyOn(prisma.hrPromotion, "count", () => 0);
  try {
    const result = await insightsService.lifecycle(
      SCOPE_A, "promotions", { salaryView: false, page: 2, limit: 10 }
    );
    const args = findMany.calls[0][0];
    assert.equal(args.skip, 10);
    assert.equal(args.take, 10);
    assert.equal(result.totalPages, 0);
  } finally { [findMany, count].forEach((m) => m.restore()); }
});

// ── Reporting structure rollup ────────────────────────────────────────────

test("reportingStructure rolls up managers and counts the unassigned", async () => {
  const groupBy = spyOn(prisma.hrEmployeeProfile, "groupBy", async () => [
    { reportingManagerId: "M1", _count: { _all: 4 } },
    { reportingManagerId: null, _count: { _all: 3 } },
  ]);
  const findMany = spyOn(prisma.hrEmployeeProfile, "findMany", async () => [
    { id: "M1", code: "EMP-0001", fullName: "Nazmul" },
  ]);
  const unassigned = spyOn(prisma.hrEmployeeProfile, "count", () => 3);
  try {
    const result = await insightsService.reportingStructure(SCOPE_A);
    assert.equal(result.managers.length, 1);
    assert.equal(result.managers[0].managerName, "Nazmul");
    assert.equal(result.managers[0].reportCount, 4);
    assert.equal(result.unassigned, 3);
    assert.equal(unassigned.calls[0][0].where.reportingManagerId, null);
  } finally { [groupBy, findMany, unassigned].forEach((m) => m.restore()); }
});

// ── Shifts & current assignments ──────────────────────────────────────────

test("shiftsOverview counts only CURRENT assignments (toDate null or future)", async () => {
  const shiftFind = spyOn(prisma.hrShift, "findMany", async () => [
    { id: "S1", name: "General", type: "FIXED", startTime: "09:00", endTime: "18:00", weeklyOff: "FRIDAY", active: true, createdAt: new Date() },
  ]);
  const groupBy = spyOn(prisma.hrShiftAssignment, "groupBy", async () => [
    { shiftId: "S1", _count: { _all: 6 } },
  ]);
  try {
    const result = await insightsService.shiftsOverview(SCOPE_A);
    const where = groupBy.calls[0][0].where;
    assert.equal(where.vendorId, "VEN_A");
    assert.ok(where.OR, "current-assignment filter must be present");
    assert.equal(result.items[0].currentAssignments, 6);
    assert.equal(shiftFind.calls[0][0].where.vendorId, "VEN_A");
  } finally { [shiftFind, groupBy].forEach((m) => m.restore()); }
});

test("shiftAssignments lists current rows with employee + shift includes", async () => {
  const findMany = spyOn(prisma.hrShiftAssignment, "findMany", async () => [
    { id: "SA1", shift: { id: "S1", name: "General" }, employee: { id: "P1", code: "EMP-0001", fullName: "Rahim" }, fromDate: "2026-01-01", toDate: null },
  ]);
  const count = spyOn(prisma.hrShiftAssignment, "count", () => 1);
  try {
    const result = await insightsService.shiftAssignments(SCOPE_A, 1, 50);
    const where = findMany.calls[0][0].where;
    assert.equal(where.vendorId, "VEN_A");
    assert.ok(where.OR);
    assert.equal(result.items[0].employee.fullName, "Rahim");
    assert.equal(result.items[0].shift.name, "General");
  } finally { [findMany, count].forEach((m) => m.restore()); }
});
