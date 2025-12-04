// types/theme.types.ts
export type LayoutType = 'layout_1' | 'layout_2' | 'layout_3';
export type ThemeStatus = 'active' | 'inactive';

export interface Theme {
  id: string;
  name: string;
  layoutType: LayoutType;
  status: ThemeStatus;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateThemeDto {
  name: string;
  layoutType: LayoutType;
  description?: string;
}

export interface UpdateThemeDto {
  name?: string;
  description?: string;
}

export interface UpdateThemeStatusDto {
  status: ThemeStatus;
}

export interface LayoutOption {
  value: LayoutType;
  label: string;
  description?: string;
}

export interface ThemeResponse {
  success: boolean;
  data: Theme;
  message?: string;
}

export interface ThemesResponse {
  success: boolean;
  data: Theme[];
  message?: string;
}

export interface LayoutOptionsResponse {
  success: boolean;
  data: LayoutOption[];
  message?: string;
}

export const LAYOUT_TYPES: readonly LayoutType[] = ['layout_1', 'layout_2', 'layout_3'];

export const LAYOUT_OPTIONS: readonly LayoutOption[] = [
  { value: 'layout_1', label: 'Layout 1 - Default', description: 'Hero slider + Category section + Product grid' },
  { value: 'layout_2', label: 'Layout 2 - Horizontal Navigation', description: 'Horizontal category nav + Hero slider + Category section' },
  { value: 'layout_3', label: 'Layout 3 - Category Grid', description: 'Category grid at top + Benefits + Category section' },
];