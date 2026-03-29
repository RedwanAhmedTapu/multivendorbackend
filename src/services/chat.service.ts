// services/chat.service.ts
import type { ParticipantType } from '@prisma/client';
import type { CreateConversationPayload } from '../types/chat.ts';
import { prisma } from '../config/prisma.ts';

// Maps a ParticipantType to its foreign-key field name on ConversationParticipant / Message
function senderField(type: ParticipantType): string {
  switch (type) {
    case 'CUSTOMER':  return 'userId';
    case 'VENDOR':    return 'vendorId';
    case 'ADMIN':     return 'employeeId';   // ADMIN reuses the employee FK
    case 'EMPLOYEE':  return 'employeeId';
    case 'DELIVERY':  return 'deliveryPersonId';
  }
}

export class ChatService {
  async createConversation(payload: CreateConversationPayload, creatorId: string) {
    const { participantIds, participantTypes, productId, orderId, title, type } = payload;

    return await prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: { type, productId, orderId, title, status: 'OPEN', messageCount: 0, unreadCount: 0 },
      });

      const participantsData = participantIds.map((id, index) => {
        const pType = participantTypes[index] as ParticipantType;
        return {
          conversationId:   conversation.id,
          participantType:  pType,
          userId:           pType === 'CUSTOMER'  ? id : undefined,
          vendorId:         pType === 'VENDOR'    ? id : undefined,
          employeeId:       (pType === 'EMPLOYEE' || pType === 'ADMIN') ? id : undefined,
          deliveryPersonId: pType === 'DELIVERY'  ? id : undefined,
        };
      });

      await tx.conversationParticipant.createMany({ data: participantsData });
      return conversation;
    });
  }

  async findOrCreateConversation(payload: CreateConversationPayload, creatorId: string) {
    const { participantIds, participantTypes, productId, orderId, type } = payload;

    const existing = await prisma.conversation.findFirst({
      where: {
        type,
        productId: productId || undefined,
        orderId:   orderId   || undefined,
        participants: {
          some: {
            OR: participantIds.map((id, index) => {
              const pType = participantTypes[index] as ParticipantType;
              return { [senderField(pType)]: id };
            }),
          },
        },
      },
      include: {
        participants: {
          include: { user: true, vendor: true, employee: true, deliveryPerson: true },
        },
        messages: {
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: { senderUser: true, senderVendor: true, senderEmployee: true, senderDelivery: true },
        },
      },
    });

    if (existing) return existing;
    return this.createConversation(payload, creatorId);
  }

  async sendMessage(
    conversationId: string,
    senderId: string,
    senderType: ParticipantType,
    content: string
  ) {
    return await prisma.$transaction(async (tx) => {
      const senderFk = senderField(senderType);

      const msgSenderField: Record<string, string> = {
        userId:           'senderId',
        vendorId:         'senderVendorId',
        employeeId:       'senderEmployeeId',
        deliveryPersonId: 'senderDeliveryPersonId',
      };

      const messageData: any = {
        conversationId,
        content,
        senderType,
        createdAt: new Date(),
        [msgSenderField[senderFk]]: senderId,
      };

      const message = await tx.message.create({
        data: messageData,
        include: {
          senderUser:     { select: { id: true, name: true, email: true } },
          senderVendor:   { select: { id: true, storeName: true } },
          senderEmployee: { select: { id: true, designation: true } },
          senderDelivery: { select: { id: true, name: true } },
        },
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt:   new Date(),
          lastMessageText: content,
          messageCount:    { increment: 1 },
          unreadCount:     { increment: 1 },
        },
      });

      return message;
    });
  }

  async getUserConversations(
    userId:   string,
    userType: ParticipantType,
    page    = 1,
    limit   = 20
  ) {
    const skip = (page - 1) * limit;
    const whereClause: any = { [senderField(userType)]: userId };

    const participants = await prisma.conversationParticipant.findMany({
      where: whereClause,
      include: {
        conversation: {
          include: {
            participants: {
              include: {
                user:           { select: { id: true, name: true, email: true } },
                vendor:         { select: { id: true, storeName: true } },
                employee:       { select: { id: true, designation: true } },
                deliveryPerson: { select: { id: true, name: true } },
              },
            },
            product: { select: { id: true, name: true, slug: true } },
            order:   { select: { id: true, totalAmount: true } },
          },
        },
      },
      orderBy: { conversation: { lastMessageAt: 'desc' } },
      skip,
      take: limit,
    });

    // Compute per-user unreadCount based on their lastReadAt vs conversation messages
    const result = await Promise.all(
      participants.map(async (cp) => {
        const conv      = cp.conversation;
        const lastReadAt = cp.lastReadAt;

        const unreadCount = lastReadAt
          ? await prisma.message.count({
              where: {
                conversationId: conv.id,
                createdAt:      { gt: lastReadAt },
                NOT: { [senderField(userType)]: userId },
              },
            })
          : await prisma.message.count({
              where: {
                conversationId: conv.id,
                NOT: { [senderField(userType)]: userId },
              },
            });

        return { ...conv, unreadCount };
      })
    );

    return result;
  }

  async getConversationMessages(conversationId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    return await prisma.message.findMany({
      where:   { conversationId },
      include: {
        senderUser:     true,
        senderVendor:   true,
        senderEmployee: true,
        senderDelivery: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    });
  }

  async markAsRead(conversationId: string, userId: string, userType: ParticipantType) {
    return this.markMessagesAsSeen(conversationId, userId, userType, new Date());
  }

  async markMessagesAsSeen(
    conversationId: string,
    userId:         string,
    userType:       ParticipantType,
    seenAt:         Date
  ) {
    const whereClause: any = { [senderField(userType)]: userId };

    await prisma.conversationParticipant.updateMany({
      where: { conversationId, ...whereClause },
      data:  { lastReadAt: seenAt },
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data:  { unreadCount: 0 },
    });

    return { seenAt };
  }

  async markMessageDelivered(messageId: string, deliveredAt: Date) {
    return await prisma.message.update({
      where: { id: messageId },
      data:  { deliveredAt, status: 'DELIVERED' },
    });
  }

  async getConversationById(conversationId: string) {
    return await prisma.conversation.findUnique({
      where:   { id: conversationId },
      include: {
        participants: {
          include: { user: true, vendor: true, employee: true, deliveryPerson: true },
        },
        product: true,
        order:   true,
        messages: {
          take:    20,
          orderBy: { createdAt: 'desc' },
          include: { senderUser: true, senderVendor: true, senderEmployee: true, senderDelivery: true },
        },
      },
    });
  }
}

export const chatService = new ChatService();