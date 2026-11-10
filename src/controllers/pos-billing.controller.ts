// src/controllers/pos-billing.controller.ts
//
// POS subscription billing:
//   - vendor side (mounted under /api/pos behind the session gate): plans,
//     own payment history, checkout (VENDOR owner only);
//   - public gateway callbacks (/api/pos-billing/*): the posted status is a
//     claim — PosSubscriptionService.handleCallback asks the gateway's API;
//   - admin side (/api/admin/pos-subscriptions/*).

import type { Request, Response } from "express";
import { AppError } from "../middlewares/error.middleware.ts";
import type { AuthRequest } from "../middlewares/auth.middleware.ts";
import type { PosRequest } from "../middlewares/pos-auth.middleware.ts";
import { posSubscriptionService, type CallbackOutcome } from "../services/pos-subscription.service.ts";

function fail(res: Response, error: unknown) {
  if (error instanceof AppError) return res.status(error.statusCode).json({ success: false, message: error.message });
  console.error("[pos-billing]", error);
  return res.status(500).json({ success: false, message: "Internal server error" });
}

function actorOf(req: AuthRequest) {
  if (!req.user) throw new AppError("Unauthorized", 401);
  return { rawId: req.user.rawId, role: req.user.role };
}

const RESULT_PAGE = "/vendor-dashboard/pos-billing";

function redirectFor(res: Response, outcome: CallbackOutcome, tranId: unknown) {
  const front = (process.env.FRONTEND_URL ?? "").replace(/\/+$/, "");
  const result = outcome === "unknown" ? "failed" : outcome;
  const ref = typeof tranId === "string" && /^[A-Za-z0-9]{1,64}$/.test(tranId) ? `&ref=${tranId}` : "";
  // The redirect only DISPLAYS the verified outcome; it never changes state.
  return res.redirect(`${front}${RESULT_PAGE}?result=${result}${ref}`);
}

export class PosBillingController {
  // ── vendor ────────────────────────────────────────────────────────────────
  async listPlans(_req: PosRequest, res: Response) {
    try {
      res.json({ success: true, data: await posSubscriptionService.listPlans() });
    } catch (e) {
      fail(res, e);
    }
  }

  async listPayments(req: PosRequest, res: Response) {
    try {
      if (!req.vendorScope) throw new AppError("Forbidden", 403);
      res.json({ success: true, data: await posSubscriptionService.listVendorPayments(req.vendorScope) });
    } catch (e) {
      fail(res, e);
    }
  }

  async checkout(req: PosRequest, res: Response) {
    try {
      if (!req.vendorScope || req.user?.role !== "VENDOR") throw new AppError("Only the store owner can buy a POS plan", 403);
      const data = await posSubscriptionService.startCheckout(req.vendorScope, { rawId: req.user.rawId }, req.body?.planId);
      res.status(201).json({ success: true, data });
    } catch (e) {
      fail(res, e);
    }
  }

  // ── public gateway callbacks ──────────────────────────────────────────────
  async sslcommerzIpn(req: Request, res: Response) {
    try {
      const outcome = await posSubscriptionService.handleCallback("SSLCOMMERZ", req.body?.tran_id, { valId: req.body?.val_id });
      res.status(200).json({ received: true, outcome });
    } catch (e) {
      console.error("[pos-billing] ipn", e);
      res.status(200).json({ received: true, outcome: "pending" });
    }
  }

  async sslcommerzReturn(req: Request, res: Response) {
    const tranId = req.body?.tran_id ?? req.query?.tran_id;
    try {
      const outcome = await posSubscriptionService.handleCallback("SSLCOMMERZ", tranId, { valId: req.body?.val_id ?? req.query?.val_id });
      redirectFor(res, outcome, tranId);
    } catch {
      redirectFor(res, "pending", tranId);
    }
  }

  async epsReturn(req: Request, res: Response) {
    const tranId = req.query?.merchantTransactionId ?? req.body?.merchantTransactionId;
    try {
      redirectFor(res, await posSubscriptionService.handleCallback("EPS", tranId), tranId);
    } catch {
      redirectFor(res, "pending", tranId);
    }
  }

  async paystationCallback(req: Request, res: Response) {
    const tranId = req.query?.invoice_number ?? req.body?.invoice_number;
    try {
      redirectFor(res, await posSubscriptionService.handleCallback("PAYSTATION", tranId), tranId);
    } catch {
      redirectFor(res, "pending", tranId);
    }
  }

  // ── admin ─────────────────────────────────────────────────────────────────
  async adminList(req: AuthRequest, res: Response) {
    try {
      res.json({ success: true, ...(await posSubscriptionService.listForAdmin(req.query as Record<string, unknown>)) });
    } catch (e) {
      fail(res, e);
    }
  }

  async adminDetail(req: AuthRequest, res: Response) {
    try {
      res.json({ success: true, data: await posSubscriptionService.detailForAdmin(req.params.vendorId) });
    } catch (e) {
      fail(res, e);
    }
  }

  private lifecycle(op: "grant" | "extend" | "revoke" | "suspend" | "restore") {
    return async (req: AuthRequest, res: Response) => {
      try {
        const saved = await posSubscriptionService[op](req.params.vendorId, req.body ?? {}, actorOf(req));
        res.json({ success: true, data: saved });
      } catch (e) {
        fail(res, e);
      }
    };
  }
  adminGrant = this.lifecycle("grant");
  adminExtend = this.lifecycle("extend");
  adminRevoke = this.lifecycle("revoke");
  adminSuspend = this.lifecycle("suspend");
  adminRestore = this.lifecycle("restore");

  async adminPlans(req: AuthRequest, res: Response) {
    try {
      res.json({ success: true, data: await posSubscriptionService.listPlans({ includeInactive: true }) });
    } catch (e) {
      fail(res, e);
    }
  }

  async adminCreatePlan(req: AuthRequest, res: Response) {
    try {
      res.status(201).json({ success: true, data: await posSubscriptionService.createPlan(req.body ?? {}, actorOf(req)) });
    } catch (e) {
      fail(res, e);
    }
  }

  async adminUpdatePlan(req: AuthRequest, res: Response) {
    try {
      res.json({ success: true, data: await posSubscriptionService.updatePlan(req.params.planId, req.body ?? {}, actorOf(req)) });
    } catch (e) {
      fail(res, e);
    }
  }

  async adminGetPolicy(_req: AuthRequest, res: Response) {
    try {
      res.json({ success: true, data: await posSubscriptionService.getPolicy(undefined, { fresh: true }) });
    } catch (e) {
      fail(res, e);
    }
  }

  async adminSetPolicy(req: AuthRequest, res: Response) {
    try {
      res.json({ success: true, data: await posSubscriptionService.setPolicy(req.body, actorOf(req)) });
    } catch (e) {
      fail(res, e);
    }
  }

  async adminDryRun(_req: AuthRequest, res: Response) {
    try {
      res.json({ success: true, data: await posSubscriptionService.rolloutDryRun() });
    } catch (e) {
      fail(res, e);
    }
  }
}
