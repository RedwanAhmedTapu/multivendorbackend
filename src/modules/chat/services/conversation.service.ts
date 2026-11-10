import { prisma } from "../../../config/prisma.ts";
import {
  ConversationRepository,
  buildDedupeKey,
} from "../repositories/conversation.repository.ts";
import { encodeCursor } from "../utils/pagination.ts";
import { identityColumns, ownerIdOf } from "../utils/participant-resolver.ts";
import { agentChatEnabled, isAgentConversationType } from "../../agent/chat/agent-chat.config.ts";
import type { CreateConversationInput } from "../dto/create-conversation.dto.ts";
import type {
  ParticipantType,
  ConversationStatus,
  ConversationType,
} from "@prisma/client";
interface FindOrCreateParticipant {
  id: string;
  type: ParticipantType;
  displayName: string;
  displayImage?: string | null;
}
// services/conversation.service.ts

/** One support-queue row (shared by the queue and the staff "New chat" start). */
export function toSupportQueueItem(c: any) {
  const requester = c.participants.find(
    (p: any) => p.participantType === "VENDOR" || p.participantType === "CUSTOMER",
  );
  const supportParticipant = c.participants.find(
    (p: any) => p.participantType === "ADMIN" || p.participantType === "EMPLOYEE",
  );
  const requesterOwnerId = requester ? ownerIdOf(requester) : null;

  return {
    id: c.id,
    type: c.type,
    status: c.status,
    priority: c.priority,
    lastMessageAt: c.lastMessageAt,
    lastMessageText: c.lastMessageText,
    requester: requester && requesterOwnerId
      ? {
          id: requesterOwnerId,
          participantType: requester.participantType,
          displayName: requester.displayName,
          displayImage: requester.displayImage,
        }
      : null,
    assignedTo: c.assignments[0] ?? null,
    // ChatBox-এর myParticipantId হিসেবে দরকার — এই conversation-এ shared support
    // employee-র participant row। এটা ছাড়া reaction/read-receipt কাজ করবে না।
    supportParticipant: supportParticipant
      ? {
          id: supportParticipant.id,
          unreadCount: supportParticipant.unreadCount,
          isPinned: supportParticipant.isPinned,
          lastReadMessageId: supportParticipant.lastReadMessageId,
          userId: supportParticipant.userId,
          vendorId: supportParticipant.vendorId,
          employeeId: supportParticipant.employeeId,
          deliveryPersonId: supportParticipant.deliveryPersonId,
        }
      : null,
  };
}

export class ConversationService {
  private repo = new ConversationRepository();

