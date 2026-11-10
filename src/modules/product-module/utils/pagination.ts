// utils/pagination.ts

/**
 * Cursor pagination is preferred for public listing/search (stable under
 * concurrent writes, no OFFSET scan cost on large tables).
 * Offset pagination (page/limit) is kept as a fallback for admin/vendor
 * dashboards that need "jump to page N" / total page counts.
 */

export interface CursorPageInput {
  cursor?: string | null; // opaque = base64(`${sortValue}|${id}`)
  limit?: number;
}

export interface OffsetPageInput {
  page?: number;
  limit?: number;
}

export const DEFAULT_LIMIT = 12;
export const MAX_LIMIT = 100;

export function clampLimit(limit?: number, fallback = DEFAULT_LIMIT) {
  const n = Number(limit) || fallback;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

export function encodeCursor(id: string, sortValue: string | number | Date) {
  const raw = `${sortValue instanceof Date ? sortValue.toISOString() : sortValue}|${id}`;
  return Buffer.from(raw, "utf-8").toString("base64url");
}

export function decodeCursor(cursor: string): { sortValue: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf-8");
    const [sortValue, id] = raw.split("|");
    if (!sortValue || !id) return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

/**
 * Builds Prisma `cursor` / `skip` / `take` args for a keyset-paginated query
 * ordered by (sortField desc, id desc) — the most common "newest first" case.
 * For ascending sorts, flip the comparator when building `where` in the caller.
 */
export function buildCursorArgs(input: CursorPageInput) {
  const take = clampLimit(input.limit);
  if (!input.cursor) {
    return { take: take + 1, skip: 0, cursorWhere: undefined };
  }
  const decoded = decodeCursor(input.cursor);
  if (!decoded) {
    return { take: take + 1, skip: 0, cursorWhere: undefined };
  }
  return { take: take + 1, skip: 0, cursorWhere: decoded };
}

/**
 * Slices a `take+1` result set into { items, hasNext, nextCursor }.
 */
export function paginateCursorResult<T extends { id: string; createdAt?: Date }>(
  rows: T[],
  take: number,
  sortField: keyof T = "createdAt" as keyof T
) {
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasNext && last ? encodeCursor(last.id, last[sortField] as any) : null;

  return {
    items,
    pagination: {
      hasNext,
      hasPrevious: undefined, // cursor pagination is one-directional by design
      nextCursor,
      limit: take,
    },
  };
}

/**
 * Offset pagination helper for admin/vendor dashboards.
 */
export function buildOffsetArgs(input: OffsetPageInput) {
  const limit = clampLimit(input.limit);
  const page = Math.max(Number(input.page) || 1, 1);
  const skip = (page - 1) * limit;
  return { page, limit, skip, take: limit };
}

export function paginateOffsetResult(totalItems: number, page: number, limit: number) {
  const totalPages = Math.max(Math.ceil(totalItems / limit), 1);
  return {
    currentPage: page,
    totalPages,
    totalItems,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
    limit,
  };
}
