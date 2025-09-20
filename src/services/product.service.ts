import { prisma } from "../config/prisma.ts";
import { WarrantyUnit } from "@prisma/client";
import type {
  CreateProductData,
  ProductImageInput,
  ProductShippingWarrantyInput,
  ProductVariantInput,
} from "@/types/product.ts";

export const ProductService = {
  // ======================
  // Get all products
  // ======================
  async getAll() {
    return prisma.product.findMany({
      include: {
        vendor: true,
        category: true,
        images: { orderBy: { sortOrder: "asc" } },
        variants: {
          include: {
            images: { orderBy: { sortOrder: "asc" } },
            attributes: { include: { attributeValue: true } },
          },
        },
        specifications: { include: { specification: true } },
        warranty: true,
      },
    });
  },

  // ======================
  // Get product by ID
  // ======================
  async getById(id: string) {
    return prisma.product.findUnique({
      where: { id },
      include: {
        vendor: true,
        category: true,
        images: { orderBy: { sortOrder: "asc" } },
        variants: {
          include: {
            images: { orderBy: { sortOrder: "asc" } },
            attributes: { include: { attributeValue: true } },
          },
        },
        specifications: { include: { specification: true } },
        warranty: true,
      },
    });
  },

  // ======================
  // Create product
  // ======================
  async create(
    data: CreateProductData & { shippingWarranty?: ProductShippingWarrantyInput; userId?: string }
  ) {
    const product = await prisma.product.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        slug: data.name
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, ""),
        vendorId: data.vendorId,
        categoryId: data.categoryId,

        images: data.images?.length
          ? { create: data.images.map((img: ProductImageInput) => ({ ...img })) }
          : undefined,

        specifications: data.specifications?.length
          ? {
              create: data.specifications.map((spec) => ({
                specificationId: spec.specificationId,
                valueString: spec.valueString ?? null,
                valueNumber: spec.valueNumber ?? null,
              })),
            }
          : undefined,

        variants: data.variants?.length
          ? {
              create: data.variants.map((variant: ProductVariantInput) => ({
                name: variant.name,
                sku: variant.sku,
                price: variant.price,
                stock: variant.stock,
                weight: variant.weight ?? 0,
                attributes: variant.attributes?.length
                  ? { create: variant.attributes.map((attr) => ({ attributeValueId: attr.attributeValueId })) }
                  : undefined,
                images: variant.images?.length
                  ? { create: variant.images.map((url, idx) => ({ url, altText: `${variant.name} image ${idx + 1}`, sortOrder: idx })) }
                  : undefined,
              })),
            }
          : undefined,

        warranty: data.shippingWarranty
          ? {
              create: {
                packageWeightValue: data.shippingWarranty.packageWeightValue,
                packageWeightUnit: data.shippingWarranty.packageWeightUnit.toUpperCase() as "KG" | "G",
                packageLength: data.shippingWarranty.packageLength,
                packageWidth: data.shippingWarranty.packageWidth,
                packageHeight: data.shippingWarranty.packageHeight,
                dangerousGoods:
                  data.shippingWarranty.dangerousGoods === "none" ? "NONE" : "CONTAINS",
                duration: data.shippingWarranty.warrantyPeriodValue,
                unit:
                  data.shippingWarranty.warrantyPeriodUnit === "days"
                    ? "DAYS"
                    : data.shippingWarranty.warrantyPeriodUnit === "months"
                    ? "MONTHS"
                    : "YEARS",
                policy: data.shippingWarranty.warrantyDetails ?? null,
                type: data.shippingWarranty.warrantyType,
              },
            }
          : undefined,
      },
      include: {
        vendor: true,
        category: true,
        images: { orderBy: { sortOrder: "asc" } },
        variants: { include: { images: { orderBy: { sortOrder: "asc" } }, attributes: { include: { attributeValue: true } } } },
        specifications: { include: { specification: true } },
        warranty: true,
      },
    });

    // Audit log
    if (data.userId) {
      await prisma.auditLog.create({
        data: {
          userId: data.userId,
          action: "CREATE",
          entity: "Product",
          entityId: product.id,
          metadata: { productName: product.name },
        },
      });
    }

    return product;
  },

  // ======================
  // Update product
  // ======================
 async update(
  id: string,
  data: Partial<CreateProductData> & {
    shippingWarranty?: ProductShippingWarrantyInput;
    images?: ProductImageInput[];
    status?: "PENDING" | "ACTIVE" | "REJECTED"; // 👈 allow status input
  }
) {
  return prisma.product.update({
    where: { id },
    data: {
      name: data.name,
      description: data.description,
      slug: data.name
        ? data.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
        : undefined,
      vendorId: data.vendorId,
      categoryId: data.categoryId,
      updatedAt: new Date(),

      // 👇 map status → approvalStatus
      approvalStatus: data.status,

      images: data.images?.length
        ? { set: [], create: data.images.map((img: ProductImageInput) => ({ ...img })) }
        : undefined,

      warranty: data.shippingWarranty
        ? {
            upsert: {
              update: {
                packageWeightValue: data.shippingWarranty.packageWeightValue,
                packageWeightUnit: data.shippingWarranty.packageWeightUnit.toUpperCase() as "KG" | "G",
                packageLength: data.shippingWarranty.packageLength,
                packageWidth: data.shippingWarranty.packageWidth,
                packageHeight: data.shippingWarranty.packageHeight,
                dangerousGoods:
                  data.shippingWarranty.dangerousGoods === "none" ? "NONE" : "CONTAINS",
                duration: data.shippingWarranty.warrantyPeriodValue,
                unit:
                  data.shippingWarranty.warrantyPeriodUnit === "days"
                    ? "DAYS"
                    : data.shippingWarranty.warrantyPeriodUnit === "months"
                    ? "MONTHS"
                    : "YEARS",
                policy: data.shippingWarranty.warrantyDetails ?? null,
                type: data.shippingWarranty.warrantyType,
              },
              create: {
                packageWeightValue: data.shippingWarranty.packageWeightValue,
                packageWeightUnit: data.shippingWarranty.packageWeightUnit.toUpperCase() as "KG" | "G",
                packageLength: data.shippingWarranty.packageLength,
                packageWidth: data.shippingWarranty.packageWidth,
                packageHeight: data.shippingWarranty.packageHeight,
                dangerousGoods:
                  data.shippingWarranty.dangerousGoods === "none" ? "NONE" : "CONTAINS",
                duration: data.shippingWarranty.warrantyPeriodValue,
                unit:
                  data.shippingWarranty.warrantyPeriodUnit === "days"
                    ? "DAYS"
                    : data.shippingWarranty.warrantyPeriodUnit === "months"
                    ? "MONTHS"
                    : "YEARS",
                policy: data.shippingWarranty.warrantyDetails ?? null,
                type: data.shippingWarranty.warrantyType,
              },
            },
          }
        : undefined,
    },
    include: {
      vendor: true,
      category: true,
      images: { orderBy: { sortOrder: "asc" } },
      variants: {
        include: {
          images: { orderBy: { sortOrder: "asc" } },
          attributes: { include: { attributeValue: true } },
        },
      },
      specifications: { include: { specification: true } },
      warranty: true,
      approvedBy: true, // 👈 include approver details
    },
  });
}

,

  // ======================
  // Remove product
  // ======================
  async remove(id: string) {
    await prisma.productImage.deleteMany({
      where: { OR: [{ productId: id }, { variant: { productId: id } }] },
    });

    await prisma.productVariantAttribute.deleteMany({
      where: { variant: { productId: id } },
    });

    await prisma.productVariant.deleteMany({ where: { productId: id } });

    await prisma.productSpecificationValue.deleteMany({ where: { productId: id } });

    return prisma.product.delete({ where: { id } });
  },
};
