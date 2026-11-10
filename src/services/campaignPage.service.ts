// services/campaignPage.service.ts
import { slugify } from '../utils/slugify.ts';
import type {
  ComponentType,
  BackgroundType,
  DecorationStatus,
  Prisma,
} from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { createCampaignService, type MarketingDb } from '../modules/marketing/campaign.service.ts';

const prisma = new PrismaClient();

/** Test hook (same pattern as orderServiceDb / paymentServiceDb): this module's own client. */
export const campaignPageDb = prisma;

// ─────────────────────────────────────────────
// INPUT TYPES
// ─────────────────────────────────────────────

export interface CreateCampaignPageInput {
  title: string;
  heroImage?: string;
  heroTitle?: string;
  heroSubtitle?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface UpdateCampaignPageInput {
  title?: string;
  heroImage?: string;
  heroTitle?: string;
  heroSubtitle?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  status?: DecorationStatus;
}

export interface CampaignComponentConfigInput {
  title?: string;
  bannerImage?: string;
  bannerLink?: string;
  bannerBackgroundType?: BackgroundType;
  bannerBackgroundColor?: string;
  productsPerRow?: number;
  countdownEndDate?: Date;
  showProductPrice?: boolean;
  showProductRating?: boolean;
  settings?: Record<string, unknown>;
}

export interface CreateCampaignComponentInput {
  campaignPageId: string;
  type: ComponentType;
  sortOrder: number;
  isVisible?: boolean;
  config?: CampaignComponentConfigInput;
  productIds?: string[];
}

export interface UpdateCampaignComponentInput {
  isVisible?: boolean;
  config?: CampaignComponentConfigInput;
}

// ─────────────────────────────────────────────
// REUSABLE INCLUDE SHAPES
// ─────────────────────────────────────────────

const CAMPAIGN_FULL = {
  components: {
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
                select: { price: true, specialPrice: true, sku: true, stock: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CampaignPageInclude;

/** Same shape, but the public page only shows visible components, and
 *  product blocks only list products of an ACTIVE vendor (Phase 1 S3/P2). */
const CAMPAIGN_PUBLIC = {
  components: {
    where: { isVisible: true },
    orderBy: { sortOrder: 'asc' as const },
    include: {
      config: true,
      products: {
        where: { product: { vendor: { status: 'ACTIVE' as const } } },
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
                select: { price: true, specialPrice: true, sku: true, stock: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CampaignPageInclude;

const COMPONENT_DETAIL = {
  config: true,
  products: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      product: {
        select: { id: true, name: true, slug: true, images: { take: 1, select: { url: true } } },
      },
    },
  },
} satisfies Prisma.CampaignPageComponentInclude;

export class CampaignPageService {
  // ── Campaign CRUD ───────────────────────────

  async create(data: CreateCampaignPageInput) {
    const slug = await this.generateUniqueSlug(data.title);
    return prisma.campaignPage.create({
      data: { ...data, slug, status: 'DRAFT' },
      include: { _count: { select: { components: true } } },
    });
  }

  async list() {
    return prisma.campaignPage.findMany({
      include: { _count: { select: { components: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getById(id: string) {
    return prisma.campaignPage.findUnique({ where: { id }, include: CAMPAIGN_FULL });
  }

  /** Public storefront lookup — only serves a live, in-window campaign. */
  async getPublishedBySlug(slug: string) {
    const now = new Date();
    const page = await prisma.campaignPage.findFirst({
      where: {
        slug,
        status: 'PUBLISHED',
        AND: [
          { OR: [{ startDate: null }, { startDate: { lte: now } }] },
          { OR: [{ endDate: null }, { endDate: { gte: now } }] },
        ],
      },
      include: CAMPAIGN_PUBLIC,
    });
    return page;
  }

  /** Dates are checked against the campaign's vendor programme (if any):
   *  once published, the start is frozen and the end may only be extended
   *  (audit-logged, registered vendors notified). No programme → unchanged. */
  async update(id: string, data: UpdateCampaignPageInput, actorUserId?: string) {
    return createCampaignService(prisma as unknown as MarketingDb).updateCampaignPage(
      actorUserId ? { userId: actorUserId } : null,
      id,
      data as Record<string, unknown>,
      { _count: { select: { components: true } } },
    );
  }

  async publish(id: string) {
    return prisma.campaignPage.update({
      where: { id },
      data: { status: 'PUBLISHED' },
    });
  }

  async unpublish(id: string) {
    return prisma.campaignPage.update({
      where: { id },
      data: { status: 'DRAFT' },
    });
  }

  /** A vendor programme with registrations blocks the delete (409). */
  async delete(id: string) {
    return createCampaignService(prisma as unknown as MarketingDb).deleteCampaignPage(id);
  }

  // ── Components ──────────────────────────────

  async addComponent(data: CreateCampaignComponentInput) {
    return prisma.$transaction(async (tx) => {
      const component = await tx.campaignPageComponent.create({
        data: {
          campaignPageId: data.campaignPageId,
          type: data.type,
          sortOrder: data.sortOrder,
          isVisible: data.isVisible ?? true,
        },
      });

      if (data.config) {
        await tx.campaignPageComponentConfig.create({
          data: { componentId: component.id, ...data.config },
        });
      }

      if (data.productIds?.length) {
        await tx.campaignPageComponentProduct.createMany({
          data: data.productIds.map((productId, i) => ({
            componentId: component.id,
            productId,
            sortOrder: i,
          })),
        });
      }

      return tx.campaignPageComponent.findUnique({
        where: { id: component.id },
        include: COMPONENT_DETAIL,
      });
    });
  }

  async updateComponent(componentId: string, data: UpdateCampaignComponentInput) {
    return prisma.$transaction(async (tx) => {
      if (data.isVisible !== undefined) {
        await tx.campaignPageComponent.update({
          where: { id: componentId },
          data: { isVisible: data.isVisible },
        });
      }

      if (data.config) {
        await tx.campaignPageComponentConfig.upsert({
          where: { componentId },
          create: { componentId, ...data.config },
          update: data.config,
        });
      }

      return tx.campaignPageComponent.findUnique({
        where: { id: componentId },
        include: COMPONENT_DETAIL,
      });
    });
  }

  async deleteComponent(componentId: string) {
    return prisma.campaignPageComponent.delete({ where: { id: componentId } });
  }

  /** Reorder all components in one shot. */
  async reorderComponents(campaignPageId: string, orderedIds: string[]) {
    return prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.campaignPageComponent.update({
          where: { id },
          data: { sortOrder: index },
        })
      )
    );
  }

  async setComponentProducts(componentId: string, productIds: string[]) {
    return prisma.$transaction(async (tx) => {
      await tx.campaignPageComponentProduct.deleteMany({ where: { componentId } });

      if (productIds.length > 0) {
        await tx.campaignPageComponentProduct.createMany({
          data: productIds.map((productId, i) => ({ componentId, productId, sortOrder: i })),
        });
      }

      return tx.campaignPageComponent.findUnique({
        where: { id: componentId },
        include: COMPONENT_DETAIL,
      });
    });
  }

  // ── Helpers ──────────────────────────────────

  private async generateUniqueSlug(title: string): Promise<string> {
    const base = slugify(title);
    const existing = await prisma.campaignPage.findMany({
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