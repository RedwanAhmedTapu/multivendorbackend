// socket/chatSocket.ts
import type { Server, Socket } from "socket.io";
import type { ParticipantType } from "@prisma/client";
import { chatService } from "../services/chat.service.ts";

// ── Types ──────────────────────────────────────────────────────

interface AuthenticatedSocket extends Socket {
  id: string;
  data: {
    user?: {
      id: string;
      rawId: string;
      role: string;
      email: string | null;
      name: string;
      vendorId?: string;
    };
  };
}

interface ConversationRoom {
  conversationId: string;
  participantSockets: Map<string, Set<string>>;
}

// ── Helper ─────────────────────────────────────────────────────

function toParticipantType(role: string): ParticipantType {
  const map: Record<string, ParticipantType> = {
    USER:            "CUSTOMER",
    CUSTOMER:        "CUSTOMER",
    VENDOR:          "VENDOR",
    VENDOR_ADMIN:    "VENDOR",
    ADMIN:           "ADMIN",
    EMPLOYEE:        "EMPLOYEE",
    DELIVERY:        "DELIVERY",
    DELIVERY_PERSON: "DELIVERY",
  };
  const mapped = map[role?.toUpperCase()];
  if (!mapped) throw new Error(`Unknown role: ${role}`);
  return mapped;
}

// ── ChatSocket Class ───────────────────────────────────────────

export class ChatSocket {
  private io: Server;
  private conversationRooms: Map<string, ConversationRoom> = new Map();

  constructor(io: Server) {
    this.io = io;
    this.registerMiddleware();
    this.registerHandlers();
    console.log("✅ ChatSocket initialized");
  }

  // ── Middleware ───────────────────────────────────────────────
  private registerMiddleware() {
    this.io.use((socket: AuthenticatedSocket, next) => {
      const user = socket.data?.user;
      if (!user?.id) {
        return next(new Error("Authentication required"));
      }
      next();
    });
  }

