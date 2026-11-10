// src/routes/courierWebhook.routes.ts
//
// 1C-11 (B3): canonical provider webhook surface. These are the routes
// courier providers should be configured to call. Each request passes:
//   provider verification (Pathao signature / RedX callback token)
//   → provider payload normalization (status + shipmentKind mapping)
//   → AdminOrderController.handleCourierWebhook → processCourierStatusUpdate
// No application JWT applies to provider callbacks; authentication is the
// provider-specific secret checked against the DB-stored credential.
import { Router } from "express";
import { verifyPathaoSignature, verifyRedxToken } from "../middlewares/webhook.middleware.ts";
import { normalizePathaoWebhook, normalizeRedxWebhook } from "../middlewares/courier-normalizer.middleware.ts";
import { AdminOrderController } from "../controllers/admin.order.controller.ts";

const router = Router();

// POST /api/webhooks/pathao — Pathao merchant webhook (signature-verified)
router.post(
  "/pathao",
  verifyPathaoSignature,
  normalizePathaoWebhook,
  AdminOrderController.handleCourierWebhook.bind(AdminOrderController),
);

// POST /api/webhooks/redx?token=… — RedX delivery callback (token-verified)
router.post(
  "/redx",
  verifyRedxToken,
  normalizeRedxWebhook,
  AdminOrderController.handleCourierWebhook.bind(AdminOrderController),
);

export default router;
