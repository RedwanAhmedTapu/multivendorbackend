// src/middlewares/pos-auth.middleware.ts
//
// Vendor POS authorization — the authenticated session is the ONLY identity.
// There is no separate POS/terminal login: the vendor owner, or one of that
// vendor's employees, signs in to FinixMart as usual and uses the POS.
//
//   posSessionGate (every /api/pos route)
//     authenticateUser, then resolvePosActor:
//       VENDOR owner      → vendorScope = own vendor; holds every POS key
//       vendor EMPLOYEE   → active Employee row of that vendor (re-read from
//                           the database on EVERY request) with
//                           permissions.posAccess === true; its other POS keys
//                           are captured from the same row
//       anyone else (ADMIN, admin-side staff, customers) → 403
//     The vendor is never taken from a body, query or path.
//
//   requirePosPermission(key)  per-action grant (posDiscount, posCredit,
//                              posRefund, posReports) on the same fresh row
//   requirePosOwner            store configuration — the vendor owner only
//
// Attribution: req.posActor.userId / employeeId — never a client staffId.

import type { Response, NextFunction } from "express";
import { prisma } from "../config/prisma.ts";
import { authenticateUser, type AuthRequest } from "./auth.middleware.ts";

export const POS_ACTION_KEYS = ["posDiscount", "posCredit", "posRefund", "posReports"] as const;
export type PosActionKey = (typeof POS_ACTION_KEYS)[number];

export interface PosActor {
  /** User.id of the signed-in person (owner or employee). */
  userId: string;
  /** Employee.id when an employee acts; null for the vendor owner. */
  employeeId: string | null;
  isOwner: boolean;
  /** Fresh from the database for this request. */
  grants: Record<PosActionKey, boolean>;
  displayName: string | null;
}

export type PosRequest = AuthRequest & { vendorScope?: string; posActor?: PosActor };

function deny(res: Response, status: number, message: string) {
  res.status(status).json({ success: false, message });
}

/** Owner holds every POS action; an employee holds exactly what its row says. */
export function posActorCan(actor: Pick<PosActor, "isOwner" | "grants">, key: PosActionKey): boolean {
  return actor.isOwner || actor.grants[key] === true;
}

export async function resolvePosActor(req: PosRequest, res: Response, next: NextFunction) {
  try {
    const user = req.user;
    if (!user) return deny(res, 401, "Unauthorized");

    if (user.role === "VENDOR") {
      if (!user.vendorId) return deny(res, 403, "Forbidden: vendor access only");
      req.vendorScope = user.vendorId;
      req.posActor = {
        userId: user.rawId,
        employeeId: null,
        isOwner: true,
        grants: { posDiscount: true, posCredit: true, posRefund: true, posReports: true },
        displayName: user.name ?? null,
      };
      return next();
    }

    if (user.role !== "EMPLOYEE" || !user.employeeId || !user.vendorId) {
      return deny(res, 403, "Forbidden: the POS is for vendor stores and their staff");
    }
    const employee = await prisma.employee.findUnique({
      where: { id: user.employeeId },
      select: { id: true, permissions: true, isActive: true, vendorId: true },
    });
    if (!employee || !employee.isActive || employee.vendorId !== user.vendorId) return deny(res, 403, "Forbidden");
    const perms = (employee.permissions ?? {}) as Record<string, unknown>;
    if (perms.posAccess !== true) return deny(res, 403, "Forbidden: you don't have 'posAccess' permission");

    req.vendorScope = user.vendorId;
    req.posActor = {
      userId: user.rawId,
      employeeId: employee.id,
      isOwner: false,
      grants: {
        posDiscount: perms.posDiscount === true,
        posCredit: perms.posCredit === true,
        posRefund: perms.posRefund === true,
        posReports: perms.posReports === true,
      },
      displayName: user.name ?? null,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Session layer for every vendor POS route. */
export const posSessionGate = [authenticateUser, resolvePosActor];

export function requirePosPermission(key: PosActionKey) {
  return (req: PosRequest, res: Response, next: NextFunction) => {
    if (!req.posActor) return deny(res, 403, "Forbidden");
    if (!posActorCan(req.posActor, key)) return deny(res, 403, `Forbidden: you don't have '${key}' permission`);
    next();
  };
}

export function requirePosOwner(req: PosRequest, res: Response, next: NextFunction) {
  if (!req.posActor?.isOwner) return deny(res, 403, "Forbidden: only the store owner can change this");
  next();
}
