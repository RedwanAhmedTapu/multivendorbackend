// src/modules/hrm/services/hrBootstrap.service.ts
//
// Idempotent starter master data so no tenant ever sees empty Employee
// Management dropdowns. Adapted from the HRM reference demo corpus
// (branch/department/designation/shift trees + the 8 statutory leave types).
//
// Rules (per the approved P0 spec):
//   - Per-tenant: every row is scoped to scope.vendorId (null = platform).
//   - Idempotent: a master type is only seeded when that tenant has ZERO
//     rows of it — existing/custom master data is never touched, and
//     repeated bootstraps are no-ops. Leave types are additionally
//     skip-if-exists by their vendor-unique code.
//   - Safe to call repeatedly (list endpoints call it lazily when a tenant
//     has no rows of that type; POST /hrm/bootstrap runs everything).

import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

const BRANCHES = [
  { code: "HO", name: "Head Office — Banani", type: "OFFICE" },
  { code: "ST01", name: "Dhanmondi Store", type: "STORE" },
  { code: "ST02", name: "Uttara Store", type: "STORE" },
  { code: "WH01", name: "Central Warehouse — Tejgaon", type: "WAREHOUSE" },
];

// departmentCode -> owning branch code (HRM demo mapping)
const DEPARTMENTS: Array<{ code: string; name: string; branch: string }> = [
  { code: "MGMT", name: "Management", branch: "HO" },
  { code: "ACC", name: "Accounts", branch: "HO" },
  { code: "HR", name: "Human Resources", branch: "HO" },
  { code: "MKT", name: "Marketing", branch: "HO" },
  { code: "PRO", name: "Procurement", branch: "HO" },
  { code: "OPS", name: "Operations", branch: "HO" },
  { code: "IT", name: "IT", branch: "HO" },
  { code: "SALES", name: "Sales", branch: "ST01" },
  { code: "CS", name: "Customer Service", branch: "ST01" },
  { code: "WH", name: "Warehouse", branch: "WH01" },
  { code: "INV", name: "Inventory", branch: "WH01" },
  { code: "DLV", name: "Delivery", branch: "WH01" },
];

const DESIGNATIONS: Array<{
  code: string; name: string; department: string; grade: string; minSalary: number; maxSalary: number;
}> = [
  { code: "MD", name: "Managing Director", department: "MGMT", grade: "A+", minSalary: 150000, maxSalary: 400000 },
  { code: "GM", name: "General Manager", department: "MGMT", grade: "A", minSalary: 90000, maxSalary: 180000 },
  { code: "HRM", name: "HR Manager", department: "HR", grade: "B", minSalary: 45000, maxSalary: 90000 },
  { code: "HRO", name: "HR Officer", department: "HR", grade: "C", minSalary: 22000, maxSalary: 40000 },
  { code: "AM", name: "Accounts Manager", department: "ACC", grade: "B", minSalary: 50000, maxSalary: 100000 },
  { code: "AO", name: "Accounts Officer", department: "ACC", grade: "C", minSalary: 25000, maxSalary: 45000 },
  { code: "SM", name: "Store Manager", department: "SALES", grade: "B", minSalary: 40000, maxSalary: 70000 },
  { code: "SS", name: "Sales Supervisor", department: "SALES", grade: "C", minSalary: 22000, maxSalary: 35000 },
  { code: "SE", name: "Sales Executive", department: "SALES", grade: "C", minSalary: 16000, maxSalary: 28000 },
  { code: "CSR", name: "Customer Service Rep.", department: "CS", grade: "C", minSalary: 15000, maxSalary: 24000 },
  { code: "WM", name: "Warehouse Manager", department: "WH", grade: "B", minSalary: 38000, maxSalary: 65000 },
  { code: "WK", name: "Warehouse Keeper", department: "WH", grade: "C", minSalary: 16000, maxSalary: 26000 },
  { code: "MT", name: "Marketing Executive", department: "MKT", grade: "C", minSalary: 20000, maxSalary: 38000 },
  { code: "ITO", name: "IT Officer", department: "IT", grade: "C", minSalary: 30000, maxSalary: 60000 },
  { code: "DRV", name: "Delivery Rider", department: "DLV", grade: "C", minSalary: 14000, maxSalary: 20000 },
];

const SHIFTS = [
  { name: "General (9-5)", startTime: "09:00", endTime: "18:00" },
  { name: "Morning Store Shift", startTime: "08:00", endTime: "16:00" },
  { name: "Evening Store Shift", startTime: "14:00", endTime: "22:00" },
  { name: "Night Warehouse Shift", startTime: "22:00", endTime: "06:00" },
];

