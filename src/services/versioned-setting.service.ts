// src/services/versioned-setting.service.ts
//
// Generic draft / published / previous-published storage for a validated JSON
// configuration in the existing `settings` table (no dedicated model, no
// migration). Used by the homepage config and the global product card config;
// each instance has its own three fixed keys and its own advisory-lock id, so
// the two never block or overwrite each other. Clients never choose a key.
//
// Consistency: every write runs in one transaction on the direct (non-pooled)
// client — config/prisma.ts requires it for interactive transactions — and
// first takes a transaction-scoped advisory lock, so concurrent writes
// serialize (including the very first write, when no rows exist to row-lock).
// If anything fails, the transaction rolls back and nothing changes.
import type { Prisma } from '@prisma/client';
import { prisma, prismaDirect } from '../config/prisma.ts';
import { publishBodySchema, saveDraftBodySchema, type SettingValidation } from '../validators/versioned-setting.validator.ts';

export interface VersionedSettingKeys {
  published: string;
  draft: string;
  previous: string;
}

export interface VersionedSettingOptions<T> {
  /** Short name for logs and messages, e.g. "homepage config". */
  label: string;
  keys: VersionedSettingKeys;
  /** Unique per setting: pg_advisory_xact_lock id. */
  lockId: number;
  validate: (raw: unknown) => SettingValidation<T>;
  /** Built-in defaults; must return a fresh copy on every call. */
  defaults: () => T;
}

// Explicit fields (no TS parameter properties): the dev server runs on Node's
// native type stripping, which rejects parameter properties.
export class VersionedSettingError extends Error {
  status: number;
  code: string;
  issues?: unknown[];

