// socket/chatSocket.ts
import { Server, Socket } from 'socket.io';
import { authenticateSocket } from '../middlewares/socketAuth.ts';
import { chatService } from '../services/chat.service.ts';
import type { ParticipantType } from '@prisma/client';

// ── Role → ParticipantType ─────────────────────────────────────────────────────
function toParticipantType(role: string): ParticipantType {
  const map: Record<string, ParticipantType> = {
    USER:            'CUSTOMER',
    CUSTOMER:        'CUSTOMER',
    VENDOR:          'VENDOR',
    VENDOR_ADMIN:    'VENDOR',
    ADMIN:           'ADMIN',
    EMPLOYEE:        'EMPLOYEE',
    DELIVERY:        'DELIVERY',
    DELIVERY_PERSON: 'DELIVERY',
  };
  const upper  = role?.toUpperCase();
  const mapped = map[upper];
  if (!mapped) {
    console.warn(`[ChatSocket] Unknown role "${role}" — defaulting to CUSTOMER`);
    return 'CUSTOMER';
  }
  return mapped;
}

interface SocketUser {
  userId:   string;
  socketId: string;
  userType: string;
  name:     string;
}

interface AuthenticatedSocket extends Socket {
  data: {
    user: { id: string; role: string; name: string; email: string };
  };
}

export class ChatSocket {
  private io:             Server;
  private connectedUsers: Map<string, SocketUser> = new Map();

  constructor(io: Server) {
    this.io = io;
    this.setupSocket();
  }

  // ── Called by ChatController.sendMessage() after saving to DB ────────────────
  public async broadcastNewMessage(
    savedMessage: any,
    conversationId: string,
    senderId: string
  ) {
    // 1. Push to every socket currently in the conversation room
    this.io
      .to(`conversation_${conversationId}`)
      .emit('new_message', savedMessage);

    // 2. Update each participant's personal room (sidebar unread badge)
    try {
      const conversation = await chatService.getConversationById(conversationId);
      if (!conversation?.participants) return;

      for (const participant of conversation.participants) {
        const participantId =
          participant.userId           ??
          participant.vendorId         ??
          participant.employeeId       ??
          participant.deliveryPersonId;

        if (!participantId || participantId === senderId) continue;

        this.io.to(`user_${participantId}`).emit('new_conversation_message', {
          conversationId,
          lastMessageText: savedMessage.content,
          lastMessageAt:   savedMessage.createdAt,
          senderId,
        });

        // Mark delivered if the recipient is online right now
        if (this.connectedUsers.has(participantId)) {
          const delivered = await chatService.markMessageDelivered(
            savedMessage.id,
            new Date()
          );
          this.io.to(`user_${participantId}`).emit('message_delivered', {
            messageId:   savedMessage.id,
            conversationId,
            deliveredAt: delivered.deliveredAt,
          });
        }
      }
    } catch (err) {
      console.error('[ChatSocket] broadcastNewMessage error:', err);
    }
  }

  private setupSocket() {
    this.io.use(authenticateSocket);

    this.io.on('connection', (socket: AuthenticatedSocket) => {
      const user = socket.data.user;

      console.log(
        `[ChatSocket] connected: id=${user.id} name=${user.name} role=${user.role}`
      );

      this.connectedUsers.set(user.id, {
        userId:   user.id,
        socketId: socket.id,
        userType: user.role,
        name:     user.name,
      });

      // Personal room — targeted events (unread badge updates, delivery receipts)
      socket.join(`user_${user.id}`);

      // Auto-join all existing conversation rooms immediately on connect
      const participantType = toParticipantType(user.role);
      this.joinUserConversations(socket, user.id, participantType).catch(console.error);

      this.io.emit('user_online', { userId: user.id });
      socket.emit('connected', {
        message:  'Connected',
        userId:   user.id,
        userName: user.name,
      });

      // ── join_conversation ──────────────────────────────────────────────────
      socket.on('join_conversation', (data) => {
        const { conversationId } = data || {};
        if (!conversationId) return;
        socket.join(`conversation_${conversationId}`);
        console.log(`[ChatSocket] ${user.id} joined room conversation_${conversationId}`);
      });

      // ── leave_conversation ─────────────────────────────────────────────────
      socket.on('leave_conversation', (data) => {
        const { conversationId } = data || {};
        if (!conversationId) return;
        socket.leave(`conversation_${conversationId}`);
      });

      // ── send_message (socket fallback — primary path is HTTP) ──────────────
      socket.on('send_message', async (data) => {
        try {
          const { conversationId, content } = data || {};
          if (!conversationId || !content?.trim()) {
            socket.emit('error', { message: 'Invalid message data' });
            return;
          }
          const senderType   = toParticipantType(user.role);
          const savedMessage = await chatService.sendMessage(
            conversationId, user.id, senderType, content.trim()
          );
          await this.broadcastNewMessage(savedMessage, conversationId, user.id);
        } catch (err: any) {
          console.error('[ChatSocket] send_message error:', err);
          socket.emit('error', { message: 'Failed to send message', details: err?.message });
        }
      });

      // ── user_typing ────────────────────────────────────────────────────────
      socket.on('user_typing', (data) => {
        const { conversationId } = data || {};
        if (!conversationId) return;
        socket.to(`conversation_${conversationId}`).emit('user_typing', {
          conversationId, userId: user.id, userName: user.name,
        });
      });

      // ── user_stop_typing ───────────────────────────────────────────────────
      socket.on('user_stop_typing', (data) => {
        const { conversationId } = data || {};
        if (!conversationId) return;
        socket.to(`conversation_${conversationId}`).emit('user_stop_typing', {
          conversationId, userId: user.id,
        });
      });

      // ── mark_read ──────────────────────────────────────────────────────────
      socket.on('mark_read', async (data) => {
        try {
          const { conversationId } = data || {};
          if (!conversationId) return;
          const userType   = toParticipantType(user.role);
          const seenResult = await chatService.markMessagesAsSeen(
            conversationId, user.id, userType, new Date()
          );
          this.io.to(`conversation_${conversationId}`).emit('message_seen', {
            conversationId,
            seenBy: { id: user.id, name: user.name, role: user.role },
            seenAt: seenResult.seenAt,
          });
        } catch (err) {
          console.error('[ChatSocket] mark_read error:', err);
        }
      });

      // ── disconnect ─────────────────────────────────────────────────────────
      socket.on('disconnect', () => {
        this.connectedUsers.delete(user.id);
        this.io.emit('user_offline', { userId: user.id });
        console.log(`[ChatSocket] disconnected: ${user.id}`);
      });
    });
  }

  // ── Auto-join all conversation rooms on connect ───────────────────────────────
  private async joinUserConversations(
    socket:   AuthenticatedSocket,
    userId:   string,
    userType: ParticipantType
  ) {
    try {
      console.log(`[ChatSocket] fetching conversations for ${userType} ${userId}…`);
      const conversations = await chatService.getUserConversations(userId, userType);

      if (conversations.length === 0) {
        console.log(
          `[ChatSocket] ${userType} ${userId} has 0 conversations in DB. ` +
          `Normal for a new user — they will join rooms via join_conversation events.`
        );
        return;
      }

      for (const conv of conversations) {
        socket.join(`conversation_${conv.id}`);
      }

      console.log(
        `✅ ${userType} ${userId} joined ${conversations.length} conversation room(s):`,
        conversations.map(c => c.id)
      );
    } catch (err) {
      console.error('[ChatSocket] joinUserConversations error:', err);
    }
  }
}