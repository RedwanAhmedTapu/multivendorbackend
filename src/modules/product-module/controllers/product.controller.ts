// controllers/product.controller.ts — barrel export
export { PublicProductController } from "./product.controller.public.ts";
export { VendorProductController } from "./product.controller.vendor.ts";
export { AdminProductController } from "./product.controller.admin.ts";

import { PublicProductController } from "./product.controller.public.ts";
import { VendorProductController } from "./product.controller.vendor.ts";
import { AdminProductController } from "./product.controller.admin.ts";

export default {
  Public: PublicProductController,
  Vendor: VendorProductController,
  Admin: AdminProductController,
};
