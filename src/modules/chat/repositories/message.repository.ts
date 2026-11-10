import { prisma } from "../../../config/prisma.ts";
import { getPrismaCursorFilter } from "../utils/pagination.ts";
import { identityColumnOf, identityWhere } from "../utils/participant-resolver.ts";
import { agentChatEnabled } from "../../agent/chat/agent-chat.config.ts";

export class MessageRepository {
  async getMessages(conversationId: string, params: { cursor?: string; limit?: number }) {
    const limit = Math.min(params.limit || 50, 100);
    return prisma.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        ...getPrismaCursorFilter(params.cursor)
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true, content: true, messageType: true, status: true, createdAt: true,
        replyToId: true, quickReplyId: true, senderType: true, senderId: true,
        senderVendorId: true, senderEmployeeId: true, senderDeliveryPersonId: true,
        ...(agentChatEnabled() ? { senderAgentId: true } : {}),
        media: { select: { url: true, thumbnailUrl: true, width: true, height: true, duration: true, blurhash: true } },
        reactions: { select: { reaction: true, participantId: true } }
      }
    });
  }

  async getParticipantId(conversationId: string, userId: string, userType: string) {
    // P10 security fix: an unknown type used to add NO identity column, so the
    // lookup matched ANY participant of the conversation. Now it matches nobody.
    if (!identityColumnOf(userType)) return undefined;
    const where: any = { conversationId, leftAt: null, ...identityWhere(userType, userId, "none") };

    const p = await prisma.conversationParticipant.findFirst({ where, select: { id: true } });
    return p?.id;
  }
}