// src/constants/theme-palette.defaults.ts
//
// Part 2 — server-side copy of the three Part-1 palette presets
// (multivendorsite/src/lib/palette/presets.ts). The backend cannot import
// frontend files, so the preset definitions are mirrored here and kept
// byte-identical by tests (tests/theme-palette.test.mjs on the frontend
// asserts the same values; this file is the backend's source of truth for
// seeding and public fallbacks).
//
// These are DATA only. Nothing here is activated: the public endpoint falls
// back to the resolved Neutral map when no palette is published, which equals
// today's production globals.css values (verified by string parity in Part 1).

export interface PresetTokens {
  [token: string]: string;
}

export interface PalettePresetDefault {
  id: 'neutral' | 'emerald' | 'orange';
  name: string;
  description: string;
  kind: 'PRESET';
  tokens: PresetTokens;
  darkTokens?: PresetTokens;
}

// ── NEUTRAL — verbatim production extraction (globals.css :root + Part-1
// extension vars). Dark map = the dormant production .dark block. ───────────
export const NEUTRAL_PRESET: PalettePresetDefault = {
  id: 'neutral',
  name: 'Neutral',
  description: 'The current production palette (shadcn neutral, oklch).',
  kind: 'PRESET',
  tokens: {
    background: 'oklch(1 0 0)',
    text: 'oklch(0.145 0 0)',
    card: 'oklch(1 0 0)',
    cardForeground: 'oklch(0.145 0 0)',
    surface: 'oklch(1 0 0)',
    surfaceForeground: 'oklch(0.145 0 0)',
    primary: 'oklch(0.205 0 0)',
    primaryForeground: 'oklch(0.985 0 0)',
    primaryHover: 'oklch(0.269 0 0)',
    primaryActive: 'oklch(0.32 0 0)',
    primaryTint: 'oklch(0.97 0 0)',
    primaryDark: 'oklch(0.145 0 0)',
    secondary: 'oklch(0.97 0 0)',
    secondaryForeground: 'oklch(0.205 0 0)',
    muted: 'oklch(0.97 0 0)',
    textSecondary: 'oklch(0.556 0 0)',
    accent: 'oklch(0.97 0 0)',
    accentForeground: 'oklch(0.205 0 0)',
    border: 'oklch(0.922 0 0)',
    borderStrong: 'oklch(0.85 0 0)',
    input: 'oklch(0.922 0 0)',
    focusRing: 'oklch(0.708 0 0)',
    danger: 'oklch(0.577 0.245 27.325)',
    success: '#16A34A',
    successForeground: '#FFFFFF',
    warning: '#D97706',
    warningForeground: '#1E293B',
    info: '#2563EB',
    infoForeground: '#FFFFFF',
    dangerForeground: '#FFFFFF',
    chart1: 'oklch(0.646 0.222 41.116)',
    chart2: 'oklch(0.6 0.118 184.704)',
    chart3: 'oklch(0.398 0.07 227.392)',
    chart4: 'oklch(0.828 0.189 84.429)',
    chart5: 'oklch(0.769 0.188 70.08)',
    sidebar: 'oklch(0.985 0 0)',
    sidebarForeground: 'oklch(0.145 0 0)',
    sidebarPrimary: 'oklch(0.205 0 0)',
    sidebarPrimaryForeground: 'oklch(0.985 0 0)',
    sidebarAccent: 'oklch(0.97 0 0)',
    sidebarAccentForeground: 'oklch(0.205 0 0)',
    sidebarBorder: 'oklch(0.922 0 0)',
    sidebarRing: 'oklch(0.708 0 0)',
  },
  darkTokens: {
    background: 'oklch(0.145 0 0)',
    text: 'oklch(0.985 0 0)',
    card: 'oklch(0.205 0 0)',
    cardForeground: 'oklch(0.985 0 0)',
    surface: 'oklch(0.205 0 0)',
    surfaceForeground: 'oklch(0.985 0 0)',
    primary: 'oklch(0.922 0 0)',
    primaryForeground: 'oklch(0.205 0 0)',
    primaryHover: 'oklch(0.85 0 0)',
    primaryActive: 'oklch(0.8 0 0)',
    primaryTint: 'oklch(0.269 0 0)',
    primaryDark: 'oklch(1 0 0)',
    secondary: 'oklch(0.269 0 0)',
    secondaryForeground: 'oklch(0.985 0 0)',
    muted: 'oklch(0.269 0 0)',
    textSecondary: 'oklch(0.708 0 0)',
    accent: 'oklch(0.269 0 0)',
    accentForeground: 'oklch(0.985 0 0)',
    border: 'oklch(1 0 0 / 10%)',
    borderStrong: 'oklch(1 0 0 / 25%)',
    input: 'oklch(1 0 0 / 15%)',
    focusRing: 'oklch(0.556 0 0)',
    danger: 'oklch(0.704 0.191 22.216)',
    success: '#16A34A',
    successForeground: '#FFFFFF',
    warning: '#D97706',
    warningForeground: '#1E293B',
    info: '#2563EB',
    infoForeground: '#FFFFFF',
    dangerForeground: '#FFFFFF',
    chart1: 'oklch(0.488 0.243 264.376)',
    chart2: 'oklch(0.696 0.17 162.48)',
    chart3: 'oklch(0.769 0.188 70.08)',
    chart4: 'oklch(0.627 0.265 303.9)',
    chart5: 'oklch(0.645 0.246 16.439)',
    sidebar: 'oklch(0.205 0 0)',
    sidebarForeground: 'oklch(0.985 0 0)',
    sidebarPrimary: 'oklch(0.488 0.243 264.376)',
    sidebarPrimaryForeground: 'oklch(0.985 0 0)',
    sidebarAccent: 'oklch(0.269 0 0)',
    sidebarAccentForeground: 'oklch(0.985 0 0)',
    sidebarBorder: 'oklch(1 0 0 / 10%)',
    sidebarRing: 'oklch(0.556 0 0)',
  },
};

