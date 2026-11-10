// services/chat.service.ts
import type { ParticipantType, Prisma } from "@prisma/client";
import type { CreateConversationPayload } from "../types/chat.ts";
import { prisma } from "../config/prisma.ts";

// ── Field mappers ──────────────────────────────────────────────

function participantField(type: ParticipantType): string {
  switch (type) {
    case "CUSTOMER":  return "userId";
    case "VENDOR":    return "vendorId";
    case "ADMIN":     return "employeeId";
    case "EMPLOYEE":  return "employeeId";
    case "DELIVERY":  return "deliveryPersonId";
    case "AGENT":     return "agentId";
  }
}

function messageSenderField(type: ParticipantType): string {
  switch (type) {
    case "CUSTOMER":  return "senderId";
    case "VENDOR":    return "senderVendorId";
    case "ADMIN":     return "senderEmployeeId";
    case "EMPLOYEE":  return "senderEmployeeId";
    case "DELIVERY":  return "senderDeliveryPersonId";
    case "AGENT":     return "senderAgentId";
  }
}

// ── Select & Include constants ─────────────────────────────────
// ✅ FIX: Only fields that ACTUALLY exist on each model
// Vendor: id, storeName, avatar (NOT logo)
// Employee: id, designation (NOT name, NOT profileImage)
// DeliveryPerson: id, name (NOT profileImage)

const PRODUCT_SELECT = {
  id: true,
  name: true,
  slug: true,
  images: {
    select: { url: true, altText: true, sortOrder: true },
    orderBy: { sortOrder: "asc" as const },
    take: 1,
  },
  variants: {
    select: { price: true, specialPrice: true, sku: true },
    orderBy: { createdAt: "asc" as const },
    take: 1,
  },
} as const;

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  customerProfile: {
    select: { id: true, profileImage: true, gender: true },
  },
} as const;

// ✅ FIX: Removed logo (doesn't exist), use avatar instead
// ✅ FIX: Removed name/profileImage from employee (may not exist)
// ✅ FIX: Removed profileImage from deliveryPerson (may not exist)
const PARTICIPANTS_INCLUDE = {
  user: { select: USER_SELECT },
  vendor: { select: { id: true, storeName: true, avatar: true } },
  employee: { select: { id: true, designation: true } },
  deliveryPerson: { select: { id: true, name: true } },
} as const;

const MESSAGE_INCLUDE = {
  senderUser: {
    select: {
      id: true,
      name: true,
      email: true,
      customerProfile: { select: { profileImage: true } },
    },
  },
  senderVendor: { select: { id: true, storeName: true, avatar: true } },
  senderEmployee: { select: { id: true, designation: true } },
  senderDelivery: { select: { id: true, name: true } },
} as const;

// ── Helper: Get display name from a participant row ────────────
// ✅ Updated to match actual model fields

function getParticipantDisplayName(p: any): string {
  if (p.user?.name) return p.user.name;
  if (p.vendor?.storeName) return p.vendor.storeName;
  if (p.employee?.designation) return p.employee.designation;
  if (p.deliveryPerson?.name) return p.deliveryPerson.name;
  return "Unknown";
}

function getParticipantProfileImage(p: any): string | null {
  if (p.user?.customerProfile?.profileImage) return p.user.customerProfile.profileImage;
  // ✅ FIX: was `logo`, now `avatar`
  if (p.vendor?.avatar) return p.vendor.avatar;
  // employee and deliveryPerson don't have profileImage in schema
  return null;
}

// ── Service ────────────────────────────────────────────────────

export class ChatService {
  
