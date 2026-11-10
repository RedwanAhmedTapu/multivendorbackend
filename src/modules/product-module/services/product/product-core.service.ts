// services/product/product-core.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { ProductRepository } from "../../repositories/product.repository.ts";
import {
  generateUniqueProductSlug,
  recordSlugChange,
  resolveSlug,
} from "../../utils/slug.util.ts";
import {
  generateAndSaveProductSEO,
  buildProductSeoPayload,
} from "../../utils/seo.util.ts";
import {
  invalidateProductCache,
  cacheGet,
  cacheSet,
  cacheKeys,
} from "../../../../config/cache.ts";
import { ReviewSummaryService } from "./review-summary.service.ts";
import { isPublicProduct } from "../../utils/filter-builder.util.ts";
import { AppError } from "../../utils/response.ts";
import { generateEan13Barcode } from "../../../../utils/barcode.ts";
import type {
  CreateProductInput,
  UpdateProductInput,
} from "../../validators/product.validator.ts";

export const ProductCoreService = {
  /**
   * CREATE — always lands as PENDING. SEO stays unpublished (isPublished:
   * false) until admin approval auto-generates it — see approveProduct()
   * in product-approval.service.ts, the single trigger point for that.
   */
  async create(
    vendorId: string,
    userId: string | undefined,
    input: CreateProductInput,
  ) {
    const slug = await generateUniqueProductSlug(input.name);

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          name: input.name,
          nameBn: input.nameBn,
          description: input.description,
          slug,
          vendorId,
          categoryId: input.categoryId,
          brandId: input.brandId,
          approvalStatus: "PENDING",

          images: {
            create: input.images.map((img, i) => ({
              url: img.url,
              altText: img.altText ?? `${input.name} image ${i + 1}`,
              sortOrder: img.sortOrder ?? i,
            })),
          },

          attributes: input.attributes?.length
            ? {
                create: input.attributes.map((a) => ({
                  attributeId: a.attributeId,
                  isForVariant: a.isForVariant ?? false,
                  valueString: a.valueString,
                  valueNumber: a.valueNumber,
                  valueBoolean: a.valueBoolean,
                  attributeValueId: a.attributeValueId,
                })),
              }
            : undefined,

          variants: {
            create: input.variants.map((v) => ({
              name: v.name,
              sku: v.sku,
              // POS barcode scanning needs a value here even if the vendor
              // never typed one — fall back to an auto-generated EAN-13.
              barcode: v.barcode || generateEan13Barcode(),
              price: 0, // pricing is a separate step per existing flow (updatePrice)
              taxRate: input.taxRate,
              availability: v.availability ?? true,
              attributes: v.attributes?.length
                ? {
                    create: v.attributes.map((a) => ({
                      attributeValueId: a.attributeValueId,
                    })),
                  }
                : undefined,
              images: v.images?.length
                ? {
                    create: v.images.map((img, idx) => {
                      const url = typeof img === "string" ? img : img.url;
                      const altText =
                        typeof img === "string"
                          ? `${v.name ?? input.name} image ${idx + 1}`
                          : (img.altText ??
                            `${v.name ?? input.name} image ${idx + 1}`);
                      const sortOrder =
                        typeof img === "string" ? idx : (img.sortOrder ?? idx);
                      return { url, altText, sortOrder };
                    }),
                  }
                : undefined,
            })),
          },

          warranty: {
            create: {
              packageWeightValue: input.shippingWarranty.packageWeightValue,
              packageWeightUnit:
                input.shippingWarranty.packageWeightUnit.toUpperCase() as
                  | "KG"
                  | "G",
              packageLength: input.shippingWarranty.packageLength,
              packageWidth: input.shippingWarranty.packageWidth,
              packageHeight: input.shippingWarranty.packageHeight,
              dangerousGoods:
                input.shippingWarranty.dangerousGoods === "none"
                  ? "NONE"
                  : "CONTAINS",
              duration: input.shippingWarranty.warrantyPeriodValue,
              unit: input.shippingWarranty.warrantyPeriodUnit.toUpperCase() as
                | "DAYS"
                | "MONTHS"
                | "YEARS",
              policy: input.shippingWarranty.warrantyDetails ?? null,
              type: input.shippingWarranty.warrantyType,
            },
          },

          // Manual SEO input (optional) is stored but NOT published yet —
          // publishing/auto-fill happens on approval.
          seo: input.seo
            ? {
                create: {
                  metaTitle: input.seo.metaTitle,
                  metaDescription: input.seo.metaDescription,
                  canonicalUrl: input.seo.canonicalUrl,
                  ogImage: input.seo.ogImage,
                  isAutoGenerated: false,
                  isPublished: false,
                },
              }
            : undefined,
        },
        include: { variants: true },
      });

      if (userId) {
        await tx.auditLog.create({
          data: {
            userId,
            action: "CREATE",
            entity: "Product",
            entityId: created.id,
            newData: {
              productName: created.name,
              vendorId,
              categoryId: created.categoryId,
            },
          },
        });
      }

      return created;
    });

    return ProductRepository.findDetailById(product.id, { vendorId });
  },

  /**
   * UPDATE — re-slugs (and records slug history) if the name changed.
   * Any update on an already-ACTIVE product resets approvalStatus back to
   * PENDING (existing business rule preserved from the current codebase),
   * and refreshes auto-generated SEO immediately after re-approval, not
   * before — an edited-but-unapproved product shouldn't show fresh SEO
   * for content nobody has reviewed yet.
   */
  async update(
    productId: string,
    vendorId: string | undefined,
    userId: string | undefined,
    input: UpdateProductInput,
  ) {
    const existing = await prisma.product.findFirst({
      where: {
        id: productId,
        ...(vendorId ? { vendorId } : {}),
        isDeleted: false,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        approvalStatus: true,
        vendorId: true,
      },
    });
    if (!existing) throw new AppError("Product not found or unauthorized", 404);

    const updateData: any = { updatedAt: new Date() };

    if (input.name && input.name !== existing.name) {
      const newSlug = await generateUniqueProductSlug(input.name, productId);
      await recordSlugChange(productId, existing.slug);
      updateData.name = input.name;
      updateData.slug = newSlug;
    }
    if (input.nameBn !== undefined) updateData.nameBn = input.nameBn;
    if (input.description !== undefined)
      updateData.description = input.description;
    if (input.categoryId !== undefined)
      updateData.categoryId = input.categoryId;
    if (input.brandId !== undefined) updateData.brandId = input.brandId;

    // Any content edit sends it back for re-approval.
    updateData.approvalStatus = "PENDING";
    updateData.approvedById = null;

    if (input.images?.length) {
      updateData.images = {
        deleteMany: { productId },
        create: input.images.map((img, i) => ({
          url: img.url,
          altText: img.altText ?? `Product image ${i + 1}`,
          sortOrder: img.sortOrder ?? i,
        })),
      };
    }

    if (input.variants?.length) {
      updateData.variants = {
        deleteMany: { productId },
        create: input.variants.map((v) => ({
          name: v.name,
          sku: v.sku,
          barcode: v.barcode || generateEan13Barcode(),
          price: 0,
          taxRate: input.taxRate ?? 0,
          availability: v.availability ?? true,
          attributes: v.attributes?.length
            ? {
                create: v.attributes.map((a) => ({
                  attributeValueId: a.attributeValueId,
                })),
              }
            : undefined,
        })),
      };
    }

    const updated = await prisma.product.update({
      where: { id: productId },
      data: updateData,
      include: { variants: true },
    });

    if (userId) {
      await prisma.auditLog.create({
        data: {
          userId,
          action: "UPDATE",
          entity: "Product",
          entityId: productId,
          oldData: existing,
          newData: { name: updated.name, slug: updated.slug },
        },
      });
    }

    await invalidateProductCache({
      productId,
      slug: existing.slug,
      vendorId: existing.vendorId,
    });
    if (updated.slug !== existing.slug) {
      await invalidateProductCache({
        productId,
        slug: updated.slug,
        vendorId: existing.vendorId,
      });
    }

    return ProductRepository.findDetailById(
      productId,
      vendorId ? { vendorId } : {},
    );
  },

  /**
   * SEO-optimized product detail lookup BY SLUG (never by raw id for
   * public traffic). Follows slug history for 301-style redirects when a
   * product's slug has changed since a link was shared/indexed.
   */
  async getDetailBySlug(slug: string, opts: { viewerUserId?: string } = {}) {
    const cacheKey = cacheKeys.productBySlug(slug);
    const cached = await cacheGet<any>(cacheKey);
    // A cache hit never bypasses visibility: the cached record carries
    // vendor.status (detailInclude). A suspended/deactivated vendor's product
    // is a 404; vendor status changes also clear these keys (S3 / P3). An
    // entry without vendor.status is ignored and re-read from the database.
    if (cached && cached.vendor?.status !== undefined) {
      return isPublicProduct(cached) ? cached : null;
    }

    const resolved = await resolveSlug(slug);
    if (!resolved) return null;

    const product = await ProductRepository.findDetailBySlug(resolved.currentSlug);
if (!product || !isPublicProduct(product)) return null;

const [reviewSummary, categoryChain] = await Promise.all([
  ReviewSummaryService.getSummary(product.id, {
    avgRating: (product as any).avgRating ?? 0,
    reviewCount: (product as any).reviewCount ?? 0,
  }),
  (product as any).categoryId
    ? ProductRepository.getCategoryAncestryChainCached((product as any).categoryId) // cache না বসালে getCategoryAncestryChain লিখুন
    : Promise.resolve([]),
]);

const seoPayload = product.seo?.isPublished ? product.seo : buildProductSeoPayload(product as any);

const breadcrumbs = categoryChain.map((c: any) => ({
  name: c.name,
  url: `/category/${c.slug}`,
}));
    const result = {
      ...product,
      reviewSummary,
      breadcrumbs,
      seo: seoPayload,
      redirectedFrom: resolved.redirected ? slug : null,
    };

    await cacheSet(cacheKey, result, 300);

    if (opts.viewerUserId) {
      // fire-and-forget view tracking; don't block the response on it
      import("./product-filter.service.ts").then(({ ProductFilterService }) =>
        ProductFilterService.trackRecentlyViewed(
          opts.viewerUserId!,
          product.id,
        ).catch(() => {}),
      );
    } else {
      ProductRepository.incrementViewCount(product.id).catch(() => {});
    }

    return result;
  },
};