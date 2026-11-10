// tests/hrm-attendance-at1.test.ts
//
// PHASE AT1: shift CRUD (tenant scope, delete guard), shift-aware late/OT
// computation (server-side), geo-fence validation, bulk mark, corrections
// (self-approval block). DB-free spies. Run with:
//   npx tsx --test tests/hrm-attendance-at1.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { shiftService } from "../src/modules/hrm/services/shift.service.ts";
import { attendanceService } from "../src/modules/hrm/services/attendance.service.ts";
import { attendanceCorrectionService } from "../src/modules/hrm/services/attendance-correction.service.ts";
import { employeeProfileService } from "../src/modules/hrm/services/employeeProfile.service.ts";

type Spy = { calls: any[][]; callCount(): number; restore(): void };
function spyOn(obj: any, method: string, impl?: (...args: any[]) => unknown): Spy {
  const calls: any[][] = [];
  const original = obj[method];
  obj[method] = async (...args: any[]) => { calls.push(args); return impl ? impl(...args) : undefined; };
  return { calls, callCount: () => calls.length, restore: () => { obj[method] = original; } };
}

const SCOPE_A = { vendorId: "VEN_A", actorUserId: "U_A", role: "VENDOR" };
const SCOPE_B = { vendorId: "VEN_B", actorUserId: "U_B", role: "VENDOR" };

// ── Shift CRUD: tenant scope + delete guard ──────────────────────────────

test("shift list is vendor-scoped", async () => {
  const find = spyOn(prisma.hrShift, "findMany", async () => []);
  const grp = spyOn(prisma.hrShiftAssignment, "groupBy", async () => []);
  try {
    await shiftService.list(SCOPE_A);
    assert.equal(find.calls[0][0].where.vendorId, "VEN_A");
  } finally { [find, grp].forEach((m) => m.restore()); }
});

test("shift create is tenant-scoped", async () => {
  const find = spyOn(prisma.hrShift, "findFirst", async () => null);
  const create = spyOn(prisma.hrShift, "create", ({ data }: any) => ({ id: "S1", ...data }));
  try {
    await shiftService.create(SCOPE_A, { name: "Test", startTime: "09:00", endTime: "18:00" });
    assert.equal(create.calls[0][0].data.vendorId, "VEN_A");
  } finally { [find, create].forEach((m) => m.restore()); }
});

test("shift delete deactivates when assignments exist", async () => {
  const find = spyOn(prisma.hrShift, "findFirst", async () => ({ id: "S1", active: true }));
  const count = spyOn(prisma.hrShiftAssignment, "count", () => 2);
  const update = spyOn(prisma.hrShift, "update", ({ data }: any) => ({ id: "S1", ...data }));
  const del = spyOn(prisma.hrShift, "delete", () => ({}));
  try {
    const r = await shiftService.remove(SCOPE_A, "S1");
    assert.equal(r.deleted, false);
    assert.equal(r.deactivated, true);
    assert.equal(del.callCount(), 0);
  } finally { [find, count, update, del].forEach((m) => m.restore()); }
});

test("shift delete hard-deletes when no assignments exist", async () => {
  const find = spyOn(prisma.hrShift, "findFirst", async () => ({ id: "S1", active: true }));
  const count = spyOn(prisma.hrShiftAssignment, "count", () => 0);
  const del = spyOn(prisma.hrShift, "delete", () => ({}));
  try {
    const r = await shiftService.remove(SCOPE_A, "S1");
    assert.equal(r.deleted, true);
    assert.equal(del.callCount(), 1);
  } finally { [find, count, del].forEach((m) => m.restore()); }
});

test("shift delete is tenant-scoped (VEN_B cannot delete VEN_A's shift)", async () => {
  const find = spyOn(prisma.hrShift, "findFirst", async () => null);
  try {
    await assert.rejects(() => shiftService.remove(SCOPE_B, "S1"), /Shift not found/);
  } finally { find.restore(); }
});

// ── Shift-aware late/OT computation (server-side) ─────────────────────────

