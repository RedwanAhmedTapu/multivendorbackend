// services/chat.service.ts
import type { Conversation, Message, ParticipantType } from '@prisma/client';
import type { CreateConversationPayload } from '../types/chat.ts';
import { prisma } from '../config/prisma.ts';

export class ChatService {
  // ✅ Create a new conversation
  async createConversation(payload: CreateConversationPayload, creatorId: string) {
    const { participantIds, participantTypes, productId, orderId, title, type } = payload;

    return await prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          type,
          productId,
          orderId,
          title,
          status: 'OPEN',
          messageCount: 0,
          unreadCount: 0,
        },
      });

      const participantsData = participantIds.map((id, index) => ({
        conversationId: conversation.id,
        participantType: participantTypes[index] as ParticipantType,
        userId: participantTypes[index] === 'CUSTOMER' ? id : undefined,
        vendorId: participantTypes[index] === 'VENDOR' ? id : undefined,
        employeeId: participantTypes[index] === 'EMPLOYEE' ? id : undefined,
        deliveryPersonId: participantTypes[index] === 'DELIVERY' ? id : undefined,
      }));

      await tx.conversationParticipant.createMany({
        data: participantsData,
      });

      return conversation;
    });
  }
// services/chat.service.ts
async findOrCreateConversation(payload: CreateConversationPayload, creatorId: string) {
  const { participantIds, participantTypes, productId, orderId, type } = payload;

  // Check if conversation already exists
  const existing = await prisma.conversation.findFirst({
    where: {
      type,
      productId: productId || undefined,
      orderId: orderId || undefined,
      participants: {
        some: {
          OR: participantIds.map((id, index) => {
            const participantType = participantTypes[index] as ParticipantType;
            if (participantType === 'CUSTOMER') return { userId: id };
            if (participantType === 'VENDOR') return { vendorId: id };
            if (participantType === 'EMPLOYEE') return { employeeId: id };
            if (participantType === 'DELIVERY') return { deliveryPersonId: id };
            return {};
          }),
        },
      },
    },
    include: {
      participants: true,
      messages: {
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: {
          senderUser: true,
          senderVendor: true,
          senderEmployee: true,
          senderDelivery: true,
        },
      },
    },
  });

  if (existing) return existing;

  // Otherwise create a new one
  return this.createConversation(payload, creatorId);
}

  // ✅ Send message
  async sendMessage(conversationId: string, senderId: string, senderType: ParticipantType, content: string) {
    return await prisma.$transaction(async (tx) => {
      const messageData: any = {
        conversationId,
        content,
        senderType,
        createdAt: new Date(),
      };

      switch (senderType) {
        case 'CUSTOMER': messageData.senderId = senderId; break;
        case 'VENDOR': messageData.senderVendorId = senderId; break;
        case 'EMPLOYEE': messageData.senderEmployeeId = senderId; break;
        case 'DELIVERY': messageData.senderDeliveryPersonId = senderId; break;
      }

      const message = await tx.message.create({
        data: messageData,
        include: {
          senderUser: { select: { id: true, name: true, email: true } },
          senderVendor: { select: { id: true, storeName: true } },
          senderEmployee: { select: { id: true, designation: true } },
          senderDelivery: { select: { id: true, name: true } },
        },
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          lastMessageText: content,
          messageCount: { increment: 1 },
          unreadCount: { increment: 1 },
        },
      });

      return message;
    });
  }

  // ✅ Get user conversations
  async getUserConversations(userId: string, userType: ParticipantType, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const whereClause: any = {};

    switch (userType) {
      case 'CUSTOMER': whereClause.userId = userId; break;
      case 'VENDOR': whereClause.vendorId = userId; break;
      case 'EMPLOYEE': whereClause.employeeId = userId; break;
      case 'DELIVERY': whereClause.deliveryPersonId = userId; break;
    }

    const conversations = await prisma.conversationParticipant.findMany({
      where: whereClause,
      include: {
        conversation: {
          include: {
            participants: {
              include: {
                user: true,
                vendor: true,
                employee: true,
                deliveryPerson: true,
              },
            },
            product: true,
            order: true,
          },
        },
      },
      orderBy: { conversation: { lastMessageAt: 'desc' } },
      skip,
      take: limit,
    });

    return conversations.map(cp => cp.conversation);
  }

  // ✅ Get conversation messages
  async getConversationMessages(conversationId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    return await prisma.message.findMany({
      where: { conversationId },
      include: {
        senderUser: true,
        senderVendor: true,
        senderEmployee: true,
        senderDelivery: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    });
  }

  // ✅ Mark messages as seen
  async markMessagesAsSeen(conversationId: string, userId: string, userType: ParticipantType, seenAt: Date) {
    const updateData: any = {};
    switch (userType) {
      case 'CUSTOMER': updateData.userId = userId; break;
      case 'VENDOR': updateData.vendorId = userId; break;
      case 'EMPLOYEE': updateData.employeeId = userId; break;
      case 'DELIVERY': updateData.deliveryPersonId = userId; break;
    }

    const updated = await prisma.conversationParticipant.updateMany({
      where: { conversationId, ...updateData },
      data: { lastReadAt: seenAt },
    });

    return { updatedMessageIds: updated.count > 0 ? [conversationId] : [], seenAt };
  }

  // ✅ Mark message delivered
  async markMessageDelivered(messageId: string, deliveredAt: Date) {
    return await prisma.message.update({
      where: { id: messageId },
      data: { deliveredAt, status: 'DELIVERED' },
    });
  }

  // ✅ Get conversation by ID
  async getConversationById(conversationId: string) {
    return await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: true,
            vendor: true,
            employee: true,
            deliveryPerson: true,
          },
        },
        product: true,
        order: true,
        messages: {
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: {
            senderUser: true,
            senderVendor: true,
            senderEmployee: true,
            senderDelivery: true,
          },
        },
      },
    });
  }
}

export const chatService = new ChatService();
