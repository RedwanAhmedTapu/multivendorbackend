// src/middlewares/permission.middleware.ts
import type { Response, NextFunction } from "express";
import { prisma } from "../config/prisma.ts";
import type { AuthRequest } from "./auth.middleware.ts";

export type PermissionKey =
  | "productManagement"
  | "orderManagement"
  | "customerSupport"
  | "analytics"
  | "offerManagement"
  | "inventoryManagement"
  | "hrManagement" // ← new: gates every /api/hrm/* route for EMPLOYEE role.
  | "marketingManagement" // Marketing Center admin side (campaigns, approvals). Admin-only grant.
  | "posSubscriptionManagement" // Admin-side staff: manage vendor POS subscriptions (never grants vendor POS access). Admin-only grant.
  | "agentManagement" // Admin-side staff: the Agent Commission admin area (/api/admin/agents). Admin-only grant.
  | "themeManagement"; // Platform theme & palette management (/api/themes/palettes*, assignments, vendor policy). Admin-only grant; vendor staff kept out by blockVendorEmployees.

/**
 * ADMIN / VENDOR (owner) always get full access.
 * EMPLOYEE role is checked against Employee.permissions JSON.
 */
export function requirePermission(module: PermissionKey) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    if (user.role === "ADMIN" || user.role === "VENDOR") {
      next();
      return;
    }

    if (user.role !== "EMPLOYEE" || !user.employeeId) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    const employee = await prisma.employee.findUnique({
      where: { id: user.employeeId },
      select: { permissions: true, isActive: true },
    });

    if (!employee || !employee.isActive) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    const perms = (employee.permissions ?? {}) as Record<string, boolean>;
    if (!perms[module]) {
      res.status(403).json({
        message: `Forbidden: you don't have '${module}' permission`,
      });
      return;
    }

    next();
  };
}

/**
 * Admin-only route hit by EMPLOYEE role → make sure it's an admin's own
 * employee (vendorId === null), not a vendor's employee.
 */
export function blockVendorEmployees(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role === "EMPLOYEE" && req.user.vendorId) {
    res.status(403).json({ message: "Forbidden: admin access only" });
    return;
  }
  next();
}

/**
 * Courier vendor routes (Phase 0): only a vendor's own staff (EMPLOYEE with a
 * vendorId, resolved from the database by authenticateUser) may use them, and
 * the vendor scope comes ONLY from that identity — never from a path, query or
 * body vendorId. Admins and admin-side employees are refused.
 */
export function requireVendorScope(req: AuthRequest, res: Response, next: NextFunction) {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  if (user.role !== "EMPLOYEE" || !user.vendorId) {
    res.status(403).json({ message: "Forbidden: vendor staff access only" });
    return;
  }
  (req as AuthRequest & { vendorScope?: string }).vendorScope = user.vendorId;
  next();
}

/**
 * Vendor-OWNER scope gate (theme management — Part 2 review decision, option a).
 * Mirrors the StoreDecoration convention (storeLayout.routes.ts: owner-only
 * `authorizeRoles('VENDOR')`), while also setting req.vendorScope from the
 * authenticated session so handlers never trust a body/query/path vendorId.
 *   VENDOR with a vendorId -> passes, vendorScope = own vendorId;
 *   anyone else (EMPLOYEE incl. vendor staff, ADMIN, CUSTOMER) -> 403;
 *   no user -> 401.
 * Vendor employees are deliberately NOT admissible here regardless of grants.
 */
export function requireVendorOwnerScope(req: AuthRequest, res: Response, next: NextFunction) {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  if (user.role !== "VENDOR" || !user.vendorId) {
    res.status(403).json({ message: "Forbidden: vendor owner access only" });
    return;
  }
  (req as AuthRequest & { vendorScope?: string }).vendorScope = user.vendorId;
  next();
}

// ═══════════════════════════════════════════════════════════════════════════
// Granular HR permissions (Employee Management P0).
//
// `hrManagement` remains the backward-compatible umbrella: an EMPLOYEE who
// holds it passes every HR gate exactly as before. The granular keys let a
// tenant grant narrower capabilities (docs, bank, salary, org, leave types)
// through the same Employee.permissions JSON map.
//
// SENSITIVE gates (salary read/edit, unmasked bank) deliberately do NOT
// auto-pass for the VENDOR role: sensitive access must be granted explicitly
// (to staff accounts via their permission map). ADMIN keeps its existing
// privileged behavior. VENDOR keeps owner semantics for all NON-sensitive
// HR gates within its own tenant (enforced by vendorId scoping downstream).
// ═══════════════════════════════════════════════════════════════════════════

