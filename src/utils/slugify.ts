// utils/slugify.ts
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")  // accent strip (é → e)
    .replace(/[^a-z0-9\s-]/g, "")     // special char remove (&, /, !, etc.)
    .replace(/\s+/g, "-")             // space → hyphen
    .replace(/-+/g, "-")              // multiple hyphen → single
    .replace(/^-|-$/g, "");           // leading/trailing hyphen trim
}
