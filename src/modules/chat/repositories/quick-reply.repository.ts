import { prisma } from "../../../config/prisma.ts";

/**
 * Phase 3: which quick replies one scope may see.
 *   - platform quick replies: scope GLOBAL with NO owning vendor;
 *   - plus, for a vendor scope, every row that vendor owns (including GLOBAL-
 *     scoped rows the old create default produced with the vendor's id — those
 *     are the vendor's own, never shared).
 * The filter is built explicitly: Prisma drops `undefined` keys (verified on
 * 6.16.1 — `{ scope: "VENDOR", vendorId: undefined }` is sent as
 * `{ scope: "VENDOR" }`), so an absent vendor id must never reach a where.
 */
export function quickReplyScopeWhere(vendorId: string | null) {
  const platform = { scope: "GLOBAL" as const, vendorId: null };
  return vendorId ? { isActive: true, OR: [platform, { vendorId }] } : { isActive: true, ...platform };
}

export function inQuickReplyScope(row: any, vendorId: string | null): boolean {
  if (!row || row.isActive === false) return false;
  if (row.scope === "GLOBAL" && (row.vendorId ?? null) === null) return true;
  return !!vendorId && row.vendorId === vendorId;
}

export class QuickReplyRepository {
  /** Chat settings: every row the vendor owns (active or not), never anyone else's. */
  async findOwnedByVendor(vendorId: string) {
    return prisma.quickReply.findMany({
      where: { vendorId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
    });
  }

  async findByScope(vendorId: string | null) {
    return prisma.quickReply.findMany({
      where: quickReplyScopeWhere(vendorId),
      orderBy: [{ sortOrder: "asc" }, { usageCount: "desc" }]
    });
  }
}