export type HrGranularKey =
  | "hrEmployeeView"
  | "hrEmployeeCreate"
  | "hrEmployeeEdit"
  | "hrEmployeeDelete"
  | "hrSalaryView"
  | "hrSalaryEdit"
  | "hrDocsUpload"
  | "hrDocsVerify"
  | "hrDocsDownload"
  | "hrDocsDelete"
  | "hrBankView"
  | "hrOrgEdit"
  | "hrLeaveTypesEdit";

const SENSITIVE_HR_KEYS = new Set<string>(["hrSalaryView", "hrSalaryEdit", "hrBankView"]);

export interface HrCapabilities {
  hrEmployeeView: boolean;
  hrEmployeeCreate: boolean;
  hrEmployeeEdit: boolean;
  hrEmployeeDelete: boolean;
  hrSalaryView: boolean;
  hrSalaryEdit: boolean;
  hrDocsUpload: boolean;
  hrDocsVerify: boolean;
  hrDocsDownload: boolean;
  hrDocsDelete: boolean;
  hrBankView: boolean;
  hrOrgEdit: boolean;
  hrLeaveTypesEdit: boolean;
}

const ALL_HR_KEYS = Object.keys({
  hrEmployeeView: 1, hrEmployeeCreate: 1, hrEmployeeEdit: 1, hrEmployeeDelete: 1,
  hrSalaryView: 1, hrSalaryEdit: 1, hrDocsUpload: 1, hrDocsVerify: 1,
  hrDocsDownload: 1, hrDocsDelete: 1, hrBankView: 1, hrOrgEdit: 1,
  hrLeaveTypesEdit: 1,
}) as HrGranularKey[];

const falseCaps = (): HrCapabilities =>
  Object.fromEntries(ALL_HR_KEYS.map((k) => [k, false])) as unknown as HrCapabilities;

const trueCaps = (): HrCapabilities =>
  Object.fromEntries(ALL_HR_KEYS.map((k) => [k, true])) as unknown as HrCapabilities;

/**
 * Server-derived HR capabilities for the current session — the single source
 * of truth for BOTH API authorization and response shaping (salary/bank
 * masking). The frontend receives the same map via /auth/me.
 *   ADMIN   -> everything (existing privileged behavior)
 *   VENDOR  -> non-sensitive HR caps within its tenant; sensitive
 *              (salary/bank) false unless explicitly granted elsewhere
 *   EMPLOYEE-> hrManagement umbrella grants everything; otherwise each
 *              granular key individually
 */
export async function getHrCapabilities(user: AuthRequest["user"]): Promise<HrCapabilities> {
  if (!user) return falseCaps();
  if (user.role === "ADMIN") return trueCaps();
  if (user.role === "VENDOR") {
    const caps = trueCaps();
    caps.hrSalaryView = false;
    caps.hrSalaryEdit = false;
    caps.hrBankView = false;
    return caps;
  }
  if (user.role !== "EMPLOYEE" || !user.employeeId) return falseCaps();

  const employee = await prisma.employee.findUnique({
    where: { id: user.employeeId },
    select: { permissions: true, isActive: true },
  });
  if (!employee || !employee.isActive) return falseCaps();

  const perms = (employee.permissions ?? {}) as Record<string, boolean>;
  if (perms["hrManagement"]) return trueCaps();

  const caps = falseCaps();
  for (const key of ALL_HR_KEYS) {
    caps[key] = perms[key] === true;
  }
  return caps;
}

/**
 * HR gate with granular support: passes for ADMIN always, for VENDOR on
 * non-sensitive gates (owner semantics, tenant-scoped downstream), and for
 * EMPLOYEE with the hrManagement umbrella OR the specific granular key.
 * Sensitive gates never auto-pass for VENDOR.
 */
