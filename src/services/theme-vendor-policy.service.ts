// src/services/theme-vendor-policy.service.ts
//
// Vendor theme policy: which palettes vendors may select for their storefront
// and which tokens they may override. Stored in the existing `settings` table
// via the shared VersionedSettingService (draft / published / previous —
// exactly the homepage-config and product-card-config pattern), with its own
// keys and its own advisory-lock id so it never blocks or overwrites the
// other settings.
import {
  DEFAULT_VENDOR_THEME_POLICY,
  validateVendorThemePolicy,
  type VendorThemePolicy,
} from '../validators/theme-palette.validator.ts';
import { VersionedSettingService } from './versioned-setting.service.ts';

export const VENDOR_THEME_POLICY_KEYS = {
  published: 'theme.vendor-policy.published',
  draft: 'theme.vendor-policy.draft',
  previous: 'theme.vendor-policy.published.previous',
} as const;

/** Arbitrary constant identifying "vendor theme policy writes" for pg_advisory_xact_lock. */
export const VENDOR_THEME_POLICY_LOCK_ID = 4206003;

export const vendorThemePolicyService = new VersionedSettingService<VendorThemePolicy>({
  label: 'theme-vendor-policy',
  keys: VENDOR_THEME_POLICY_KEYS,
  lockId: VENDOR_THEME_POLICY_LOCK_ID,
  validate: validateVendorThemePolicy,
  defaults: () => ({ ...DEFAULT_VENDOR_THEME_POLICY }),
});
