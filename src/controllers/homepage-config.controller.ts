// controllers/homepage-config.controller.ts
//
// Homepage configuration endpoints (/api/themes/homepage-config…). Handlers
// are the shared versioned-setting handlers; names kept from Phase 1.
import { homepageConfigService } from '../services/homepage-config.service.ts';
import type { HomepageConfig } from '../validators/homepage-config.validator.ts';
import { VersionedSettingController } from './versioned-setting.controller.ts';

export class HomepageConfigController extends VersionedSettingController<HomepageConfig> {
  constructor() {
    super(homepageConfigService, { noun: 'homepage configuration' });
  }
}

export const homepageConfigController = new HomepageConfigController();
