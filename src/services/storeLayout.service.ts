// services/storeLayout.service.ts
import { prisma } from '../config/prisma.ts';
import type { 
  ComponentType, 
  BackgroundType, 
  CategoryLayout, 
  BannerType, 
  BannerLayout, 
  TimerPosition 
} from '@prisma/client';

export interface CreateStoreLayoutInput {
  vendorId: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  thumbnail?: string;
}

export interface CreateComponentInput {
  layoutId: string;
  type: ComponentType;
  sortOrder: number;
  config?: ComponentConfigInput;
  productIds?: string[];
  categoryIds?: string[];
}

export interface ComponentConfigInput {
  // Store Banner
  bannerImage?: string;
  bannerBackgroundType?: BackgroundType;
  bannerBackgroundColor?: string;
  showChatButton?: boolean;
  showRating?: boolean;
  showVerifiedBadge?: boolean;
  showFollowers?: boolean;
  showLogo?: boolean;
  showStoreName?: boolean;
  
  // Category Component
  categoryLayout?: CategoryLayout;
  categoriesPerRow?: number;
  showCategoryCount?: boolean;
  categorySlideInterval?: number;
  
  // Product Component
  productsPerRow?: number;
  showProductPrice?: boolean;
  showProductRating?: boolean;
  showAddToCart?: boolean;
  autoSlide?: boolean;
  slideInterval?: number;
  
  // Banner Component
  bannerType?: BannerType;
  bannerLayout?: BannerLayout;
  bannerHeight?: string;
  bannerImages?: any[];
  
  // Countdown Component
  countdownBannerImage?: string;
  countdownEndDate?: Date;
  timerPosition?: TimerPosition;
  showDays?: boolean;
  showHours?: boolean;
  showMinutes?: boolean;
  showSeconds?: boolean;
  countdownTitle?: string;
  countdownBackgroundColor?: string;
  
  // Voucher Component
  voucherBannerImage?: string;
  voucherCode?: string;
  voucherTitle?: string;
  voucherDescription?: string;
  voucherBackgroundColor?: string;
  voucherTextColor?: string;
  minOrderAmount?: number;
  discountAmount?: number;
  discountPercentage?: number;
  voucherValidFrom?: Date;
  voucherValidTo?: Date;
  showVoucherCode?: boolean;
  useDefaultDesign?: boolean;
  
  // Styling
  customCSS?: string;
  padding?: string;
  margin?: string;
  borderRadius?: string;
  boxShadow?: string;
}

export interface UpdateBannerCustomizationInput {
  bannerImage?: string;
  bannerBackgroundType?: BackgroundType;
  bannerBackgroundValue?: string;
  showChatButton?: boolean;
  showRating?: boolean;
  showVerifiedBadge?: boolean;
  showFollowers?: boolean;
  chatButtonColor?: string;
  storeNameColor?: string;
  textColor?: string;
}

export class StoreLayoutService {
  // Store Layout Methods
  async createStoreLayout(data: CreateStoreLayoutInput) {
    // If setting as default, unset other defaults for this vendor
    if (data.isDefault) {
      await prisma.storeLayout.updateMany({
        where: { vendorId: data.vendorId, isDefault: true },
        data: { isDefault: false }
      });
    }

    return prisma.storeLayout.create({
      data: {
        vendorId: data.vendorId,
        name: data.name,
        description: data.description,
        isDefault: data.isDefault || false,
        thumbnail: data.thumbnail,
      },
      include: {
        components: {
          include: {
            config: true,
            products: {
              include: { product: true }
            },
            categories: {
              include: { category: true }
            }
          },
          orderBy: { sortOrder: 'asc' }
        }
      }
    });
  }

