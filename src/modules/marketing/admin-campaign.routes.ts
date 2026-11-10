// src/modules/marketing/admin-campaign.routes.ts
//
// Admin Marketing Center API (vendor programmes of campaign pages), mounted at
// /api/marketing/admin. Router-level guard for EVERY route:
//   authenticateUser → authorizeRoles("ADMIN","EMPLOYEE") → blockVendorEmployees
//   → requirePermission("marketingManagement")
// ADMIN passes; admin-side staff need marketingManagement; vendor owners,
// vendor staff and customers are refused (403); anonymous → 401.
// The page builder itself stays on /api/campaigns (ADMIN only).

import { Router } from "express";
import { prisma } from "../../config/prisma.ts";
import { authenticateUser, authorizeRoles } from "../../middlewares/auth.middleware.ts";
import { blockVendorEmployees, requirePermission } from "../../middlewares/permission.middleware.ts";
import { createCampaignService, type MarketingDb } from "./campaign.service.ts";
import { createAdminCampaignController } from "./admin-campaign.controller.ts";

export function createMarketingAdminRouter(db: MarketingDb = prisma as unknown as MarketingDb) {
  const router = Router();
  const c = createAdminCampaignController(createCampaignService(db));

  router.use(authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), blockVendorEmployees, requirePermission("marketingManagement"));

  // Campaign pages + programme summary (staff list; badges on the admin list).
  router.get("/campaign-pages", c.listPages);
  router.get("/campaign-pages/:pageId/programme", c.getProgramme);
  router.post("/campaign-pages/:pageId/programme", c.createProgramme);

  router.patch("/programmes/:id", c.updateProgramme);
  router.post("/programmes/:id/publish", c.publish);
  router.post("/programmes/:id/cancel", c.cancel);
  router.get("/programmes/:id/registrations", c.listRegistrations);
  router.post("/programmes/:id/registrations/bulk-review", c.bulkReview);
  router.post("/registrations/:id/approve", c.approve);
  router.post("/registrations/:id/reject", c.reject);

  return router;
}

export default createMarketingAdminRouter();
