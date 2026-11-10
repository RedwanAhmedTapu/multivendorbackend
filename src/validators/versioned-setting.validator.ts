// src/validators/versioned-setting.validator.ts
//
// Shared pieces for versioned JSON settings (homepage config, product card
// config): the PUT draft body and the validation result shape every
// setting-specific validator returns.
import { z } from 'zod';

/** PUT …/draft body. `expectedUpdatedAt` enables optimistic concurrency. */
export const saveDraftBodySchema = z.strictObject({
  config: z.unknown(),
  expectedUpdatedAt: z.string().datetime().nullable().optional(),
});

/**
 * POST …/publish body (optional — callers that send nothing keep working).
 * `expectedDraftUpdatedAt` = the draft's updatedAt the editor saved/loaded;
 * a different stored draft means someone else changed it → 409.
 */
export const publishBodySchema = z
  .strictObject({
    expectedDraftUpdatedAt: z.string().datetime().nullable().optional(),
  })
  .optional();

export type SettingValidation<T> =
  | { ok: true; config: T }
  | { ok: false; code: 'UNSUPPORTED_SCHEMA_VERSION' | 'INVALID_CONFIG'; message: string; issues?: unknown[] };
