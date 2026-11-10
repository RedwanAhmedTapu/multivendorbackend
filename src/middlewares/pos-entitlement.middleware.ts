// src/middlewares/pos-entitlement.middleware.ts
//
// Router-level POS subscription gate for EVERY operational POS mutation
// (sales, refunds, voids, due collection, customer writes, settings and bank
// account changes). Checked independently of — and after — the employee
// permission gate: a permitted employee of an unentitled store is refused, and
// an entitled store's employee without posAccess never reaches this.
//
// Only ACTIVE and GRACE may operate. Expired, suspended, revoked, invalid and
// missing subscriptions → 402. Reads (history, settings view, subscription
// status) and renewal/checkout are deliberately NOT behind this gate.
//
// POS_SUBSCRIPTION_ENFORCEMENT=monitor (explicit opt-in for rollout): nothing
// is blocked; would-be denials are logged and flagged in X-POS-Entitlement.

import type { Response, NextFunction } from "express";
import { enforcementMode, posSubscriptionService } from "../services/pos-subscription.service.ts";
import type { PosRequest } from "./pos-auth.middleware.ts";
import { subscriptionService } from "../modules/subscriptions/subscription.service.ts";

export const POS_ENTITLEMENT_CODE = "POS_SUBSCRIPTION_REQUIRED";

export async function requirePosEntitlement(req: PosRequest, res: Response, next: NextFunction) {
  try {
    const vendorId = req.vendorScope;
    if (!vendorId) {
      res.status(403).json({ success: false, message: "Forbidden: vendor access only" });
      return;
    }
    const entitlement = await posSubscriptionService.entitlementFor(vendorId);
    if (entitlement.canOperate) {
      if (entitlement.state === "GRACE") res.setHeader?.("X-POS-Entitlement", "grace");
      return next();
    }
    // Additive (subscription platform, decision D3): a FinixMart plan or offer
    // that includes the "pos" feature also opens the POS. An explicit POS
    // suspension still wins. Any failure here (e.g. the plan tables are not
    // migrated yet) falls back to the POS-only decision above.
    if (entitlement.state !== "SUSPENDED" && (await planGrantsPos(vendorId))) {
      res.setHeader?.("X-POS-Entitlement", "plan");
      return next();
    }
    if (enforcementMode() === "monitor") {
      res.setHeader?.("X-POS-Entitlement", `would-deny:${entitlement.state}`);
      console.warn(`[pos-entitlement] monitor: would deny vendor=${vendorId} state=${entitlement.state} ${req.method} ${req.originalUrl ?? req.url ?? ""}`);
      return next();
    }
    res.status(402).json({
      success: false,
      code: POS_ENTITLEMENT_CODE,
      message:
        entitlement.state === "SUSPENDED"
          ? "Your POS access is suspended. Contact FinixMart support."
          : entitlement.state === "NONE" || entitlement.state === "INVALID"
            ? "Your store has no active POS subscription."
            : "Your POS subscription has ended. Renew to continue using the POS.",
      entitlement,
    });
  } catch (err) {
    next(err);
  }
}

/** True only when the vendor's plan / offers grant the "pos" feature (never throws). */
export async function planGrantsPos(vendorId: string, svc = subscriptionService): Promise<boolean> {
  try {
    return (await svc().entitlementFor(vendorId, "pos")).granted === true;
  } catch (err) {
    console.warn(`[pos-entitlement] plan check skipped: ${(err as Error)?.message ?? err}`);
    return false;
  }
}
