// tests/hrm-calendar.test.ts
//
// PHASE D3: HR Calendar aggregation. Events derive ONLY from existing data
// (birthdays/anniversaries/probation from profiles, leave, document expiry,
// holidays; payroll/loan installments gated behind hrSalaryView).
// Tenant isolation asserted on every source query. DB-free. Run with:
//   npx tsx --test tests/hrm-calendar.test.ts

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
const WINDOW = { from: "2026-10-01", to: "2026-10-31" };

function mockSources(overrides: Partial<Record<string, () => unknown>> = {}) {
  const spies = [
    spyOn(prisma.hrEmployeeProfile, "findMany",
      overrides.profiles ?? (() => [
        { id: "P1", fullName: "Oct Birthday", dob: "1990-10-15", joiningDate: "2020-10-20", probationMonths: 3, confirmationDate: null },
        { id: "P2", fullName: "No Events", dob: "1990-03-01", joiningDate: "2020-03-01", probationMonths: 3, confirmationDate: "2020-06-01" },
        { id: "P3", fullName: "Probation Ends", dob: null, joiningDate: "2026-08-01", probationMonths: 2, confirmationDate: null },
      ])),
    spyOn(prisma.hrLeaveRequest, "findMany",
      overrides.leave ?? (() => [
        { id: "L1", fromDate: "2026-10-05", toDate: "2026-10-06", status: "APPROVED", employeeId: "P1", employee: { fullName: "Oct Birthday" }, leaveType: { name: "Casual Leave" } },
      ])),
    spyOn(prisma.hrEmployeeDocument, "findMany",
      overrides.docs ?? (() => [
        { id: "DOC1", docType: "NID", expiryDate: "2026-10-14", employeeId: "P2", employee: { fullName: "No Events" } },
      ])),
    spyOn(prisma.hrHoliday, "findMany",
      overrides.holidays ?? (() => [{ id: "H1", date: "2026-10-25", name: "Victory Day" }])),
    spyOn(prisma.hrPayrollRun, "findMany", overrides.payroll ?? (() => [])),
    spyOn(prisma.hrLoanInstallment, "findMany", overrides.loans ?? (() => [])),
  ];
  return { spies, payrollSpy: spies[4], loanSpy: spies[5] };
}

test("calendar derives birthdays, anniversaries, probation end, leave, doc expiry and holidays", async () => {
  const { spies, payrollSpy } = mockSources();
  try {
    const result = await insightsService.calendar(SCOPE_A, { ...WINDOW, salaryView: false });

    const byType = (t: string) => result.items.filter((e) => e.type === t);
    // Birthday on 10-15 (P1 only — P2's March birthday is outside the window)
    assert.equal(byType("birthday").length, 1);
    assert.match(byType("birthday")[0].title, /Oct Birthday/);
    // Anniversary on 10-20
    assert.equal(byType("anniversary").length, 1);
    assert.match(byType("anniversary")[0].title, /Oct Birthday/);
    // Probation end: 2026-08-01 + 2 months = 2026-10-01 (in window)
    assert.equal(byType("probation").length, 1);
    assert.match(byType("probation")[0].title, /Probation Ends/);
    // Leave
    assert.equal(byType("leave").length, 1);
    assert.match(byType("leave")[0].title, /Casual Leave/);
    // Document expiry
    assert.equal(byType("doc-expiry").length, 1);
    assert.match(byType("doc-expiry")[0].title, /NID expiry/);
    // Holiday
    assert.equal(byType("holiday").length, 1);
    assert.match(byType("holiday")[0].title, /Victory Day/);
    // No payroll/loan events without hrSalaryView
    assert.equal(byType("payroll").length, 0);
    assert.equal(byType("loan").length, 0);
    assert.equal(payrollSpy.callCount(), 0);
    // Sorted by date
    const dates = result.items.map((e) => e.date);
    assert.deepEqual(dates, [...dates].sort());
  } finally { spies.forEach((m) => m.restore()); }
});

test("calendar includes payroll and loan events WITH hrSalaryView", async () => {
  const { spies, payrollSpy, loanSpy } = mockSources({
    payroll: () => [{ id: "R1", periodMonth: 10, periodYear: 2026, status: "APPROVED", paymentDate: "2026-10-28" }],
    loans: () => [{ id: "I1", dueDate: "2026-10-28", loan: { employeeId: "P1", employee: { fullName: "Oct Birthday" } } }],
  });
  try {
    const result = await insightsService.calendar(SCOPE_A, { ...WINDOW, salaryView: true });
    assert.equal(result.items.filter((e) => e.type === "payroll").length, 1);
    assert.equal(result.items.filter((e) => e.type === "loan").length, 1);
    assert.equal(payrollSpy.calls[0][0].where.vendorId, "VEN_A");
    assert.equal(loanSpy.calls[0][0].where.loan.vendorId, "VEN_A");
  } finally { spies.forEach((m) => m.restore()); }
});

test("calendar is tenant-isolated (VEN_B sees none of VEN_A's events)", async () => {
  // Faithful DB simulation: rows are stored under VEN_A; a VEN_B-scoped
  // profile query (linkedVendorId = VEN_B) finds nothing.
  const { spies } = mockSources({
    profiles: ({ where }: any) =>
      where?.linkedVendorId === "VEN_A"
        ? [{ id: "P1", fullName: "Oct Birthday", dob: "1990-10-15", joiningDate: "2020-10-20", probationMonths: 3, confirmationDate: null }]
        : [],
    leave: ({ where }: any) => (where?.vendorId === "VEN_A" ? [] : []),
    docs: ({ where }: any) => (where?.vendorId === "VEN_A" ? [] : []),
    holidays: ({ where }: any) => (where?.vendorId === "VEN_A" ? [] : []),
  });
  try {
    const result = await insightsService.calendar(SCOPE_B, { ...WINDOW, salaryView: false });
    assert.equal(result.items.length, 0);
  } finally { spies.forEach((m) => m.restore()); }
});

test("profile query is always vendor-scoped", async () => {
  const { spies } = mockSources();
  try {
    await insightsService.calendar(SCOPE_B, { ...WINDOW, salaryView: false });
    assert.equal(spies[0].calls[0][0].where.linkedVendorId, "VEN_B");
    assert.equal(spies[1].calls[0][0].where.vendorId, "VEN_B");
    assert.equal(spies[2].calls[0][0].where.vendorId, "VEN_B");
    assert.equal(spies[3].calls[0][0].where.vendorId, "VEN_B");
  } finally { spies.forEach((m) => m.restore()); }
});
