// services/product/product-search.service.ts
import { prisma } from "../../../../config/prisma.ts";
import { clampLimit } from "../../utils/pagination.ts";
import { cacheGet, cacheSet, cacheKeys, hashFilters } from "../../../../config/cache.ts";
import { ProductRepository } from "../../repositories/product.repository.ts";
import { PUBLIC_VENDOR_SQL, applyPublicVisibility } from "../../utils/filter-builder.util.ts";

/**
 * SEO-optimized product search.
 *
 * Primary path: Postgres full-text search against the generated
 * `search_vector` column (see prisma/schema-additions.prisma) using
 * `websearch_to_tsquery`, which gives free AND/OR/phrase parsing and
 * naturally tolerates word-order variance. Ranked with ts_rank.
 *
 * Fallback path (if the search_vector migration hasn't been applied yet,
 * e.g. local dev on SQLite): Prisma `contains` across name/description/SKU,
 * with a simple relevance score computed in application code (exact name
 * match > name startsWith > name contains > description contains).
 *
 * Typo tolerance: `similarity()` from pg_trgm is used as a secondary
 * ranking signal when the primary FTS query returns few results — this
 * requires `CREATE EXTENSION IF NOT EXISTS pg_trgm;` once per database.
 */
export const ProductSearchService = {
  /**
   * @param opts.withCardData
   *   - false (default): bare `{ id, name, slug, rank }` — cheap, meant for
   *     autocomplete/typeahead dropdowns that only render text.
   *   - true: same ranked id list, then hydrated with `cardInclude` shape
   *     (1 image, cheapest variant, vendor/category, avgRating) — for an
   *     actual "/search?q=..." results *page* that renders product cards.
   *     Still only 1-2 lean queries total, never the full product detail.
   */
  async search(query: string, opts: { limit?: number; onlyActive?: boolean; withCardData?: boolean } = {}) {
    const q = query.trim();
    if (!q) return [];

    const limit = clampLimit(opts.limit, 20);
    const onlyActive = opts.onlyActive ?? true;
    const withCardData = opts.withCardData ?? false;

    const cacheKey = cacheKeys.productSearch(hashFilters({ q, limit, onlyActive, withCardData }));
    const cached = await cacheGet<any[]>(cacheKey);
    if (cached) return cached;

    let results: any[];
    try {
      results = await this.fullTextSearch(q, limit, onlyActive);
      if (results.length === 0) {
        // pg_trgm similarity fallback for typos / partial matches
        results = await this.fuzzySearch(q, limit, onlyActive);
      }
    } catch (err) {
      console.warn("Full-text search unavailable, falling back to contains-based search:", (err as Error).message);
      results = await this.fallbackSearch(q, limit, onlyActive);
    }

    if (withCardData && results.length) {
      results = await this.hydrateWithCardData(results);
    }

    await cacheSet(cacheKey, results, 120);
    return results;
  },

  /**
   * Takes the ranked `{ id, ... }` rows from full-text/fuzzy/fallback search
   * and joins them against `cardInclude` in a single `findMany({ id: { in }})`
   * — one extra query, not one query per result — then re-applies the
   * original rank order (Prisma's `in` doesn't preserve input order).
   */
  async hydrateWithCardData(rankedResults: any[]) {
    const ids = rankedResults.map((r) => r.id);
    const cards = await ProductRepository.findCardsByWhere({ id: { in: ids } }, { take: ids.length });
    const cardById = new Map(cards.map((c: any) => [c.id, c]));

    return rankedResults
      .map((r) => {
        const card = cardById.get(r.id);
        return card ? { ...card, rank: r.rank } : null;
      })
      .filter(Boolean);
  },

  async fullTextSearch(q: string, limit: number, onlyActive: boolean): Promise<any[]> {
    // Public search also requires an ACTIVE vendor (constant SQL, no user input).
    const statusClause = onlyActive ? `AND p."approvalStatus" = 'ACTIVE' AND p."isDeleted" = false ${PUBLIC_VENDOR_SQL}` : `AND p."isDeleted" = false`;

    return prisma.$queryRawUnsafe(
      `
      SELECT p.id, p.name, p.slug,
             ts_rank(p.search_vector, websearch_to_tsquery('simple', $1)) AS rank
      FROM products p
      WHERE p.search_vector @@ websearch_to_tsquery('simple', $1)
        ${statusClause}
      ORDER BY rank DESC, p."createdAt" DESC
      LIMIT $2
      `,
      q,
      limit
    );
  },

  async fuzzySearch(q: string, limit: number, onlyActive: boolean): Promise<any[]> {
    // Public search also requires an ACTIVE vendor (constant SQL, no user input).
    const statusClause = onlyActive ? `AND p."approvalStatus" = 'ACTIVE' AND p."isDeleted" = false ${PUBLIC_VENDOR_SQL}` : `AND p."isDeleted" = false`;

    return prisma.$queryRawUnsafe(
      `
      SELECT p.id, p.name, p.slug,
             similarity(p.name, $1) AS rank
      FROM products p
      WHERE similarity(p.name, $1) > 0.2
        ${statusClause}
      ORDER BY rank DESC
      LIMIT $2
      `,
      q,
      limit
    );
  },

  async fallbackSearch(q: string, limit: number, onlyActive: boolean) {
    const where: any = {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { nameBn: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { variants: { some: { sku: { contains: q, mode: "insensitive" } } } },
      ],
    };
    if (onlyActive) {
      applyPublicVisibility(where);
    } else {
      where.isDeleted = false;
    }

    const products = await prisma.product.findMany({
      where,
      select: { id: true, name: true, slug: true, description: true },
      take: limit * 2, // over-fetch, then rank + trim below
    });

    const lowerQ = q.toLowerCase();
    const scored = products.map((p) => {
      const lowerName = p.name.toLowerCase();
      let score = 0;
      if (lowerName === lowerQ) score = 100;
      else if (lowerName.startsWith(lowerQ)) score = 75;
      else if (lowerName.includes(lowerQ)) score = 50;
      else score = 25;
      return { ...p, rank: score };
    });

    return scored.sort((a, b) => b.rank - a.rank).slice(0, limit);
  },
};