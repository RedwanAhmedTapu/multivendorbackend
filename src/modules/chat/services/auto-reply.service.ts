import { prisma } from "../../../config/prisma.ts";
import { AutoReplyRepository } from "../repositories/auto-reply.repository.ts";
import  redisClient  from "../../../config/redis.ts";
import { RedisKeys } from "../utils/redis-keys.ts";
import type{ Message } from "@prisma/client";
import type { CreateAutoReplyInput, UpdateAutoReplyInput } from "../dto/auto-reply.dto.ts";

/** How long a scope's rule list may be served from Redis (the value the code always intended). */
export const AUTO_REPLY_CACHE_TTL_SECONDS = 3600;

/**
 * Phase 2: upper bound for one cache command. While the connection is down and
 * reconnecting, node-redis QUEUES commands instead of rejecting them, so an
 * unbounded await would hang the request / the auto-reply trigger until Redis
 * returns. After this the cache is treated as unavailable (database fallback);
 * a queued command still runs later — order is kept, so a queued DEL still
 * invalidates.
 */
export const AUTO_REPLY_CACHE_OP_TIMEOUT_MS = 500;

function cacheOp<T>(op: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("cache timeout")), AUTO_REPLY_CACHE_OP_TIMEOUT_MS);
  });
  return Promise.race([op(), timeout]).finally(() => clearTimeout(timer));
}

export class AutoReplyService {
  private repo = new AutoReplyRepository();

  /**
   * Drop this vendor's cached rule list after a mutation. A Redis failure here
   * must not turn a saved change into an error response — the entry then
   * expires within AUTO_REPLY_CACHE_TTL_SECONDS.
   */
  private async invalidate(vendorId: string) {
    try {
      await cacheOp(() => redisClient.del(RedisKeys.autoReplies(vendorId)));
    } catch {
      console.error("[auto-reply] cache invalidation failed; entry expires by TTL");
    }
  }

  // Phase 0: a vendor manages only its OWN vendor-scope rules. Input is the
  // validated whitelist (dto/auto-reply.dto.ts); scope and vendorId are forced
  // here, never read from the request. update/delete return null when the rule
  // isn't this vendor's (the controller answers 404).
  async create(data: CreateAutoReplyInput, vendorId: string) {
    const rule = await prisma.autoReply.create({ data: { ...data, scope: "VENDOR", vendorId } });
    await this.invalidate(vendorId);
    return rule;
  }

  async update(id: string, data: UpdateAutoReplyInput, vendorId: string) {
    const owned = await prisma.autoReply.findFirst({ where: { id, vendorId, scope: "VENDOR" }, select: { id: true } });
    if (!owned) return null;
    const rule = await prisma.autoReply.update({ where: { id: owned.id }, data });
    await this.invalidate(vendorId);
    return rule;
  }

  async delete(id: string, vendorId: string) {
    const owned = await prisma.autoReply.findFirst({ where: { id, vendorId, scope: "VENDOR" }, select: { id: true } });
    if (!owned) return null;
    const rule = await prisma.autoReply.delete({ where: { id: owned.id } });
    await this.invalidate(vendorId);
    return rule;
  }

  // Phase 1: rules for one scope (GLOBAL + this vendor's VENDOR rules), cached
  // per scope for AUTO_REPLY_CACHE_TTL_SECONDS.
  //   - TTL: node-redis v5 takes { EX } — `set(key, value, "EX", 3600)` set
  //     NO expiry (the options argument was the string "EX");
  //   - a cached entry is re-checked against the scope, so a foreign vendor's
  //     rule can never come back from the cache;
  //   - Redis unavailable / unreadable entry → the scoped DB query (the cache
  //     is an optimisation, never a source of truth); write failures are ignored.
  async getRules(vendorId?: string) {
    const cacheKey = RedisKeys.autoReplies(vendorId);
    const inScope = (r: any) => r?.scope === "GLOBAL" || (!!vendorId && r?.scope === "VENDOR" && r?.vendorId === vendorId);
    try {
      const raw = await cacheOp(() => redisClient.get(cacheKey));
      const cached = raw ? JSON.parse(raw) : null;
      if (Array.isArray(cached)) return cached.filter(inScope);
    } catch {
      // fall through to the database
    }
    const rules = (await this.repo.findActiveByScope(vendorId)).filter(inScope);
    try {
      await cacheOp(() => redisClient.set(cacheKey, JSON.stringify(rules), { EX: AUTO_REPLY_CACHE_TTL_SECONDS }));
    } catch {
      // cache write failure is harmless — next read goes to the database
    }
    return rules;
  }

  /** Chat settings: the vendor's own rules (active and inactive). Never a falsy vendor id. */
  async listOwn(vendorId: string) {
    if (!vendorId) return [];
    return this.repo.findOwnedByVendor(vendorId);
  }

  async processTrigger(conversationId: string, incomingMessage: Message, vendorId?: string) {
    const rules = await this.getRules(vendorId);
    for (const rule of rules) {
      if (await this.evaluate(rule, conversationId, incomingMessage)) {
        await this.execute(rule, conversationId, incomingMessage);
        break;
      }
    }
  }

  private async evaluate(rule: any, conversationId: string, msg: Message): Promise<boolean> {
    const triggers = await this.repo.countTriggers(rule.id, conversationId);
    if (triggers >= rule.maxTriggersPerConv) return false;

    if (rule.triggerType === "KEYWORD" && msg.content) {
      const lower = msg.content.toLowerCase();
      return rule.keywords.some((kw: string) => lower.includes(kw.toLowerCase()));
    }
    if (rule.triggerType === "FIRST_MESSAGE") {
      const count = await prisma.message.count({ where: { conversationId, senderType: msg.senderType } });
      return count === 1;
    }
    return false;
  }

 private async execute(rule: any, conversationId: string, msg: Message) {
  const isVendorRule = rule.scope === "VENDOR" && rule.vendorId;
  await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId,
        messageType: rule.messageType,
        content: rule.message,
        senderType: isVendorRule ? "VENDOR" : "ADMIN",
        senderVendorId: isVendorRule ? rule.vendorId : null,
        senderEmployeeId: isVendorRule ? null : null, // GLOBAL/admin auto-reply: কোনো real Employee নেই, তাই null-ই রাখো (senderId columns সব nullable)
        status: "SENT",
      },
    }),
    prisma.autoReplyTrigger.create({
      data: { autoReplyId: rule.id, conversationId, messageId: msg.id, triggeredBy: msg.senderId, triggeredByType: msg.senderType },
    }),
    prisma.autoReply.update({ where: { id: rule.id }, data: { triggerCount: { increment: 1 } } }),
  ]);
}
}