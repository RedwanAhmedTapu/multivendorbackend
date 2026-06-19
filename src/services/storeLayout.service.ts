import { slugify } from '../utils/slugify.ts';
import type {
  ComponentType,
  BackgroundType,
  CategoryLayout,
  DecorationStatus,
  Prisma,
  
} from '@prisma/client';
import { PrismaClient } from '@prisma/client';


const prisma = new PrismaClient();
// ─────────────────────────────────────────────
// INPUT TYPES
// ─────────────────────────────────────────────

export interface CreateDecorationInput {
  vendorId: string;
  name: string;
  thumbnail?: string;
  isDefault?: boolean;
}

export interface UpdateDecorationInput {
  name?: string;
  thumbnail?: string;
  status?: DecorationStatus;
  publishedAt?: Date;
}

export interface CreateComponentInput {
  decorationId: string;
  type: ComponentType;
  sortOrder: number;
  isVisible?: boolean;
  config?: ComponentConfigInput;
  productIds?: string[];
  categoryIds?: string[];
}

export interface UpdateComponentInput {
  sortOrder?: number;
  isVisible?: boolean;
  config?: ComponentConfigInput;
}

export interface ComponentConfigInput {
  // Promoted scalar fields
  bannerImage?: string;
  bannerBackgroundType?: BackgroundType;
  bannerBackgroundColor?: string;
  categoryLayout?: CategoryLayout;
  productsPerRow?: number;
  categoriesPerRow?: number;
  autoSlide?: boolean;
  slideInterval?: number;
  countdownEndDate?: Date;
  showProductPrice?: boolean;
  showProductRating?: boolean;
  showAddToCart?: boolean;
  showCategoryCount?: boolean;
  // Styling
  customCSS?: string;
  padding?: string;
  margin?: string;
  borderRadius?: string;
  boxShadow?: string;
  // Everything else (voucher, countdown details, banner images, timer config, etc.)
  settings?: Record<string, unknown>;
}

export interface UpdateBannerCustomizationInput {
  bannerImage?: string;
  bannerBackgroundType?: BackgroundType;
  bannerBackgroundValue?: string;
}

// ─────────────────────────────────────────────
// REUSABLE INCLUDE SHAPES
// ─────────────────────────────────────────────

/** Full decoration with all components — used only when the builder loads */
const DECORATION_FULL = {
  components: {
    where: { isVisible: true },
    orderBy: { sortOrder: 'asc' as const },
    include: {
      config: true,
      products: {
        orderBy: { sortOrder: 'asc' as const },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              images: { take: 1, select: { url: true } },
              variants: {
                take: 1,
                select: { price: true, specialPrice: true, sku: true },
              },
            },
          },
        },
      },
      categories: {
        orderBy: { sortOrder: 'asc' as const },
        include: {
          category: {
            select: { id: true, name: true, slug: true, image: true },
          },
        },
      },
    },
  },
} satisfies Prisma.StoreDecorationInclude;

/** Lightweight list — for the decoration gallery/picker */
const DECORATION_LIST = {
  _count: { select: { components: true } },
} satisfies Prisma.StoreDecorationInclude;

/** Single component with its relations — returned after mutations */
const COMPONENT_DETAIL = {
  config: true,
  products: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          slug: true,
          images: { take: 1, select: { url: true } },
        },
      },
    },
  },
  categories: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      category: {
        select: { id: true, name: true, slug: true, image: true },
      },
    },
  },
} satisfies Prisma.DecorationComponentInclude;

// ─────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────

export class StoreDecorationService {

  // ── Decoration CRUD ────────────────────────

