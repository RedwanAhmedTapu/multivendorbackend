// src/modules/marketing/vendor-campaign.controller.ts
// Vendor campaign-registration API handlers: validate input (zod), call the
// service with the vendor id from the authenticated identity
// (req.vendorScope, set by requireVendorPermission) — never from the request —
// and map MarketingError → HTTP (shared with the admin controller).

import type { AuthRequest } from "../../middlewares/auth.middleware.ts";
import { MarketingError } from "./campaign.service.ts";
import type { VendorCampaignService } from "./vendor-campaign.service.ts";
import { actorOf, handle, parse } from "./admin-campaign.controller.ts";
import {
  vendorCampaignDetailQuery,
  vendorEditRegistrationSchema,
  vendorListCampaignsQuery,
  vendorListRegistrationsQuery,
  vendorRegisterSchema,
  vendorWithdrawSchema,
} from "./campaign.validators.ts";

const vendorOf = (req: AuthRequest) => {
  const vendorId = (req as AuthRequest & { vendorScope?: string }).vendorScope;
  if (!vendorId) throw new MarketingError(400, "Missing vendor scope");
  return vendorId;
};

export function createVendorCampaignController(service: VendorCampaignService) {
  return {
    listCampaigns: handle(async (req, res) => {
      const result = await service.listCampaigns(vendorOf(req), parse(vendorListCampaignsQuery, req.query));
      res.json({ success: true, data: result.items, earliestEndAt: result.earliestEndAt, pagination: result.pagination });
    }),
    getCampaign: handle(async (req, res) => {
      const result = await service.getCampaign(vendorOf(req), req.params.id, parse(vendorCampaignDetailQuery, req.query));
      res.json({ success: true, data: { campaign: result.campaign, variants: result.variants }, pagination: result.pagination });
    }),
    register: handle(async (req, res) => {
      const { items } = parse(vendorRegisterSchema, req.body);
      const result = await service.register(actorOf(req), vendorOf(req), req.params.id, items);
      res.status(result.created.length ? 201 : 200).json({ success: true, data: result });
    }),
    listRegistrations: handle(async (req, res) => {
      const result = await service.listMyRegistrations(vendorOf(req), parse(vendorListRegistrationsQuery, req.query));
      res.json({ success: true, data: result.items, pagination: result.pagination });
    }),
    editRegistration: handle(async (req, res) => {
      const patch = parse(vendorEditRegistrationSchema, req.body);
      res.json({ success: true, data: await service.editRegistration(actorOf(req), vendorOf(req), req.params.id, patch) });
    }),
    withdrawRegistration: handle(async (req, res) => {
      const { reason } = parse(vendorWithdrawSchema, req.body);
      res.json({ success: true, data: await service.withdrawRegistration(actorOf(req), vendorOf(req), req.params.id, reason) });
    }),
  };
}
