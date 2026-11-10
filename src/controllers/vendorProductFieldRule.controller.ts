// controllers/vendorProductFieldRule.controller.ts
import type { Response } from "express";
import { VendorProductFieldRuleService } from "../services/vendorProductFieldRule.service.ts";
import type { AuthRequest } from "../middlewares/auth.middleware.ts";

export const VendorProductFieldRuleController = {
  // ======================
  // ADMIN: list rules for a vendor
  // ======================
  async adminGetByVendor(req: AuthRequest, res: Response) {
    try {
      const { vendorId } = req.params;
      const { categoryId } = req.query;

      const rules = await VendorProductFieldRuleService.getByVendorId(
        vendorId,
        categoryId as string | undefined
      );

      return res.json({ success: true, data: rules });
    } catch (error: any) {
      console.error("Error fetching vendor product field rules:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch vendor product field rules",
      });
    }
  },

  // ======================
  // ADMIN: available ProductField options for the settings UI
  // ======================
  async adminGetFields(_req: AuthRequest, res: Response) {
    try {
      const fields = VendorProductFieldRuleService.getAvailableFields();
      return res.json({ success: true, data: fields });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch available fields",
      });
    }
  },

  // ======================
  // ADMIN: upsert a single field rule
  // ======================
  async adminUpsert(req: AuthRequest, res: Response) {
    try {
      const { vendorId } = req.params;
      const { categoryId = null, field, isEnabled, isRequired } = req.body;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }
      if (!field) {
        return res.status(400).json({ success: false, message: "`field` is required" });
      }

      const rule = await VendorProductFieldRuleService.upsert(
        vendorId,
        categoryId,
        field,
        { isEnabled, isRequired },
        adminId
      );

      return res.json({
        success: true,
        data: rule,
        message: "Vendor product field rule saved",
      });
    } catch (error: any) {
      console.error("Error saving vendor product field rule:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to save vendor product field rule",
      });
    }
  },

  // ======================
  // ADMIN: bulk upsert (save the whole form at once)
  // ======================
  async adminBulkUpsert(req: AuthRequest, res: Response) {
    try {
      const { vendorId } = req.params;
      const { categoryId = null, rules } = req.body;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }
      if (!Array.isArray(rules) || rules.length === 0) {
        return res.status(400).json({
          success: false,
          message: "`rules` must be a non-empty array of { field, isEnabled?, isRequired? }",
        });
      }

      const savedRules = await VendorProductFieldRuleService.bulkUpsert(
        vendorId,
        categoryId,
        rules,
        adminId
      );

      return res.json({
        success: true,
        data: savedRules,
        message: "Vendor product field rules saved",
      });
    } catch (error: any) {
      console.error("Error bulk saving vendor product field rules:", error);
      return res.status(400).json({
        success: false,
        message: error.message || "Failed to save vendor product field rules",
      });
    }
  },

  // ======================
  // ADMIN: remove a rule
  // ======================
  async adminRemove(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      await VendorProductFieldRuleService.remove(id);

      return res.json({ success: true, message: "Vendor product field rule removed" });
    } catch (error: any) {
      console.error("Error removing vendor product field rule:", error);

      if (error.message === "Vendor product field rule not found") {
        return res.status(404).json({ success: false, message: error.message });
      }

      return res.status(400).json({
        success: false,
        message: error.message || "Failed to remove vendor product field rule",
      });
    }
  },

  // ======================
  // VENDOR: resolved settings for building the add/edit product form
  // ======================
  async vendorGetMyRules(req: AuthRequest, res: Response) {
    try {
      const vendorId = req.user?.vendorId; // adjust to however vendorId is exposed on req.user
      const { categoryId } = req.query;

      if (!vendorId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const resolved = await VendorProductFieldRuleService.getResolvedForVendor(
        vendorId,
        categoryId as string | undefined
      );

      return res.json({ success: true, data: resolved });
    } catch (error: any) {
      console.error("Error fetching resolved product field rules:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch product field rules",
      });
    }
  },
  // ======================
// ADMIN: list all configured vendor/scope assignments (searchable)
// ======================
async adminListScopes(req: AuthRequest, res: Response) {
  try {
    const { search, page = "1", limit = "20" } = req.query;

    const result = await VendorProductFieldRuleService.getAllScopes({
      search: search as string,
      page: parseInt(page as string, 10),
      limit: parseInt(limit as string, 10),
    });

    return res.json({
      success: true,
      data: result.scopes,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (error: any) {
    console.error("Error listing permission scopes:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to list permission scopes",
    });
  }
},

// ======================
// ADMIN: remove every field rule for one vendor/scope pair
// ======================
async adminRemoveScope(req: AuthRequest, res: Response) {
  try {
    const { vendorId } = req.params;
    const { categoryId = null } = req.body;

    const result = await VendorProductFieldRuleService.removeByScope(vendorId, categoryId);

    return res.json({
      success: true,
      message: `Removed ${result.count} field rule(s) for this scope`,
    });
  } catch (error: any) {
    console.error("Error removing permission scope:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to remove permission scope",
    });
  }
},
};