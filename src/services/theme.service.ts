// services/theme.service.ts
import { prisma, prismaDirect } from '../config/prisma.ts';
import type { 
  Theme, 
  LayoutType, 
  CreateThemeDto, 
} from '../types/theme.types.ts';
import {

  LAYOUT_TYPES,
  LAYOUT_OPTIONS
} from '../types/theme.types.ts';
import type { Prisma } from '@prisma/client';

/** Thrown when a write would leave the homepage with no active layout. */
export const ACTIVE_LAYOUT_LOCKED =
  'The active layout cannot be deactivated. Activate another layout instead.';

export class ThemeService {
  /**
   * Runs `fn` in a transaction after locking every theme row in a fixed
   * order, so concurrent activations serialize instead of interleaving
   * (no deadlocks, never two active layouts).
   */
  private withThemesLocked<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    // Direct (non-pooled) client — config/prisma.ts requires it for
    // interactive transactions.
    return prismaDirect.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM themes ORDER BY id FOR UPDATE`;
      return fn(tx);
    });
  }

  /** Makes `themeId` the only active theme. Call inside withThemesLocked. */
  private async activateWithin(tx: Prisma.TransactionClient, themeId: string): Promise<Theme> {
    await tx.theme.updateMany({
      where: { id: { not: themeId } },
      data: { status: 'inactive' },
    });
    const updatedTheme = await tx.theme.update({
      where: { id: themeId },
      data: { status: 'active' },
    });
    return updatedTheme as Theme;
  }

  /**
   * Get all themes
   */
  async getAllThemes(): Promise<Theme[]> {
    const themes = await prisma.theme.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
    return themes as Theme[];
  }

  /**
   * Get active theme
   */
  async getActiveTheme(): Promise<Theme | null> {
    const theme = await prisma.theme.findFirst({
      where: {
        status: 'active',
      },
    });
    return theme as Theme | null;
  }

  /**
   * Get theme by layout type
   */
  async getThemeByLayoutType(layoutType: LayoutType): Promise<Theme | null> {
    const theme = await prisma.theme.findUnique({
      where: {
        layoutType,
      },
    });
    return theme as Theme | null;
  }

  /**
   * Create a new theme (predefined layout)
   */
  async createTheme(data: CreateThemeDto): Promise<Theme> {
    // Validate that layout type is one of the predefined ones
    if (!LAYOUT_TYPES.includes(data.layoutType)) {
      throw new Error(`Invalid layout type. Must be one of: ${LAYOUT_TYPES.join(', ')}`);
    }

    // Check if layout type already exists
    const existingTheme = await prisma.theme.findUnique({
      where: {
        layoutType: data.layoutType,
      },
    });

    if (existingTheme) {
      throw new Error(`Layout type '${data.layoutType}' already exists`);
    }

    const theme = await prisma.theme.create({
      data: {
        name: data.name,
        layoutType: data.layoutType,
        description: data.description || null,
        status: 'inactive', // New themes are always inactive
      },
    });
    return theme as Theme;
  }

  /**
   * Activate a theme (deactivates all others)
   */
  async activateTheme(layoutType: LayoutType): Promise<Theme> {
    // Deactivate-others + activate commit together or not at all.
    return this.withThemesLocked(async (tx) => {
      const theme = await tx.theme.findUnique({ where: { layoutType } });
      if (!theme) {
        throw new Error('Theme not found');
      }
      return this.activateWithin(tx, theme.id);
    });
  }

  /**
   * Deactivate a theme. The active layout can't be deactivated — that would
   * leave the homepage with no active layout; activate another one instead.
   */
  async deactivateTheme(layoutType: LayoutType): Promise<Theme> {
    return this.withThemesLocked(async (tx) => {
      const theme = await tx.theme.findUnique({ where: { layoutType } });
      if (!theme) {
        throw new Error('Theme not found');
      }
      if (theme.status === 'active') {
        throw new Error(ACTIVE_LAYOUT_LOCKED);
      }
      return theme as Theme; // already inactive
    });
  }

  /**
   * Toggle theme status. Only inactive → active is allowed (it activates the
   * layout and deactivates the others); toggling the active layout off is
   * refused for the same reason as deactivateTheme.
   */
  async toggleThemeStatus(layoutType: LayoutType): Promise<Theme> {
    return this.withThemesLocked(async (tx) => {
      const theme = await tx.theme.findUnique({ where: { layoutType } });
      if (!theme) {
        throw new Error('Theme not found');
      }
      if (theme.status === 'active') {
        throw new Error(ACTIVE_LAYOUT_LOCKED);
      }
      return this.activateWithin(tx, theme.id);
    });
  }

  /**
   * Get layout options
   */
  async getLayoutOptions() {
    return [...LAYOUT_OPTIONS]; // Return a copy to prevent mutation
  }

  /**
   * Initialize themes on startup
   */
  async initializeThemes(): Promise<void> {
    const predefinedLayouts = LAYOUT_OPTIONS.map(option => ({
      name: option.label,
      layoutType: option.value,
      description: option.description || null,
    }));

    // Never create a second active layout when one is already active.
    const hasActive = (await prisma.theme.count({ where: { status: 'active' } })) > 0;

    for (const layout of predefinedLayouts) {
      const exists = await prisma.theme.findUnique({
        where: { layoutType: layout.layoutType },
      });

      if (!exists) {
        // Set first layout as active by default (only if nothing is active)
        const isFirst = layout.layoutType === 'layout_1' && !hasActive;
        await prisma.theme.create({
          data: {
            name: layout.name,
            layoutType: layout.layoutType,
            description: layout.description,
            status: isFirst ? 'active' : 'inactive',
          },
        });
      }
    }
  }
}

export const themeService = new ThemeService();