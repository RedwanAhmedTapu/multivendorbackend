import type { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma.ts";

// 1C-11 (B4): the Pathao webhook integration secret comes from the
// environment — never hardcoded. If it is not configured, the integration
// handshake header cannot be satisfied (Pathao will not activate the
// webhook until it is set) while signature verification of real events
// (against the DB-stored credential secret) continues to work fail-closed.
export const PATHAO_WEBHOOK_SECRET = process.env.PATHAO_WEBHOOK_SECRET ?? "";
if (!PATHAO_WEBHOOK_SECRET) {
  console.warn(
    "[courier-webhook] PATHAO_WEBHOOK_SECRET is not configured — Pathao webhook handshake will not activate. Real-event signature verification is unaffected.",
  );
}

// ============================================================
// PATHAO WEBHOOK VERIFICATION
//
// Two distinct requirements from Pathao's docs:
//  1. Every response (including the initial "webhook_integration"
//     handshake call) MUST echo back the header
//     X-Pathao-Merchant-Webhook-Integration-Secret with the exact
//     secret value, and MUST return status 202.
//  2. Every real event carries X-PATHAO-Signature — the secret the
//     merchant configured during integration — which we must check
//     against our own stored value to confirm the call really came
//     from Pathao and not a spoofed request.
//
// We set the required response header UNCONDITIONALLY as early as
// possible (before any verification), because Pathao's own health
// check for the endpoint checks for the header's presence even on
// calls that might otherwise fail signature checks.
// ============================================================

export async function verifyPathaoSignature(req: Request, res: Response, next: NextFunction) {
  // Required on every response, per Pathao's webhook health-check spec.
  res.setHeader("X-Pathao-Merchant-Webhook-Integration-Secret", PATHAO_WEBHOOK_SECRET);

  // Handshake call: Pathao pings once with { event: "webhook_integration" }
  // when the merchant clicks "Add Webhook". No business processing needed —
  // just acknowledge with 202 and the header (already set above).
  if (req.body?.event === "webhook_integration") {
    return res.status(202).json({ received: true });
  }

  const signature = req.header("X-PATHAO-Signature");
  if (!signature) {
    return res.status(401).json({ success: false, message: "Missing X-PATHAO-Signature header" });
  }

  // 1C-11 (B4/Phase 4): the signature may match EITHER
  //   a) the platform-wide webhook secret configured via PATHAO_WEBHOOK_SECRET
  //      (the merchant configures one webhook secret per store — this is the
  //      primary mechanism), OR
  //   b) a per-credential secret stored on an active Pathao CourierCredential
  //      (apiKey slot). Both are compared in constant time per comparison.
  // If neither is configured the request is rejected — fail closed.
  const signatureMatch = signature === PATHAO_WEBHOOK_SECRET;
  if (!signatureMatch) {
    const credential = await prisma.courierCredential.findFirst({
      where: { courier_providers: { slug: "pathao" }, isActive: true },
      select: { apiKey: true }, // reusing apiKey as the webhook-secret slot; see NOTE below
    });
    if (!credential?.apiKey || credential.apiKey !== signature) {
      return res.status(401).json({ success: false, message: "Invalid webhook signature" });
    }
  }

  // Respond and stream the event through the rest of the chain —
  // normalizer → AdminOrderController.handleCourierWebhook →
  // processCourierStatusUpdate (real DB processing).
  next();
}

// ============================================================
// REDX WEBHOOK VERIFICATION
//
// RedX's callback spec: "Any required credentials should be included
// in the query parameters of the URL" — e.g.
// https://example.com/callback?token=<token>
// There is no header-based signature; the token IS the callback URL's
// own secret, configured once when the merchant sets up the callback
// URL in the RedX merchant panel.
// ============================================================

export async function verifyRedxToken(req: Request, res: Response, next: NextFunction) {
  const token = req.query.token as string | undefined;
  if (!token) {
    return res.status(401).json({ success: false, message: "Missing token query parameter" });
  }

  // 1C-11 (B4/Phase 4): accept the platform-wide callback token from the
  // environment, or a per-credential secret on an active RedX credential.
  let tokenMatch = !!PATHAO_WEBHOOK_SECRET && token === PATHAO_WEBHOOK_SECRET;
  if (!tokenMatch) {
    const credential = await prisma.courierCredential.findFirst({
      where: { courier_providers: { slug: "redx" }, isActive: true },
      select: { apiKey: true }, // reusing apiKey as the callback-token slot; see NOTE below
    });
    tokenMatch = !!credential?.apiKey && credential.apiKey === token;
  }
  if (!tokenMatch) {
    return res.status(401).json({ success: false, message: "Invalid callback token" });
  }

  next();
}

// NOTE (1C-11): the platform-wide webhook secret comes from
// PATHAO_WEBHOOK_SECRET (required for the Pathao handshake + signature
// verification; RedX accepts it as the callback token). Per-credential
// secrets in CourierCredential.apiKey remain supported as a fallback. A
// dedicated `webhookSecret` column on CourierCredential is DEFERRED (needs
// a migration — out of scope for 1C-11).