  // ── Create conversation ──────────────────────────────────────
  async createConversation(
    payload: CreateConversationPayload,
    creatorId: string,
  ) {
    const {
      participantIds,
      participantTypes,
      productId,
      orderId,
      title,
      type,
    } = payload;

    return await prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          type,
          productId: productId || undefined,
          orderId: orderId != null ? orderId : undefined,
          title,
          status: "OPEN",
          messageCount: 0,
          unreadCount: 0,
        },
      });

      const participantsData = participantIds.map((id, index) => {
        const pType = participantTypes[index] as ParticipantType;
        return {
          conversationId: conversation.id,
          participantType: pType,
          userId:           pType === "CUSTOMER"  ? id : undefined,
          vendorId:         pType === "VENDOR"    ? id : undefined,
          employeeId:       (pType === "EMPLOYEE" || pType === "ADMIN") ? id : undefined,
          deliveryPersonId: pType === "DELIVERY"  ? id : undefined,
        };
      });

      await tx.conversationParticipant.createMany({ data: participantsData });

      const createdCount = await tx.conversationParticipant.count({
        where: { conversationId: conversation.id },
      });

      if (createdCount !== participantIds.length) {
        console.error(
          `[ChatService] WARNING: Expected ${participantIds.length} participants ` +
          `but found ${createdCount} for conversation ${conversation.id}`,
          { participantIds, participantTypes }
        );
      }

      return tx.conversation.findUnique({
        where: { id: conversation.id },
        include: {
          participants: { include: PARTICIPANTS_INCLUDE },
          product: { select: PRODUCT_SELECT },
        },
      });
    });
  }

  // ── Find or create conversation ──────────────────────────────
  async findOrCreateConversation(
    payload: CreateConversationPayload,
    creatorId: string,
  ) {
    const { participantIds, participantTypes, productId, orderId, type } = payload;

    const participantConditions = participantIds.map((id, index) => {
      const pType = participantTypes[index] as ParticipantType;
      return {
        participants: {
          some: {
            [participantField(pType)]: id,
            participantType: pType,
          },
        },
      };
    });

    const existing = await prisma.conversation.findFirst({
      where: {
        type,
        productId: productId || undefined,
        orderId: orderId != null ? orderId : undefined,
        AND: participantConditions,
      },
      include: {
        participants: { include: PARTICIPANTS_INCLUDE },
        product: { select: PRODUCT_SELECT },
      },
    });

    if (existing) return existing;
    return this.createConversation(payload, creatorId);
  }

  // ── Get user conversations with enriched "otherParticipant" ──
  async getUserConversations(
    userId: string,
    userType: ParticipantType,
    page = 1,
    limit = 20,
  ) {
    const skip = (page - 1) * limit;

    const conversations = await prisma.conversation.findMany({
      where: {
        participants: {
          some: {
            [participantField(userType)]: userId,
          },
        },
      },
      include: {
        participants: { include: PARTICIPANTS_INCLUDE },
        product: { select: PRODUCT_SELECT },
        order: { select: { id: true, totalAmount: true } },
      },
      orderBy: { lastMessageAt: "desc" },
      skip,
      take: limit,
    });

    const senderFk = messageSenderField(userType);

    const result = await Promise.all(
      conversations.map(async (conv) => {
        const myParticipant = conv.participants.find((p) => {
          const field = participantField(userType) as keyof typeof p;
          return (p as any)[field] === userId;
        });

        const unreadWhere: any = {
          conversationId: conv.id,
          NOT: { [senderFk]: userId },
        };

        if (myParticipant?.lastReadAt) {
          unreadWhere.createdAt = { gt: myParticipant.lastReadAt };
        }

        const unreadCount = await prisma.message.count({
          where: unreadWhere,
        });

        const otherParticipant = conv.participants.find((p) => {
          const field = participantField(userType) as keyof typeof p;
          return (p as any)[field] !== userId;
        });

        return {
          ...conv,
          unreadCount,
          otherParticipant: otherParticipant
            ? {
                ...otherParticipant,
                displayName: getParticipantDisplayName(otherParticipant),
                profileImage: getParticipantProfileImage(otherParticipant),
              }
            : null,
        };
      }),
    );

    const total = await prisma.conversation.count({
      where: {
        participants: {
          some: {
            [participantField(userType)]: userId,
          },
        },
      },
    });

    return {
      data: result,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // ── Search conversations ─────────────────────────────────────
  async searchConversations(
    userId: string,
    userType: ParticipantType,
    query: string,
    page = 1,
    limit = 20,
  ) {
    const skip = (page - 1) * limit;
    const field = participantField(userType);

    const searchConditions: Prisma.ConversationWhereInput[] = [
      { title: { contains: query, mode: "insensitive" } },
      { lastMessageText: { contains: query, mode: "insensitive" } },
      {
        participants: {
          some: {
            user: {
              OR: [
                { name: { contains: query, mode: "insensitive" } },
                { email: { contains: query, mode: "insensitive" } },
              ],
            },
          },
        },
      },
      {
        participants: {
          some: {
            vendor: {
              storeName: { contains: query, mode: "insensitive" },
            },
          },
        },
      },
      {
        participants: {
          some: {
            employee: {
              designation: { contains: query, mode: "insensitive" },
            },
          },
        },
      },
      {
        participants: {
          some: {
            deliveryPerson: {
              name: { contains: query, mode: "insensitive" },
            },
          },
        },
      },
    ];

    const conversations = await prisma.conversation.findMany({
      where: {
        AND: [
          {
            participants: {
              some: { [field]: userId },
            },
          },
          { OR: searchConditions },
        ],
      },
      include: {
        participants: { include: PARTICIPANTS_INCLUDE },
        product: { select: PRODUCT_SELECT },
        order: { select: { id: true, totalAmount: true } },
      },
      orderBy: { lastMessageAt: "desc" },
      skip,
      take: limit,
    });

    const senderFk = messageSenderField(userType);

    const result = await Promise.all(
      conversations.map(async (conv) => {
        const myParticipant = conv.participants.find((p) => {
          const f = participantField(userType) as keyof typeof p;
          return (p as any)[f] === userId;
        });

        const unreadWhere: any = {
          conversationId: conv.id,
          NOT: { [senderFk]: userId },
        };

        if (myParticipant?.lastReadAt) {
          unreadWhere.createdAt = { gt: myParticipant.lastReadAt };
        }

        const unreadCount = await prisma.message.count({ where: unreadWhere });

        const otherParticipant = conv.participants.find((p) => {
          const f = participantField(userType) as keyof typeof p;
          return (p as any)[f] !== userId;
        });

        return {
          ...conv,
          unreadCount,
          otherParticipant: otherParticipant
            ? {
                ...otherParticipant,
                displayName: getParticipantDisplayName(otherParticipant),
                profileImage: getParticipantProfileImage(otherParticipant),
              }
            : null,
        };
      }),
    );

    return {
      data: result,
      pagination: {
        page,
        limit,
        total: result.length,
        pages: 1,
      },
    };
  }

  // ── Send message ─────────────────────────────────────────────
  async sendMessage(
    conversationId: string,
    senderId: string,
    senderType: ParticipantType,
    content: string,
  ) {
    return await prisma.$transaction(async (tx) => {
      const msgFk = messageSenderField(senderType);

      const message = await tx.message.create({
        data: {
          conversationId,
          content,
          senderType,
          status: "SENT",
          createdAt: new Date(),
          [msgFk]: senderId,
        },
        include: MESSAGE_INCLUDE,
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          lastMessageText: content,
          messageCount: { increment: 1 },
        },
      });

      return message;
    });
  }

  // ── Get conversation messages ────────────────────────────────
  async getConversationMessages(
    conversationId: string,
    page = 1,
    limit = 50,
  ) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId },
        include: MESSAGE_INCLUDE,
        orderBy: { createdAt: "asc" },
        skip,
        take: limit,
      }),
      prisma.message.count({
        where: { conversationId },
      }),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // ── Get conversation by ID ───────────────────────────────────
  async getConversationById(conversationId: string) {
    return await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: { include: PARTICIPANTS_INCLUDE },
        product: { select: PRODUCT_SELECT },
        order: { select: { id: true, totalAmount: true } },
      },
    });
  }

  // ── Mark as read ─────────────────────────────────────────────
  async markAsRead(
    conversationId: string,
    userId: string,
    userType: ParticipantType,
  ) {
    const seenAt = new Date();

    await prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        [participantField(userType)]: userId,
      },
      data: { lastReadAt: seenAt },
    });

    const senderFk = messageSenderField(userType);
    await prisma.message.updateMany({
      where: {
        conversationId,
        NOT: { [senderFk]: userId },
        status: { in: ["SENT", "DELIVERED"] },
      },
      data: { status: "SEEN", seenAt },
    });

    return { seenAt, message: "Messages marked as read" };
  }

  // ── Mark message delivered ───────────────────────────────────
  async markMessageDelivered(messageId: string, deliveredAt: Date) {
    return await prisma.message.update({
      where: { id: messageId },
      data: { deliveredAt, status: "DELIVERED" },
    });
  }

  // ── Mark message seen ────────────────────────────────────────
  async markMessageSeen(messageId: string, seenAt: Date) {
    return await prisma.message.update({
      where: { id: messageId },
      data: { status: "SEEN", seenAt },
    });
  }

  // ── Get total unread count ───────────────────────────────────
  async getUnreadCount(userId: string, userType: ParticipantType) {
    const senderFk = messageSenderField(userType);
    const field = participantField(userType);

    const participants = await prisma.conversationParticipant.findMany({
      where: { [field]: userId },
      select: { conversationId: true, lastReadAt: true },
    });

    let totalUnread = 0;

    for (const p of participants) {
      const where: any = {
        conversationId: p.conversationId,
        NOT: { [senderFk]: userId },
      };

      if (p.lastReadAt) {
        where.createdAt = { gt: p.lastReadAt };
      }

      const count = await prisma.message.count({ where });
      totalUnread += count;
    }

    return { count: totalUnread };
  }

  // ── Mute conversation ────────────────────────────────────────
  async muteConversation(
    conversationId: string,
    userId: string,
    userType: ParticipantType,
  ) {
    const updated = await prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        [participantField(userType)]: userId,
      },
      data: { isMuted: true },
    });

    if (updated.count === 0) {
      throw new Error("Participant not found");
    }

    return this.getConversationById(conversationId);
  }

  // ── Unmute conversation ──────────────────────────────────────
  async unmuteConversation(
    conversationId: string,
    userId: string,
    userType: ParticipantType,
  ) {
    const updated = await prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        [participantField(userType)]: userId,
      },
      data: { isMuted: false },
    });

    if (updated.count === 0) {
      throw new Error("Participant not found");
    }

    return this.getConversationById(conversationId);
  }

  // ── Leave conversation ───────────────────────────────────────
  async leaveConversation(
    conversationId: string,
    userId: string,
    userType: ParticipantType,
  ) {
    const updated = await prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        [participantField(userType)]: userId,
        leftAt: null,
      },
      data: { leftAt: new Date() },
    });

    if (updated.count === 0) {
      throw new Error("Participant not found or already left");
    }

    const activeCount = await prisma.conversationParticipant.count({
      where: {
        conversationId,
        leftAt: null,
      },
    });

    if (activeCount === 0) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { status: "CLOSED" },
      });
    }

    return { message: "Successfully left the conversation" };
  }

  // ── Get conversations by type ────────────────────────────────
  async getUserConversationsByType(
    userId: string,
    userType: ParticipantType,
    type: string,
    page = 1,
    limit = 20,
  ) {
    const skip = (page - 1) * limit;
    const field = participantField(userType);

    const where: Prisma.ConversationWhereInput = {
      participants: {
        some: { [field]: userId },
      },
    };

    if (type && type !== "ALL") {
      (where as any).type = type;
    }

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          participants: { include: PARTICIPANTS_INCLUDE },
          product: { select: PRODUCT_SELECT },
          order: { select: { id: true, totalAmount: true } },
        },
        orderBy: { lastMessageAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.conversation.count({ where }),
    ]);

    const senderFk = messageSenderField(userType);

    const result = await Promise.all(
      conversations.map(async (conv) => {
        const myParticipant = conv.participants.find((p) => {
          const f = participantField(userType) as keyof typeof p;
          return (p as any)[f] === userId;
        });

        const unreadWhere: any = {
          conversationId: conv.id,
          NOT: { [senderFk]: userId },
        };

        if (myParticipant?.lastReadAt) {
          unreadWhere.createdAt = { gt: myParticipant.lastReadAt };
        }

        const unreadCount = await prisma.message.count({ where: unreadWhere });

        const otherParticipant = conv.participants.find((p) => {
          const f = participantField(userType) as keyof typeof p;
          return (p as any)[f] !== userId;
        });

        return {
          ...conv,
          unreadCount,
          otherParticipant: otherParticipant
            ? {
                ...otherParticipant,
                displayName: getParticipantDisplayName(otherParticipant),
                profileImage: getParticipantProfileImage(otherParticipant),
              }
            : null,
        };
      }),
    );

    return {
      data: result,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }
}

export const chatService = new ChatService();