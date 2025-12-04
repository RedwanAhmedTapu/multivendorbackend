// services/theme.service.ts
import { prisma } from '../config/prisma.ts';
import type { 
  Theme, 
  LayoutType, 
  ThemeStatus, 
  CreateThemeDto, 
} from '../types/theme.types.ts';
import { 
  
  LAYOUT_TYPES, 
  LAYOUT_OPTIONS  
} from '../types/theme.types.ts';

export class ThemeService {
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
    const theme = await this.getThemeByLayoutType(layoutType);
    
    if (!theme) {
      throw new Error('Theme not found');
    }

    // Deactivate all other themes
    await prisma.theme.updateMany({
      where: {
        id: {
          not: theme.id,
        },
      },
      data: {
        status: 'inactive',
      },
    });

    // Activate the selected theme
    const updatedTheme = await prisma.theme.update({
      where: { id: theme.id },
      data: { status: 'active' },
    });

    return updatedTheme as Theme;
  }

  /**
   * Deactivate a theme
   */
  async deactivateTheme(layoutType: LayoutType): Promise<Theme> {
    const theme = await this.getThemeByLayoutType(layoutType);
    
    if (!theme) {
      throw new Error('Theme not found');
    }

    const updatedTheme = await prisma.theme.update({
      where: { id: theme.id },
      data: { status: 'inactive' },
    });

    return updatedTheme as Theme;
  }

  /**
   * Toggle theme status
   */
  async toggleThemeStatus(layoutType: LayoutType): Promise<Theme> {
    const theme = await this.getThemeByLayoutType(layoutType);
    
    if (!theme) {
      throw new Error('Theme not found');
    }

    const newStatus: ThemeStatus = theme.status === 'active' ? 'inactive' : 'active';
    
    // If activating, deactivate all others
    if (newStatus === 'active') {
      await prisma.theme.updateMany({
        where: {
          id: {
            not: theme.id,
          },
        },
        data: {
          status: 'inactive',
        },
      });
    }

    const updatedTheme = await prisma.theme.update({
      where: { id: theme.id },
      data: { status: newStatus },
    });

    return updatedTheme as Theme;
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

    for (const layout of predefinedLayouts) {
      const exists = await prisma.theme.findUnique({
        where: { layoutType: layout.layoutType },
      });

      if (!exists) {
        // Set first layout as active by default
        const isFirst = layout.layoutType === 'layout_1';
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