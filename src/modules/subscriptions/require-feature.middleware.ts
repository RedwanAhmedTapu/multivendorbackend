// src/modules/subscriptions/require-feature.middleware.ts
//
// The one backend gate for plan features:
//   router.use(authenticateUser, requireVendorPermission("…"), requireFeature("accounting"))
//   router.post("/try-on", requireFeature("virtual_try_on", { limitKey: "renders", consume: 1 }), handler)
//
// Responses (shape shared with the POS 402):
//   402 { code: "SUBSCRIPTION_INACTIVE" | "FEATURE_NOT_IN_PLAN", feature, subscription }
//   429 { code: "USAGE_LIMIT_REACHED", feature, limitKey, used, cap }
//   500 { code: "FEATURE_UNKNOWN" }: a route names a feature nobody created (fail closed)
// A feature whose `enforced` switch is off, or the platform monitor mode, never
// blocks: would-be denials are logged and flagged in X-Subscription-Entitlement.
// The vendor id comes only from the authenticated identity (vendorScope set by
// the vendor permission guard, or the vendor's own session).

import type { NextFunction, Request, Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.middleware.ts";
import { subscriptionService, type SubscriptionService } from "./subscription.service.ts";

export interface RequireFeatureOptions {
  limitKey?: string;
  consume?: number; // count this request against the limit (atomic); omit to only check the feature
}

const messages: Record<string, string> = {
  SUBSCRIPTION_INACTIVE: "This feature needs an active FinixMart plan. Choose a plan under Subscription.",
  FEATURE_NOT_IN_PLAN: "Your current plan doesn't include this feature. Upgrade under Subscription.",
  FEATURE_UNKNOWN: "This feature isn't configured yet.",
};

export function requireFeature(featureKey: string, opts: RequireFeatureOptions = {}, service: () => SubscriptionService = subscriptionService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = req as AuthRequest & { vendorScope?: string };
      const vendorId = r.vendorScope ?? (r.user?.role === "VENDOR" ? r.user.vendorId : null);
      if (!vendorId) {
        res.status(403).json({ success: false, code: "FORBIDDEN", message: "Forbidden: vendor access only" });
        return;
      }
      const svc = service();
      const ent = await svc.entitlementFor(vendorId, featureKey);
      if (ent.reason === "FEATURE_UNKNOWN") {
        console.error(`[entitlement] route uses unknown feature "${featureKey}"`);
        res.status(500).json({ success: false, code: "FEATURE_UNKNOWN", message: messages.FEATURE_UNKNOWN });
        return;
      }
      if (!ent.granted) {
        if (!ent.allowed) {
          res.status(402).json({ success: false, code: ent.reason, feature: featureKey, message: messages[ent.reason ?? "FEATURE_NOT_IN_PLAN"], subscription: ent.subscription });
          return;
        }
        res.setHeader?.("X-Subscription-Entitlement", `would-deny:${ent.reason}`);
        console.warn(`[entitlement] monitor: would deny vendor=${vendorId} feature=${featureKey} reason=${ent.reason}`);
      }
      if (opts.limitKey && opts.consume) {
        const u = await svc.consumeUsage(vendorId, featureKey, opts.limitKey, opts.consume);
        if (!u.ok) {
          res.status(429).json({ success: false, code: "USAGE_LIMIT_REACHED", feature: featureKey, limitKey: opts.limitKey, used: u.used, cap: u.cap, message: `You've reached your plan's limit (${u.cap}). Upgrade under Subscription for more.` });
          return;
        }
      } else if (opts.limitKey && ent.granted) {
        const cap = ent.limits[opts.limitKey];
        if (cap === false && ent.enforced && !ent.monitor) {
          res.status(402).json({ success: false, code: "FEATURE_NOT_IN_PLAN", feature: featureKey, limitKey: opts.limitKey, message: messages.FEATURE_NOT_IN_PLAN });
          return;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
