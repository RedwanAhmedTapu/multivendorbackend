import { prisma } from "../../../config/prisma.ts";

export class AutoReplyRepository {
  async findActiveByScope(vendorId?: string) {
    // Phase 0: with no vendor in scope (vendor/admin senders, support chats)
    // only GLOBAL rules apply. `{ scope: "VENDOR", vendorId: undefined }`
    // matched EVERY vendor's rules (Prisma drops undefined filters), so vendor
    // A's auto-reply could be posted as vendor A into unrelated conversations.
    return prisma.autoReply.findMany({
      where: {
        isActive: true,
        OR: vendorId ? [{ scope: "GLOBAL" }, { scope: "VENDOR", vendorId }] : [{ scope: "GLOBAL" }]
      },
      orderBy: { createdAt: "asc" }
    });
  }

  // Chat settings (management): the vendor's OWN rules only, active or not, so a
  // disabled rule can be found and re-enabled. GLOBAL rules are not listed here
  // (they aren't the vendor's to manage; see the historical scope audit).
  async findOwnedByVendor(vendorId: string) {
    return prisma.autoReply.findMany({
      where: { scope: "VENDOR", vendorId },
      orderBy: { createdAt: "asc" },
    });
  }

  async countTriggers(autoReplyId: string, conversationId: string) {
    return prisma.autoReplyTrigger.count({ where: { autoReplyId, conversationId } });
  }
}