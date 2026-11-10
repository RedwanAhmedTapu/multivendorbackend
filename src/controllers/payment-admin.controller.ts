// src/controllers/payment-admin.controller.ts
import type { Request, Response } from "express";
import { paymentGatewayService } from "../services/payment-gateway.service.ts";

export class PaymentAdminController {
  /**
   * GET /api/payment/admin/providers
   * List every configured gateway. Secret credential columns are redacted
   * (redactCredential): the UI sees "set / not set", never the values.
   */
  static async listProviders(req: Request, res: Response) {
    try {
      const providers = await paymentGatewayService.getAllProviders();
      res.json({ success: true, data: providers });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/payment/admin/providers
   * Body: { name: "SSLCOMMERZ" | "EPS" | "PAYSTATION", displayName?, productionBaseUrl,
   *         sandboxBaseUrl?, authType: "BASIC" | "TOKEN", priority? }
   * New providers are created inactive — activate separately once
   * credentials are set, so a half-configured gateway never goes live.
   */
  static async createProvider(req: Request, res: Response) {
    try {
      const { name, displayName, description, logo, sandboxBaseUrl, productionBaseUrl, authType, priority } = req.body;

      if (!name || !productionBaseUrl || !authType) {
        return res.status(400).json({ success: false, message: "name, productionBaseUrl and authType are required" });
      }
      if (!["BASIC", "TOKEN"].includes(authType)) {
        return res.status(400).json({ success: false, message: "authType must be BASIC (static credentials) or TOKEN (EPS-style)" });
      }

      const provider = await paymentGatewayService.createProvider({
        name, displayName, description, logo, sandboxBaseUrl, productionBaseUrl, authType, priority,
      });
      res.status(201).json({ success: true, data: provider });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/payment/admin/providers/:providerId/credentials
   * Body for SSLCommerz: { environment, storeId, storePassword }
   * Body for EPS:        { environment, merchantId, storeId, username, password, hashKey }
   * Body for PayStation: { environment, merchantId, password }
   *
   * FIX: merchantId used to be missing from this destructure, so it was
   * silently dropped and never reached the database.
   */
  static async upsertCredential(req: Request, res: Response) {
    try {
      const { providerId } = req.params;
      const { environment, storeId, storePassword, merchantId, username, password, hashKey } = req.body;

      if (!environment || !["SANDBOX", "PRODUCTION"].includes(environment)) {
        return res.status(400).json({ success: false, message: "environment must be SANDBOX or PRODUCTION" });
      }

      const credential = await paymentGatewayService.upsertCredential(providerId, environment, {
        storeId, storePassword, merchantId, username, password, hashKey,
      });
      res.status(201).json({ success: true, data: credential });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PATCH /api/payment/admin/providers/:providerId/activate
   * Makes this the ONE active gateway — deactivates every other one in
   * the same DB transaction, so the storefront never sees two "active"
   * gateways at once. Fails (400) if the gateway's credentials for the
   * current environment are incomplete.
   */
  static async activateProvider(req: Request, res: Response) {
    try {
      const { providerId } = req.params;
      await paymentGatewayService.setActiveProvider(providerId);
      res.json({ success: true, message: "Gateway activated. All other gateways were deactivated." });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  static async deactivateProvider(req: Request, res: Response) {
    try {
      const { providerId } = req.params;
      const result = await paymentGatewayService.deactivateProvider(providerId);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}