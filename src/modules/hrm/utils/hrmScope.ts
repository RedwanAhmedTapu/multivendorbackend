// src/modules/hrm/utils/hrmScope.ts
//
// Every HR route needs to know: "is this request about admin/platform HR
// data, or a specific Vendor's HR data?" That's exactly what your existing
// auth.middleware.ts already puts on req.user:
//   - ADMIN                       -> vendorId is null
//   - VENDOR                      -> vendorId is that vendor's own id
//   - EMPLOYEE (admin's staff)    -> vendorId is null
//   - EMPLOYEE (a vendor's staff) -> vendorId is that vendor's id
//
// So the HR "scope" is simply req.user.vendorId — we don't invent a new
// concept, we reuse the one that's already correct across your app.

import type { Response, NextFunction } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.ts";
import type { HrScope } from "../types/hrm.types.ts";

export function getHrScope(req: AuthRequest): HrScope {
  const user = req.user!;
  return {
    vendorId: user.vendorId ?? null,
    // NOTE: user.id is a role-specific effective id (Vendor.id for VENDOR,
    // Employee.id for EMPLOYEE/ADMIN — see auth.middleware.ts). createdBy /
    // actedBy / approvedBy fields on Hr* models reference the real User
    // table, so we use rawId here, not id.
    actorUserId: user.rawId,
    role: user.role,
  };
}

/**
 * Attach req.hrScope so controllers don't repeat this on every handler.
 * Mount this once at the top of hrm.routes.ts, after authenticateUser.
 */
export function attachHrScope(req: AuthRequest, _res: Response, next: NextFunction) {
  (req as AuthRequest & { hrScope: HrScope }).hrScope = getHrScope(req);
  next();
}

export interface HrScopedRequest extends AuthRequest {
  hrScope: HrScope;
}

/**
 * Employee identity for SELF-SERVICE submissions (leave / loan / advance /
 * expense / resignation apply). These endpoints must never accept a
 * client-provided employeeId — an employee could otherwise submit leave,
 * loans, or a resignation on behalf of a colleague. Identity is resolved
 * strictly from the authenticated session:
 *   - EMPLOYEE -> their own Employee.id
 *   - ADMIN    -> null (the auto-provisioned chat-FK row is not an HR
 *                 identity; admins manage HR through the permission-gated
 *                 routes instead)
 *   - VENDOR   -> null (owners have no Employee row)
 * Callers must reject null with the standard
 * "No employee record for this account" 400.
 */
export function selfEmployeeId(req: HrScopedRequest): string | null {
  if (req.user?.role !== "EMPLOYEE") return null;
  return req.user.employeeId ?? null;
}