export function requireHr(grant: HrGranularKey) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (user.role === "ADMIN") {
      next();
      return;
    }
    if (user.role === "VENDOR") {
      if (SENSITIVE_HR_KEYS.has(grant)) {
        res.status(403).json({
          success: false,
          message: `Forbidden: '${grant}' must be explicitly granted — vendor accounts do not automatically receive sensitive salary/bank access.`,
        });
        return;
      }
      next();
      return;
    }
    if (user.role !== "EMPLOYEE" || !user.employeeId) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    const employee = await prisma.employee.findUnique({
      where: { id: user.employeeId },
      select: { permissions: true, isActive: true },
    });
    if (!employee || !employee.isActive) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    const perms = (employee.permissions ?? {}) as Record<string, boolean>;
    if (!perms["hrManagement"] && !perms[grant]) {
      res.status(403).json({
        success: false,
        message: `Forbidden: you don't have '${grant}' permission`,
      });
      return;
    }
    next();
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 (S5/S6): vendor-scoped permissions and permission-key validation.
// ═══════════════════════════════════════════════════════════════════════════

/** Runtime list of the base module keys (mirrors the PermissionKey union). */
export const BASE_PERMISSION_KEYS: readonly PermissionKey[] = [
  "productManagement",
  "orderManagement",
  "customerSupport",
  "analytics",
  "offerManagement",
  "inventoryManagement",
  "hrManagement",
  "marketingManagement",
  "posSubscriptionManagement",
  "agentManagement",
  "themeManagement",
];

/** Keys only the ADMIN may grant (admin-side staff powers). A VENDOR owner
 *  granting them is refused, even though vendor staff could never use them. */
export const ADMIN_ONLY_PERMISSION_KEYS: readonly PermissionKey[] = ["marketingManagement", "posSubscriptionManagement", "agentManagement", "themeManagement"];

/** Keys that only a vendor owner may grant, and only to that vendor's staff.
 *  `adManagement` is defined for the advertising phase; nothing grants it
 *  automatically and no route uses it yet. */
// Vendor POS (granted by the vendor owner to its own employees; the owner
// holds all of them). Checked from Employee.permissions on every request:
//   posAccess    open the POS: sell, look up products, customers, invoices,
//                collect dues
//   posDiscount  give discounts / write off part of a sale
//   posCredit    sell on credit and set customer credit terms
//   posRefund    refund or void a sale
//   posReports   POS dashboard figures
export type VendorOnlyPermissionKey = "adManagement" | "posAccess" | "posDiscount" | "posCredit" | "posRefund" | "posReports";
export const VENDOR_ONLY_PERMISSION_KEYS: readonly VendorOnlyPermissionKey[] = [
  "adManagement",
  "posAccess",
  "posDiscount",
  "posCredit",
  "posRefund",
  "posReports",
];

/** Every key accepted in Employee.permissions. */
export const KNOWN_PERMISSION_KEYS: readonly string[] = [
  ...BASE_PERMISSION_KEYS,
  ...ALL_HR_KEYS,
  ...VENDOR_ONLY_PERMISSION_KEYS,
];

/** Keys a VENDOR owner does not hold and therefore cannot grant. */
export const SENSITIVE_PERMISSION_KEYS: readonly string[] = [...SENSITIVE_HR_KEYS];

export type PermissionPatchResult =
  | { ok: true }
  | { ok: false; status: 400 | 403; message: string };

/**
 * Validate a permissions object before any employee permission write.
 *   - absent (undefined/null) or the legacy empty array → nothing to check;
 *   - must be a plain object of known keys with boolean values (400);
 *   - VENDOR actors cannot grant the sensitive salary/bank keys (403);
 *   - non-VENDOR actors (ADMIN, editing admin-side staff) cannot grant
 *     vendor-only keys (403).
 * Stored data is never rewritten here — only the incoming write is checked.
 */
