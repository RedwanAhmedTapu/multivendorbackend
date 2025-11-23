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
    return prisma.product.findMany({
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
              } 
            },
          },
        },
        specifications: { 
          include: { 
            specification: true,
          } 
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
              } 
            },
          },
        },
        specifications: { 
          include: { 
            specification: true,
          } 
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
    
    // Filter by approval status if provided
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
              } 
            },
          },
          orderBy: { createdAt: "asc" },
        },
        specifications: { 
          include: { 
            specification: {
              select: {
                id: true,
                name: true,
                slug: true,
                type: true,
                unit: true,
              },
            },
          } 
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
      orderBy: [
        { createdAt: "desc" },
      ],
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
        approvalStatus: "PENDING", // Default to pending

        images: data.images?.length
          ? { 
              create: data.images.map((img: ProductImageInput, index) => ({ 
                url: img.url,
                altText: img.altText || `${data.name} image ${index + 1}`,
                sortOrder: img.sortOrder ?? index,
              })) 
            }
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
                stock: variant.stock ?? 0,
                weight: variant.weight ?? 0,
                
                attributes: variant.attributes?.length
                  ? { 
                      create: variant.attributes.map((attr) => ({ 
                        attributeValueId: attr.attributeValueId 
                      })) 
                    }
                  : undefined,
                
                images: variant.images?.length
                  ? { 
                      create: variant.images.map((img, idx) => ({ 
                        url: typeof img === 'string' ? img : img.url,
                        altText: typeof img === 'string' 
                          ? `${variant.name} image ${idx + 1}` 
                          : img.altText || `${variant.name} image ${idx + 1}`,
                        sortOrder: typeof img === 'string' ? idx : img.sortOrder ?? idx,
                      })) 
                    }
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
                dangerousGoods: data.shippingWarranty.dangerousGoods === "none" 
                  ? "NONE" 
                  : "CONTAINS",
                duration: data.shippingWarranty.warrantyPeriodValue,
                unit: data.shippingWarranty.warrantyPeriodUnit === "days"
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
              } 
            } 
          } 
        },
        specifications: { 
          include: { 
            specification: true,
          } 
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
    if (data.description !== undefined) updateData.description = data.description;
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

    // Handle warranty
    if (data.shippingWarranty) {
      updateData.warranty = {
        upsert: {
          update: {
            packageWeightValue: data.shippingWarranty.packageWeightValue,
            packageWeightUnit: data.shippingWarranty.packageWeightUnit.toUpperCase() as "KG" | "G",
            packageLength: data.shippingWarranty.packageLength,
            packageWidth: data.shippingWarranty.packageWidth,
            packageHeight: data.shippingWarranty.packageHeight,
            dangerousGoods: data.shippingWarranty.dangerousGoods === "none" 
              ? "NONE" 
              : "CONTAINS",
            duration: data.shippingWarranty.warrantyPeriodValue,
            unit: data.shippingWarranty.warrantyPeriodUnit === "days"
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
            dangerousGoods: data.shippingWarranty.dangerousGoods === "none" 
              ? "NONE" 
              : "CONTAINS",
            duration: data.shippingWarranty.warrantyPeriodValue,
            unit: data.shippingWarranty.warrantyPeriodUnit === "days"
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
              } 
            },
          },
        },
        specifications: { 
          include: { 
            specification: true,
          } 
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
          oldData: oldProduct,
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
        OR: [
          { productId: id }, 
          { variant: { productId: id } }
        ] 
      },
    });

    await prisma.productVariantAttribute.deleteMany({
      where: { variant: { productId: id } },
    });

    await prisma.productVariant.deleteMany({ 
      where: { productId: id } 
    });

    await prisma.productSpecificationValue.deleteMany({ 
      where: { productId: id } 
    });

    await prisma.productAttributeSetting.deleteMany({
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
      where: { id } 
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
    // Build where clause dynamically
    const where: any = {
      approvalStatus: filters.approvalStatus || "ACTIVE",
    };

    // Vendor ID filter (for single vendor)
    if (filters.vendorId) {
      where.vendorId = filters.vendorId;
    }

    // Category filter - handle both single categoryId and multiple categoryIds
    if (filters.categoryIds && filters.categoryIds.length > 0) {
      where.categoryId = { in: filters.categoryIds };
    } else if (filters.categoryId) {
      where.categoryId = filters.categoryId;
    }

    // Vendor filter (for multiple vendors)
    if (filters.vendors && filters.vendors.length > 0) {
      where.vendorId = { in: filters.vendors };
    }

    // Search filter
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: "insensitive" } },
        { description: { contains: filters.search, mode: "insensitive" } },
      ];
    }

    // Initialize variants conditions array
    const variantsConditions: any[] = [];

    // Price range filter
    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      const priceCondition: any = {};
      if (filters.minPrice !== undefined) priceCondition.gte = filters.minPrice;
      if (filters.maxPrice !== undefined) priceCondition.lte = filters.maxPrice;
      variantsConditions.push({ price: priceCondition });
    }

    // Stock availability filter
    if (filters.inStock) {
      variantsConditions.push({ stock: { gt: 0 } });
    }

    // Add variants conditions to where clause if any exist
    if (variantsConditions.length > 0) {
      where.variants = {
        some: {
          AND: variantsConditions,
        },
      };
    }

    // Attribute filters
    if (filters.attributes && Object.keys(filters.attributes).length > 0) {
      const attributeConditions = Object.entries(filters.attributes)
        .filter(([_, valueIds]) => {
          return Array.isArray(valueIds) && valueIds.length > 0;
        })
        .map(([attributeId, valueIds]) => {
          const validValueIds = Array.isArray(valueIds) ? valueIds : [valueIds].filter(Boolean);
          
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

    // Specification filters
    if (filters.specifications && Object.keys(filters.specifications).length > 0) {
      const specificationConditions = Object.entries(filters.specifications)
        .filter(([_, values]) => Array.isArray(values) && values.length > 0)
        .map(([specId, values]) => {
          const validValues = Array.isArray(values) ? values : [values].filter(Boolean);
          
          return {
            specifications: {
              some: {
                specificationId: specId,
                OR: [
                  { valueString: { in: validValues } },
                  { valueNumber: { in: validValues.map(v => parseFloat(v)).filter(v => !isNaN(v)) } },
                ],
              },
            },
          };
        });

      if (specificationConditions.length > 0) {
        where.AND = [...(where.AND || []), ...specificationConditions];
      }
    }

    console.log('Generated where clause:', JSON.stringify(where, null, 2));

    try {
      // Fetch products with all relations
      const products = await prisma.product.findMany({
        where,
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
          },
          specifications: {
            include: {
              specification: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  type: true,
                  unit: true,
                },
              },
            },
          },
          warranty: true,
          reviews: {
            select: {
              id: true,
              rating: true,
            },
          },
        },
        orderBy: [
          { createdAt: "desc" },
        ],
      });

      console.log(`Found ${products.length} products before post-filtering`);

      // Post-fetch filtering for complex conditions
      let filteredProducts = products;

      // Filter by rating
      if (filters.ratings && filters.ratings.length > 0) {
        const minRating = Math.min(...filters.ratings);
        filteredProducts = filteredProducts.filter((product: any) => {
          const avgRating = product.reviews.length > 0
            ? product.reviews.reduce((sum: number, r: any) => sum + r.rating, 0) / product.reviews.length
            : 0;
          return avgRating >= minRating;
        });
      }

      // Filter by brands
      if (filters.brands && filters.brands.length > 0) {
        filteredProducts = filteredProducts.filter((product: any) => {
          const brandAttributes = product.variants.flatMap((v: any) =>
            v.attributes
              .filter((a: any) => 
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

      // Filter for new arrivals
      if (filters.newArrivals) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        filteredProducts = filteredProducts.filter(
          (product: any) => new Date(product.createdAt) >= thirtyDaysAgo
        );
      }

      // Filter for on sale (products with compareAtPrice higher than price)
      if (filters.onSale) {
        filteredProducts = filteredProducts.filter((product: any) =>
          product.variants.some((v: any) => 
            v.compareAtPrice && v.compareAtPrice > v.price
          )
        );
      }

      console.log(`Found ${filteredProducts.length} products after post-filtering`);
      return filteredProducts;
    } catch (error) {
      console.error('Database error:', error);
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
};