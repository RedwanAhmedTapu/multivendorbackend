import type { Request, Response } from 'express';
import { StoreDecorationService } from '../services/storeLayout.service.ts';
import type {
  CreateDecorationInput,
  UpdateDecorationInput,
  CreateComponentInput,
  UpdateComponentInput,
  UpdateBannerCustomizationInput,
} from '../services/storeLayout.service.ts';

const svc = new StoreDecorationService();

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const ok = (res: Response, data: unknown, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res: Response, error: unknown, status = 400) =>
  res.status(status).json({
    success: false,
    message: error instanceof Error ? error.message : 'Unknown error',
  });

// ─────────────────────────────────────────────
// CONTROLLER
// ─────────────────────────────────────────────

export class StoreDecorationController {

  // ── Decorations ────────────────────────────

  /** POST /decorations */
  async createDecoration(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const input: CreateDecorationInput = { ...req.body, vendorId };
      const data = await svc.createDecoration(input);
      ok(res, data, 201);
    } catch (e) { fail(res, e); }
  }

  /** GET /decorations */
  async listDecorations(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      console.log(vendorId,"v")
      const data = await svc.getVendorDecorations(vendorId);
      ok(res, data);
    } catch (e) { fail(res, e, 500); }
  }

  /** GET /decorations/:id */
  async getDecoration(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const data = await svc.getDecorationById(req.params.id, vendorId);
      if (!data) return fail(res, new Error('Decoration not found'), 404);
      ok(res, data);
    } catch (e) { fail(res, e, 500); }
  }

  /** GET /decorations/storefront/:vendorId  — public, no auth */
  async getStorefront(req: Request, res: Response) {
    try {
      const data = await svc.getPublishedDecoration(req.params.vendorId);
      if (!data) return fail(res, new Error('No published decoration'), 404);
      ok(res, data);
    } catch (e) { fail(res, e, 500); }
  }

  /** PATCH /decorations/:id */
  async updateDecoration(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const input: UpdateDecorationInput = req.body;
      const data = await svc.updateDecoration(req.params.id, vendorId, input);
      ok(res, data);
    } catch (e) { fail(res, e); }
  }

  /** POST /decorations/:id/publish */
  async publishDecoration(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const data = await svc.publishDecoration(req.params.id, vendorId);
      ok(res, data);
    } catch (e) { fail(res, e); }
  }

  /** POST /decorations/:id/archive */
  async archiveDecoration(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const data = await svc.archiveDecoration(req.params.id, vendorId);
      ok(res, data);
    } catch (e) { fail(res, e); }
  }

  /** DELETE /decorations/:id */
  async deleteDecoration(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      await svc.deleteDecoration(req.params.id, vendorId);
      ok(res, { message: 'Decoration deleted' });
    } catch (e) { fail(res, e); }
  }

  /** POST /decorations/:id/duplicate */
  async duplicateDecoration(req: Request, res: Response) {
    try {
      const vendorId = req.user.vendorId;
      const { name } = req.body;
      const data = await svc.duplicateDecoration(req.params.id, vendorId, name);
      ok(res, data, 201);
    } catch (e) { fail(res, e); }
  }

  // ── Components ─────────────────────────────

  /** POST /decorations/:id/components */
  async addComponent(req: Request, res: Response) {
    try {
      const input: CreateComponentInput = {
        ...req.body,
        decorationId: req.params.id,
      };
      const data = await svc.addComponent(input);
      ok(res, data, 201);
    } catch (e) { fail(res, e); }
  }

  /** PATCH /decorations/:id/components/:componentId */
  async updateComponent(req: Request, res: Response) {
    try {
      const input: UpdateComponentInput = req.body;
      const data = await svc.updateComponent(
        req.params.componentId,
        req.params.id,
        input,
      );
      ok(res, data);
    } catch (e) { fail(res, e); }
  }

  /** DELETE /decorations/:id/components/:componentId */
  async deleteComponent(req: Request, res: Response) {
    try {
      await svc.deleteComponent(req.params.componentId, req.params.id);
      ok(res, { message: 'Component deleted' });
    } catch (e) { fail(res, e); }
  }

  /** PUT /decorations/:id/components/reorder
   *  body: { orderedIds: string[] }
   */
  async reorderComponents(req: Request, res: Response) {
    try {
      const { orderedIds } = req.body as { orderedIds: string[] };
      if (!Array.isArray(orderedIds)) {
        return fail(res, new Error('orderedIds must be an array'));
      }
      await svc.reorderComponents(req.params.id, orderedIds);
      ok(res, { message: 'Reordered' });
    } catch (e) { fail(res, e); }
  }

  /** PUT /decorations/:id/components/:componentId/products
   *  body: { productIds: string[] }
   */
  async setComponentProducts(req: Request, res: Response) {
    try {
      const { productIds } = req.body as { productIds: string[] };
      const data = await svc.setComponentProducts(
        req.params.componentId,
        req.params.id,
        productIds ?? [],
      );
      ok(res, data);
    } catch (e) { fail(res, e); }
  }

  /** PUT /decorations/:id/components/:componentId/categories
   *  body: { categoryIds: string[] }
   */
  async setComponentCategories(req: Request, res: Response) {
    try {
      const { categoryIds } = req.body as { categoryIds: string[] };
      const data = await svc.setComponentCategories(
        req.params.componentId,
        req.params.id,
        categoryIds ?? [],
      );
      ok(res, data);
    } catch (e) { fail(res, e); }
  }

  // ── Banner Customization ───────────────────

  /** GET /decorations/banner-customization */
  async getBannerCustomization(req: Request, res: Response) {
    try {
      const data = await svc.getBannerCustomization(req.user.vendorId);
      ok(res, data);
    } catch (e) { fail(res, e, 500); }
  }

  /** PUT /decorations/banner-customization */
  async upsertBannerCustomization(req: Request, res: Response) {
    try {
      const input: UpdateBannerCustomizationInput = req.body;
      const data = await svc.upsertBannerCustomization(req.user.vendorId, input);
      ok(res, data);
    } catch (e) { fail(res, e); }
  }

  // ── Templates ─────────────────────────────

  /** GET /decorations/templates?category=xyz */
  async listTemplates(req: Request, res: Response) {
    try {
      const data = await svc.getLayoutTemplates(req.query.category as string | undefined);
      ok(res, data);
    } catch (e) { fail(res, e, 500); }
  }

  /** POST /decorations/templates/apply
   *  body: { templateId, name? }
   */
  async applyTemplate(req: Request, res: Response) {
    try {
      const { templateId, name } = req.body as { templateId: string; name?: string };
      const data = await svc.applyTemplate(req.user.vendorId, templateId, name ?? '');
      ok(res, data, 201);
    } catch (e) { fail(res, e); }
  }
}