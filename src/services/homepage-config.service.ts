// src/services/homepage-config.service.ts
//
// Platform homepage configuration: draft / published / previous-published in
// the existing `settings` table, via the shared VersionedSettingService (one
// transaction + advisory lock per write, optimistic concurrency, rollback-safe
// publish/restore). The active layout itself stays in the `themes` table
// (theme.service.ts) and is NOT touched here. Product card design is a
// separate global setting (product-card-config.service.ts).
import { getDefaultHomepageConfig } from '../constants/homepage-config.defaults.ts';
import { validateHomepageConfig, type HomepageConfig } from '../validators/homepage-config.validator.ts';
import { VersionedSettingError, VersionedSettingService } from './versioned-setting.service.ts';

export const HOMEPAGE_CONFIG_KEYS = {
  published: 'homepage.published',
  draft: 'homepage.draft',
  previous: 'homepage.published.previous',
} as const;

/** Arbitrary constant identifying "homepage config writes" for pg_advisory_xact_lock. */
export const HOMEPAGE_CONFIG_LOCK_ID = 4206001;

/** Kept under its Phase 1 name; it is the shared versioned-setting error. */
export { VersionedSettingError as HomepageConfigError };

export class HomepageConfigService extends VersionedSettingService<HomepageConfig> {
  constructor() {
    super({
      label: 'homepage-config',
      keys: HOMEPAGE_CONFIG_KEYS,
      lockId: HOMEPAGE_CONFIG_LOCK_ID,
      validate: validateHomepageConfig,
      defaults: getDefaultHomepageConfig,
    });
  }
}

export const homepageConfigService = new HomepageConfigService();

export { VersionedSettingError };