  async getVendorLayouts(vendorId: string) {
    return prisma.storeLayout.findMany({
      where: { vendorId },
      include: {
        components: {
          include: {
            config: true,
            products: {
              include: { product: true }
            },
            categories: {
              include: { category: true }
            }
          },
          orderBy: { sortOrder: 'asc' }
        }
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
    });
  }

  async getStoreLayout(id: string) {
    return prisma.storeLayout.findUnique({
      where: { id },
      include: {
        components: {
          include: {
            config: true,
            products: {
              include: { product: true }
            },
            categories: {
              include: { category: true }
            }
          },
          orderBy: { sortOrder: 'asc' }
        },
        vendor: {
          include: {
            performance: true,
            followers: true,
            storeSettings: true,
            bannerCustomization: true
          }
        }
      }
    });
  }

  async setDefaultLayout(vendorId: string, layoutId: string) {
    return prisma.$transaction(async (tx) => {
      // Unset current default
      await tx.storeLayout.updateMany({
        where: { vendorId, isDefault: true },
        data: { isDefault: false }
      });

      // Set new default
      return tx.storeLayout.update({
        where: { id: layoutId },
        data: { isDefault: true },
        include: {
          components: {
            include: {
              config: true,
              products: {
                include: { product: true }
              },
              categories: {
                include: { category: true }
              }
            },
            orderBy: { sortOrder: 'asc' }
          }
        }
      });
    });
  }

  async deleteStoreLayout(id: string) {
    return prisma.storeLayout.delete({
      where: { id }
    });
  }

  // Component Methods
  async addComponentToLayout(data: CreateComponentInput) {
    return prisma.$transaction(async (tx) => {
      const component = await tx.storeLayoutComponent.create({
        data: {
          layoutId: data.layoutId,
          type: data.type,
          sortOrder: data.sortOrder,
        }
      });

      // Create config if provided
      if (data.config) {
        await tx.componentConfig.create({
          data: {
            componentId: component.id,
            ...data.config
          }
        });
      }

      // Add products if provided
      if (data.productIds && data.productIds.length > 0) {
        await tx.componentProduct.createMany({
          data: data.productIds.map((productId, index) => ({
            componentId: component.id,
            productId,
            sortOrder: index
          }))
        });
      }

      // Add categories if provided
      if (data.categoryIds && data.categoryIds.length > 0) {
        await tx.componentCategory.createMany({
          data: data.categoryIds.map((categoryId, index) => ({
            componentId: component.id,
            categoryId,
            sortOrder: index
          }))
        });
      }

      return this.getComponentWithDetails(component.id);
    });
  }

  async updateComponent(componentId: string, data: {
    sortOrder?: number;
    config?: ComponentConfigInput;
  }) {
    return prisma.$transaction(async (tx) => {
      // Update component
      if (data.sortOrder !== undefined) {
        await tx.storeLayoutComponent.update({
          where: { id: componentId },
          data: { sortOrder: data.sortOrder }
        });
      }

      // Update or create config
      if (data.config) {
        const existingConfig = await tx.componentConfig.findUnique({
          where: { componentId }
        });

        if (existingConfig) {
          await tx.componentConfig.update({
            where: { componentId },
            data: data.config
          });
        } else {
          await tx.componentConfig.create({
            data: {
              componentId,
              ...data.config
            }
          });
        }
      }

      return this.getComponentWithDetails(componentId);
    });
  }

  async deleteComponent(componentId: string) {
    return prisma.storeLayoutComponent.delete({
      where: { id: componentId }
    });
  }

  async updateComponentProducts(componentId: string, productIds: string[]) {
    return prisma.$transaction(async (tx) => {
      // Remove existing products
      await tx.componentProduct.deleteMany({
        where: { componentId }
      });

      // Add new products
      if (productIds.length > 0) {
        await tx.componentProduct.createMany({
          data: productIds.map((productId, index) => ({
            componentId,
            productId,
            sortOrder: index
          }))
        });
      }

      return this.getComponentWithDetails(componentId);
    });
  }

  async updateComponentCategories(componentId: string, categoryIds: string[]) {
    return prisma.$transaction(async (tx) => {
      // Remove existing categories
      await tx.componentCategory.deleteMany({
        where: { componentId }
      });

      // Add new categories
      if (categoryIds.length > 0) {
        await tx.componentCategory.createMany({
          data: categoryIds.map((categoryId, index) => ({
            componentId,
            categoryId,
            sortOrder: index
          }))
        });
      }

      return this.getComponentWithDetails(componentId);
    });
  }

  // Banner Customization Methods
  async getBannerCustomization(vendorId: string) {
    return prisma.storeBannerCustomization.findUnique({
      where: { vendorId },
      include: {
        vendor: {
          include: {
            performance: true,
            followers: true
          }
        }
      }
    });
  }

  async updateBannerCustomization(vendorId: string, data: UpdateBannerCustomizationInput) {
    const existing = await prisma.storeBannerCustomization.findUnique({
      where: { vendorId }
    });

    if (existing) {
      return prisma.storeBannerCustomization.update({
        where: { vendorId },
        data,
        include: {
          vendor: {
            include: {
              performance: true,
              followers: true
            }
          }
        }
      });
    } else {
      return prisma.storeBannerCustomization.create({
        data: {
          vendorId,
          ...data
        },
        include: {
          vendor: {
            include: {
              performance: true,
              followers: true
            }
          }
        }
      });
    }
  }

  // Helper Methods
  private async getComponentWithDetails(componentId: string) {
    return prisma.storeLayoutComponent.findUnique({
      where: { id: componentId },
      include: {
        config: true,
        products: {
          include: { product: true },
          orderBy: { sortOrder: 'asc' }
        },
        categories: {
          include: { category: true },
          orderBy: { sortOrder: 'asc' }
        }
      }
    });
  }

  // Template Methods
  async getLayoutTemplates(category?: string) {
    return prisma.layoutTemplate.findMany({
      where: category ? { category } : undefined,
      orderBy: { usageCount: 'desc' }
    });
  }

  async applyTemplate(vendorId: string, templateId: string) {
    const template = await prisma.layoutTemplate.findUnique({
      where: { id: templateId }
    });

    if (!template) {
      throw new Error('Template not found');
    }

    // Increment usage count
    await prisma.layoutTemplate.update({
      where: { id: templateId },
      data: { usageCount: { increment: 1 } }
    });

    // Create layout from template structure
    const structure = template.structure as any;
    return this.createStoreLayout({
      vendorId,
      name: template.name,
      description: `Created from template: ${template.name}`,
      thumbnail: template.thumbnail
    });
  }
}