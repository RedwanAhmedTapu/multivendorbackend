// validators/product.validator.ts
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────
// Uploaded assets (product images, videos) are stored as a *relative R2
// storage key* — e.g. "vendors/{vendorId}/productimages/169...-file.png" —
// not a full URL. uploadToR2() returns both `key` and `url`, but every
// upload flow in this app (product images, blog images, brand docs, chat
// media) persists the relative `key` and resolves it to a full URL only
// at render time (see frontend getImageUrl() / NEXT_PUBLIC_R2_PUBLIC_DOMAIN).
// A plain z.string().url() rejects that key outright, so real upload
// payloads were failing validation. This accepts either form.
// ─────────────────────────────────────────────────────────────────────────
const storagePathOrUrl = (label: string) =>
  z.string().min(1, `${label} is required`).refine(
    (val) => {
      if (/^https?:\/\//i.test(val)) {
        try {
          new URL(val);
          return true;
        } catch {
          return false;
        }
      }
      // relative storage key: reject absolute paths, path traversal and
      // control characters — otherwise accept it, since real uploaded
      // filenames can legally contain almost any printable character
      // (commas, spaces, parentheses, unicode, etc.)
      return (
        val.length <= 1024 &&
        !val.startsWith("/") &&
        !val.includes("..") &&
        !/[\x00-\x1f\x7f]/.test(val)
      );
    },
    { message: `${label} must be a valid URL or an uploaded file's storage path` },
  );

const imageSchema = z.object({
  url: storagePathOrUrl("Image url"),
  altText: z.string().nullable().optional(),
  sortOrder: z.number().int().nullable().optional(),
});

const videoSchema = z
  .object({
    videoUrl: storagePathOrUrl("Video url").nullable().optional(),
    videoUploadUrl: storagePathOrUrl("Video upload url").nullable().optional(), // set after /upload endpoint
  })
  .refine((v) => v.videoUrl || v.videoUploadUrl, {
    message: "Provide either videoUrl or an uploaded video",
  })
  .optional();

const attributeSchema = z.object({
  attributeId: z.string().min(1),
  isForVariant: z.boolean().nullable().optional(),
  valueString: z.string().nullable().optional(),
  valueNumber: z.number().nullable().optional(),
  valueBoolean: z.boolean().nullable().optional(),
  attributeValueId: z.string().nullable().optional(),
});

const variantSchema = z.object({
  name: z.string().nullable().optional(),
  sku: z.string().min(1, "SKU is required"),
  // Optional: if the vendor doesn't provide one, the server auto-generates
  // an EAN-13 barcode so POS scanning still works out of the box.
  barcode: z.string().trim().min(1).nullable().optional(),
  attributes: z.array(z.object({ attributeValueId: z.string().min(1) })).optional(),
  images: z.array(z.union([storagePathOrUrl("Variant image url"), imageSchema])).optional(),
  availability: z.boolean().nullable().optional(),
});

const warrantySchema = z.object({
  packageWeightValue: z.number().positive(),
  packageWeightUnit: z.enum(["kg", "g", "KG", "G"]),
  packageLength: z.number().positive(),
  packageWidth: z.number().positive(),
  packageHeight: z.number().positive(),
  dangerousGoods: z.enum(["none", "contains"]),
  warrantyPeriodValue: z.number().int().nonnegative(),
  warrantyPeriodUnit: z.enum(["days", "months", "years"]),
  warrantyDetails: z.string().nullable().optional(),
  warrantyType: z.enum([
    "FINIXMART_WARRANTY",
    "LOCAL_WARRANTY",
    "AGENT_WARRANTY",
    "BRAND_WARRANTY",
    "SELLER_WARRANTY",
    "LOCAL_SELLER_WARRANTY",
    "INTERNATIONAL_WARRANTY",
    "INTERNATIONAL_MANUFACTURER_WARRANTY",
    "INTERNATIONAL_SELLER_WARRANTY",
    "NON_LOCAL_WARRANTY",
    "NO_WARRANTY",
    "NOT_APPLICABLE",
    "ORIGINAL_PRODUCT",
  ]),
});

/**
 * Required per the brief: name, taxRate, category, images (>=1),
 * description, warranty, warehouse.
 * Optional: video (upload or url), brand, tags, keywords, offer,
 * freeShipping, sale, seo.
 */
