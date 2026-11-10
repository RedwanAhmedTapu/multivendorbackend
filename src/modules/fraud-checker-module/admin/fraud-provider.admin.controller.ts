import type { Request, Response } from "express";
import { fraudProviderAdminService } from "./fraud-provider.admin.service.ts";
import { fraudCheckerService } from "../fraud-checker.service.ts";

export class FraudProviderAdminController {
  /** GET /admin/fraud-providers/available — adapters known to the code, for the "Add" dropdown. */
  async listAvailable(req: Request, res: Response) {
    const data = await fraudProviderAdminService.listAvailableAdapters();
    return res.json({ success: true, data });
  }

  /** GET /admin/fraud-providers — configured provider rows, credentials masked. */
  async list(req: Request, res: Response) {
    const data = await fraudProviderAdminService.listProviders();
    return res.json({ success: true, data });
  }

  /** GET /admin/fraud-providers/:id */
  async getById(req: Request, res: Response) {
    try {
      const data = await fraudProviderAdminService.getProvider(req.params.id);
      return res.json({ success: true, data });
    } catch (error: any) {
      return res.status(404).json({ success: false, error: "Provider not found" });
    }
  }

  /**
   * POST /admin/fraud-providers
   * Body: { slug, name, baseUrl?, isActive?, priority?, fallbackOnError?, credentials, configJson? }
   * `credentials` is plaintext in the request body over HTTPS — it is
   * encrypted server-side before touching the database and is never
   * echoed back in plaintext in the response.
   */
  async create(req: Request, res: Response) {
    try {
      const { slug, name, credentials } = req.body;
      if (!slug || !name || !credentials) {
        return res.status(400).json({ success: false, error: "slug, name and credentials are required" });
      }
      const data = await fraudProviderAdminService.createProvider({
        ...req.body,
        createdById: req.user?.rawId,
      });
      return res.status(201).json({ success: true, data });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  /** PATCH /admin/fraud-providers/:id — any subset of fields; credentials only re-encrypted if sent. */
  async update(req: Request, res: Response) {
    try {
      const data = await fraudProviderAdminService.updateProvider(req.params.id, req.body);
      return res.json({ success: true, data });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  /** PATCH /admin/fraud-providers/:id/active — Body: { isActive: boolean } */
  async setActive(req: Request, res: Response) {
    try {
      const { isActive } = req.body;
      if (typeof isActive !== "boolean") {
        return res.status(400).json({ success: false, error: "isActive (boolean) is required" });
      }
      const data = await fraudProviderAdminService.setActive(req.params.id, isActive);
      return res.json({ success: true, data });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  /** DELETE /admin/fraud-providers/:id */
  async remove(req: Request, res: Response) {
    try {
      const data = await fraudProviderAdminService.deleteProvider(req.params.id);
      return res.json({ success: true, data });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  /**
   * POST /admin/fraud-providers/:id/test
   * Body: { phone: "01712345678" }
   * Runs one live call against this specific provider (bypassing
   * priority/fallback) so the admin can confirm the credentials work
   * right after saving them.
   */
  async testConnection(req: Request, res: Response) {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ success: false, error: "phone is required" });

      const result = await fraudCheckerService.testProvider(req.params.id, phone);
      return res.json({ success: true, data: result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  /** GET /admin/fraud-providers/:id/logs — recent success/failure history for the dashboard. */
  async getLogs(req: Request, res: Response) {
    const limit = Math.min(200, parseInt(req.query.limit as string) || 50);
    const data = await fraudProviderAdminService.getProviderLogs(req.params.id, limit);
    return res.json({ success: true, data });
  }
}
