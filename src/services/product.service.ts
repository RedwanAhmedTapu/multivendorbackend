// services/product.service.ts
import { prisma } from "../config/prisma.ts";

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
    const now = new Date();

    return prisma.product.findMany({
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
            isForVariant: false, // Only specifications
          },
          include: {
            attribute: true,
            attributeValue: true, // For SELECT/MULTISELECT types
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
        offerProducts: {
          where: {
            offer: {
              type: "FREE_SHIPPING",
              isActive: true,
              status: "ACTIVE",
              validFrom: { lte: now },
              OR: [
                { validTo: { gte: now } },
                { validTo: null },
              ],
            },
          },
          take: 1,
          select: {
            offer: {
              select: {
                id: true,
                type: true,
                title: true,
                minOrderAmount: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  // ======================
  // Get product by ID
  // ======================
  async getById(id: string) {
    return prisma.product.findUnique({
      where: { id },
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
            isForVariant: false, // Only specifications
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
          take: 10,
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
          where: {
            isForVariant: false, // Only specifications
          },
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

        // Create specifications using ProductAttribute with isForVariant: false
        attributes: data.attributes?.length
          ? {
              create: data.attributes.map((spec) => {
                const attributeData: any = {
                  attributeId: spec.attributeId,
                  isForVariant: false,
                };

                // Handle different attribute types
                if (spec.valueString !== undefined) {
                  attributeData.valueString = spec.valueString;
                } else if (spec.valueNumber !== undefined) {
                  attributeData.valueNumber = spec.valueNumber;
                } else if (spec.valueBoolean !== undefined) {
                  attributeData.valueBoolean = spec.valueBoolean;
                } else if (spec.attributeValueId) {
                  // For SELECT/MULTISELECT types
                  attributeData.attributeValueId = spec.attributeValueId;
                }

                return attributeData;
              }),
            }
          : undefined,

        variants: data.variants?.length
          ? {
              create: data.variants.map((variant: ProductVariantInput) => {
                // Auto calculate discount
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
    data: Partial<CreateProductData> & {
      shippingWarranty?: ProductShippingWarrantyInput;
      images?: ProductImageInput[];
      specifications?: Array<{
        attributeId: string;
        valueString?: string;
        valueNumber?: number;
        valueBoolean?: boolean;
        attributeValueId?: string;
      }>;
      status?: "PENDING" | "ACTIVE" | "REJECTED";
      approvedById?: string;
      userId?: string;
    }
  ) {
    // Get old data for audit log
    const oldProduct = await prisma.product.findUnique({
      where: { id },
      select: {
        name: true,
        approvalStatus: true,
        vendorId: true,
        categoryId: true,
      },
    });

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
    if (data.description !== undefined)
      updateData.description = data.description;
    if (data.vendorId !== undefined) updateData.vendorId = data.vendorId;
    if (data.categoryId !== undefined) updateData.categoryId = data.categoryId;

    // Update approval status
    if (data.status !== undefined) {
      updateData.approvalStatus = data.status;
      if (data.approvedById && data.status === "ACTIVE") {
        updateData.approvedById = data.approvedById;
      }
    }

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

    // Handle specifications update
    if (data.specifications && data.specifications.length > 0) {
      updateData.attributes = {
        deleteMany: { productId: id, isForVariant: false },
        create: data.specifications.map((spec) => {
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
          newData: {
            name: updatedProduct.name,
            approvalStatus: updatedProduct.approvalStatus,
            vendorId: updatedProduct.vendorId,
            categoryId: updatedProduct.categoryId,
          },
        },
      });
    }

    return updatedProduct;
  },

  // ======================
  // Remove product
  // ======================
  async remove(id: string, userId?: string) {
    // Get product info for audit log
    const product = await prisma.product.findUnique({
      where: { id },
      select: {
        name: true,
        vendorId: true,
      },
    });

    // Delete related records in correct order
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

    // Delete ProductAttribute records (handles both specifications and variant settings)
    await prisma.productAttribute.deleteMany({
      where: { productId: id },
    });

    await prisma.review.deleteMany({
      where: { productId: id },
    });

    await prisma.warranty.deleteMany({
      where: { productId: id },
    });

    // Delete the product
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
        },
      });
    }

    return deletedProduct;
  },

  // ======================
  // Filter products
  // ======================
  async filterProducts(filters: {
    vendorId?: string;
    categoryId?: string;
    categoryIds?: string[];
    minPrice?: number;
    maxPrice?: number;
    attributes?: Record<string, string[]>;
    specifications?: Record<string, string[]>;
    ratings?: number[];
    brands?: string[];
    vendors?: string[];
    inStock?: boolean;
    onSale?: boolean;
    newArrivals?: boolean;
    search?: string;
    approvalStatus?: "PENDING" | "ACTIVE" | "REJECTED";
  }) {
    const where: any = {
      approvalStatus: filters.approvalStatus || "ACTIVE",
    };

    if (filters.vendorId) {
      where.vendorId = filters.vendorId;
    }

    if (filters.categoryIds && filters.categoryIds.length > 0) {
      where.categoryId = { in: filters.categoryIds };
    } else if (filters.categoryId) {
      where.categoryId = filters.categoryId;
    }

    if (filters.vendors && filters.vendors.length > 0) {
      where.vendorId = { in: filters.vendors };
    }

    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: "insensitive" } },
        { description: { contains: filters.search, mode: "insensitive" } },
      ];
    }

    const variantsConditions: any[] = [];

    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      const priceCondition: any = {};
      if (filters.minPrice !== undefined) priceCondition.gte = filters.minPrice;
      if (filters.maxPrice !== undefined) priceCondition.lte = filters.maxPrice;
      variantsConditions.push({ price: priceCondition });
    }

    if (filters.inStock) {
      variantsConditions.push({ stock: { gt: 0 } });
    }

    if (variantsConditions.length > 0) {
      where.variants = {
        some: {
          AND: variantsConditions,
        },
      };
    }

    // Attribute filters (for variant attributes)
    if (filters.attributes && Object.keys(filters.attributes).length > 0) {
      const attributeConditions = Object.entries(filters.attributes)
        .filter(([_, valueIds]) => {
          return Array.isArray(valueIds) && valueIds.length > 0;
        })
        .map(([attributeId, valueIds]) => {
          const validValueIds = Array.isArray(valueIds)
            ? valueIds
            : [valueIds].filter(Boolean);

          return {
            variants: {
              some: {
                attributes: {
                  some: {
                    attributeValueId: { in: validValueIds },
                  },
                },
              },
            },
          };
        });

      if (attributeConditions.length > 0) {
        where.AND = [...(where.AND || []), ...attributeConditions];
      }
    }

    // Specification filters (using ProductAttribute with isForVariant: false)
    if (
      filters.specifications &&
      Object.keys(filters.specifications).length > 0
    ) {
      const specificationConditions = Object.entries(filters.specifications)
        .filter(([_, values]) => Array.isArray(values) && values.length > 0)
        .map(([attributeId, values]) => {
          const validValues = Array.isArray(values)
            ? values
            : [values].filter(Boolean);

          return {
            attributes: {
              some: {
                attributeId: attributeId,
                isForVariant: false, // Only specifications
                OR: [
                  { valueString: { in: validValues } },
                  {
                    valueNumber: {
                      in: validValues
                        .map((v) => parseFloat(v))
                        .filter((v) => !isNaN(v)),
                    },
                  },
                  {
                    attributeValue: {
                      value: { in: validValues },
                    },
                  },
                ],
              },
            },
          };
        });

      if (specificationConditions.length > 0) {
        where.AND = [...(where.AND || []), ...specificationConditions];
      }
    }

    try {
      const products = await prisma.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          approvalStatus: true,
          createdAt: true,
          vendor: {
            select: {
              id: true,
              storeName: true,
              avatar: true,
              verificationStatus: true,
            },
          },
          category: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
          images: {
            orderBy: { sortOrder: "asc" },
            take: 1,
            select: {
              url: true,
              altText: true,
            },
          },
          variants: {
            take: 1,
            orderBy: { price: "asc" },
            select: {
              price: true,
              specialPrice: true,
              discount: true,
              stock: true,
            },
          },
          reviews: {
            select: {
              rating: true,
            },
          },
          offerProducts: {
            where: {
              offer: {
                type: "FREE_SHIPPING",
                isActive: true,
                status: "ACTIVE",
                validFrom: { lte: new Date() },
                OR: [{ validTo: { gte: new Date() } }, { validTo: null }],
              },
            },
            take: 1,
            select: {
              offer: {
                select: {
                  id: true,
                  type: true,
                  title: true,
                  minOrderAmount: true,
                },
              },
            },
          },
        },
        orderBy: [{ createdAt: "desc" }],
      });

      let filteredProducts = products;

      if (filters.ratings && filters.ratings.length > 0) {
        const minRating = Math.min(...filters.ratings);
        filteredProducts = filteredProducts.filter((product: any) => {
          const avgRating =
            product.reviews.length > 0
              ? product.reviews.reduce(
                  (sum: number, r: any) => sum + r.rating,
                  0
                ) / product.reviews.length
              : 0;
          return avgRating >= minRating;
        });
      }

      if (filters.brands && filters.brands.length > 0) {
        filteredProducts = filteredProducts.filter((product: any) => {
          const brandAttributes = product.variants.flatMap((v: any) =>
            v.attributes
              .filter(
                (a: any) =>
                  a.attributeValue.attribute.slug === "brand" ||
                  a.attributeValue.attribute.name.toLowerCase() === "brand"
              )
              .map((a: any) => a.attributeValue.value)
          );
          return brandAttributes.some((brand: string) =>
            filters.brands!.includes(brand)
          );
        });
      }

      if (filters.newArrivals) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        filteredProducts = filteredProducts.filter(
          (product: any) => new Date(product.createdAt) >= thirtyDaysAgo
        );
      }

      if (filters.onSale) {
        filteredProducts = filteredProducts.filter((product: any) =>
          product.variants.some(
            (v: any) => v.specialPrice && v.specialPrice < v.price
          )
        );
      }

      console.log(
        `Found ${filteredProducts.length} products after post-filtering`
      );
      return filteredProducts;
    } catch (error) {
      console.error("Database error:", error);
      throw error;
    }
  },

  // ======================
  // Get product statistics
  // ======================
  async getStatistics(vendorId?: string) {
    const where = vendorId ? { vendorId } : {};

    const [total, pending, active, rejected] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.count({ where: { ...where, approvalStatus: "PENDING" } }),
      prisma.product.count({ where: { ...where, approvalStatus: "ACTIVE" } }),
      prisma.product.count({ where: { ...where, approvalStatus: "REJECTED" } }),
    ]);

    return {
      total,
      pending,
      active,
      rejected,
    };
  },

  // ======================
  // Additional Helper Methods
  // ======================

  // Get products by category
  async getByCategoryId(categoryId: string) {
    return prisma.product.findMany({
      where: { 
        categoryId,
        approvalStatus: "ACTIVE"
      },
      include: {
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
          },
        },
        images: {
          orderBy: { sortOrder: "asc" },
          take: 1,
        },
        variants: {
          take: 1,
          orderBy: { price: "asc" },
          select: {
            price: true,
            specialPrice: true,
            discount: true,
            stock: true,
          },
        },
        reviews: {
          select: {
            rating: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  // Get featured products
  async getFeatured(limit: number = 10) {
    return prisma.product.findMany({
      where: { 
        approvalStatus: "ACTIVE",
        variants: {
          some: {
            discount: { gt: 0 }, // Products with discounts
          },
        },
      },
      include: {
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
          },
        },
        images: {
          orderBy: { sortOrder: "asc" },
          take: 1,
        },
        variants: {
          take: 1,
          orderBy: { price: "asc" },
          select: {
            price: true,
            specialPrice: true,
            discount: true,
            stock: true,
          },
        },
        reviews: {
          select: {
            rating: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },

  // Update product stock
  async updateStock(productId: string, variantId: string, quantity: number) {
    return prisma.productVariant.update({
      where: { id: variantId },
      data: {
        stock: {
          decrement: quantity,
        },
      },
    });
  },

  // Approve product
  async approveProduct(id: string, adminId: string) {
    return this.update(id, {
      status: "ACTIVE",
      approvedById: adminId,
    });
  },

  // Reject product
  async rejectProduct(id: string, adminId: string) {
    return this.update(id, {
      status: "REJECTED",
      approvedById: adminId,
    });
  },

  // Get products needing approval
  async getPendingApproval() {
    return prisma.product.findMany({
      where: { approvalStatus: "PENDING" },
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
          },
        },
        images: {
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
    });
  },
};