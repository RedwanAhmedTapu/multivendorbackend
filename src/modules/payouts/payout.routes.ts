// src/modules/payouts/payout.routes.ts
//
//   /api/admin/payouts   ADMIN only (v1): policy, vendor rules / holds, preview,
//                        batches (draft → approve → mark paid per item), lists, audit.
//   /api/vendor/payouts  the store owner's own payout summary and history.
// The legacy /api/payout routes (disabled processor, 410) are untouched.

import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../middlewares/auth.middleware.ts";
import { actorOf, handle, qInt, qStr, requireVendorOwner, vendorOf } from "../subscriptions/http.ts";
import { payoutService, type PayoutService } from "./payout.service.ts";

export function createAdminPayoutRouter(get: () => PayoutService = payoutService) {
  const r = Router();
  r.use(authenticateUser, authorizeRoles("ADMIN"));
  const s = () => get();

  r.get("/overview", handle(async (_req, res) => res.json({ success: true, data: await s().overview() })));
  r.get("/policy", handle(async (_req, res) => res.json({ success: true, data: await s().getPolicy() })));
  r.put("/policy", handle(async (req, res) => res.json({ success: true, data: await s().setPolicy(req.body, actorOf(req)) })));

  r.get("/rules", handle(async (_req, res) => res.json({ success: true, data: await s().listRules() })));
  r.put("/rules/:vendorId", handle(async (req, res) => res.json({ success: true, data: await s().setRule(req.params.vendorId, req.body ?? {}, actorOf(req)) })));
  r.post("/vendors/:vendorId/:action", handle(async (req, res) => {
    const action = req.params.action;
    if (!["hold", "release", "pause", "resume"].includes(action)) {
      res.status(404).json({ success: false, code: "NOT_FOUND", message: "Unknown action" });
      return;
    }
    res.json({ success: true, data: await s().setVendorState(req.params.vendorId, action as "hold", req.body ?? {}, actorOf(req)) });
  }));
  r.get("/vendors/:vendorId/eligibility", handle(async (req, res) => res.json({ success: true, data: await s().eligibilityFor(req.params.vendorId) })));

  r.get("/preview", handle(async (req, res) => res.json({ success: true, data: await s().preview({ onlyDue: req.query.onlyDue === "1" || req.query.onlyDue === "true", date: qStr(req.query.date) }) })));

  r.get("/batches", handle(async (req, res) => res.json({ success: true, data: await s().listBatches({ status: qStr(req.query.status) }) })));
  r.post("/batches", handle(async (req, res) => res.status(201).json({ success: true, data: await s().createBatch(req.body ?? {}, actorOf(req)) })));
  r.get("/batches/:id", handle(async (req, res) => res.json({ success: true, data: await s().getBatch(req.params.id) })));
  r.post("/batches/:id/approve", handle(async (req, res) => res.json({ success: true, data: await s().approveBatch(req.params.id, actorOf(req)) })));
  r.post("/batches/:id/cancel", handle(async (req, res) => res.json({ success: true, data: await s().cancelBatch(req.params.id, req.body?.reason, actorOf(req)) })));

  r.get("/items", handle(async (req, res) => res.json({ success: true, data: await s().listItems({ status: qStr(req.query.status), vendorId: qStr(req.query.vendorId), page: qInt(req.query.page), pageSize: qInt(req.query.pageSize) }) })));
  r.post("/items/:id/hold", handle(async (req, res) => res.json({ success: true, data: await s().holdItem(req.params.id, req.body?.reason, actorOf(req)) })));
  r.post("/items/:id/release", handle(async (req, res) => res.json({ success: true, data: await s().releaseItem(req.params.id, actorOf(req)) })));
  r.post("/items/:id/cancel", handle(async (req, res) => res.json({ success: true, data: await s().cancelItem(req.params.id, req.body?.reason, actorOf(req)) })));
  r.post("/items/:id/mark-paid", handle(async (req, res) => res.json({ success: true, data: await s().markItemPaid(req.params.id, req.body ?? {}, actorOf(req)) })));

  r.get("/audit", handle(async (req, res) => res.json({ success: true, data: await s().listAudit({ entity: qStr(req.query.entity), entityId: qStr(req.query.entityId) }) })));
  return r;
}

export function createVendorPayoutRouter(get: () => PayoutService = payoutService) {
  const r = Router();
  r.use(authenticateUser, requireVendorOwner);
  r.get("/summary", handle(async (req, res) => res.json({ success: true, data: await get().vendorSummary(vendorOf(req)) })));
  return r;
}
