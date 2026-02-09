// services/product.service.public.ts
import { prisma } from "../config/prisma.ts";

/**
 * Public Product Service
 * Handles customer-facing product operations
 */
export const PublicProductService = {
  // ======================
  // Get all active products
  // ======================
  async getAll() {
    const now = new Date();

    return prisma.product.findMany({
      where: {
        approvalStatus: "ACTIVE",
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
          select: {
            id: true,
            rating: true,
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
      where: { 
        id,
        approvalStatus: "ACTIVE",
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
      },
    });
  },

  // ======================
  // Get products by category
  // ======================
  async getByCategoryId(categoryId: string) {
    return prisma.product.findMany({
      where: { 
        categoryId,
        approvalStatus: "ACTIVE",
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

  // ======================
  // Get featured products
  // ======================
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

  // ======================
  // Filter products
  // ======================
  async filterProducts(filters: {
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
  }) {
    const where: any = {
      approvalStatus: "ACTIVE",
    };

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

    // Specification filters
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
                isForVariant: false,
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

      // Post-filtering for ratings
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

      // Post-filtering for brands
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

      // Post-filtering for new arrivals
      if (filters.newArrivals) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        filteredProducts = filteredProducts.filter(
          (product: any) => new Date(product.createdAt) >= thirtyDaysAgo
        );
      }

      // Post-filtering for on sale
      if (filters.onSale) {
        filteredProducts = filteredProducts.filter((product: any) =>
          product.variants.some(
            (v: any) => v.specialPrice && v.specialPrice < v.price
          )
        );
      }

      return filteredProducts;
    } catch (error) {
      console.error("Database error:", error);
      throw error;
    }
  },

  // ======================
  // Search products
  // ======================
  async search(query: string, limit: number = 20) {
    return prisma.product.findMany({
      where: {
        approvalStatus: "ACTIVE",
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { description: { contains: query, mode: "insensitive" } },
        ],
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
      take: limit,
      orderBy: { createdAt: "desc" },
    });
  },
};