// src/modules/subscriptions/subscription.routes.ts
//
//   /api/admin/subscriptions   ADMIN only (v1, decision D5): catalogue, vendor
//                              subscriptions, offers, transactions, reports, settings.
//   /api/vendor/subscription   the store owner (VENDOR role) only; the vendor id
//                              comes from the session, never from the request.

import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../middlewares/auth.middleware.ts";
import { actorOf, handle, qInt, qStr, requireVendorOwner, vendorOf } from "./http.ts";
import { subscriptionService, type SubscriptionService } from "./subscription.service.ts";

export function createAdminSubscriptionRouter(get: () => SubscriptionService = subscriptionService) {
  const r = Router();
  r.use(authenticateUser, authorizeRoles("ADMIN"));
  const s = () => get();

  r.get("/overview", handle(async (_req, res) => res.json({ success: true, data: await s().overview() })));
  r.get("/settings", handle(async (_req, res) => res.json({ success: true, data: await s().getSettings({ fresh: true }) })));
  r.put("/settings", handle(async (req, res) => res.json({ success: true, data: await s().setSettings(req.body, actorOf(req)) })));

  r.get("/features", handle(async (_req, res) => res.json({ success: true, data: await s().listFeatures() })));
  r.post("/features", handle(async (req, res) => res.status(201).json({ success: true, data: await s().createFeature(req.body ?? {}, actorOf(req)) })));
  r.patch("/features/:id", handle(async (req, res) => res.json({ success: true, data: await s().updateFeature(req.params.id, req.body ?? {}, actorOf(req)) })));

  r.get("/cycles", handle(async (_req, res) => res.json({ success: true, data: await s().listCycles() })));
  r.post("/cycles", handle(async (req, res) => res.status(201).json({ success: true, data: await s().createCycle(req.body ?? {}, actorOf(req)) })));
  r.patch("/cycles/:id", handle(async (req, res) => res.json({ success: true, data: await s().updateCycle(req.params.id, req.body ?? {}, actorOf(req)) })));

  r.get("/plans", handle(async (req, res) => res.json({ success: true, data: await s().listPackages({ status: qStr(req.query.status) }) })));
  r.post("/plans", handle(async (req, res) => res.status(201).json({ success: true, data: await s().createPackage(req.body ?? {}, actorOf(req)) })));
  r.get("/plans/:id", handle(async (req, res) => res.json({ success: true, data: await s().getPackage(req.params.id) })));
  r.patch("/plans/:id", handle(async (req, res) => res.json({ success: true, data: await s().updatePackage(req.params.id, req.body ?? {}, actorOf(req)) })));
  r.post("/plans/:id/duplicate", handle(async (req, res) => res.status(201).json({ success: true, data: await s().duplicatePackage(req.params.id, actorOf(req)) })));
  r.post("/plans/:id/status", handle(async (req, res) => res.json({ success: true, data: await s().setPackageStatus(req.params.id, String(req.body?.status ?? ""), actorOf(req)) })));
  r.put("/plans/:id/features", handle(async (req, res) => res.json({ success: true, data: await s().setPackageFeatures(req.params.id, req.body?.features, actorOf(req)) })));
  r.put("/plans/:id/prices", handle(async (req, res) => res.json({ success: true, data: await s().setPackagePrices(req.params.id, req.body?.prices, actorOf(req)) })));

  r.get("/vendor-search", handle(async (req, res) => res.json({ success: true, data: await s().searchVendors(qStr(req.query.q)) })));
  r.get("/vendors", handle(async (req, res) => res.json({ success: true, data: await s().listSubscriptions({ state: qStr(req.query.state), q: qStr(req.query.q), packageId: qStr(req.query.packageId), page: qInt(req.query.page), pageSize: qInt(req.query.pageSize) }) })));
  r.get("/vendors/:vendorId", handle(async (req, res) => res.json({ success: true, data: await s().vendorDetailForAdmin(req.params.vendorId) })));
  r.get("/vendors/:vendorId/quote", handle(async (req, res) => {
    const q = await s().quoteFor(req.params.vendorId, String(req.query.packageId ?? ""), String(req.query.cycleId ?? ""), { forAdmin: true });
    res.json({ success: true, data: q.quote });
  }));
  r.post("/vendors/:vendorId/payments", handle(async (req, res) => {
    const out = await s().recordPayment(req.params.vendorId, req.body ?? {}, actorOf(req));
    res.status(out.duplicate ? 200 : 201).json({ success: true, data: out });
  }));
  r.post("/vendors/:vendorId/activate", handle(async (req, res) => res.json({ success: true, data: await s().activate(req.params.vendorId, req.body ?? {}, actorOf(req)) })));
  r.post("/vendors/:vendorId/extend", handle(async (req, res) => res.json({ success: true, data: await s().extend(req.params.vendorId, req.body ?? {}, actorOf(req)) })));
  r.post("/vendors/:vendorId/suspend", handle(async (req, res) => res.json({ success: true, data: await s().suspend(req.params.vendorId, req.body ?? {}, actorOf(req)) })));
  r.post("/vendors/:vendorId/restore", handle(async (req, res) => res.json({ success: true, data: await s().restore(req.params.vendorId, req.body ?? {}, actorOf(req)) })));
  r.post("/vendors/:vendorId/cancel", handle(async (req, res) => res.json({ success: true, data: await s().cancel(req.params.vendorId, req.body ?? {}, actorOf(req)) })));

  r.get("/offers", handle(async (req, res) => res.json({ success: true, data: await s().listOffers({ vendorId: qStr(req.query.vendorId), status: qStr(req.query.status) }) })));
  r.post("/offers", handle(async (req, res) => res.status(201).json({ success: true, data: await s().createOffer(req.body ?? {}, actorOf(req)) })));
  r.post("/offers/:id/:action", handle(async (req, res) => res.json({ success: true, data: await s().setOfferStatus(req.params.id, req.params.action, req.body?.reason, actorOf(req)) })));

  r.get("/transactions", handle(async (req, res) => res.json({ success: true, data: await s().listPayments({ vendorId: qStr(req.query.vendorId), status: qStr(req.query.status), from: qStr(req.query.from), to: qStr(req.query.to), page: qInt(req.query.page), pageSize: qInt(req.query.pageSize) }) })));
  r.post("/transactions/:id/confirm", handle(async (req, res) => res.json({ success: true, data: await s().confirmPayment(req.params.id, req.body ?? {}, actorOf(req)) })));
  r.post("/transactions/:id/status", handle(async (req, res) => res.json({ success: true, data: await s().setPaymentStatus(req.params.id, String(req.body?.status ?? ""), req.body?.reason, actorOf(req)) })));

  return r;
}

export function createVendorSubscriptionRouter(get: () => SubscriptionService = subscriptionService) {
  const r = Router();
  r.use(authenticateUser, requireVendorOwner);
  const s = () => get();

  r.get("/plans", handle(async (req, res) => res.json({ success: true, data: await s().vendorPlans(vendorOf(req)) })));
  r.get("/current", handle(async (req, res) => res.json({ success: true, data: await s().vendorCurrent(vendorOf(req)) })));
  r.get("/payments", handle(async (req, res) => res.json({ success: true, data: await s().vendorPayments(vendorOf(req)) })));
  r.get("/entitlements", handle(async (req, res) => res.json({ success: true, data: await s().entitlementsFor(vendorOf(req)) })));
  r.post("/requests", handle(async (req, res) => {
    const out = await s().vendorRequestPlan(vendorOf(req), req.body ?? {});
    res.status(out.status === "ACTIVE" || !("duplicate" in out && out.duplicate) ? 201 : 200).json({ success: true, data: out });
  }));
  r.post("/requests/:id/cancel", handle(async (req, res) => res.json({ success: true, data: await s().vendorCancelRequest(vendorOf(req), req.params.id) })));
  return r;
}
