// sockets/ChatSocket.ts
import { Server, Socket } from 'socket.io';
import { authenticateSocket } from '../middlewares/socketAuth.ts';
import { chatService } from '../services/chat.service.ts';

interface SocketUser {
  userId: string;
  socketId: string;
  userType: string;
  name: string;
}

interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      id: string;
      role: string;
      name: string;
      email: string;
    };
  };
}

export class ChatSocket {
  private io: Server;
  private connectedUsers: Map<string, SocketUser> = new Map();

  constructor(io: Server) {
    this.io = io;
    this.setupSocket();
  }

  private setupSocket() {
    this.io.use(authenticateSocket);

    this.io.on('connection', (socket: AuthenticatedSocket) => {
      const user = socket.data.user;
      this.connectedUsers.set(user.id, {
        userId: user.id,
        socketId: socket.id,
        userType: user.role,
        name: user.name,
      });

      socket.join(`user_${user.id}`);
      this.joinUserConversations(socket, user.id, user.role).catch(console.error);

      // Join room
      socket.on('join_conversation', (data) => {
        const { conversationId } = data || {};
        if (conversationId) socket.join(`conversation_${conversationId}`);
      });

      socket.on('leave_conversation', (data) => {
        const { conversationId } = data || {};
        if (conversationId) socket.leave(`conversation_${conversationId}`);
      });

      // Send message
      socket.on('send_message', async (data) => {
        try {
          const { conversationId, content } = data || {};
          if (!conversationId || !content?.trim()) {
            socket.emit('error', { message: 'Invalid message data' });
            return;
          }

          // Persist message (status: SENT)
          const savedMessage = await chatService.sendMessage(
            conversationId,
            user.id,
            user.role,
            content.trim()
          );

          // Broadcast new_message to conversation room
          this.io.to(`conversation_${conversationId}`).emit('new_message', savedMessage);

          // For each participant, if online, mark as delivered for that participant
          const conversation = await chatService.getConversationById(conversationId);
          if (conversation && conversation.participants) {
            for (const participant of conversation.participants) {
              const participantId =
                participant.userId || participant.vendorId || participant.employeeId || participant.deliveryPersonId;
              if (participantId && participantId !== user.id) {
                const userSocket = this.connectedUsers.get(participantId);
                if (userSocket) {
                  // mark message as delivered (server-level deliveredAt)
                  const deliveredMessage = await chatService.markMessageDelivered(savedMessage.id, new Date());
                  // notify specific user and conversation
                  this.io.to(`user_${participantId}`).emit('message_delivered', {
                    messageId: savedMessage.id,
                    conversationId,
                    deliveredAt: deliveredMessage.deliveredAt,
                  });
                }
              }
            }
          }
        } catch (err) {
          console.error('Error in send_message handler:', err);
          socket.emit('error', { message: 'Failed to send message', details: err?.message });
        }
      });

      // Handle mark_read (client marks conversation read)
      socket.on('mark_read', async (data) => {
        try {
          const { conversationId } = data || {};
          if (!conversationId) return;
          // Update DB: set seenAt for unread messages in conversation for this user
          const seenResult = await chatService.markMessagesAsSeen(conversationId, user.id, user.role, new Date());

          if (seenResult && seenResult.updatedMessageIds?.length) {
            // Broadcast to conversation that these messages were seen by this user
            this.io.to(`conversation_${conversationId}`).emit('message_seen', {
              conversationId,
              seenBy: { id: user.id, name: user.name, role: user.role },
              messageIds: seenResult.updatedMessageIds,
              seenAt: seenResult.seenAt,
            });
          }
        } catch (err) {
          console.error('Error in mark_read:', err);
        }
      });

      socket.on('disconnect', (reason) => {
        this.connectedUsers.delete(user.id);
      });

      socket.emit('connected', { message: 'Connected', userId: user.id, userName: user.name });
    });
  }

  private async joinUserConversations(socket: AuthenticatedSocket, userId: string, userType: string) {
    try {
      const conversations = await chatService.getUserConversations(userId, userType);
      for (const conversation of conversations) {
        socket.join(`conversation_${conversation.id}`);
      }
    } catch (err) {
      console.error('joinUserConversations error', err);
    }
  }
}
