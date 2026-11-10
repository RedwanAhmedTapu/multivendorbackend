// tests/hrm-attendance.security.test.ts
//
// Regression tests for the HR attendance runtime bug
// ("Argument `vendorId` must not be null" on hrAttendance compound-unique
// lookups) and the tenant boundaries around attendance.
//
// Root cause covered:
//   - Prisma REJECTS null in a compound-unique findUnique/upsert; platform
//     staff (vendorId null) crashed self-service check-in/out and admin
//     manual marking. All attendance lookups are now null-safe findFirst.
//   - Self-service must resolve the authenticated employee's HrEmployeeProfile
//     server-side (session Employee.id -> profile) and derive the tenant from
//     profile.linkedVendorId — never from the client, never from a fake id.
//
// DB-free (plain property spies on the Prisma delegates). Run with:
//   npx tsx --test tests/hrm-attendance.security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { attendanceService } from "../src/modules/hrm/services/attendance.service.ts";
import { attendanceController } from "../src/modules/hrm/controllers/attendance.controller.ts";
import { employeeProfileService } from "../src/modules/hrm/services/employeeProfile.service.ts";

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLATFORM_PROFILE = { id: "PROF_PLATFORM", linkedVendorId: null };
const VENDOR_PROFILE = { id: "PROF_VENDORA", linkedVendorId: "VEN_A" };

// ── 1. Platform employee (vendorId null) self-service succeeds ───────────

test("check-in for a PLATFORM employee resolves null vendor safely (no compound-unique crash)", async () => {
  const profileLookup = spyOn(prisma.hrEmployeeProfile, "findFirst", ({ where }: any) =>
    where?.linkedEmployeeId === "EMP_ME" && where?.linkedVendorId === null ? { ...PLATFORM_PROFILE } : null);
  const attFind = spyOn(prisma.hrAttendance, "findFirst", () => null);
  const attCreate = spyOn(prisma.hrAttendance, "create", ({ data }: any) => ({ id: "A1", ...data }));
  try {
    const record = await attendanceService.checkIn({ vendorId: null, actorUserId: "U_ME", role: "EMPLOYEE" }, "EMP_ME");
    assert.equal(record.employeeId, "PROF_PLATFORM"); // profile id, NOT the legacy Employee.id
    assert.equal(attFind.calls[0][0].where.vendorId, null);
    assert.match(attFind.calls[0][0].where.date, DATE_RE);
    assert.equal(attCreate.calls[0][0].data.vendorId, null);
    assert.equal(attCreate.calls[0][0].data.employeeId, "PROF_PLATFORM");
    assert.equal(attCreate.calls[0][0].data.source, "WEB");
  } finally {
    [profileLookup, attFind, attCreate].forEach((m) => m.restore());
  }
});

test("check-in for a VENDOR employee uses the profile's own vendorId", async () => {
  const profileLookup = spyOn(prisma.hrEmployeeProfile, "findFirst", ({ where }: any) =>
    where?.linkedEmployeeId === "EMP_ME" && where?.linkedVendorId === "VEN_A" ? { ...VENDOR_PROFILE } : null);
  const attFind = spyOn(prisma.hrAttendance, "findFirst", () => null);
  const attCreate = spyOn(prisma.hrAttendance, "create", ({ data }: any) => ({ id: "A2", ...data }));
  try {
    await attendanceService.checkIn({ vendorId: "VEN_A", actorUserId: "U_ME", role: "EMPLOYEE" }, "EMP_ME");
    assert.equal(attCreate.calls[0][0].data.vendorId, "VEN_A");
    assert.equal(attCreate.calls[0][0].data.employeeId, "PROF_VENDORA");
  } finally {
    [profileLookup, attFind, attCreate].forEach((m) => m.restore());
  }
});

// ── 2. Employee with no resolvable profile -> controlled 4xx ─────────────

test("check-in with no HR profile in scope returns a controlled 400, not a Prisma 500", async () => {
  const profileLookup = spyOn(prisma.hrEmployeeProfile, "findFirst", () => null);
  try {
    const res = mockRes();
    await attendanceController.checkIn(
      { hrScope: { vendorId: null, actorUserId: "U_ME", role: "EMPLOYEE" }, user: { employeeId: "EMP_ME" }, params: {}, body: {} } as any,
      res
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body?.message ?? "", /No employee record for this account/);
  } finally {
    profileLookup.restore();
  }
});

// ── 3. Cross-tenant self-service is impossible ───────────────────────────

