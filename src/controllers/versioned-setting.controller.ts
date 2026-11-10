// controllers/versioned-setting.controller.ts
//
// HTTP handlers shared by every versioned JSON setting (homepage config,
// global product card config). Same response shapes as the Phase 1 homepage
// config endpoints: { success, data, message? } / { success: false, error,
// code, issues? }.
import type { Request, Response } from 'express';
import { VersionedSettingError, type VersionedSettingService } from '../services/versioned-setting.service.ts';

export interface VersionedSettingMessages {
  /** e.g. "homepage configuration" — used in success/error messages. */
  noun: string;
}

// Explicit fields (no TS parameter properties) for Node's native type stripping.
export class VersionedSettingController<T> {
  private readonly service: VersionedSettingService<T>;
  private readonly noun: string;

  constructor(service: VersionedSettingService<T>, messages: VersionedSettingMessages) {
    this.service = service;
    this.noun = messages.noun;
  }

  private sendError(res: Response, error: unknown, fallback: string) {
    if (error instanceof VersionedSettingError) {
      return res.status(error.status).json({
        success: false,
        error: error.message,
        code: error.code,
        ...(error.issues ? { issues: error.issues } : {}),
      });
    }
    console.error(`[${this.service.label}] ${fallback}:`, error);
    return res.status(500).json({ success: false, error: fallback });
  }

  /** Published configuration (public; never fails — falls back to defaults). */
  async getPublished(req: Request, res: Response) {
    const { config, source, updatedAt } = await this.service.getPublished();
    res.json({ success: true, data: { config, source, updatedAt } });
  }

  /** Draft for the editor (ADMIN). */
  async getDraft(req: Request, res: Response) {
    try {
      res.json({ success: true, data: await this.service.getDraft() });
    } catch (error) {
      this.sendError(res, error, `Failed to load ${this.noun} draft`);
    }
  }

  /** Save draft (ADMIN). Body: { config, expectedUpdatedAt? } */
  async saveDraft(req: Request, res: Response) {
    try {
      const data = await this.service.saveDraft(req.body);
      res.json({ success: true, data, message: 'Draft saved' });
    } catch (error) {
      this.sendError(res, error, `Failed to save ${this.noun} draft`);
    }
  }

  /** Publish the saved draft (ADMIN). Optional body: { expectedDraftUpdatedAt } */
  async publish(req: Request, res: Response) {
    try {
      const data = await this.service.publish(req.body);
      res.json({
        success: true,
        data,
        message: data.unchanged
          ? `Draft is identical to the published ${this.noun} — nothing to publish`
          : `${this.capitalNoun()} published`,
      });
    } catch (error) {
      this.sendError(res, error, `Failed to publish ${this.noun}`);
    }
  }

  /** Discard the draft: replace it with the published config (or defaults) (ADMIN). */
  async discardDraft(req: Request, res: Response) {
    try {
      const data = await this.service.discardDraft();
      res.json({ success: true, data, message: 'Draft discarded' });
    } catch (error) {
      this.sendError(res, error, `Failed to discard ${this.noun} draft`);
    }
  }

  /** Reset the draft to the built-in defaults; publish to apply (ADMIN). */
  async resetDraftToDefaults(req: Request, res: Response) {
    try {
      const data = await this.service.resetDraftToDefaults();
      res.json({ success: true, data, message: 'Draft reset to defaults (not published)' });
    } catch (error) {
      this.sendError(res, error, `Failed to reset ${this.noun} draft`);
    }
  }

  /** Roll the published config back to the previous version (ADMIN). */
  async restorePrevious(req: Request, res: Response) {
    try {
      const data = await this.service.restorePrevious();
      res.json({ success: true, data, message: `Previous ${this.noun} restored` });
    } catch (error) {
      this.sendError(res, error, `Failed to restore previous ${this.noun}`);
    }
  }

  private capitalNoun() {
    return this.noun.charAt(0).toUpperCase() + this.noun.slice(1);
  }
}