test("mark computes LATE server-side from shift grace period", async () => {
  const profileFind = spyOn(employeeProfileService, "findScopedProfile", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: null, departmentId: null,
  }));
  const shiftAssign = spyOn(prisma.hrShiftAssignment, "findFirst", async () => ({
    shift: { startTime: "09:00", endTime: "18:00", graceMinutes: 10, otThresholdMinutes: 30 },
  }));
  const attFind = spyOn(prisma.hrAttendance, "findFirst", async () => null);
  const attCreate = spyOn(prisma.hrAttendance, "create", ({ data }: any) => ({ id: "A1", ...data }));
  try {
    // Check-in at 09:30 → 20 min late (grace 10 min)
    const r = await attendanceService.mark(SCOPE_A, {
      employeeId: "P1", date: "2026-10-01", checkIn: "09:30", checkOut: "18:00",
    });
    assert.equal(r.lateMinutes, 20);
    assert.equal(r.status, "LATE");
    assert.equal(r.overtimeMinutes, 0);
  } finally { [profileFind, shiftAssign, attFind, attCreate].forEach((m) => m.restore()); }
});

test("mark computes OT server-side beyond shift end + threshold", async () => {
  const profileFind = spyOn(employeeProfileService, "findScopedProfile", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: null, departmentId: null,
  }));
  const shiftAssign = spyOn(prisma.hrShiftAssignment, "findFirst", async () => ({
    shift: { startTime: "09:00", endTime: "18:00", graceMinutes: 10, otThresholdMinutes: 30 },
  }));
  const attFind = spyOn(prisma.hrAttendance, "findFirst", async () => ({ id: "A1", checkIn: "09:00", date: "2026-10-01", status: "PRESENT" }));
  const attUpdate = spyOn(prisma.hrAttendance, "update", ({ data }: any) => ({ id: "A1", ...data }));
  try {
    // Check-out at 19:00 → 60 min after shift end, threshold 30 → 60 min OT
    await attendanceService.mark(SCOPE_A, {
      employeeId: "P1", date: "2026-10-01", checkIn: "09:00", checkOut: "19:00",
    });
    assert.equal(attUpdate.calls[0][0].data.overtimeMinutes, 60);
  } finally { [profileFind, shiftAssign, attFind, attUpdate].forEach((m) => m.restore()); }
});

test("mark with status override does not compute LATE (explicit override wins)", async () => {
  const profileFind = spyOn(employeeProfileService, "findScopedProfile", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: null, departmentId: null,
  }));
  const shiftAssign = spyOn(prisma.hrShiftAssignment, "findFirst", async () => ({
    shift: { startTime: "09:00", endTime: "18:00", graceMinutes: 10, otThresholdMinutes: 30 },
  }));
  const attFind = spyOn(prisma.hrAttendance, "findFirst", async () => null);
  const attCreate = spyOn(prisma.hrAttendance, "create", ({ data }: any) => ({ id: "A1", ...data }));
  try {
    // Late check-in but status overridden to PRESENT
    const r = await attendanceService.mark(SCOPE_A, {
      employeeId: "P1", date: "2026-10-01", checkIn: "10:30", checkOut: "18:00", status: "PRESENT",
    });
    assert.equal(r.status, "PRESENT");
  } finally { [profileFind, shiftAssign, attFind, attCreate].forEach((m) => m.restore()); }
});

test("mark rejects check-out before check-in", async () => {
  const profileFind = spyOn(employeeProfileService, "findScopedProfile", async () => ({
    id: "P1", linkedVendorId: "VEN_A", designationId: "D1", branchId: null, departmentId: null,
  }));
  const shiftAssign = spyOn(prisma.hrShiftAssignment, "findFirst", async () => null);
  try {
    await assert.rejects(
      () => attendanceService.mark(SCOPE_A, {
        employeeId: "P1", date: "2026-10-01", checkIn: "18:00", checkOut: "09:00",
      }),
      /Check-out time must be after check-in/
    );
  } finally { [profileFind, shiftAssign].forEach((m) => m.restore()); }
});

// ── Geo-fence validation ─────────────────────────────────────────────────

test("self-service check-in rejects when outside the branch geo-fence", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", linkedVendorId: "VEN_A", branchId: "BR1",
  }));
  const branchFind = spyOn(prisma.hrBranch, "findUnique", async () => ({
    latitude: 23.7925, longitude: 90.4078, name: "Head Office — Banani",
  }));
  try {
    // 10 km away from the branch center
    await assert.rejects(
      () => attendanceService.checkIn(SCOPE_A, "EMP_ME", { lat: 23.7925 + 0.09, lng: 90.4078 }),
      /Geo-fence check-in rejected/
    );
  } finally { [profFind, branchFind].forEach((m) => m.restore()); }
});

