// src/services/product-card-config.service.ts
//
// Global product card design (one configuration for every customer-facing
// listing): draft / published / previous-published in the existing `settings`
// table via the shared VersionedSettingService. Separate keys and a separate
// advisory-lock id from the homepage config, so neither can block or
// overwrite the other.
import { getDefaultProductCardConfig } from '../constants/product-card.defaults.ts';
import { validateProductCardConfig, type ProductCardConfig } from '../validators/product-card.validator.ts';
import { VersionedSettingService } from './versioned-setting.service.ts';

export const PRODUCT_CARD_CONFIG_KEYS = {
  published: 'product-card.published',
  draft: 'product-card.draft',
  previous: 'product-card.published.previous',
} as const;

/** Arbitrary constant identifying "product card config writes" for pg_advisory_xact_lock. */
export const PRODUCT_CARD_CONFIG_LOCK_ID = 4206002;

export const productCardConfigService = new VersionedSettingService<ProductCardConfig>({
  label: 'product-card-config',
  keys: PRODUCT_CARD_CONFIG_KEYS,
  lockId: PRODUCT_CARD_CONFIG_LOCK_ID,
  validate: validateProductCardConfig,
  defaults: getDefaultProductCardConfig,
});
