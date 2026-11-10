import { prisma } from "../../../config/prisma.ts";
import type {
  ParticipantType,
  ConversationStatus,
  ConversationType,
} from "@prisma/client";
import { getPrismaCursorFilter } from "../utils/pagination.ts";
import { identityWhere } from "../utils/participant-resolver.ts";
import { agentChatEnabled } from "../../agent/chat/agent-chat.config.ts";
import crypto from "crypto";

export function buildDedupeKey(
  type: ConversationType,
  context: { productId?: string | null; orderId?: string | null },
  participantIds: string[],
) {
  const sorted = [...participantIds].sort().join(":");
  
  // ✅ FIX: PRODUCT_INQUIRY = one unified chat per customer-vendor pair.
  // Don't include productId/orderId in the dedupe key, so all product
  // inquiries go to the same conversation thread.
  const productPart = type === "PRODUCT_INQUIRY" ? "" : (context.productId ?? "");
  const orderPart   = type === "PRODUCT_INQUIRY" ? "" : (context.orderId ?? "");
  
  const raw = `${type}|${productPart}|${orderPart}|${sorted}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}
export class ConversationRepository {
  async findById(id: string) {
    return prisma.conversation.findUnique({ where: { id } });
  }
  async findByDedupeKey(dedupeKey: string) {
    if (!dedupeKey) return null; // ✅ Guard against empty key
    
    try {
      return await prisma.conversation.findUnique({
        where: { dedupeKey },
        include: { participants: true },
      });
    } catch (error) {
      // ✅ Log but don't throw - table might not have field yet during migration
      console.error("findByDedupeKey error:", error);
      return null;
    }
  }
 async findByParticipants(
  type: ConversationType,
  userId: string,
  vendorId: string
) {
  return prisma.conversation.findFirst({
    where: {
      type,
      status: { notIn: ["CLOSED", "ARCHIVED"] },
      participants: {
        every: {
          leftAt: null,
          OR: [
            { userId, participantType: "CUSTOMER" },
            { vendorId, participantType: "VENDOR" },
          ],
        },
      },
    },
    include: { participants: true },
  });
}
  async getUserConversations(
    ownerId: string,
    ownerType: ParticipantType,
    params: {
      cursor?: string | null;
      limit?: number;
      status?: ConversationStatus;
    },
  ) {
    const limit = Math.min(params.limit || 20, 50);
    const whereFilter: any = {
      leftAt: null,
      ...getSenderFilter(ownerType, ownerId),
      conversation: {
        // FIX: closedAt: null was hardcoded, which made it impossible to ever
        // return CLOSED/ARCHIVED conversations even when explicitly requested
        // via params.status — closedAt is always set for those statuses, so
        // `status: "CLOSED", closedAt: null` is a contradiction that matches
        // nothing. Only default to hiding closed/archived when no explicit
        // status filter was requested.
        ...(params.status
          ? { status: params.status }
          : { status: { notIn: ["CLOSED", "ARCHIVED"] } }),
        ...getPrismaCursorFilter(params.cursor),
      },
    };

    return prisma.conversationParticipant.findMany({
      where: whereFilter,
      select: {
        id: true,
        unreadCount: true,
        isPinned: true,
        lastReadMessageId: true,
        userId: true,
        vendorId: true,
        employeeId: true,
        deliveryPersonId: true,
        conversation: {
          select: {
            id: true,
            type: true,
            status: true,
            title: true,
            lastMessageAt: true,
            lastMessageText: true,
            lastMessageType: true,
            lastSenderId: true,
            lastSenderType: true,
            priority: true,
            ...(agentChatEnabled() ? { agentLinkId: true } : {}),
            // FIX: this is the piece that was missing entirely. Without the
            // sibling participant rows, there is no data anywhere to build
            // `otherParticipant` from — the service has nothing to compute it
            // out of. Pull every active participant on the conversation;
            // the service filters out "me" and picks the counterpart.
            participants: {
              where: { leftAt: null },
              select: {
                id: true,
                participantType: true,
                userId: true,
                vendorId: true,
                employeeId: true,
                deliveryPersonId: true,
                ...(agentChatEnabled() ? { agentId: true } : {}),
                displayName: true,
                displayImage: true,
              },
            },
          },
        },
      },
      orderBy: [
        { isPinned: "desc" },
        { conversation: { lastMessageAt: "desc" } },
        { id: "desc" },
      ],
      take: limit,
    });
  }
 async getSupportQueue(params: {
  category: "USER_SUPPORT" | "VENDOR_SUPPORT" | "ALL";
  view: "UNASSIGNED" | "MINE" | "ALL";
  myEmployeeId?: string;
  status?: ConversationStatus;
  cursor?: string | null;
  limit?: number;
}) {
  const limit = Math.min(params.limit || 20, 50);
  const where: any = {
    type: params.category === "ALL" ? { in: ["VENDOR_SUPPORT", "USER_SUPPORT"] } : params.category,
    ...(params.status ? { status: params.status } : {}),
    ...getPrismaCursorFilter(params.cursor),
  };

  if (params.view === "UNASSIGNED") {
    where.assignments = { none: { isActive: true } };
  } else if (params.view === "MINE") {
    where.assignments = { some: { isActive: true, assigneeId: params.myEmployeeId } };
  }

  return prisma.conversation.findMany({
    where,
    include: {
      participants: { where: { leftAt: null } },
      assignments: { where: { isActive: true } },
    },
    orderBy: [{ priority: "desc" }, { lastMessageAt: "desc" }],
    take: limit,
  });
}
}

function getSenderFilter(type: ParticipantType, id: string) {
  return identityWhere(type, id, "employeeId"); // unknown → ADMIN / EMPLOYEE column
}
