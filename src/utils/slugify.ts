// utils/slugify.ts
export const slugify = (str: string) =>
  str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');