// src/modules/marketing/vendor-campaign.routes.ts
//
// Vendor campaign-registration API, mounted at /api/marketing/vendor.
// Router-level guard for EVERY route:
//   authenticateUser → requireVendorPermission("offerManagement")
// VENDOR owners pass; vendor staff need offerManagement (active, same
// vendor); ADMIN, admin-side staff and customers are refused (403);
// anonymous → 401. The vendor id comes only from the authenticated identity.

import { Router } from "express";
import { prisma } from "../../config/prisma.ts";
import { authenticateUser } from "../../middlewares/auth.middleware.ts";
import { requireVendorPermission } from "../../middlewares/permission.middleware.ts";
import type { MarketingDb } from "./campaign.service.ts";
import { createVendorCampaignService } from "./vendor-campaign.service.ts";
import { createVendorCampaignController } from "./vendor-campaign.controller.ts";

export function createMarketingVendorRouter(db: MarketingDb = prisma as unknown as MarketingDb) {
  const router = Router();
  const c = createVendorCampaignController(createVendorCampaignService(db));

  router.use(authenticateUser, requireVendorPermission("offerManagement"));

  router.get("/campaigns", c.listCampaigns);
  router.get("/campaigns/:id", c.getCampaign);
  router.post("/campaigns/:id/registrations", c.register);
  router.get("/registrations", c.listRegistrations);
  router.patch("/registrations/:id", c.editRegistration);
  router.post("/registrations/:id/withdraw", c.withdrawRegistration);

  return router;
}

export default createMarketingVendorRouter();