export const createProductSchema = z.object({
  name: z.string().trim().min(2, "Product name is required"),
  nameBn: z.string().trim().nullable().optional(),
  description: z.string().trim().min(1, "Description is required"),
  categoryId: z.string().min(1, "Category is required"),
  brandId: z.string().nullable().optional(),
  taxRate: z.number().min(0).max(100, "taxRate must be between 0 and 100"),

  images: z.array(imageSchema).min(1, "At least one image is required"),
  video: videoSchema,

  tags: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),

  attributes: z.array(attributeSchema).optional(),
  variants: z.array(variantSchema).min(1, "At least one variant with a SKU is required"),

  shippingWarranty: warrantySchema,

  freeShipping: z.boolean().nullable().optional(),
  isFeatured: z.boolean().nullable().optional(),

  // Manual SEO override — optional. If omitted, SEO stays unpublished
  // (DRAFT) until admin approval, at which point it is auto-generated.
  seo: z
    .object({
      metaTitle: z.string().max(60).nullable().optional(),
      metaDescription: z.string().max(160).nullable().optional(),
      canonicalUrl: z.string().url().nullable().optional(),
      ogImage: z.string().url().nullable().optional(),
    })
    .optional(),
});

export const updateProductSchema = createProductSchema.partial().extend({
  variants: z.array(variantSchema).optional(),
  images: z.array(imageSchema).optional(),
});

export const rejectProductSchema = z.object({
  reason: z.string().trim().min(3, "Rejection reason is required"),
});

export const bulkIdsSchema = z.object({
  productIds: z.array(z.string().min(1)).min(1, "productIds must be a non-empty array"),
  reason: z.string().optional(),
});

export const stockUpdateSchema = z.object({
  stock: z.number().int().min(0),
});

export const priceUpdateSchema = z.object({
  price: z.number().min(0),
  autoCalculateDiscount: z.boolean().optional().default(true),
});

export const specialPriceUpdateSchema = z.object({
  specialPrice: z.number().min(0).nullable(),
  autoCalculateDiscount: z.boolean().optional().default(true),
});

/**
 * Shared filter schema — superset used by user/vendor/admin filter builders.
 * Role-specific fields (approvalStatus, vendorId, etc.) are validated
 * separately per role in the filter-builder utility.
 */
export const productFilterSchema = z.object({
  categoryId: z.string().optional(),
  categorySlug: z.string().optional(),
  categoryIds: z.array(z.string()).optional(),
  subCategoryId: z.string().optional(),
  brandId: z.string().optional(),
  brandIds: z.array(z.string()).optional(),
  search: z.string().optional(),
  keyword: z.string().optional(),
  tags: z.array(z.string()).optional(),

  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),

  minRating: z.number().min(0).max(5).optional(),

  inStock: z.boolean().optional(),
  outOfStock: z.boolean().optional(),

  onSale: z.boolean().optional(),
  newArrival: z.boolean().optional(),
  featured: z.boolean().optional(),
  freeShipping: z.boolean().optional(),
  hasDiscount: z.boolean().optional(),

  warehouseId: z.string().optional(),
  attributes: z.record(z.string(), z.array(z.string())).optional(), 
  color: z.array(z.string()).optional(),
  size: z.array(z.string()).optional(),
  sku: z.string().optional(),

  sortBy: z
    .enum([
      "newest",
      "oldest",
      "price_asc",
      "price_desc",
      "rating_desc",
      "rating_asc",
      "popularity",
      "trending",
      "best_selling",
      "most_viewed",
      "top_rated",
      "highest_discount",
      "recently_updated",
    ])
    .optional(),

  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().optional(),
});

export const adminProductFilterSchema = productFilterSchema.extend({
  approvalStatus: z.enum(["PENDING", "ACTIVE", "REJECTED", "DRAFT", "INACTIVE"]).optional(),
  vendorId: z.string().optional(),
  vendorName: z.string().optional(),
  includeDeleted: z.boolean().optional(),
  taxRateMin: z.number().optional(),
  taxRateMax: z.number().optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  updatedFrom: z.coerce.date().optional(),
  updatedTo: z.coerce.date().optional(),
});

export const vendorProductFilterSchema = productFilterSchema.extend({
  approvalStatus: z.enum(["PENDING", "ACTIVE", "REJECTED", "DRAFT"]).optional(),
  lowStock: z.boolean().optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductFilterInput = z.infer<typeof productFilterSchema>;
export type AdminProductFilterInput = z.infer<typeof adminProductFilterSchema>;
export type VendorProductFilterInput = z.infer<typeof vendorProductFilterSchema>;