  constructor(status: number, code: string, message: string, issues?: unknown[]) {
    super(message);
    this.name = 'VersionedSettingError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type Db = Prisma.TransactionClient;
type StoredRow = { value: unknown; updatedAt: Date } | null;

export class VersionedSettingService<T> {
  readonly label: string;
  readonly keys: VersionedSettingKeys;
  private readonly lockId: number;
  private readonly validate: (raw: unknown) => SettingValidation<T>;
  private readonly defaults: () => T;

  constructor(options: VersionedSettingOptions<T>) {
    this.label = options.label;
    this.keys = options.keys;
    this.lockId = options.lockId;
    this.validate = options.validate;
    this.defaults = options.defaults;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private read(db: Db, key: string): Promise<StoredRow> {
    return db.setting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });
  }

  private write(db: Db, key: string, config: T) {
    const value = config as unknown as Prisma.InputJsonValue;
    return db.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
      select: { updatedAt: true },
    });
  }

  /** The stored config if present and valid, else null. Never throws. */
  private validStored(row: StoredRow): T | null {
    if (!row) return null;
    const v = this.validate(row.value);
    return v.ok ? v.config : null;
  }

  private withLock<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
    return prismaDirect.$transaction(async (tx) => {
      // pg_advisory_xact_lock returns void; select a constant so the row is
      // deserializable. Released automatically at commit/rollback.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${this.lockId}::bigint)`;
      return fn(tx);
    });
  }

  // ── public read ──────────────────────────────────────────────────────────

  /**
   * Published configuration. Never mutates, never throws.
   * source: 'published' = stored config; 'default' = nothing published yet;
   * 'fallback' = stored config invalid or unreadable (defaults served — callers
   * should not cache this for long).
   */
  async getPublished(): Promise<{ config: T; source: 'published' | 'default' | 'fallback'; updatedAt: Date | null }> {
    try {
      const row = await this.read(prisma, this.keys.published);
      if (!row) return { config: this.defaults(), source: 'default', updatedAt: null };
      const config = this.validStored(row);
      if (config) return { config, source: 'published', updatedAt: row.updatedAt };
      console.warn(`[${this.label}] stored published config is invalid — serving defaults`);
    } catch (err) {
      console.error(`[${this.label}] failed to read published config — serving defaults:`, err);
    }
    return { config: this.defaults(), source: 'fallback', updatedAt: null };
  }

  // ── admin reads ──────────────────────────────────────────────────────────

  /** The editor's working copy: draft → published → defaults. Nothing is written. */
  async getDraft() {
    const [draftRow, publishedRow, previousRow] = await Promise.all([
      this.read(prisma, this.keys.draft),
      this.read(prisma, this.keys.published),
      this.read(prisma, this.keys.previous),
    ]);
    const draft = this.validStored(draftRow);
    const published = this.validStored(publishedRow);

    const config = draft ?? published ?? this.defaults();
    const source: 'draft' | 'published' | 'default' = draft ? 'draft' : published ? 'published' : 'default';

    return {
      config,
      source,
      meta: {
        draftUpdatedAt: draftRow?.updatedAt ?? null,
        publishedUpdatedAt: publishedRow?.updatedAt ?? null,
        previousAvailable: this.validStored(previousRow) !== null,
        hasUnpublishedChanges: draft !== null && JSON.stringify(draft) !== JSON.stringify(published ?? this.defaults()),
        storedDraftInvalid: draftRow !== null && draft === null,
        storedPublishedInvalid: publishedRow !== null && published === null,
      },
    };
  }

  // ── admin writes ─────────────────────────────────────────────────────────

  /**
   * Validates the whole config, then saves it as the draft. The published
   * config is never touched. Invalid input throws before any write, so the
   * last valid draft survives. Optional `expectedUpdatedAt` (the draft's
   * updatedAt the editor loaded, or null if there was none) rejects stale
   * saves with 409 instead of silently overwriting another admin's work.
   */
  async saveDraft(body: unknown) {
    const parsedBody = saveDraftBodySchema.safeParse(body);
    if (!parsedBody.success) {
      throw new VersionedSettingError(
        400,
        'INVALID_BODY',
        'Body must be { config, expectedUpdatedAt? }',
        parsedBody.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const v = this.validate(parsedBody.data.config);
    if (!v.ok) {
      throw new VersionedSettingError(v.code === 'UNSUPPORTED_SCHEMA_VERSION' ? 400 : 422, v.code, v.message, v.issues);
    }
    const { expectedUpdatedAt } = parsedBody.data;

    return this.withLock(async (tx) => {
      if (expectedUpdatedAt !== undefined) {
        const current = await this.read(tx, this.keys.draft);
        const currentIso = current ? current.updatedAt.toISOString() : null;
        const expectedIso = expectedUpdatedAt === null ? null : new Date(expectedUpdatedAt).toISOString();
        if (currentIso !== expectedIso) {
          throw new VersionedSettingError(
            409,
            'DRAFT_CONFLICT',
            'The draft was changed since you loaded it. Reload the editor before saving.',
          );
        }
      }
      const saved = await this.write(tx, this.keys.draft, v.config);
      return { config: v.config, updatedAt: saved.updatedAt };
    });
  }

  /**
   * Promotes the saved draft to published. The draft is re-validated inside
   * the transaction; the current published config (if valid) becomes
   * `previous`. Publishing a draft identical to the published config is a
   * no-op so it can't overwrite the rollback target.
   *
   * Optional body `{ expectedDraftUpdatedAt }` (the draft's updatedAt the
   * editor last saw, or null for "no draft"): when given and the stored draft
   * differs, nothing is published and a 409 DRAFT_CONFLICT is thrown — so an
   * admin can't publish another admin's newer draft unseen. Omitting it keeps
   * the original behaviour (publish whatever draft is saved).
   */
  async publish(body?: unknown) {
    const parsedBody = publishBodySchema.safeParse(body ?? undefined);
    if (!parsedBody.success) {
      throw new VersionedSettingError(
        400,
        'INVALID_BODY',
        'Body must be empty or { expectedDraftUpdatedAt }',
        parsedBody.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const expected = parsedBody.data?.expectedDraftUpdatedAt;

    return this.withLock(async (tx) => {
      const draftRow = await this.read(tx, this.keys.draft);
      if (expected !== undefined) {
        const currentIso = draftRow ? draftRow.updatedAt.toISOString() : null;
        const expectedIso = expected === null ? null : new Date(expected).toISOString();
        if (currentIso !== expectedIso) {
          throw new VersionedSettingError(
            409,
            'DRAFT_CONFLICT',
            'The draft was changed since you loaded it. Reload the editor and review it before publishing.',
          );
        }
      }
      if (!draftRow) {
        throw new VersionedSettingError(409, 'NO_DRAFT', 'There is no saved draft to publish.');
      }
      const v = this.validate(draftRow.value);
      if (!v.ok) {
        throw new VersionedSettingError(422, 'INVALID_DRAFT', `Saved draft is invalid: ${v.message}`, v.issues);
      }

      const publishedRow = await this.read(tx, this.keys.published);
      const currentPublished = this.validStored(publishedRow);

      if (currentPublished && JSON.stringify(currentPublished) === JSON.stringify(v.config)) {
        return { config: v.config, publishedAt: publishedRow!.updatedAt, previousSaved: false, unchanged: true };
      }

      if (currentPublished) {
        await this.write(tx, this.keys.previous, currentPublished);
      }
      const saved = await this.write(tx, this.keys.published, v.config);
      return { config: v.config, publishedAt: saved.updatedAt, previousSaved: currentPublished !== null, unchanged: false };
    });
  }

  /** Replaces the draft with the current published config (or defaults). Published is untouched. */
  async discardDraft() {
    return this.withLock(async (tx) => {
      const published = this.validStored(await this.read(tx, this.keys.published));
      const config = published ?? this.defaults();
      const saved = await this.write(tx, this.keys.draft, config);
      return { config, source: published ? ('published' as const) : ('default' as const), updatedAt: saved.updatedAt };
    });
  }

  /** Replaces the draft with the built-in defaults. Published is untouched — publish to apply. */
  async resetDraftToDefaults() {
    return this.withLock(async (tx) => {
      const config = this.defaults();
      const saved = await this.write(tx, this.keys.draft, config);
      return { config, updatedAt: saved.updatedAt };
    });
  }

  /**
   * Rolls the published config back to `previous` (validated first). The
   * config being replaced becomes the new `previous`, so a restore can itself
   * be undone. The draft is not touched.
   */
  async restorePrevious() {
    return this.withLock(async (tx) => {
      const previousRow = await this.read(tx, this.keys.previous);
      if (!previousRow) {
        throw new VersionedSettingError(404, 'NO_PREVIOUS', 'There is no previously published configuration to restore.');
      }
      const v = this.validate(previousRow.value);
      if (!v.ok) {
        throw new VersionedSettingError(
          422,
          'INVALID_PREVIOUS',
          `The previously published configuration is invalid and cannot be restored: ${v.message}`,
          v.issues,
        );
      }

      const currentPublished = this.validStored(await this.read(tx, this.keys.published));
      const saved = await this.write(tx, this.keys.published, v.config);
      if (currentPublished) {
        await this.write(tx, this.keys.previous, currentPublished);
      }
      // reversible = the replaced config was saved as the new `previous`.
      return { config: v.config, publishedAt: saved.updatedAt, reversible: currentPublished !== null };
    });
  }
}
