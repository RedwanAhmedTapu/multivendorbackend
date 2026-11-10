// src/modules/hrm/services/attendance.service.ts
//
// PHASE AT1: shift-aware late/OT computation (server-side, never trusted
// from the client), geo-fence validation, bulk mark present. The compound
// unique (vendorId, employeeId, date) with nullable vendorId means every
// lookup uses null-safe findFirst + update/create.
import { prisma, prismaDirect } from "../../../config/prisma.ts";
import { employeeProfileService } from "./employeeProfile.service.ts";
import type { HrScope } from "../types/hrm.types.ts";
import type { MarkAttendanceInput, AttendanceFilters } from "../types/hrm.types.ts";

const todayIso = () => new Date().toISOString().slice(0, 10);
const nowHm = () => new Date().toISOString().slice(11, 16);

function computeWorkingMinutes(checkIn?: string | null, checkOut?: string | null) {
  if (!checkIn || !checkOut) return 0;
  const [ih, im] = checkIn.split(":").map(Number);
  const [oh, om] = checkOut.split(":").map(Number);
  return Math.max(0, oh * 60 + om - (ih * 60 + im));
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** Resolve the authenticated employee's HR profile and tenant (session-derived). */
async function resolveSelfProfile(scope: HrScope, myEmployeeId: string) {
  const profile = await prisma.hrEmployeeProfile.findFirst({
    where: { linkedEmployeeId: myEmployeeId, linkedVendorId: scope.vendorId },
    select: { id: true, linkedVendorId: true, branchId: true },
  });
  if (!profile) throw new Error("No employee record for this account");
  return { profileId: profile.id, vendorId: profile.linkedVendorId ?? null, branchId: profile.branchId ?? null };
}

/** Resolve the employee's CURRENT shift (latest assignment, toDate null or future). */
async function resolveCurrentShift(vendorId: string | null, employeeProfileId: string) {
  const t = todayIso();
  const assignment = await prisma.hrShiftAssignment.findFirst({
    where: {
      employeeId: employeeProfileId,
      vendorId,
      fromDate: { lte: t },
      OR: [{ toDate: null }, { toDate: { gte: t } }],
    },
    include: { shift: true },
    orderBy: { fromDate: "desc" },
  });
  return assignment?.shift ?? null;
}

/**
 * Compute late and OT minutes SERVER-SIDE from the shift rules.
 * Never trusts client-supplied late/OT values.
 */
function computeLateAndOvertime(
  checkIn: string | null | undefined,
  checkOut: string | null | undefined,
  shift: { startTime: string; endTime: string; graceMinutes: number; otThresholdMinutes: number } | null
): { lateMinutes: number; overtimeMinutes: number; status: string } {
  if (!checkIn) return { lateMinutes: 0, overtimeMinutes: 0, status: "ABSENT" };
  if (!shift) return { lateMinutes: 0, overtimeMinutes: 0, status: "PRESENT" };

  const checkInMin = toMinutes(checkIn);
  const shiftStart = toMinutes(shift.startTime);
  const shiftEnd = toMinutes(shift.endTime);

  let lateMinutes = 0;
  let overtimeMinutes = 0;
  let status = "PRESENT";

  // Late: check-in beyond shift start + grace.
  if (checkInMin > shiftStart + shift.graceMinutes) {
    lateMinutes = checkInMin - shiftStart - shift.graceMinutes;
    status = "LATE";
  }

  // OT: check-out beyond shift end + OT threshold.
  if (checkOut) {
    const checkOutMin = toMinutes(checkOut);
    if (checkOutMin > shiftEnd + shift.otThresholdMinutes) {
      overtimeMinutes = checkOutMin - shiftEnd;
    }
  }

  return { lateMinutes, overtimeMinutes, status };
}

/** Shared geo-fence evaluation — used by the real punch AND the simulator. */
interface GeoFenceEvaluation {
  evaluated: boolean; // false = no fence to enforce (no branch / no coordinates / no GPS)
  allowed: boolean;
  distanceMeters: number | null;
  radiusMeters: number | null;
  branchName: string | null;
}

async function evaluateGeoFence(
  branchId: string | null,
  lat: number | undefined,
  lng: number | undefined
): Promise<GeoFenceEvaluation> {
  if (!branchId || lat === undefined || lng === undefined) {
    return { evaluated: false, allowed: true, distanceMeters: null, radiusMeters: null, branchName: null };
  }
  const branch = await prisma.hrBranch.findUnique({
    where: { id: branchId },
    select: { latitude: true, longitude: true, name: true },
  });
  // If the branch has no coordinates, skip validation.
  if (!branch?.latitude || !branch?.longitude) {
    return { evaluated: false, allowed: true, distanceMeters: null, radiusMeters: null, branchName: branch?.name ?? null };
  }
  const distanceMeters = haversineDistance(branch.latitude, branch.longitude, lat, lng);
  // Default 200 m radius (HrBranch has no explicit radius column; 200 m is the
  // HRM reference default).
  const radiusMeters = 200;
  return {
    evaluated: true,
    allowed: distanceMeters <= radiusMeters,
    distanceMeters,
    radiusMeters,
    branchName: branch.name,
  };
}

/** Geo-fence validation for the real punch: throws when outside the fence. */
async function validateGeoFence(
  branchId: string | null,
  lat: number | undefined,
  lng: number | undefined
) {
  const r = await evaluateGeoFence(branchId, lat, lng);
  if (r.evaluated && !r.allowed) {
    throw new Error(
      `Geo-fence check-in rejected: you are ${r.distanceMeters}m from ${r.branchName} (radius ${r.radiusMeters}m)`
    );
  }
}

export const attendanceService = {
  /** Management mark: shift-aware late/OT computed server-side. */
  async mark(scope: HrScope, data: MarkAttendanceInput) {
    const target = await employeeProfileService.findScopedProfile(scope, data.employeeId);
    if (!target) throw new Error("Employee profile not found");
    const vendorId = target.linkedVendorId ?? null;

    const date = data.date || todayIso();

    // Resolve the employee's current shift for late/OT computation.
    const shift = await resolveCurrentShift(vendorId, data.employeeId);

    // Validate check-out is after check-in.
    if (data.checkIn && data.checkOut) {
      const ci = toMinutes(data.checkIn);
      const co = toMinutes(data.checkOut);
      if (co <= ci) throw new Error("Check-out time must be after check-in time");
    }

    const workingMinutes = computeWorkingMinutes(data.checkIn, data.checkOut);
    const { lateMinutes, overtimeMinutes } = computeLateAndOvertime(
      data.checkIn, data.checkOut, shift
    );

    const updateData: any = {
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      workingMinutes,
      lateMinutes,
      overtimeMinutes,
      remarks: data.remarks,
    };

    // Status: explicit override takes precedence; otherwise derive.
    const status = data.status || (data.checkIn ? (lateMinutes > 0 ? "LATE" : "PRESENT") : "ABSENT");
    updateData.status = status;

    const existing = await prisma.hrAttendance.findFirst({
      where: { vendorId, employeeId: data.employeeId, date },
    });
    if (existing) {
      return prisma.hrAttendance.update({ where: { id: existing.id }, data: updateData });
    }
    return prisma.hrAttendance.create({
      data: {
        vendorId,
        employeeId: data.employeeId,
        date,
        ...updateData,
        status,
        source: "MANUAL",
      },
    });
  },

  /** Employee self-service check-in (with optional geo-fence validation). */
  async checkIn(scope: HrScope, myEmployeeId: string, geo?: { lat: number; lng: number }) {
    const { profileId, vendorId, branchId } = await resolveSelfProfile(scope, myEmployeeId);
    const date = todayIso();

    // Geo-fence validation.
    if (geo) await validateGeoFence(branchId, geo.lat, geo.lng);

    const shift = await resolveCurrentShift(vendorId, profileId);
    const checkIn = nowHm();
    const { lateMinutes } = computeLateAndOvertime(checkIn, null, shift);

    const existing = await prisma.hrAttendance.findFirst({
      where: { vendorId, employeeId: profileId, date },
    });
    if (existing?.checkIn) throw new Error("Already checked in today");

    if (existing) {
      return prisma.hrAttendance.update({
        where: { id: existing.id },
        data: { checkIn, status: lateMinutes > 0 ? "LATE" : "PRESENT", lateMinutes },
      });
    }
    return prisma.hrAttendance.create({
      data: {
        vendorId, employeeId: profileId, date, checkIn,
        status: lateMinutes > 0 ? "LATE" : "PRESENT",
        lateMinutes, source: "WEB",
      },
    });
  },

  /** Employee self-service check-out (with optional geo-fence validation). */
  async checkOut(scope: HrScope, myEmployeeId: string, geo?: { lat: number; lng: number }) {
    const { profileId, vendorId, branchId } = await resolveSelfProfile(scope, myEmployeeId);
    const date = todayIso();

    if (geo) await validateGeoFence(branchId, geo.lat, geo.lng);

    const existing = await prisma.hrAttendance.findFirst({
      where: { vendorId, employeeId: profileId, date },
    });
    if (!existing?.checkIn) throw new Error("You haven't checked in today");
    if (existing.checkOut) throw new Error("Already checked out today");

    const checkOut = nowHm();
    const shift = await resolveCurrentShift(vendorId, profileId);
    const { overtimeMinutes } = computeLateAndOvertime(existing.checkIn, checkOut, shift);

    return prisma.hrAttendance.update({
      where: { id: existing.id },
      data: {
        checkOut,
        workingMinutes: computeWorkingMinutes(existing.checkIn, checkOut),
        overtimeMinutes,
      },
    });
  },

  /**
   * Manager-side geo-fence simulator: runs the SAME fence evaluation the real
   * punch uses, for an arbitrary (tenant-scoped) employee, WITHOUT writing any
   * attendance record.
   */
  async geoSimulate(
    scope: HrScope,
    input: { employeeId: string; mode: string; latitude: number; longitude: number; accuracy?: number }
  ) {
    const target = await employeeProfileService.findScopedProfile(scope, input.employeeId);
    if (!target) throw new Error("Employee profile not found");
    const branchId = target.branchId ?? null;

    const lat = Number(input.latitude);
    const lng = Number(input.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error("Valid latitude and longitude are required");
    }

    // Tenant-scoped branch load: 404-cloak cross-vendor branches.
    if (branchId) {
      const branch = await prisma.hrBranch.findFirst({
        where: { id: branchId, vendorId: scope.vendorId },
        select: { id: true },
      });
      if (!branch) throw new Error("Employee profile not found");
    }

    const r = await evaluateGeoFence(branchId, lat, lng);
    const place = r.branchName ?? "the employee's branch";
    const message = !r.evaluated
      ? branchId
        ? `${place} has no GPS center configured — geo-fence disabled, punch allowed.`
        : "Employee has no branch assigned — no geo-fence to validate, punch allowed."
      : r.allowed
        ? `Inside radius: ${r.distanceMeters}m from ${place} (radius ${r.radiusMeters}m)`
        : `Outside radius: ${r.distanceMeters}m from ${place} (radius ${r.radiusMeters}m)`;

    return {
      allowed: r.allowed,
      distanceMeters: r.distanceMeters,
      radiusMeters: r.radiusMeters,
      branchName: r.branchName,
      message,
    };
  },

  /** Bulk mark present for the given employee IDs. */
  async bulkMarkPresent(scope: HrScope, employeeIds: string[], date: string, actorUserId: string) {
    const results: Array<{ employeeId: string; ok: boolean; error?: string }> = [];
    for (const empId of employeeIds) {
      try {
        const target = await employeeProfileService.findScopedProfile(scope, empId);
        if (!target) { results.push({ employeeId: empId, ok: false, error: "not found" }); continue; }
        const vendorId = target.linkedVendorId ?? null;
        const shift = await resolveCurrentShift(vendorId, empId);
        const checkIn = nowHm();
        const existing = await prisma.hrAttendance.findFirst({
          where: { vendorId, employeeId: empId, date },
        });
        if (existing) {
          if (existing.checkIn) { results.push({ employeeId: empId, ok: true }); continue; }
          await prisma.hrAttendance.update({
            where: { id: existing.id },
            data: { checkIn, status: "PRESENT", source: "MANUAL" },
          });
        } else {
          await prisma.hrAttendance.create({
            data: { vendorId, employeeId: empId, date, checkIn, status: "PRESENT", source: "MANUAL" },
          });
        }
        results.push({ employeeId: empId, ok: true });
      } catch (err: any) {
        results.push({ employeeId: empId, ok: false, error: err.message });
      }
    }
    return { processed: results.length, succeeded: results.filter((r) => r.ok).length, results };
  },

  /** Paginated list with employee names resolved server-side. */
  async list(scope: HrScope, filters: AttendanceFilters) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(filters.limit) || 31));

    const where: any = { vendorId: scope.vendorId };
    if (filters.employeeId) where.employeeId = filters.employeeId;
    if (filters.status) where.status = filters.status;
    if (filters.fromDate || filters.toDate) {
      where.date = {
        ...(filters.fromDate ? { gte: filters.fromDate } : {}),
        ...(filters.toDate ? { lte: filters.toDate } : {}),
      };
    }

    const [items, total] = await Promise.all([
      prisma.hrAttendance.findMany({
        where,
        include: { employee: { select: { id: true, code: true, fullName: true, branchId: true, departmentId: true } } },
        orderBy: [{ date: "desc" as const }, { employeeId: "asc" as const }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.hrAttendance.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  },
};
