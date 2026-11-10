import { prisma } from "../../../config/prisma.ts";
import { MessageRepository } from "../repositories/message.repository.ts";
import redisClient from "../../../config/redis.ts";
import { RedisKeys } from "../utils/redis-keys.ts";
import { SocketEmitter } from "../socket/chat.handler.ts";

export class ReadReceiptService {
  private repo = new MessageRepository();

  async markAsRead(conversationId: string, participantId: string, upToMessageId: string, ownerId?: string) {
    await prisma.$transaction([
      prisma.conversationParticipant.update({
        where: { id: participantId },
        data: { lastReadMessageId: upToMessageId, lastReadAt: new Date(), unreadCount: 0 }
      }),
      prisma.messageReceipt.upsert({
        where: { messageId_participantId: { messageId: upToMessageId, participantId } },
        create: { messageId: upToMessageId, participantId, seenAt: new Date() },
        update: { seenAt: new Date() }
      })
    ]);

    if (ownerId) {
      await redisClient.del(RedisKeys.unreadTotal(ownerId));
    }
    await redisClient.del(RedisKeys.unreadCount(participantId));

    SocketEmitter.toRoom(`conversation:${conversationId}`).emit("messageRead", {
      conversationId, participantId, messageId: upToMessageId
    });
  }
}