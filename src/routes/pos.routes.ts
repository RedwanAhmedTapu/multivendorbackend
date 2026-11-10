// src/routes/pos.routes.ts
//
// Vendor POS. Server-side layers:
//   1. posSessionGate        the signed-in vendor owner, or one of that vendor's
//                            employees holding posAccess (Employee row re-read
//                            every request). No separate POS/terminal login.
//                            ADMIN / admin-side staff / customers are refused.
//                            Sets req.vendorScope + req.posActor.
//   2. requirePosEntitlement on EVERY operational mutation: only ACTIVE / GRACE
//                            subscriptions may operate (402 otherwise).
//   3. per-action grants     posDiscount / posCredit (checked in the service),
//                            posRefund, posReports; store configuration is
//                            owner-only.
// Not behind the entitlement gate: subscription status, plans, checkout
// (renewal) and vendor-scoped historical reads.

import { Router } from "express";
import { PosController } from "../controllers/pos.controller.ts";
import { PosBillingController } from "../controllers/pos-billing.controller.ts";
import { authorizeRoles } from "../middlewares/auth.middleware.ts";
import { posSessionGate, requirePosOwner, requirePosPermission } from "../middlewares/pos-auth.middleware.ts";
import { requirePosEntitlement } from "../middlewares/pos-entitlement.middleware.ts";

const router = Router();
const c = new PosController();
const billing = new PosBillingController();
const operate = requirePosEntitlement;

router.use(...posSessionGate);

// ── billing / renewal (never blocked by expiry) ────────────────────────────
router.get("/subscription", c.getSubscription.bind(c));
router.get("/subscription/plans", billing.listPlans.bind(billing));
router.get("/subscription/payments", authorizeRoles("VENDOR"), billing.listPayments.bind(billing));
router.post("/subscription/checkout", authorizeRoles("VENDOR"), billing.checkout.bind(billing));

// ── who am I at the POS (session-derived) ──────────────────────────────────
router.get("/me", c.me.bind(c));

// ── historical / reference reads (vendor-scoped; available after expiry) ───
router.get("/dashboard", requirePosPermission("posReports"), c.getDashboard.bind(c));
router.get("/sales", c.listSales.bind(c));
router.get("/sales/:id", c.getSale.bind(c));
router.get("/customers", c.listCustomers.bind(c));
router.get("/customers/:id", c.getCustomer.bind(c));
router.get("/bank-accounts", c.listBankAccounts.bind(c));
router.get("/settings", c.getSettings.bind(c));
// Legacy terminal-login records (read-only; kept for historical sale attribution).
router.get("/staff", requirePosOwner, c.listStaff.bind(c));

// ── operational mutations (subscription required) ──────────────────────────
router.get("/variant/lookup/:code", operate, c.lookupVariantByCode.bind(c)); // selling aid
router.get("/products", operate, c.listProducts.bind(c)); // selling aid: own catalog + sellable stock
router.post("/sales", operate, c.createSale.bind(c));
router.post("/sales/:id/refund", operate, requirePosPermission("posRefund"), c.refundSale.bind(c));
router.post("/sales/:id/void", operate, requirePosPermission("posRefund"), c.voidSale.bind(c));
router.post("/sales/:id/pay-due", operate, c.payDue.bind(c));
router.post("/customers", operate, c.createCustomer.bind(c));
router.put("/customers/:id", operate, c.updateCustomer.bind(c));
router.post("/bank-accounts", operate, requirePosOwner, c.createBankAccount.bind(c));
router.put("/settings", operate, requirePosOwner, c.updateSettings.bind(c));

export default router;
