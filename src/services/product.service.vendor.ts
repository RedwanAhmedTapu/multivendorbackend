// services/product.service.vendor.ts
import { prisma } from "../config/prisma.ts";

import type {
  CreateProductData,
  ProductImageInput,
  ProductShippingWarrantyInput,
  ProductVariantInput,
} from "@/types/product.ts";

/**
 * Vendor Product Service
 * Handles vendor-specific product operations
 */

/**
 * Helper function to check if text contains image URLs
 */
function containsImageUrls(text: string): boolean {
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];
  const imagePatterns = [
    /https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg)/i,
    /<img[^>]+src=["'][^"']+["'][^>]*>/i,
    /!\[.*?\]\(.*?\)/, // Markdown images
  ];

  const lowerText = text.toLowerCase();

  // Check for file extensions
  if (imageExtensions.some((ext) => lowerText.includes(ext))) {
    return true;
  }

  // Check for URL patterns
  return imagePatterns.some((pattern) => pattern.test(text));
}

export const VendorProductService = {
  // ======================
  // Get My Products
  // ======================
  async getMyProducts(
    vendorId: string,
    options: {
      status?: "PENDING" | "ACTIVE" | "REJECTED" | "DRAFT";
      search?: string;
      category?: string;
      minPrice?: number;
      maxPrice?: number;
      sortBy?: string;
      sortOrder?: "asc" | "desc";
      page?: number;
      limit?: number;
    } = {}
  ) {
    const {
      status,
      search,
      category,
      minPrice,
      maxPrice,
      sortBy = "createdAt",
      sortOrder = "desc",
      page = 1,
      limit = 10,
    } = options;

    // Build where clause
    const where: any = { vendorId };

    // Status filter
    if (status) {
      where.approvalStatus = status;
    }

    // Search filter (search in name, description, SKU)
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        {
          variants: {
            some: { sku: { contains: search, mode: "insensitive" } },
          },
        },
      ];
    }

    // Category filter
    if (category) {
      where.categoryId = category;
    }

    // Price range filter
    if (minPrice !== undefined || maxPrice !== undefined) {
      where.variants = {
        some: {
          ...(minPrice !== undefined && { price: { gte: minPrice } }),
          ...(maxPrice !== undefined && { price: { lte: maxPrice } }),
        },
      };
    }

    // Sort configuration
    let orderBy: any = { [sortBy]: sortOrder };

    // Handle special sort cases
    if (sortBy === "price") {
      orderBy = { variants: { price: sortOrder } };
    } else if (sortBy === "stock") {
      orderBy = { variants: { stock: sortOrder } };
    }

    // Get total count for pagination
    const total = await prisma.product.count({ where });

    // Calculate pagination
    const skip = (page - 1) * limit;
    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    // Fetch products with pagination
    const products = await prisma.product.findMany({
      where,
      include: {
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
            status: true,
          },
        },
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            image: true,
          },
        },
        images: {
          orderBy: { sortOrder: "asc" },
          take: 5,
        },
        variants: {
          include: {
            images: {
              orderBy: { sortOrder: "asc" },
              take: 3,
            },
            attributes: {
              include: {
                attributeValue: {
                  include: {
                    attribute: {
                      select: {
                        id: true,
                        name: true,
                        slug: true,
                        type: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        attributes: {
          include: {
            attribute: {
              select: {
                id: true,
                name: true,
                slug: true,
                type: true,
                unit: true,
              },
            },
            attributeValue: true,
          },
        },
        warranty: true,
        reviews: {
          select: {
            id: true,
            rating: true,
          },
        },
        approvedBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy,
      skip,
      take: limit,
    });

    return {
      products,
      total,
      page,
      limit,
      totalPages,
      hasNext,
      hasPrev,
    };
  },
  // ======================
  // Get products by vendor ID
  // ======================
  async getByVendorId(
    vendorId: string,
    options?: {
      status?: "PENDING" | "ACTIVE" | "REJECTED";
      includeInactive?: boolean;
    }
  ) {
    const where: any = { vendorId };

    if (options?.status) {
      where.approvalStatus = options.status;
    }

    return prisma.product.findMany({
      where,
      include: {
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
            status: true,
          },
        },
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            image: true,
          },
        },
        images: {
          orderBy: { sortOrder: "asc" },
          take: 5,
        },
        variants: {
          include: {
            images: {
              orderBy: { sortOrder: "asc" },
              take: 3,
            },
            attributes: {
              include: {
                attributeValue: {
                  include: {
                    attribute: {
                      select: {
                        id: true,
                        name: true,
                        slug: true,
                        type: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        attributes: {
          include: {
            attribute: {
              select: {
                id: true,
                name: true,
                slug: true,
                type: true,
                unit: true,
              },
            },
            attributeValue: true,
          },
        },
        warranty: true,
        reviews: {
          select: {
            id: true,
            rating: true,
          },
        },
        approvedBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }],
    });
  },

  // ======================
  // Get single product (vendor can see their own regardless of status)
  // ======================
  async getById(id: string, vendorId: string) {
    return prisma.product.findFirst({
      where: {
        id,
        vendorId,
      },
      include: {
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
            status: true,
            verificationStatus: true,
          },
        },
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            image: true,
            parent: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
        images: {
          orderBy: { sortOrder: "asc" },
        },
        variants: {
          include: {
            images: { orderBy: { sortOrder: "asc" } },
            attributes: {
              include: {
                attributeValue: {
                  include: {
                    attribute: true,
                  },
                },
              },
            },
          },
        },
        attributes: {
          where: {
            isForVariant: false,
          },
          include: {
            attribute: true,
            attributeValue: true,
          },
        },
        warranty: true,
        reviews: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        approvedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });
  },

  // ======================
  // Create product
  // ======================
  async create(
    data: CreateProductData & {
      shippingWarranty?: ProductShippingWarrantyInput;
      userId?: string;
    }
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
        approvalStatus: "PENDING",

        images: data.images?.length
          ? {
              create: data.images.map((img: ProductImageInput, index) => ({
                url: img.url,
                altText: img.altText || `${data.name} image ${index + 1}`,
                sortOrder: img.sortOrder ?? index,
              })),
            }
          : undefined,

        // Create specifications
        attributes: data.attributes?.length
          ? {
              create: data.attributes.map((spec) => {
                const attributeData: any = {
                  attributeId: spec.attributeId,
                  isForVariant: false,
                };

                if (spec.valueString !== undefined) {
                  attributeData.valueString = spec.valueString;
                } else if (spec.valueNumber !== undefined) {
                  attributeData.valueNumber = spec.valueNumber;
                } else if (spec.valueBoolean !== undefined) {
                  attributeData.valueBoolean = spec.valueBoolean;
                } else if (spec.attributeValueId) {
                  attributeData.attributeValueId = spec.attributeValueId;
                }

                return attributeData;
              }),
            }
          : undefined,

        variants: data.variants?.length
          ? {
              create: data.variants.map((variant: ProductVariantInput) => {
                const discount =
                  variant.specialPrice && variant.price
                    ? Math.round(
                        ((variant.price - variant.specialPrice) /
                          variant.price) *
                          100
                      )
                    : 0;

                return {
                  name: variant.name,
                  sku: variant.sku,
                  price: variant.price,
                  specialPrice: variant.specialPrice ?? null,
                  discount: discount,
                  stock: variant.stock ?? 0,

                  attributes: variant.attributes?.length
                    ? {
                        create: variant.attributes.map((attr) => ({
                          attributeValueId: attr.attributeValueId,
                        })),
                      }
                    : undefined,

                  images: variant.images?.length
                    ? {
                        create: variant.images.map((img, idx) => ({
                          url: typeof img === "string" ? img : img.url,
                          altText:
                            typeof img === "string"
                              ? `${variant.name} image ${idx + 1}`
                              : img.altText ||
                                `${variant.name} image ${idx + 1}`,
                          sortOrder:
                            typeof img === "string"
                              ? idx
                              : img.sortOrder ?? idx,
                        })),
                      }
                    : undefined,
                };
              }),
            }
          : undefined,

        warranty: data.shippingWarranty
          ? {
              create: {
                packageWeightValue: data.shippingWarranty.packageWeightValue,
                packageWeightUnit:
                  data.shippingWarranty.packageWeightUnit.toUpperCase() as
                    | "KG"
                    | "G",
                packageLength: data.shippingWarranty.packageLength,
                packageWidth: data.shippingWarranty.packageWidth,
                packageHeight: data.shippingWarranty.packageHeight,
                dangerousGoods:
                  data.shippingWarranty.dangerousGoods === "none"
                    ? "NONE"
                    : "CONTAINS",
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
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
          },
        },
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        images: { orderBy: { sortOrder: "asc" } },
        variants: {
          include: {
            images: { orderBy: { sortOrder: "asc" } },
            attributes: {
              include: {
                attributeValue: {
                  include: {
                    attribute: true,
                  },
                },
              },
            },
          },
        },
        attributes: {
          where: {
            isForVariant: false,
          },
          include: {
            attribute: true,
            attributeValue: true,
          },
        },
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
          newData: {
            productName: product.name,
            vendorId: product.vendorId,
            categoryId: product.categoryId,
          },
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
    vendorId: string,
    data: Partial<CreateProductData> & {
      shippingWarranty?: ProductShippingWarrantyInput;
      images?: ProductImageInput[];
      variants?: ProductVariantInput[];
      userId?: string;
    }
  ) {
    // Verify vendor owns this product
    const existingProduct = await prisma.product.findFirst({
      where: { id, vendorId },
      select: {
        name: true,
        approvalStatus: true,
        vendorId: true,
        categoryId: true,
      },
    });

    if (!existingProduct) {
      throw new Error("Product not found or unauthorized");
    }

    const updateData: any = {
      updatedAt: new Date(),
    };

    // Update basic fields
    if (data.name !== undefined) {
      updateData.name = data.name;
      updateData.slug = data.name
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
    }
    if (data.description !== undefined) {
      updateData.description = data.description;
    }
    if (data.categoryId !== undefined) {
      updateData.categoryId = data.categoryId;
    }

    // Reset approval status to PENDING when product is updated
    updateData.approvalStatus = "PENDING";
    updateData.approvedById = null;

    // Handle images
    if (data.images && data.images.length > 0) {
      updateData.images = {
        deleteMany: { productId: id },
        create: data.images.map((img: ProductImageInput, index) => ({
          url: img.url,
          altText: img.altText || `Product image ${index + 1}`,
          sortOrder: img.sortOrder ?? index,
        })),
      };
    }

    // Handle specifications
    if (data.attributes && data.attributes.length > 0) {
      updateData.attributes = {
        deleteMany: { productId: id, isForVariant: false },
        create: data.attributes.map((spec) => {
          const attributeData: any = {
            attributeId: spec.attributeId,
            isForVariant: false,
          };

          if (spec.valueString !== undefined) {
            attributeData.valueString = spec.valueString;
          } else if (spec.valueNumber !== undefined) {
            attributeData.valueNumber = spec.valueNumber;
          } else if (spec.valueBoolean !== undefined) {
            attributeData.valueBoolean = spec.valueBoolean;
          } else if (spec.attributeValueId) {
            attributeData.attributeValueId = spec.attributeValueId;
          }

          return attributeData;
        }),
      };
    }

    // Handle variants
    if (data.variants && data.variants.length > 0) {
      updateData.variants = {
        deleteMany: { productId: id },
        create: data.variants.map((variant: ProductVariantInput) => {
          const discount =
            variant.specialPrice && variant.price
              ? Math.round(
                  ((variant.price - variant.specialPrice) / variant.price) * 100
                )
              : 0;

          return {
            name: variant.name,
            sku: variant.sku,
            price: variant.price,
            specialPrice: variant.specialPrice ?? null,
            discount: discount,
            stock: variant.stock ?? 0,

            attributes: variant.attributes?.length
              ? {
                  create: variant.attributes.map((attr) => ({
                    attributeValueId: attr.attributeValueId,
                  })),
                }
              : undefined,

            images: variant.images?.length
              ? {
                  create: variant.images.map((img, idx) => ({
                    url: typeof img === "string" ? img : img.url,
                    altText:
                      typeof img === "string"
                        ? `${variant.name} image ${idx + 1}`
                        : img.altText || `${variant.name} image ${idx + 1}`,
                    sortOrder:
                      typeof img === "string" ? idx : img.sortOrder ?? idx,
                  })),
                }
              : undefined,
          };
        }),
      };
    }

    // Handle warranty
    if (data.shippingWarranty) {
      updateData.warranty = {
        upsert: {
          update: {
            packageWeightValue: data.shippingWarranty.packageWeightValue,
            packageWeightUnit:
              data.shippingWarranty.packageWeightUnit.toUpperCase() as
                | "KG"
                | "G",
            packageLength: data.shippingWarranty.packageLength,
            packageWidth: data.shippingWarranty.packageWidth,
            packageHeight: data.shippingWarranty.packageHeight,
            dangerousGoods:
              data.shippingWarranty.dangerousGoods === "none"
                ? "NONE"
                : "CONTAINS",
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
            packageWeightUnit:
              data.shippingWarranty.packageWeightUnit.toUpperCase() as
                | "KG"
                | "G",
            packageLength: data.shippingWarranty.packageLength,
            packageWidth: data.shippingWarranty.packageWidth,
            packageHeight: data.shippingWarranty.packageHeight,
            dangerousGoods:
              data.shippingWarranty.dangerousGoods === "none"
                ? "NONE"
                : "CONTAINS",
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
      };
    }

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: updateData,
      include: {
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
            status: true,
            verificationStatus: true,
          },
        },
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            image: true,
            parent: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
        images: {
          orderBy: { sortOrder: "asc" },
        },
        variants: {
          include: {
            images: {
              orderBy: { sortOrder: "asc" },
            },
            attributes: {
              include: {
                attributeValue: {
                  include: {
                    attribute: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        attributes: {
          where: {
            isForVariant: false,
          },
          include: {
            attribute: true,
            attributeValue: true,
          },
        },
        warranty: true,
        reviews: {
          select: {
            id: true,
            rating: true,
          },
        },
        approvedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Audit log
    if (data.userId) {
      await prisma.auditLog.create({
        data: {
          userId: data.userId,
          action: "UPDATE",
          entity: "Product",
          entityId: id,
          oldData: existingProduct,
          newData: {
            name: updatedProduct.name,
            approvalStatus: updatedProduct.approvalStatus,
            vendorId: updatedProduct.vendorId,
            categoryId: updatedProduct.categoryId,
            variantsCount: updatedProduct.variants.length,
            imagesCount: updatedProduct.images.length,
          },
        },
      });
    }

    return updatedProduct;
  },

  // ======================
  // Delete product
  // ======================
  async remove(id: string, vendorId: string, userId?: string) {
    // Verify vendor owns this product
    const product = await prisma.product.findFirst({
      where: { id, vendorId },
      select: {
        name: true,
        vendorId: true,
      },
    });

    if (!product) {
      throw new Error("Product not found or unauthorized");
    }

    // Delete related records
    await prisma.productImage.deleteMany({
      where: {
        OR: [{ productId: id }, { variant: { productId: id } }],
      },
    });

    await prisma.productVariantAttribute.deleteMany({
      where: { variant: { productId: id } },
    });

    await prisma.productVariant.deleteMany({
      where: { productId: id },
    });

    await prisma.productAttribute.deleteMany({
      where: { productId: id },
    });

    await prisma.review.deleteMany({
      where: { productId: id },
    });

    await prisma.warranty.deleteMany({
      where: { productId: id },
    });

    const deletedProduct = await prisma.product.delete({
      where: { id },
    });

    // Audit log
    if (userId) {
      await prisma.auditLog.create({
        data: {
          userId,
          action: "DELETE",
          entity: "Product",
          entityId: id,
          oldData: product,
        },
      });
    }

    return deletedProduct;
  },

  // ======================
  // Update product stock
  // ======================
  async updateStock(
    productId: string,
    vendorId: string,
    variantId: string,
    newStock: number
  ) {
    // Verify vendor owns this product
    const product = await prisma.product.findFirst({
      where: { id: productId, vendorId },
    });

    if (!product) {
      throw new Error("Product not found or unauthorized");
    }

    return prisma.productVariant.update({
      where: { id: variantId },
      data: {
        stock: newStock,
      },
    });
  },
  // ======================
  // Update product price
  // ======================
  async updatePrice(
    productId: string,
    vendorId: string,
    variantId: string,
    newPrice: number,
    updateDiscount?: boolean
  ) {
    // Verify vendor owns this product
    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        vendorId,
        variants: {
          some: { id: variantId },
        },
      },
      include: {
        variants: {
          where: { id: variantId },
        },
      },
    });

    if (!product) {
      throw new Error("Product not found or unauthorized");
    }

    const variant = product.variants[0];
    const updateData: any = { price: newPrice };

    // Automatically update discount percentage if special price exists
    if (updateDiscount && variant.specialPrice) {
      const discount = Math.round(
        ((variant.specialPrice - newPrice) / variant.specialPrice) * 100
      );
      updateData.discount = Math.max(0, discount);
    }

    return prisma.productVariant.update({
      where: { id: variantId },
      data: updateData,
    });
  },
  // ======================
  // Update product special price
  // ======================
  async updateSpecialPrice(
    productId: string,
    vendorId: string,
    variantId: string,
    specialPrice: number | null,
    updateDiscount?: boolean
  ) {
    // Verify vendor owns this product
    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        vendorId,
        variants: {
          some: { id: variantId },
        },
      },
      include: {
        variants: {
          where: { id: variantId },
        },
      },
    });

    if (!product) {
      throw new Error("Product not found or unauthorized");
    }

    const variant = product.variants[0];
    const updateData: any = { specialPrice };

    // Calculate discount percentage if needed
    if (updateDiscount && specialPrice && variant.price) {
      const discount = Math.round(
        ((variant.price - specialPrice) / variant.price) * 100
      );
      updateData.discount = Math.max(0, discount);
    } else if (specialPrice === null) {
      // Remove discount if special price is cleared
      updateData.discount = null;
    }

    return prisma.productVariant.update({
      where: { id: variantId },
      data: updateData,
    });
  },
  // ======================
  // Get vendor statistics
  // ======================
  async getStatistics(vendorId: string) {
    const [total, pending, active, rejected, totalReviews, avgRating] =
      await Promise.all([
        prisma.product.count({ where: { vendorId } }),
        prisma.product.count({
          where: { vendorId, approvalStatus: "PENDING" },
        }),
        prisma.product.count({
          where: { vendorId, approvalStatus: "ACTIVE" },
        }),
        prisma.product.count({
          where: { vendorId, approvalStatus: "REJECTED" },
        }),
        prisma.review.count({
          where: { product: { vendorId } },
        }),
        prisma.review.aggregate({
          where: { product: { vendorId } },
          _avg: { rating: true },
        }),
      ]);

    return {
      total,
      pending,
      active,
      rejected,
      totalReviews,
      averageRating: avgRating._avg.rating || 0,
    };
  },

  async getProductsContentSummary(vendorId: string) {
    const products = await prisma.product.findMany({
      where: { vendorId },
      select: {
        id: true,
        name: true,
        description: true,
        images: {
          select: { url: true },
        },
        approvalStatus: true,
      },
    });

    const summary = await Promise.all(
      products.map(async (product) => {
        const mainImageCount = product.images.length;
        const hasEnoughMainImages = mainImageCount >= 3;
        const hasDescriptionImages = product.description
          ? containsImageUrls(product.description)
          : false;
        const isDescriptionTooShort = product.description
          ? product.description.trim().length < 150
          : true;

        const issues = [];
        if (!hasEnoughMainImages) issues.push("Need more images");
        if (!hasDescriptionImages) issues.push("No images in description");
        if (isDescriptionTooShort) issues.push("Short description");

        return {
          productId: product.id,
          productName: product.name,
          status: product.approvalStatus,
          imageCount: mainImageCount,
          hasDescriptionImages,
          isDescriptionTooShort,
          issues,
          needsImprovement: issues.length > 0,
        };
      })
    );

    const needsImprovement = summary.filter(
      (item) => item.needsImprovement
    ).length;

    return {
      totalProducts: summary.length,
      needsImprovement,
      improvementRate:
        Math.round((needsImprovement / summary.length) * 100) || 0,
      products: summary,
    };
  },
};