// The 8 statutory leave types, with the HRM reference policy values.
const LEAVE_TYPES = [
  { code: "CASUAL", name: "Casual Leave", paid: true, defaultDays: 10, carryForward: false, maxCarryForward: 0, encashmentAllowed: true, waitingPeriodDays: 0, probationEligible: true },
  { code: "SICK", name: "Sick Leave", paid: true, defaultDays: 14, carryForward: false, maxCarryForward: 0, encashmentAllowed: true, waitingPeriodDays: 30, probationEligible: true },
  { code: "ANNUAL", name: "Annual Leave", paid: true, defaultDays: 20, carryForward: true, maxCarryForward: 5, encashmentAllowed: true, waitingPeriodDays: 30, probationEligible: false },
  { code: "EARNED", name: "Earned Leave", paid: true, defaultDays: 18, carryForward: true, maxCarryForward: 5, encashmentAllowed: true, waitingPeriodDays: 30, probationEligible: false },
  { code: "EMERGENCY", name: "Emergency Leave", paid: true, defaultDays: 7, carryForward: false, maxCarryForward: 0, encashmentAllowed: false, waitingPeriodDays: 30, probationEligible: true },
  { code: "MATERNITY", name: "Maternity Leave", paid: true, defaultDays: 112, carryForward: false, maxCarryForward: 0, encashmentAllowed: false, waitingPeriodDays: 30, probationEligible: false },
  { code: "PATERNITY", name: "Paternity Leave", paid: true, defaultDays: 7, carryForward: false, maxCarryForward: 0, encashmentAllowed: false, waitingPeriodDays: 30, probationEligible: false },
  { code: "UNPAID", name: "Unpaid Leave", paid: false, defaultDays: 15, carryForward: false, maxCarryForward: 0, encashmentAllowed: false, waitingPeriodDays: 30, probationEligible: false },
];

// Adaptation note: FinixMart's HrLeaveType has no waitingPeriodDays /
// probationEligible columns (the HRM reference model does), so those two
// policy fields are intentionally not seeded — the seeded values cover every
// column that exists. Requires-attachment stays at its schema default.

export const hrBootstrapService = {
  /**
   * Seed starter master data for a tenant. Idempotent AT RECORD LEVEL:
   * every record is checked for existence (by vendor-unique code, or by
   * name for shifts which have no code) before creation, and unique-index
   * races (P2002) are swallowed. This replaces the previous count===0 gate,
   * which duplicated whole seed sets when two first-loads raced (the
   * duplicate master-data bug).
   */
  async ensureDefaults(scope: HrScope): Promise<Record<string, number>> {
    const vendorId = scope.vendorId;
    const created: Record<string, number> = {};
    const n = (k: string) => { created[k] = (created[k] ?? 0) + 1; };
    const ignoreDuplicate = (err: any) => {
      if (err?.code === "P2002") return null; // lost a create race — fine
      throw err;
    };

    // ── Leave types (vendor-unique code) ───────────────────────────────
    const leaveCodes = new Set(
      (await prisma.hrLeaveType.findMany({ where: { vendorId }, select: { code: true } })).map((r) => r.code)
    );
    for (const t of LEAVE_TYPES) {
      if (leaveCodes.has(t.code)) continue;
      await prisma.hrLeaveType.create({
        data: { vendorId, code: t.code, name: t.name, paid: t.paid, defaultDays: t.defaultDays, carryForward: t.carryForward, maxCarryForward: t.maxCarryForward, encashmentAllowed: t.encashmentAllowed, active: true },
      }).catch(ignoreDuplicate);
      n("leaveTypes");
    }

    // ── Branches (vendor-unique code) ──────────────────────────────────
    const branchIds: Record<string, string> = {};
    for (const b of BRANCHES) {
      const existing = await prisma.hrBranch.findFirst({ where: { vendorId, code: b.code }, select: { id: true } });
      if (existing) { branchIds[b.code] = existing.id; continue; }
      try {
        const row = await prisma.hrBranch.create({
          data: { vendorId, code: b.code, name: b.name, type: b.type as any, active: true },
        });
        branchIds[b.code] = row.id;
        n("branches");
      } catch (err) { ignoreDuplicate(err); }
    }

    // ── Departments (vendor-unique code) ───────────────────────────────
    for (const d of DEPARTMENTS) {
      const existing = await prisma.hrDepartment.findFirst({ where: { vendorId, code: d.code }, select: { id: true } });
      if (existing) continue;
      await prisma.hrDepartment.create({
        data: { vendorId, code: d.code, name: d.name, status: "ACTIVE", branchId: branchIds[d.branch] ?? undefined },
      }).catch(ignoreDuplicate);
      n("departments");
    }

    // ── Designations (vendor-unique code) ──────────────────────────────
    for (const d of DESIGNATIONS) {
      const existing = await prisma.hrDesignation.findFirst({ where: { vendorId, code: d.code }, select: { id: true } });
      if (existing) continue;
      const dept = await prisma.hrDepartment.findFirst({ where: { vendorId, code: d.department }, select: { id: true } });
      await prisma.hrDesignation.create({
        data: {
          vendorId, code: d.code, name: d.name, status: "ACTIVE",
          departmentId: dept?.id,
          grade: d.grade, minSalary: d.minSalary, maxSalary: d.maxSalary,
        },
      }).catch(ignoreDuplicate);
      n("designations");
    }

    // ── Shifts (NO unique constraint → dedupe by vendor+name) ──────────
    const shiftNames = new Set(
      (await prisma.hrShift.findMany({ where: { vendorId }, select: { name: true } })).map((r) => r.name)
    );
    for (const s of SHIFTS) {
      if (shiftNames.has(s.name)) continue;
      await prisma.hrShift.create({
        data: {
          vendorId, name: s.name, type: "FIXED",
          startTime: s.startTime, endTime: s.endTime,
          graceMinutes: 10, breakMinutes: 60, minWorkingHours: 8,
          otThresholdMinutes: 30, otMultiplier: 1.5, weeklyOff: "FRIDAY",
          active: true,
        },
      }).catch(ignoreDuplicate);
      n("shifts");
    }

    return created;
  },
};
