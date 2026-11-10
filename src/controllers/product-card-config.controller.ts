// controllers/product-card-config.controller.ts
//
// Global product card design endpoints (/api/themes/product-card…), using the
// shared versioned-setting handlers.
import { productCardConfigService } from '../services/product-card-config.service.ts';
import type { ProductCardConfig } from '../validators/product-card.validator.ts';
import { VersionedSettingController } from './versioned-setting.controller.ts';

export const productCardConfigController = new VersionedSettingController<ProductCardConfig>(productCardConfigService, {
  noun: 'product card design',
});