 // modules/chat/services/conversation.service.ts
async findOrCreate(
  type: ConversationType,
  context: { productId?: string | null; orderId?: string | null },
  participants: FindOrCreateParticipant[],
) {
  if (!participants || participants.length < 2) {
    throw new Error("At least 2 participants required");
  }

  const participantIds = participants.map((p) => p.id);
  const dedupeKey = buildDedupeKey(type, context, participantIds);

  console.log("[findOrCreate] dedupeKey:", dedupeKey);

  let existing = await this.repo.findByDedupeKey(dedupeKey);

  // ✅ FALLBACK: unified vendor chat lookup (no productId filter)
  if (!existing && type === "PRODUCT_INQUIRY") {
    const customer = participants.find((p) => p.type === "CUSTOMER");
    const vendor   = participants.find((p) => p.type === "VENDOR");

    if (customer && vendor) {
      existing = await this.repo.findByParticipants(
        type,
        customer.id,
        vendor.id,
      );
    }
  }

  if (existing) {
    console.log("[findOrCreate] Found existing unified conversation:", existing.id);
    return existing;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const conv = await tx.conversation.create({
        data: {
          type,
          // ✅ Unified chat: don't tie to a specific product/order
          productId: type === "PRODUCT_INQUIRY" ? null : (context.productId ?? null),
          orderId:   type === "PRODUCT_INQUIRY" ? null : (context.orderId ?? null),
          dedupeKey,
          participants: {
            create: participants.map((p) => ({
              participantType: p.type,
              ...identityColumns(p.type, p.id),
              displayName: p.displayName,
              displayImage: p.displayImage,
            })),
          },
        },
        include: { participants: true },
      });

      await tx.conversationActivity.create({
        data: {
          conversationId: conv.id,
          activityType: "CREATED",
          metadata: { count: participants.length },
        },
      });

      return conv;
    });
  } catch (err: any) {
    if (err.code === "P2002" && err.meta?.target?.includes("dedupeKey")) {
      const winner = await this.repo.findByDedupeKey(dedupeKey);
      if (winner) return winner;
    }
    throw err;
  }
}

  // ✅ NEW: Get or create for product inquiry (specialized endpoint)
  async getProductInquiryConversation(
    productId: string,
    customer: FindOrCreateParticipant,
    vendor: FindOrCreateParticipant,
  ) {
    return this.findOrCreate("PRODUCT_INQUIRY", { productId }, [
      customer,
      vendor,
    ]);
  }

  async create(data: CreateConversationInput) {
    return prisma.$transaction(async (tx) => {
      const conv = await tx.conversation.create({
        data: {
          type: data.type,
          productId: data.productId,
          orderId: data.orderId,
          title: data.title,
          participants: {
            create: data.participantIds.map((p) => ({
              participantType: p.type,
              ...identityColumns(p.type, p.id),
              displayName: p.displayName,
              displayImage: p.displayImage,
            })),
          },
        },
        include: { participants: true },
      });

      await tx.conversationActivity.create({
        data: {
          conversationId: conv.id,
          activityType: "CREATED",
          metadata: { count: data.participantIds.length },
        },
      });

      return conv;
    });
  }

  async getUserList(
    ownerId: string,
    ownerType: ParticipantType,
    params: { cursor?: string; limit?: number; status?: ConversationStatus },
  ) {
    const fetched = await this.repo.getUserConversations(
      ownerId,
      ownerType,
      params,
    );
    // P10: agent conversations are invisible while the feature is off.
    const rows = agentChatEnabled() ? fetched : fetched.filter((r) => !isAgentConversationType(r.conversation.type));
    const limit = Math.min(params.limit || 20, 50);

    // FIX: shape each row into what the frontend's ChatConversationParticipant
    // type expects — in particular, resolve otherParticipant by taking the
    // sibling participants the repository now fetches and excluding "me".
    // This is the piece the chat list / chat box grouping and display logic
    // depends on entirely.
    const data = rows.map((row) => {
      const others = row.conversation.participants.filter(
        (p) => p.id !== row.id,
      );

      // For 1:1 conversations there's exactly one other participant. For
      // group-style conversations (e.g. DELIVERY_CHAT with a rider + support),
      // pick the first non-self participant as the "headline" counterpart —
      // good enough for list display; anyone needing the full roster should
      // fetch conversation details, not the list endpoint.
      const other = others[0] ?? null;
      const otherOwnerId = other ? ownerIdOf(other) : null;

      return {
        id: row.id,
        unreadCount: row.unreadCount,
        isPinned: row.isPinned,
        lastReadMessageId: row.lastReadMessageId,
        userId: row.userId,
        vendorId: row.vendorId,
        employeeId: row.employeeId,
        deliveryPersonId: row.deliveryPersonId,
        otherParticipant:
          other && otherOwnerId
            ? {
                id: otherOwnerId,
                participantType: other.participantType,
                displayName: other.displayName,
                displayImage: other.displayImage,
              }
            : null,
        conversation: {
          id: row.conversation.id,
          type: row.conversation.type,
          status: row.conversation.status,
          title: row.conversation.title,
          lastMessageAt: row.conversation.lastMessageAt,
          lastMessageText: row.conversation.lastMessageText,
          lastMessageType: row.conversation.lastMessageType,
          lastSenderId: row.conversation.lastSenderId,
          lastSenderType: row.conversation.lastSenderType,
          priority: row.conversation.priority,
          // P10: only agent conversations carry their vendor-link id
          ...(isAgentConversationType(row.conversation.type) ? { agentLinkId: (row.conversation as any).agentLinkId ?? null } : {}),
        },
      };
    });

    return {
      data,
      // FIX: lastMessageAt can be null for a brand-new conversation with no
      // messages yet — encodeCursor(...!) would throw on that row. Fall back
      // to the conversation's createdAt-equivalent (epoch) so pagination
      // doesn't crash on empty conversations.
      nextCursor:
        rows.length === limit
          ? encodeCursor(
              rows[rows.length - 1].conversation.lastMessageAt ?? new Date(0),
              rows[rows.length - 1].id,
            )
          : null,
      hasMore: rows.length === limit,
    };
  }

  async updateStatus(
    conversationId: string,
    status: ConversationStatus,
    performedBy: string,
  ) {
    const conv = await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status,
        closedAt:
          status === "CLOSED" || status === "ARCHIVED" ? new Date() : null,
      },
    });
    await prisma.conversationActivity.create({
      data: {
        conversationId,
        activityType: "STATUS_CHANGED",
        performedBy,
        newValue: status,
      },
    });
    return conv;
  }

  // Admin Support Features
  async assign(
    conversationId: string,
    assigneeId: string,
    assigneeType: ParticipantType,
    assignedBy: string,
    note?: string,
  ) {
    await prisma.conversationAssignment.updateMany({
      where: { conversationId, isActive: true },
      data: { isActive: false, unassignedAt: new Date() },
    });
    const assignment = await prisma.conversationAssignment.create({
      data: {
        conversationId,
        assigneeId,
        assigneeType,
        assignedBy: assignedBy,
        note,
      },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { status: "ASSIGNED" },
    });
    return assignment;
  }

  async addLabel(
    conversationId: string,
    label: string,
    color: string,
    addedBy: string,
  ) {
    return prisma.conversationLabel.create({
      data: {
        conversationId,
        label,
        color,
        addedBy: addedBy,
        addedByType: "EMPLOYEE",
      },
    });
  }

  async addNote(conversationId: string, authorId: string, content: string) {
    return prisma.conversationNote.create({
      data: { conversationId, authorId, authorType: "EMPLOYEE", content },
    });
  }
 async getSupportQueue(
  category: "USER_SUPPORT" | "VENDOR_SUPPORT" | "ALL",
  view: "UNASSIGNED" | "MINE" | "ALL",
  myEmployeeId: string,
  params: { status?: ConversationStatus; cursor?: string; limit?: number },
) {
  const rows = await this.repo.getSupportQueue({ category, view, myEmployeeId, ...params });

  return rows.map(toSupportQueueItem);
}
}