test("an EMPLOYEE cannot check in under another vendor's tenant", async () => {
  // Faithful DB simulation: the vendor-A employee is stored with
  // linkedVendorId "VEN_A". A vendor-B session's lookup filters
  // linkedVendorId = "VEN_B", so the row is simply not found.
  const profileLookup = spyOn(prisma.hrEmployeeProfile, "findFirst", ({ where }: any) =>
    where?.linkedEmployeeId === "EMP_OF_VENDOR_A" && where?.linkedVendorId === "VEN_A"
      ? { id: "PROF_VENDORA", linkedVendorId: "VEN_A" }
      : null);
  const attCreate = spyOn(prisma.hrAttendance, "create", ({ data }: any) => ({ id: "X", ...data }));
  try {
    await assert.rejects(
      () => attendanceService.checkIn({ vendorId: "VEN_B", actorUserId: "U_B", role: "EMPLOYEE" }, "EMP_OF_VENDOR_A"),
      /No employee record for this account/
    );
    assert.equal(attCreate.callCount(), 0);
  } finally {
    [profileLookup, attCreate].forEach((m) => m.restore());
  }
});

// ── 4. Vendor cannot mark another vendor's employee ──────────────────────

test("vendor B cannot manually mark vendor A's employee attendance", async () => {
  const scoped = spyOn(employeeProfileService, "findScopedProfile", () => null); // other tenant -> not found
  const attCreate = spyOn(prisma.hrAttendance, "create", ({ data }: any) => ({ id: "X", ...data }));
  try {
    await assert.rejects(
      () => attendanceService.mark(
        { vendorId: "VEN_B", actorUserId: "U_B", role: "VENDOR" },
        { employeeId: "PROF_VENDORA", date: "2026-09-30", status: "PRESENT" } as any
      ),
      /Employee profile not found/
    );
    assert.equal(attCreate.callCount(), 0);
  } finally {
    [scoped, attCreate].forEach((m) => m.restore());
  }
});

test("vendor A marking its OWN employee derives the row vendorId from the profile", async () => {
  const scoped = spyOn(employeeProfileService, "findScopedProfile", () => ({ id: "PROF_VENDORA", linkedVendorId: "VEN_A" }));
  const attFind = spyOn(prisma.hrAttendance, "findFirst", () => null);
  const attCreate = spyOn(prisma.hrAttendance, "create", ({ data }: any) => ({ id: "A3", ...data }));
  try {
    await attendanceService.mark(
      { vendorId: "VEN_A", actorUserId: "U_A", role: "VENDOR" },
      { employeeId: "PROF_VENDORA", date: "2026-09-30", checkIn: "09:00", status: "PRESENT" } as any
    );
    assert.equal(attCreate.calls[0][0].data.vendorId, "VEN_A");
    assert.equal(attCreate.calls[0][0].data.employeeId, "PROF_VENDORA");
    assert.equal(attCreate.calls[0][0].data.source, "MANUAL");
  } finally {
    [scoped, attFind, attCreate].forEach((m) => m.restore());
  }
});

// ── 5. Admin (platform) manual marking still works ───────────────────────

test("ADMIN can mark a platform employee's attendance (null vendor preserved)", async () => {
  const scoped = spyOn(employeeProfileService, "findScopedProfile", () => ({ id: "PROF_PLATFORM", linkedVendorId: null }));
  const attFind = spyOn(prisma.hrAttendance, "findFirst", () => null);
  const attCreate = spyOn(prisma.hrAttendance, "create", ({ data }: any) => ({ id: "A4", ...data }));
  try {
    await attendanceService.mark(
      { vendorId: null, actorUserId: "U_ADMIN", role: "ADMIN" },
      { employeeId: "PROF_PLATFORM", date: "2026-09-30", status: "PRESENT" } as any
    );
    assert.equal(attCreate.calls[0][0].data.vendorId, null);
    assert.equal(attCreate.calls[0][0].data.employeeId, "PROF_PLATFORM");
  } finally {
    [scoped, attFind, attCreate].forEach((m) => m.restore());
  }
});

// ── 6. Check-out guards unchanged ────────────────────────────────────────

test("check-out without a check-in is rejected with the existing message", async () => {
  const profileLookup = spyOn(prisma.hrEmployeeProfile, "findFirst", ({ where }: any) =>
    where?.linkedEmployeeId === "EMP_ME" ? { ...PLATFORM_PROFILE } : null);
  const attFind = spyOn(prisma.hrAttendance, "findFirst", () => null); // no record today
  try {
    await assert.rejects(
      () => attendanceService.checkOut({ vendorId: null, actorUserId: "U_ME", role: "EMPLOYEE" }, "EMP_ME"),
      /You haven't checked in today/
    );
  } finally {
    [profileLookup, attFind].forEach((m) => m.restore());
  }
});