  // ── Handlers ─────────────────────────────────────────────────
  private registerHandlers() {
    this.io.on("connection", (socket: AuthenticatedSocket) => {
      const user = socket.data.user!;

      console.log(
        `[ChatSocket] Connected: ${user.name} (${user.role}) ` +
        `socket=${socket.id} userId=${user.id}`
      );

      // ✅ FIX: Join a personal room so broadcasts can find this socket
      //     even when they're NOT in a specific conversation room
      socket.join(`user:${user.id}`);

      // Join all existing conversation rooms on connect
      this.joinUserConversations(socket, user).catch((err) => {
        console.error("[ChatSocket] Error joining conversations on connect:", err);
      });

      // Join a specific conversation room
      socket.on("join_conversation", async (conversationId: string) => {
        try {
          await this.joinConversationRoom(socket, conversationId, user.id);

          const result = await chatService.getConversationMessages(
            conversationId,
            1,
            20
          );

          socket.emit("conversation_history", {
            conversationId,
            messages: result.data,
          });
        } catch (err) {
          console.error("[ChatSocket] join_conversation error:", err);
        }
      });

      // Leave a specific conversation room
      socket.on("leave_conversation", (conversationId: string) => {
        this.leaveConversationRoom(socket, conversationId, user.id);
      });

      // Send a message via socket
      socket.on(
        "send_message",
        async (data: { conversationId: string; content: string }) => {
          try {
            if (!data.conversationId || !data.content?.trim()) return;

            const senderType = toParticipantType(user.role);
            const message = await chatService.sendMessage(
              data.conversationId,
              user.id,
              senderType,
              data.content.trim()
            );

            await this.broadcastNewMessage(
              message,
              data.conversationId,
              user.id
            );
          } catch (err) {
            console.error("[ChatSocket] send_message error:", err);
            socket.emit("error", { message: "Failed to send message" });
          }
        }
      );

      // Mark messages as read via socket
      socket.on("mark_read", async (conversationId: string) => {
        try {
          if (!conversationId) return;

          const senderType = toParticipantType(user.role);
          await chatService.markAsRead(conversationId, user.id, senderType);

          this.io.to(`conversation:${conversationId}`).emit("messages_read", {
            conversationId,
            readBy: user.id,
            readByType: senderType,
            readAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error("[ChatSocket] mark_read error:", err);
        }
      });

      // Typing indicator
      socket.on(
        "typing",
        (data: { conversationId: string; isTyping: boolean }) => {
          socket
            .to(`conversation:${data.conversationId}`)
            .emit("user_typing", {
              conversationId: data.conversationId,
              userId: user.id,
              userName: user.name,
              isTyping: data.isTyping,
            });
        }
      );

      // Disconnect
      socket.on("disconnect", () => {
        console.log(
          `[ChatSocket] Disconnected: ${user.name} (${user.role}) socket=${socket.id}`
        );
        this.removeSocketFromAllRooms(socket.id);
      });
    });
  }

  // ── Join all conversations the user belongs to ───────────────
  async joinUserConversations(socket: AuthenticatedSocket, user: any) {
    try {
      const senderType = toParticipantType(user.role);
      const result = await chatService.getUserConversations(
        user.id,
        senderType,
        1,
        500
      );

      for (const conv of result.data) {
        await this.joinConversationRoom(socket, conv.id, user.id);
      }

      console.log(
        `[ChatSocket] ${user.name} joined ${result.data.length} conversation rooms`
      );
    } catch (err) {
      console.error("[ChatSocket] joinUserConversations error:", err);
    }
  }

  // ── Join a single conversation room ─────────────────────────
  private async joinConversationRoom(
    socket: AuthenticatedSocket,
    conversationId: string,
    userId: string
  ) {
    const roomName = `conversation:${conversationId}`;

    if (!this.conversationRooms.has(conversationId)) {
      this.conversationRooms.set(conversationId, {
        conversationId,
        participantSockets: new Map(),
      });
    }

    const room = this.conversationRooms.get(conversationId)!;

    if (!room.participantSockets.has(userId)) {
      room.participantSockets.set(userId, new Set());
    }
    room.participantSockets.get(userId)!.add(socket.id);

    await socket.join(roomName);
  }

  // ── Leave a single conversation room ────────────────────────
  private leaveConversationRoom(
    socket: AuthenticatedSocket,
    conversationId: string,
    userId: string
  ) {
    const roomName = `conversation:${conversationId}`;
    socket.leave(roomName);

    const room = this.conversationRooms.get(conversationId);
    if (room) {
      room.participantSockets.get(userId)?.delete(socket.id);

      if (room.participantSockets.get(userId)?.size === 0) {
        room.participantSockets.delete(userId);
      }

      if (room.participantSockets.size === 0) {
        this.conversationRooms.delete(conversationId);
      }
    }
  }

  // ── Remove socket from all rooms on disconnect ───────────────
  private removeSocketFromAllRooms(socketId: string) {
    for (const [convId, room] of this.conversationRooms.entries()) {
      for (const [userId, socketIds] of room.participantSockets.entries()) {
        if (socketIds.has(socketId)) {
          socketIds.delete(socketId);
          if (socketIds.size === 0) {
            room.participantSockets.delete(userId);
          }
        }
      }
      if (room.participantSockets.size === 0) {
        this.conversationRooms.delete(convId);
      }
    }
  }

  // ── Broadcast new message ───────────────────────────────────
  async broadcastNewMessage(
    message: any,
    conversationId: string,
    senderId: string
  ) {
    const roomName = `conversation:${conversationId}`;

    // Emit to everyone in the conversation room
    this.io.to(roomName).emit("new_message", message);

    // Emit to participant sockets NOT in the room (for list updates)
    const convData = await chatService.getConversationById(conversationId);
    if (convData) {
      for (const p of convData.participants) {
        const participantUserId =
          p.userId || p.vendorId || p.employeeId || p.deliveryPersonId;
        if (participantUserId && participantUserId !== senderId) {
          const userRoom = `user:${participantUserId}`;
          const userRoomSockets = this.io.sockets.adapter.rooms.get(userRoom);
          if (userRoomSockets) {
            for (const sid of userRoomSockets) {
              const sock = this.io.sockets.sockets.get(sid);
              if (sock && !sock.rooms.has(roomName)) {
                sock.emit("new_conversation_message", {
                  conversationId,
                  lastMessageText: message.content,
                  lastMessageAt: message.createdAt,
                  senderId,
                  senderType: message.senderType,
                });
              }
            }
          }
        }
      }
    }
  }

  // ── Broadcast read status ───────────────────────────────────
  async broadcastReadStatus(
    conversationId: string,
    readBy: string,
    readByType: ParticipantType
  ) {
    const roomName = `conversation:${conversationId}`;

    this.io.to(roomName).emit("messages_read", {
      conversationId,
      readBy,
      readByType,
      readAt: new Date().toISOString(),
    });
  }

  // ── Utility: online participants ────────────────────────────
  getOnlineParticipants(conversationId: string): string[] {
    const room = this.conversationRooms.get(conversationId);
    if (!room) return [];
    return Array.from(room.participantSockets.keys());
  }

  isUserOnlineInConversation(
    conversationId: string,
    userId: string
  ): boolean {
    const room = this.conversationRooms.get(conversationId);
    if (!room) return false;
    const sockets = room.participantSockets.get(userId);
    return !!sockets && sockets.size > 0;
  }

  getConnectedCount(): number {
    return this.io.sockets.sockets.size;
  }
}