// ── EMERALD — brief spec on the Tailwind emerald/slate scale ────────────────
export const EMERALD_PRESET: PalettePresetDefault = {
  id: 'emerald',
  name: 'Emerald',
  description: 'Emerald brand palette (spec). Matches the existing vendor-area emerald usage.',
  kind: 'PRESET',
  tokens: {
    primary: '#10B981',
    primaryHover: '#059669',
    primaryTint: '#ECFDF5',
    primaryDark: '#064E3B',
    surface: '#FFFFFF',
    background: '#F8FAFC',
    border: '#E2E8F0',
    text: '#0F172A',
    primaryActive: '#047857',
    secondary: '#F1F5F9',
    accent: '#D1FAE5',
    card: '#FFFFFF',
    textSecondary: '#64748B',
    muted: '#F1F5F9',
    borderStrong: '#CBD5E1',
    focusRing: '#10B981',
    success: '#16A34A',
    warning: '#D97706',
    danger: '#DC2626',
    info: '#2563EB',
  },
};

// ── ORANGE — brief spec; new to the platform ─────────────────────────────────
export const ORANGE_PRESET: PalettePresetDefault = {
  id: 'orange',
  name: 'Orange',
  description: 'Orange brand palette (spec). New — no existing code uses it yet.',
  kind: 'PRESET',
  tokens: {
    primary: '#FF7A1A',
    primaryHover: '#FF9B45',
    primaryTint: '#FFB7A8',
    background: '#FFF7F2',
    card: '#FFFFFF',
    text: '#1E293B',
    border: '#E5E7EB',
    success: '#16A34A',
    primaryActive: '#E06B17',
    primaryDark: '#8C430E',
    secondary: '#FFF2E8',
    accent: '#FFDEC6',
    surface: '#FFFFFF',
    textSecondary: '#64748B',
    muted: '#FBE9DC',
    borderStrong: '#D1D5DB',
    focusRing: '#FF7A1A',
    warning: '#D97706',
    danger: '#DC2626',
    info: '#2563EB',
  },
};

export const PALETTE_PRESET_DEFAULTS: readonly PalettePresetDefault[] = [
  NEUTRAL_PRESET,
  EMERALD_PRESET,
  ORANGE_PRESET,
];

export function getPresetDefault(id: string): PalettePresetDefault | null {
  return PALETTE_PRESET_DEFAULTS.find((p) => p.id === id) ?? null;
}