test("self-service check-in succeeds when inside the branch geo-fence", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", linkedVendorId: "VEN_A", branchId: "BR1",
  }));
  const branchFind = spyOn(prisma.hrBranch, "findUnique", async () => ({
    latitude: 23.7925, longitude: 90.4078, name: "Head Office — Banani",
  }));
  const shiftAssign = spyOn(prisma.hrShiftAssignment, "findFirst", async () => null);
  const attFind = spyOn(prisma.hrAttendance, "findFirst", async () => null);
  const attCreate = spyOn(prisma.hrAttendance, "create", ({ data }: any) => ({ id: "A1", ...data }));
  try {
    // ~50 m from the branch center (within 200 m radius)
    const r = await attendanceService.checkIn(SCOPE_A, "EMP_ME", { lat: 23.7925 + 0.0005, lng: 90.4078 });
    assert.ok(r.checkIn);
  } finally { [profFind, branchFind, shiftAssign, attFind, attCreate].forEach((m) => m.restore()); }
});

test("self-service check-in skips geo-fence when branch has no coordinates", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({
    id: "P1", linkedVendorId: "VEN_A", branchId: "BR1",
  }));
  const branchFind = spyOn(prisma.hrBranch, "findUnique", async () => ({
    latitude: null, longitude: null, name: "No GPS Branch",
  }));
  const shiftAssign = spyOn(prisma.hrShiftAssignment, "findFirst", async () => null);
  const attFind = spyOn(prisma.hrAttendance, "findFirst", async () => null);
  const attCreate = spyOn(prisma.hrAttendance, "create", ({ data }: any) => ({ id: "A1", ...data }));
  try {
    const r = await attendanceService.checkIn(SCOPE_A, "EMP_ME");
    assert.ok(r.checkIn); // no geo rejection
  } finally { [profFind, branchFind, shiftAssign, attFind, attCreate].forEach((m) => m.restore()); }
});

// ── Corrections ──────────────────────────────────────────────────────────

test("correction request is created as PENDING", async () => {
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({ id: "P1" }));
  const create = spyOn(prisma.hrAttendanceCorrection, "create", ({ data }: any) => ({ id: "C1", ...data }));
  try {
    const r = await attendanceCorrectionService.request(
      SCOPE_A,
      { employeeId: "P1", date: "2026-10-01", requestedIn: "09:15", reason: "Traffic" },
      "U_A"
    );
    assert.equal(r.status, "PENDING");
  } finally { [create, profFind].forEach((m) => m.restore()); }
});

test("correction: self-approval blocked", async () => {
  const find = spyOn(prisma.hrAttendanceCorrection, "findFirst", async () => ({
    id: "C1", employeeId: "P1", status: "PENDING", vendorId: "VEN_A",
    date: "2026-10-01", requestedIn: "09:00", requestedOut: null,
  }));
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({ id: "P1" }));
  try {
    await assert.rejects(
      () => attendanceCorrectionService.act(SCOPE_A, "C1", "APPROVED", "U_A", "EMP_ME"),
      /cannot approve or reject your own correction/
    );
  } finally { [find, profFind].forEach((m) => m.restore()); }
});

test("correction approval applies corrected times to the attendance record", async () => {
  const find = spyOn(prisma.hrAttendanceCorrection, "findFirst", async () => ({
    id: "C1", employeeId: "P1", status: "PENDING", vendorId: "VEN_A",
    date: "2026-10-01", requestedIn: "09:00", requestedOut: "17:30",
  }));
  const profFind = spyOn(prisma.hrEmployeeProfile, "findFirst", async () => ({ id: "P_ACTOR" }));
  const corrUpdate = spyOn(prisma.hrAttendanceCorrection, "update", ({ data }: any) => ({ id: "C1", ...data }));
  const attFind = spyOn(prisma.hrAttendance, "findFirst", async () => ({ id: "A1", checkIn: "10:00" }));
  const attUpdate = spyOn(prisma.hrAttendance, "update", ({ data }: any) => ({ id: "A1", ...data }));
  const tx = spyOn(prismaDirect, "$transaction", (fn: (tx: any) => Promise<unknown>) =>
    fn({
      hrAttendanceCorrection: prisma.hrAttendanceCorrection,
      hrAttendance: prisma.hrAttendance,
    }));
  try {
    const r = await attendanceCorrectionService.act(SCOPE_A, "C1", "APPROVED", "U_A", "EMP_OTHER");
    assert.equal(r.status, "APPROVED");
    // The corrected check-in was applied to the attendance record.
    const attData = attUpdate.calls[0][0].data;
    assert.equal(attData.checkIn, "09:00");
    assert.equal(attData.checkOut, "17:30");
  } finally { [find, profFind, corrUpdate, attFind, attUpdate, tx].forEach((m) => m.restore()); }
});

// prismaDirect import needed for the tx spy
import { prismaDirect } from "../src/config/prisma.ts";
