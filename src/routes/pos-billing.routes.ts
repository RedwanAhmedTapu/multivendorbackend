// src/routes/pos-billing.routes.ts
//
// Two routers:
//   posBillingCallbackRoutes  → /api/pos-billing        PUBLIC gateway callbacks.
//       No login (gateways call server-to-server; browser redirects may lack
//       the token). Every handler re-verifies with the gateway's own API
//       before anything changes; the redirect only displays the result.
//   posSubscriptionAdminRoutes → /api/admin/pos-subscriptions
//       ADMIN, or admin-side staff holding posSubscriptionManagement
//       (vendor staff refused). Plan writes, the trial policy and the rollout
//       dry-run are ADMIN only. This permission never grants vendor POS access
//       (the POS router requires posAccess, which only vendor staff can hold).

import { Router, urlencoded } from "express";
import { PosBillingController } from "../controllers/pos-billing.controller.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";
import { blockVendorEmployees, requirePermission } from "../middlewares/permission.middleware.ts";

const c = new PosBillingController();

export const posBillingCallbackRoutes = Router();
// SSLCommerz posts form bodies.
posBillingCallbackRoutes.use(urlencoded({ extended: false, limit: "64kb" }));
posBillingCallbackRoutes.post("/sslcommerz/ipn", c.sslcommerzIpn.bind(c));
for (const p of ["success", "fail", "cancel"]) {
  posBillingCallbackRoutes.post(`/sslcommerz/${p}`, c.sslcommerzReturn.bind(c));
  posBillingCallbackRoutes.get(`/sslcommerz/${p}`, c.sslcommerzReturn.bind(c));
  posBillingCallbackRoutes.get(`/eps/${p}`, c.epsReturn.bind(c));
  posBillingCallbackRoutes.post(`/eps/${p}`, c.epsReturn.bind(c));
}
posBillingCallbackRoutes.get("/paystation/callback", c.paystationCallback.bind(c));
posBillingCallbackRoutes.post("/paystation/callback", c.paystationCallback.bind(c));

export const posSubscriptionAdminRoutes = Router();
const staffOrAdmin = [authorizeRoles("ADMIN", "EMPLOYEE"), blockVendorEmployees, requirePermission("posSubscriptionManagement")];
const adminOnly = [authorizeRoles("ADMIN")];
posSubscriptionAdminRoutes.use(authenticateUser);

posSubscriptionAdminRoutes.get("/policy", ...staffOrAdmin, c.adminGetPolicy.bind(c));
posSubscriptionAdminRoutes.put("/policy", ...adminOnly, c.adminSetPolicy.bind(c));
posSubscriptionAdminRoutes.get("/plans", ...staffOrAdmin, c.adminPlans.bind(c));
posSubscriptionAdminRoutes.post("/plans", ...adminOnly, c.adminCreatePlan.bind(c));
posSubscriptionAdminRoutes.patch("/plans/:planId", ...adminOnly, c.adminUpdatePlan.bind(c));
posSubscriptionAdminRoutes.get("/rollout/dry-run", ...adminOnly, c.adminDryRun.bind(c));

posSubscriptionAdminRoutes.get("/", ...staffOrAdmin, c.adminList.bind(c));
posSubscriptionAdminRoutes.get("/:vendorId", ...staffOrAdmin, c.adminDetail.bind(c));
posSubscriptionAdminRoutes.post("/:vendorId/grant", ...staffOrAdmin, c.adminGrant);
posSubscriptionAdminRoutes.post("/:vendorId/extend", ...staffOrAdmin, c.adminExtend);
posSubscriptionAdminRoutes.post("/:vendorId/revoke", ...staffOrAdmin, c.adminRevoke);
posSubscriptionAdminRoutes.post("/:vendorId/suspend", ...staffOrAdmin, c.adminSuspend);
posSubscriptionAdminRoutes.post("/:vendorId/restore", ...staffOrAdmin, c.adminRestore);