  async createDecoration(data: CreateDecorationInput) {
    const slug = await this.generateUniqueSlug(data.name);

    return prisma.$transaction(async (tx) => {
      // Unset default if needed — single targeted update, no full scan
      if (data.isDefault) {
        await tx.storeDecoration.updateMany({
          where: { vendorId: data.vendorId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.storeDecoration.create({
        data: {
          vendorId: data.vendorId,
          name: data.name,
          slug,
          isDefault: data.isDefault ?? false,
          thumbnail: data.thumbnail,
          status: 'DRAFT',
        },
        include: DECORATION_LIST,
      });
    });
  }

  /** Lightweight list for gallery — no deep component loading */
  async getVendorDecorations(vendorId: string) {
    console.log(vendorId,"f")
    return prisma.storeDecoration.findMany({
      where: { vendorId },
      include: DECORATION_LIST,
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  /** Full load — only called when vendor opens the builder */
  async getDecorationById(id: string, vendorId: string) {
    return prisma.storeDecoration.findFirst({
      where: { id, vendorId },
      include: DECORATION_FULL,
    });
  }

  /** Public storefront — fetch the live default by slug or vendorId */
  async getPublishedDecoration(vendorId: string) {
    return prisma.storeDecoration.findFirst({
      where: { vendorId, isDefault: true, status: 'PUBLISHED' },
      include: DECORATION_FULL,
    });
  }

  async updateDecoration(id: string, vendorId: string, data: UpdateDecorationInput) {
    // Optimistic lock: bump version on every save
    return prisma.storeDecoration.update({
      where: { id, vendorId },
      data: { ...data, version: { increment: 1 } },
      include: DECORATION_LIST,
    });
  }

  async publishDecoration(id: string, vendorId: string) {
    return prisma.$transaction(async (tx) => {
      // Pull currently-default published decoration id in one read
      const current = await tx.storeDecoration.findFirst({
        where: { vendorId, isDefault: true, status: 'PUBLISHED' },
        select: { id: true },
      });

      // Demote current default (only if different)
      if (current && current.id !== id) {
        await tx.storeDecoration.update({
          where: { id: current.id },
          data: { isDefault: false, status: 'ARCHIVED' },
        });
      }

      return tx.storeDecoration.update({
        where: { id, vendorId },
        data: {
          status: 'PUBLISHED',
          isDefault: true,
          publishedAt: new Date(),
          version: { increment: 1 },
        },
        include: DECORATION_LIST,
      });
    });
  }

  async archiveDecoration(id: string, vendorId: string) {
    return prisma.storeDecoration.update({
      where: { id, vendorId },
      data: { status: 'ARCHIVED', isDefault: false, version: { increment: 1 } },
      include: DECORATION_LIST,
    });
  }

  async deleteDecoration(id: string, vendorId: string) {
    // Cascade deletes components/config/products/categories via FK
    return prisma.storeDecoration.delete({ where: { id, vendorId } });
  }

  /** Duplicate an existing decoration as a new DRAFT */
  async duplicateDecoration(id: string, vendorId: string, name: string) {
    const source = await prisma.storeDecoration.findFirst({
      where: { id, vendorId },
      include: DECORATION_FULL,
    });
    if (!source) throw new Error('Decoration not found');

    const slug = await this.generateUniqueSlug(name);

    return prisma.$transaction(async (tx) => {
      const copy = await tx.storeDecoration.create({
        data: {
          vendorId,
          name,
          slug,
          status: 'DRAFT',
          thumbnail: source.thumbnail,
          isDefault: false,
        },
      });

      // Re-create each component + its relations
      for (const comp of source.components) {
        const newComp = await tx.decorationComponent.create({
          data: {
            decorationId: copy.id,
            type: comp.type,
            sortOrder: comp.sortOrder,
            isVisible: comp.isVisible,
          },
        });

        if (comp.config) {
          const { id: _id, componentId: _cid, createdAt: _ca, updatedAt: _ua, ...configData } = comp.config;
          await tx.decorationComponentConfig.create({
            data: { componentId: newComp.id, ...configData },
          });
        }

        if (comp.products.length > 0) {
          await tx.decorationComponentProduct.createMany({
            data: comp.products.map((p) => ({
              componentId: newComp.id,
              productId: p.productId,
              sortOrder: p.sortOrder,
              isFeatured: p.isFeatured,
            })),
          });
        }

        if (comp.categories.length > 0) {
          await tx.decorationComponentCategory.createMany({
            data: comp.categories.map((c) => ({
              componentId: newComp.id,
              categoryId: c.categoryId,
              sortOrder: c.sortOrder,
              isFeatured: c.isFeatured,
            })),
          });
        }
      }

      return tx.storeDecoration.findUnique({
        where: { id: copy.id },
        include: DECORATION_LIST,
      });
    });
  }

  // ── Component CRUD ─────────────────────────

  async addComponent(data: CreateComponentInput) {
    return prisma.$transaction(async (tx) => {
      const component = await tx.decorationComponent.create({
        data: {
          decorationId: data.decorationId,
          type: data.type,
          sortOrder: data.sortOrder,
          isVisible: data.isVisible ?? true,
        },
      });

      if (data.config) {
        await tx.decorationComponentConfig.create({
          data: { componentId: component.id, ...data.config },
        });
      }

      if (data.productIds?.length) {
        await tx.decorationComponentProduct.createMany({
          data: data.productIds.map((productId, i) => ({
            componentId: component.id,
            productId,
            sortOrder: i,
          })),
        });
      }

      if (data.categoryIds?.length) {
        await tx.decorationComponentCategory.createMany({
          data: data.categoryIds.map((categoryId, i) => ({
            componentId: component.id,
            categoryId,
            sortOrder: i,
          })),
        });
      }

      // Bump decoration version so storefront cache can invalidate
      await tx.storeDecoration.update({
        where: { id: data.decorationId },
        data: { version: { increment: 1 } },
      });

      return tx.decorationComponent.findUnique({
        where: { id: component.id },
        include: COMPONENT_DETAIL,
      });
    });
  }

  async updateComponent(componentId: string, decorationId: string, data: UpdateComponentInput) {
    return prisma.$transaction(async (tx) => {
      const { config, ...componentFields } = data;

      if (Object.keys(componentFields).length > 0) {
        await tx.decorationComponent.update({
          where: { id: componentId },
          data: componentFields,
        });
      }

      if (config) {
        // upsert avoids the redundant findUnique + conditional create/update
        await tx.decorationComponentConfig.upsert({
          where: { componentId },
          create: { componentId, ...config },
          update: config,
        });
      }

      await tx.storeDecoration.update({
        where: { id: decorationId },
        data: { version: { increment: 1 } },
      });

      return tx.decorationComponent.findUnique({
        where: { id: componentId },
        include: COMPONENT_DETAIL,
      });
    });
  }

  async deleteComponent(componentId: string, decorationId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.decorationComponent.delete({ where: { id: componentId } });
      await tx.storeDecoration.update({
        where: { id: decorationId },
        data: { version: { increment: 1 } },
      });
    });
  }

  /** Reorder all components in one shot — avoids N individual updates */
  async reorderComponents(decorationId: string, orderedIds: string[]) {
    return prisma.$transaction([
      ...orderedIds.map((id, index) =>
        prisma.decorationComponent.update({
          where: { id },
          data: { sortOrder: index },
        })
      ),
      prisma.storeDecoration.update({
        where: { id: decorationId },
        data: { version: { increment: 1 } },
      }),
    ]);
  }

  // ── Component Products ─────────────────────

  async setComponentProducts(componentId: string, decorationId: string, productIds: string[]) {
    return prisma.$transaction(async (tx) => {
      await tx.decorationComponentProduct.deleteMany({ where: { componentId } });

      if (productIds.length > 0) {
        await tx.decorationComponentProduct.createMany({
          data: productIds.map((productId, i) => ({
            componentId,
            productId,
            sortOrder: i,
          })),
        });
      }

      await tx.storeDecoration.update({
        where: { id: decorationId },
        data: { version: { increment: 1 } },
      });

      return tx.decorationComponent.findUnique({
        where: { id: componentId },
        include: COMPONENT_DETAIL,
      });
    });
  }

  // ── Component Categories ───────────────────

  async setComponentCategories(componentId: string, decorationId: string, categoryIds: string[]) {
    return prisma.$transaction(async (tx) => {
      await tx.decorationComponentCategory.deleteMany({ where: { componentId } });

      if (categoryIds.length > 0) {
        await tx.decorationComponentCategory.createMany({
          data: categoryIds.map((categoryId, i) => ({
            componentId,
            categoryId,
            sortOrder: i,
          })),
        });
      }

      await tx.storeDecoration.update({
        where: { id: decorationId },
        data: { version: { increment: 1 } },
      });

      return tx.decorationComponent.findUnique({
        where: { id: componentId },
        include: COMPONENT_DETAIL,
      });
    });
  }

  // ── Banner Customization ───────────────────

  async getBannerCustomization(vendorId: string) {
    return prisma.storeBannerCustomization.findUnique({
      where: { vendorId },
    });
  }

  async upsertBannerCustomization(vendorId: string, data: UpdateBannerCustomizationInput) {
    return prisma.storeBannerCustomization.upsert({
      where: { vendorId },
      create: { vendorId, ...data },
      update: data,
    });
  }

  // ── Templates ─────────────────────────────

  async getLayoutTemplates(category?: string) {
    return prisma.layoutTemplate.findMany({
      where: category ? { category } : undefined,
      orderBy: { usageCount: 'desc' },
      select: {
        id: true,
        name: true,
        thumbnail: true,
        category: true,
        isPremium: true,
        usageCount: true,
        rating: true,
        // structure is large — omit from list, load on demand
      },
    });
  }

  async applyTemplate(vendorId: string, templateId: string, name: string) {
    const template = await prisma.layoutTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template) throw new Error('Template not found');

    const slug = await this.generateUniqueSlug(name || template.name);

    return prisma.$transaction(async (tx) => {
      await tx.layoutTemplate.update({
        where: { id: templateId },
        data: { usageCount: { increment: 1 } },
      });

      const decoration = await tx.storeDecoration.create({
        data: {
          vendorId,
          name: name || template.name,
          slug,
          thumbnail: template.thumbnail,
          status: 'DRAFT',
        },
      });

      // Build components from template structure if it defines them
      const structure = template.structure as {
        components?: Array<{
          type: ComponentType;
          sortOrder: number;
          config?: ComponentConfigInput;
        }>;
      };

      if (structure?.components?.length) {
        for (const comp of structure.components) {
          const newComp = await tx.decorationComponent.create({
            data: {
              decorationId: decoration.id,
              type: comp.type,
              sortOrder: comp.sortOrder,
            },
          });
          if (comp.config) {
            await tx.decorationComponentConfig.create({
              data: { componentId: newComp.id, ...comp.config },
            });
          }
        }
      }

      return tx.storeDecoration.findUnique({
        where: { id: decoration.id },
        include: DECORATION_FULL,
      });
    });
  }

  // ── Helpers ────────────────────────────────

  private async generateUniqueSlug(name: string): Promise<string> {
    const base = slugify(name);
    const existing = await prisma.storeDecoration.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    if (!existing.length) return base;
    const suffixes = existing
      .map((d) => d.slug.replace(base, '').replace(/^-/, ''))
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
    const next = suffixes.length ? Math.max(...suffixes) + 1 : 2;
    return `${base}-${next}`;
  }
}