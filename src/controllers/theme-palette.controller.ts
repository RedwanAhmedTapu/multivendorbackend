// controllers/theme-palette.controller.ts
//
// Theme palette endpoints (/api/themes/palette…, /palettes…, /assignments…,
// /vendor…, /me/preference). Response envelope matches the existing
// versioned-setting controllers: { success, data, message? } on success,
// { success: false, error, code, issues? } on failure.
//
// Vendor identity NEVER comes from the client: storefront handlers read
// req.vendorScope, set by requireVendorScope from the authenticated session.
import type { Request, Response } from 'express';
import type { AuthRequest } from '../middlewares/auth.middleware.ts';
import * as service from '../services/theme-palette.service.ts';
import { ThemePaletteError } from '../services/theme-palette.service.ts';
import { vendorThemePolicyService } from '../services/theme-vendor-policy.service.ts';
import {
  createPaletteBodySchema,
  customerPreferenceBodySchema,
  publishPaletteBodySchema,
  rollbackBodySchema,
  updatePaletteBodySchema,
  upsertAssignmentBodySchema,
  vendorStorefrontPaletteBodySchema,
} from '../validators/theme-palette.validator.ts';
import type { z } from 'zod';

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof ThemePaletteError) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
      code: error.code,
      ...(error.issues ? { issues: error.issues } : {}),
    });
  }
  console.error(`[theme-palette] ${fallback}:`, error);
  return res.status(500).json({ success: false, error: fallback });
}

function badRequest(res: Response, message: string, issues: { path: string; message: string }[]) {
  return res.status(400).json({ success: false, error: message, code: 'INVALID_BODY', issues });
}

function parseBody<S extends z.ZodType>(
  res: Response,
  schema: S,
  body: unknown,
  hint: string,
): z.infer<S> | null {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    badRequest(res, hint, parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    return null;
  }
  return parsed.data as z.infer<S>;
}

const actorOf = (req: Request): service.Actor => ({ userId: (req as AuthRequest).user?.rawId ?? null });

export class ThemePaletteController {
  // ── public ────────────────────────────────────────────────────────────────

  /** GET /palette/active?scope=…&scopeId=/vendorId=… — published only; falls
   *  back to the built-in Neutral preset; never fails. */
  async getActivePalette(req: Request, res: Response) {
    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'PLATFORM_WEBSITE';
    const valid = ['PLATFORM_WEBSITE', 'ADMIN_DASHBOARD', 'VENDOR_DASHBOARD', 'VENDOR_STOREFRONT', 'CUSTOMER_DEFAULT'];
    if (!valid.includes(scope)) {
      return res.status(400).json({ success: false, error: `scope must be one of ${valid.join(', ')}`, code: 'INVALID_SCOPE' });
    }
    // VENDOR_STOREFRONT reads are keyed by vendor id from the query (public
    // storefront pages are anonymous); every other scope ignores scopeId.
    const scopeId =
      scope === 'VENDOR_STOREFRONT'
        ? ((typeof req.query.vendorId === 'string' && req.query.vendorId) ||
            (typeof req.query.scopeId === 'string' && req.query.scopeId) ||
            '')
        : '';
    const data = await service.getActivePalette(scope, scopeId);
    res.json({ success: true, data });
  }

  // ── admin: palette CRUD + lifecycle ────────────────────────────────────────

  async listPalettes(req: Request, res: Response) {
    try {
      res.json({ success: true, data: await service.listPalettes() });
    } catch (error) {
      sendError(res, error, 'Failed to list palettes');
    }
  }

  async getPalette(req: Request, res: Response) {
    try {
      res.json({ success: true, data: await service.getPalette(req.params.id as string) });
    } catch (error) {
      sendError(res, error, 'Failed to load palette');
    }
  }

  async listVersions(req: Request, res: Response) {
    try {
      res.json({ success: true, data: await service.listVersions(req.params.id as string) });
    } catch (error) {
      sendError(res, error, 'Failed to load palette versions');
    }
  }

  async createPalette(req: Request, res: Response) {
    const body = parseBody(res, createPaletteBodySchema, req.body, 'Body must be { name, description?, tokens, darkTokens? }');
    if (!body) return;
    try {
      const row = await service.createPalette(body, actorOf(req));
      res.status(201).json({ success: true, data: row, message: 'Palette created as draft' });
    } catch (error) {
      sendError(res, error, 'Failed to create palette');
    }
  }

  async updatePalette(req: Request, res: Response) {
    const body = parseBody(res, updatePaletteBodySchema, req.body, 'Body may contain { name, description, tokens, darkTokens, expectedUpdatedAt }');
    if (!body) return;
    try {
      const row = await service.updatePalette(req.params.id as string, body, actorOf(req));
      res.json({ success: true, data: row, message: 'Palette updated' });
    } catch (error) {
      sendError(res, error, 'Failed to update palette');
    }
  }

  async duplicatePalette(req: Request, res: Response) {
    try {
      const row = await service.duplicatePalette(req.params.id as string, actorOf(req));
      res.status(201).json({ success: true, data: row, message: 'Palette duplicated as draft' });
    } catch (error) {
      sendError(res, error, 'Failed to duplicate palette');
    }
  }

  async publishPalette(req: Request, res: Response) {
    const body = parseBody(res, publishPaletteBodySchema, req.body ?? undefined, 'Body must be empty or { note }');
    if (body === null) return;
    try {
      const row = await service.publishPalette(req.params.id as string, body ?? {}, actorOf(req));
      res.json({ success: true, data: row, message: `Palette published as version ${row.version}` });
    } catch (error) {
      sendError(res, error, 'Failed to publish palette');
    }
  }

