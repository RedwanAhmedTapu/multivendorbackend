// blog-module/utils/pagination.ts
// Cursor pagination for public blog traffic (stable under concurrent
// writes), offset pagination for the admin post list (needs page jumps
// and total counts) — same split as product-module.

export interface CursorPage<T> {
  items: T[];
  hasNext: boolean;
  nextCursor: string | null;
  limit: number;
}

export function buildCursorArgs(cursor: string | undefined, limit: number) {
  return {
    take: limit + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  };
}

export function toCursorPage<T extends { id: string }>(rows: T[], limit: number): CursorPage<T> {
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return {
    items,
    hasNext,
    nextCursor: hasNext ? items[items.length - 1].id : null,
    limit,
  };
}

export interface OffsetPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function buildOffsetArgs(page = 1, limit = 20) {
  return { skip: (page - 1) * limit, take: limit };
}

export function toOffsetPage<T>(items: T[], total: number, page: number, limit: number): OffsetPage<T> {
  return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
