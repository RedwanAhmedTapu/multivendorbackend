import { prisma } from "../../../config/prisma.ts";
import { QuickReplyRepository, inQuickReplyScope } from "../repositories/quick-reply.repository.ts";
import redisClient from "../../../config/redis.ts";
import { RedisKeys } from "../utils/redis-keys.ts";
import { withRedisTimeout } from "../utils/redis-timeout.ts";
import type { CreateQuickReplyInput, UpdateQuickReplyInput } from "../dto/quick-reply.dto.ts";

/** How long one scope's quick-reply list may be served from Redis. */
export const QUICK_REPLY_CACHE_TTL_SECONDS = 3600;
const CACHE_OP_TIMEOUT_MS = 500;

// Phase 3: a vendor manages only its OWN rows. The vendor id is the
// authenticated one (controller); ownership is part of every write's `where`
// (updateMany / deleteMany on { id, vendorId }), so there is no check-then-act
// gap and a foreign or missing id both come back as null (→ 404). A falsy
// vendor id is refused before any query — it must never drop the filter.
export class QuickReplyService {
  private repo = new QuickReplyRepository();

  private async invalidate(vendorId: string) {
    try {
      await withRedisTimeout(() => redisClient.del(RedisKeys.quickReplies(vendorId)), CACHE_OP_TIMEOUT_MS);
    } catch {
      console.error("[quick-reply] cache invalidation failed; entry expires by TTL");
    }
  }

  async create(data: CreateQuickReplyInput, vendorId: string) {
    if (!vendorId) throw new Error("vendor scope required");
    const qr = await prisma.quickReply.create({ data: { ...data, scope: "VENDOR", vendorId } });
    await this.invalidate(vendorId);
    return qr;
  }

  async update(id: string, data: UpdateQuickReplyInput, vendorId: string) {
    if (!vendorId || !id) return null;
    const { scope: _ignored, ...fields } = data; // only VENDOR can pass validation; nothing to write
    const { count } = await prisma.quickReply.updateMany({ where: { id, vendorId }, data: fields });
    if (count === 0) return null;
    await this.invalidate(vendorId);
    return prisma.quickReply.findFirst({ where: { id, vendorId } });
  }

  async delete(id: string, vendorId: string) {
    if (!vendorId || !id) return null;
    const { count } = await prisma.quickReply.deleteMany({ where: { id, vendorId } });
    if (count === 0) return null;
    await this.invalidate(vendorId);
    return { id };
  }

  /** Chat settings: the vendor's own quick replies (active and inactive). */
  async listOwn(vendorId: string) {
    if (!vendorId) return [];
    return this.repo.findOwnedByVendor(vendorId);
  }

  async getSuggestions(query: string, vendorId: string | null) {
    const scope = vendorId || null;
    const cacheKey = RedisKeys.quickReplies(scope ?? undefined);
    let list: any[] | null = null;
    try {
      const raw = await withRedisTimeout(() => redisClient.get(cacheKey), CACHE_OP_TIMEOUT_MS);
      const cached = raw ? JSON.parse(raw) : null;
      if (Array.isArray(cached)) list = cached;
    } catch {
      // Redis unavailable / unreadable entry → database
    }

    if (!list) {
      list = await this.repo.findByScope(scope);
      try {
        // Phase 2: node-redis v5 takes { EX } — the old `"EX", 3600` arguments set no expiry.
        await withRedisTimeout(
          () => redisClient.set(cacheKey, JSON.stringify(list), { EX: QUICK_REPLY_CACHE_TTL_SECONDS }),
          CACHE_OP_TIMEOUT_MS
        );
      } catch {
        // cache write failure is harmless
      }
    }
    // a cached (or any) entry is re-checked against the scope
    list = list.filter((qr) => inQuickReplyScope(qr, scope));

    if (!query) return list.slice(0, 10);
    const q = query.toLowerCase();
    return list.filter(qr =>
      qr.keywords?.some((k: string) => q.includes(k.toLowerCase())) ||
      qr.name.toLowerCase().includes(q) ||
      qr.shortcut?.toLowerCase() === q
    ).slice(0, 5);
  }

  async useShortcut(id: string) {
    await prisma.quickReply.update({ where: { id }, data: { usageCount: { increment: 1 } } });
  }
}