  async archivePalette(req: Request, res: Response) {
    try {
      const row = await service.archivePalette(req.params.id as string, actorOf(req));
      res.json({ success: true, data: row, message: 'Palette archived' });
    } catch (error) {
      sendError(res, error, 'Failed to archive palette');
    }
  }

  async deletePalette(req: Request, res: Response) {
    try {
      await service.deletePalette(req.params.id as string, actorOf(req));
      res.json({ success: true, data: { deleted: true }, message: 'Palette deleted' });
    } catch (error) {
      sendError(res, error, 'Failed to delete palette');
    }
  }

  async rollbackPalette(req: Request, res: Response) {
    const body = parseBody(res, rollbackBodySchema, req.body, 'Body must be { version, note? }');
    if (!body) return;
    try {
      const row = await service.rollbackPalette(req.params.id as string, body, actorOf(req));
      res.json({ success: true, data: row, message: `Rolled back — published as version ${row.version}` });
    } catch (error) {
      sendError(res, error, 'Failed to roll back palette');
    }
  }

  async restorePresetDefault(req: Request, res: Response) {
    try {
      const row = await service.restorePresetDefault(req.params.id as string, actorOf(req));
      res.json({ success: true, data: row, message: 'Palette restored to built-in defaults' });
    } catch (error) {
      sendError(res, error, 'Failed to restore palette defaults');
    }
  }

  // ── admin: assignments ─────────────────────────────────────────────────────

  async listAssignments(req: Request, res: Response) {
    try {
      res.json({ success: true, data: await service.listAssignments() });
    } catch (error) {
      sendError(res, error, 'Failed to list assignments');
    }
  }

  async upsertAssignment(req: Request, res: Response) {
    const body = parseBody(res, upsertAssignmentBodySchema, req.body, 'Body must be { scope, scopeId?, paletteId }');
    if (!body) return;
    try {
      const row = await service.upsertAssignment(body, actorOf(req));
      res.json({ success: true, data: row, message: 'Assignment saved' });
    } catch (error) {
      sendError(res, error, 'Failed to save assignment');
    }
  }

  // ── vendor storefront (vendorScope set by requireVendorScope) ─────────────

  private vendorScopeOf(req: Request): string {
    return (req as AuthRequest & { vendorScope?: string }).vendorScope as string;
  }

  async listVendorPalettes(req: Request, res: Response) {
    try {
      res.json({ success: true, data: await service.listVendorPalettes() });
    } catch (error) {
      sendError(res, error, 'Failed to list vendor palettes');
    }
  }

  /** Own storefront theme = effective tokens (assignment + whitelist overrides). */
  async getVendorStorefront(req: Request, res: Response) {
    try {
      res.json({ success: true, data: await service.getVendorStorefrontTheme(this.vendorScopeOf(req)) });
    } catch (error) {
      sendError(res, error, 'Failed to load storefront theme');
    }
  }

  /** Preview = the same resolution as GET, explicitly side-effect free. */
  async getVendorPreview(req: Request, res: Response) {
    try {
      res.json({ success: true, data: await service.getVendorStorefrontTheme(this.vendorScopeOf(req)) });
    } catch (error) {
      sendError(res, error, 'Failed to preview storefront theme');
    }
  }

  async putVendorStorefront(req: Request, res: Response) {
    const body = parseBody(res, vendorStorefrontPaletteBodySchema, req.body, 'Body must be { paletteId, overrides? }');
    if (!body) return;
    try {
      const row = await service.upsertVendorStorefrontTheme(this.vendorScopeOf(req), body, actorOf(req));
      res.json({ success: true, data: row, message: 'Storefront theme saved' });
    } catch (error) {
      sendError(res, error, 'Failed to save storefront theme');
    }
  }

  async resetVendorStorefront(req: Request, res: Response) {
    try {
      const data = await service.resetVendorStorefrontTheme(this.vendorScopeOf(req), actorOf(req));
      res.json({ success: true, data, message: data.reset ? 'Storefront theme reset to platform default' : 'Nothing to reset' });
    } catch (error) {
      sendError(res, error, 'Failed to reset storefront theme');
    }
  }

  // ── customer preference (own data only) ────────────────────────────────────

  private customerIdOf(req: Request): string | null {
    return (req as AuthRequest).user?.rawId ?? null;
  }

  async getMyPreference(req: Request, res: Response) {
    try {
      const userId = this.customerIdOf(req);
      if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
      res.json({ success: true, data: await service.getCustomerPreference(userId) });
    } catch (error) {
      sendError(res, error, 'Failed to load theme preference');
    }
  }

  async putMyPreference(req: Request, res: Response) {
    const body = parseBody(res, customerPreferenceBodySchema, req.body, 'Body must be { mode, paletteId? }');
    if (!body) return;
    try {
      const userId = this.customerIdOf(req);
      if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
      const row = await service.upsertCustomerPreference(userId, body);
      res.json({ success: true, data: row, message: 'Theme preference saved' });
    } catch (error) {
      sendError(res, error, 'Failed to save theme preference');
    }
  }

  async deleteMyPreference(req: Request, res: Response) {
    try {
      const userId = this.customerIdOf(req);
      if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
      const data = await service.deleteCustomerPreference(userId);
      res.json({ success: true, data, message: data.deleted ? 'Theme preference removed' : 'Nothing to remove' });
    } catch (error) {
      sendError(res, error, 'Failed to remove theme preference');
    }
  }

  // ── vendor policy passthrough (VersionedSettingController handles these) ──
  // Kept as properties so the routes file can build one controller for the
  // policy endpoints without importing a second class.
}

export const themePaletteController = new ThemePaletteController();

/** Draft/published/previous handlers for the vendor theme policy setting. */
export { vendorThemePolicyService };
