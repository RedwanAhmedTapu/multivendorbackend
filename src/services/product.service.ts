// services/product.service.ts


export { PublicProductService } from './product.service.public.ts';
export { VendorProductService } from './product.service.vendor.ts';
export { AdminProductService } from './product.service.admin.ts';

// Optional: Default export for backward compatibility
import { PublicProductService } from './product.service.public.ts';
import { VendorProductService } from './product.service.vendor.ts';
import { AdminProductService } from './product.service.admin.ts';

export default {
  Public: PublicProductService,
  Vendor: VendorProductService,
  Admin: AdminProductService,
};