export function validatePermissionPatch(permissions: unknown, actorRole: string | undefined): PermissionPatchResult {
  if (permissions === undefined || permissions === null) return { ok: true };
  if (Array.isArray(permissions) && permissions.length === 0) return { ok: true };
  if (typeof permissions !== "object" || Array.isArray(permissions)) {
    return { ok: false, status: 400, message: "Invalid permissions: expected an object of permission keys" };
  }
  const entries = Object.entries(permissions as Record<string, unknown>);
  const unknown = entries.map(([k]) => k).filter((k) => !KNOWN_PERMISSION_KEYS.includes(k));
  if (unknown.length > 0) {
    return { ok: false, status: 400, message: `Invalid permissions: unknown key(s) '${unknown.join("', '")}'` };
  }
  const nonBoolean = entries.filter(([, v]) => typeof v !== "boolean").map(([k]) => k);
  if (nonBoolean.length > 0) {
    return { ok: false, status: 400, message: `Invalid permissions: '${nonBoolean.join("', '")}' must be true or false` };
  }
  const granted = entries.filter(([, v]) => v === true).map(([k]) => k);
  if (actorRole === "VENDOR") {
    const adminOnly = granted.filter((k) => (ADMIN_ONLY_PERMISSION_KEYS as readonly string[]).includes(k));
    if (adminOnly.length > 0) {
      return {
        ok: false,
        status: 403,
        message: `Forbidden: '${adminOnly.join("', '")}' can only be granted by an administrator.`,
      };
    }
    const sensitive = granted.filter((k) => SENSITIVE_PERMISSION_KEYS.includes(k));
    if (sensitive.length > 0) {
      return {
        ok: false,
        status: 403,
        message: `Forbidden: vendor accounts do not hold '${sensitive.join("', '")}' and therefore cannot grant them.`,
      };
    }
  } else {
    const vendorOnly = granted.filter((k) => (VENDOR_ONLY_PERMISSION_KEYS as readonly string[]).includes(k));
    if (vendorOnly.length > 0) {
      return {
        ok: false,
        status: 403,
        message: `Forbidden: '${vendorOnly.join("', '")}' can only be granted by a vendor owner to their own staff.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Vendor-scoped permission gate (does NOT change requirePermission()).
 *   VENDOR   -> passes with its own non-null vendorId;
 *   EMPLOYEE -> passes only with a non-null vendorId, an active Employee row
 *               belonging to that vendor, and permissions[key] === true;
 *   anything else (ADMIN, admin-side staff, CUSTOMER) -> 403; no user -> 401.
 * Sets req.vendorScope from the authenticated identity only — handlers must
 * use it and never a body/query/path vendorId.
 */
export function requireVendorPermission(key: PermissionKey | HrGranularKey | VendorOnlyPermissionKey) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const scoped = req as AuthRequest & { vendorScope?: string };
    if (user.role === "VENDOR") {
      if (!user.vendorId) {
        res.status(403).json({ message: "Forbidden: vendor access only" });
        return;
      }
      scoped.vendorScope = user.vendorId;
      next();
      return;
    }
    if (user.role !== "EMPLOYEE" || !user.employeeId || !user.vendorId) {
      res.status(403).json({ message: "Forbidden: vendor access only" });
      return;
    }
    const employee = await prisma.employee.findUnique({
      where: { id: user.employeeId },
      select: { permissions: true, isActive: true, vendorId: true },
    });
    if (!employee || !employee.isActive || employee.vendorId !== user.vendorId) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    const perms = (employee.permissions ?? {}) as Record<string, unknown>;
    if (perms[key] !== true) {
      res.status(403).json({ message: `Forbidden: you don't have '${key}' permission` });
      return;
    }
    scoped.vendorScope = user.vendorId;
    next();
  };
}

/**
 * Vendor-management ownership gate (the route's `:param` is a vendor id).
 *   ADMIN                                   → passes (manages every vendor)
 *   VENDOR with a vendorId                  → passes only for its own vendor id
 *   EMPLOYEE of a vendor, only when `staffKey` is given and the active
 *     Employee row holds permissions[staffKey] === true → own vendor only
 *   anyone else (admin-side staff, CUSTOMER, …) → 403;  no user → 401
 * A vendor (or its staff) asking for ANOTHER vendor's id gets 404, so ids of
 * other vendors are not confirmed. The vendor is matched against the
 * authenticated session, never trusted from the URL.
 */
export function requireOwnVendorParam(param: string, staffKey?: PermissionKey) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (user.role === "ADMIN") {
      next();
      return;
    }
    const own = user.vendorId;
    if (user.role === "VENDOR" && own) {
      // owner — ownership checked below
    } else if (staffKey && user.role === "EMPLOYEE" && own && user.employeeId) {
      const employee = await prisma.employee.findUnique({
        where: { id: user.employeeId },
        select: { permissions: true, isActive: true, vendorId: true },
      });
      const perms = (employee?.permissions ?? {}) as Record<string, unknown>;
      if (!employee || !employee.isActive || employee.vendorId !== own || perms[staffKey] !== true) {
        res.status(403).json({ message: "Forbidden" });
        return;
      }
    } else {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    if (req.params[param] !== own) {
      res.status(404).json({ success: false, message: "Not found" });
      return;
    }
    (req as AuthRequest & { vendorScope?: string }).vendorScope = own;
    next();
  };
}
