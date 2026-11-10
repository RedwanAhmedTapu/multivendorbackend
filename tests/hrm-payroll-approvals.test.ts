// tests/hrm-payroll-approvals.test.ts
//
// PHASE D1 regressions:
//   - Payroll routes ride the SENSITIVE gates (hrSalaryView read /
//     hrSalaryEdit actions) — source-contract test so the gating cannot
//     silently regress.
//   - Payroll list/detail are tenant-scoped.
//   - Leave separation of duties: an actor can never approve their own
//     leave request (actor profile resolved server-side).
//
// DB-free. Run with:
//   npx tsx --test tests/hrm-payroll-approvals.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prisma } from "../src/config/prisma.ts";
import { leaveService } from "../src/modules/hrm/services/leave.service.ts";
import { payrollService } from "../src/modules/hrm/services/payroll.service.ts";

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

// ── Payroll route gating (source contract) ───────────────────────────────

test("payroll routes are gated by hrSalaryView (reads) and hrSalaryEdit (actions)", () => {
  const src = readFileSync("src/modules/hrm/routes/payroll.routes.ts", "utf8");
  assert.match(src, /requireHr\("hrSalaryView"\)/, "reads must require hrSalaryView");
  assert.match(src, /requireHr\("hrSalaryEdit"\)/, "actions must require hrSalaryEdit");
  // The old umbrella-only gate must be gone from this router.
  assert.doesNotMatch(src, /requirePermission\("hrManagement"\)/, "umbrella-only gate must not remain on payroll");
});

// ── Payroll tenant scoping ────────────────────────────────────────────────

test("payroll runs list is scoped to the caller's vendor", async () => {
  const spy = spyOn(prisma.hrPayrollRun, "findMany", async () => []);
  try {
    await payrollService.list(SCOPE_A);
    assert.equal(spy.calls[0][0].where.vendorId, "VEN_A");
  } finally { spy.restore(); }
});

test("payroll run detail 404-cloaks cross-vendor runs", async () => {
  const spy = spyOn(prisma.hrPayrollRun, "findFirst", async () => null);
  try {
    await assert.rejects(
      () => payrollService.getById(SCOPE_A, "RUN_1"),
      /Payroll run not found/
    );
    assert.equal(spy.calls[0][0].where.vendorId, "VEN_A");
  } finally { spy.restore(); }
});

// ── Leave separation of duties ────────────────────────────────────────────

test("an employee can NEVER approve their own leave request (server-side SoD)", async () => {
  const reqFind = spyOn(prisma.hrLeaveRequest, "findFirst", async () => ({
    id: "LR1", employeeId: "PROF_ME", leaveTypeId: "LT1", status: "PENDING",
    fromDate: "2026-10-01", toDate: "2026-10-02", vendorId: "VEN_A",
  }));
  // Actor's HR profile resolves to the SAME profile as the request.
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({ id: "PROF_ME" }));
  const tx = spyOn(prisma, "$transaction", async () => { throw new Error("must not reach the transaction"); });
  try {
    await assert.rejects(
      () => leaveService.actOn(
        SCOPE_A, "LR1", { status: "APPROVED" } as any, "U_A", "EMP_ME"
      ),
      /cannot approve or reject your own leave request/
    );
    assert.equal(tx.callCount(), 0);
  } finally { [reqFind, profFind, tx].forEach((m) => m.restore()); }
});

test("a DIFFERENT actor can approve the leave request (SoD only blocks self)", async () => {
  const reqFind = spyOn(prisma.hrLeaveRequest, "findFirst", async () => ({
    id: "LR1", employeeId: "PROF_OTHER", leaveTypeId: "LT1", status: "PENDING",
    fromDate: "2026-10-01", toDate: "2026-10-02", vendorId: "VEN_A",
  }));
  // Actor profile differs from the requester → allowed.
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({ id: "PROF_ACTOR" }));
  const tx = spyOn(prisma, "$transaction", (async (fn: (tx: any) => Promise<unknown>) =>
    fn({
      hrLeaveRequest: { update: async ({ data }: any) => ({ id: "LR1", ...data }) },
      hrLeaveBalance: { upsert: async () => ({}) },
      hrEmployeeHistory: { create: async () => ({}) },
    })) as any);
  try {
    const result = await leaveService.actOn(
      SCOPE_A, "LR1", { status: "APPROVED" } as any, "U_OTHER", "EMP_OTHER"
    );
    assert.equal(result.status, "APPROVED");
  } finally { [reqFind, profFind, tx].forEach((m) => m.restore()); }
});

test("actors with no linked profile are not blocked by the SoD check (owners/admins)", async () => {
  const reqFind = spyOn(prisma.hrLeaveRequest, "findFirst", async () => ({
    id: "LR2", employeeId: "PROF_X", leaveTypeId: "LT1", status: "PENDING",
    fromDate: "2026-10-01", toDate: "2026-10-02", vendorId: null,
  }));
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => null);
  const tx = spyOn(prisma, "$transaction", (async (fn: (tx: any) => Promise<unknown>) =>
    fn({
      hrLeaveRequest: { update: async ({ data }: any) => ({ id: "LR2", ...data }) },
      hrLeaveBalance: { upsert: async () => ({}) },
      hrEmployeeHistory: { create: async () => ({}) },
    })) as any);
  try {
    const result = await leaveService.actOn(
      SCOPE_PLATFORM, "LR2", { status: "REJECTED" } as any, "U_ADMIN", null
    );
    assert.equal(result.status, "REJECTED");
  } finally { [reqFind, profFind, tx].forEach((m) => m.restore()); }
});

const SCOPE_PLATFORM = { vendorId: null, actorUserId: "U_ADMIN", role: "ADMIN" };
