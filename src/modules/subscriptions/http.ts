// src/modules/subscriptions/http.ts
// Shared HTTP helpers for the subscription and payout modules: map domain
// errors to a consistent JSON shape { success:false, code, message }, and read
// the actor / vendor scope only from the authenticated identity.

import type { NextFunction, Request, Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.middleware.ts";

export interface DomainError extends Error {
  statusCode: number;
  code: string;
}
const isDomainError = (e: unknown): e is DomainError =>
  e instanceof Error && typeof (e as DomainError).statusCode === "number" && typeof (e as DomainError).code === "string";

export function handle(fn: (req: AuthRequest, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req as AuthRequest, res);
    } catch (err) {
      if (isDomainError(err)) {
        res.status(err.statusCode).json({ success: false, code: err.code, message: err.message });
        return;
      }
      next(err);
    }
  };
}

export const actorOf = (req: AuthRequest) => {
  const userId = req.user?.rawId;
  if (!userId) throw Object.assign(new Error("Missing authenticated user"), { statusCode: 401, code: "UNAUTHENTICATED" });
  return { userId, name: req.user?.name ?? null };
};

export const vendorOf = (req: AuthRequest) => {
  const v = (req as AuthRequest & { vendorScope?: string }).vendorScope;
  if (!v) throw Object.assign(new Error("Forbidden: vendor access only"), { statusCode: 403, code: "FORBIDDEN" });
  return v;
};

/**
 * Billing and payouts are the store owner's business: VENDOR role only (vendor
 * staff, admins and customers get 403). Sets req.vendorScope from the session.
 */
export function requireVendorOwner(req: Request, res: Response, next: NextFunction) {
  const user = (req as AuthRequest).user;
  if (!user) {
    res.status(401).json({ success: false, code: "UNAUTHENTICATED", message: "Unauthorized" });
    return;
  }
  if (user.role !== "VENDOR" || !user.vendorId) {
    res.status(403).json({ success: false, code: "FORBIDDEN", message: "Only the store owner can open billing and payouts" });
    return;
  }
  (req as AuthRequest & { vendorScope?: string }).vendorScope = user.vendorId;
  next();
}

export const qInt = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
export const qStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : undefined);
