// controllers/chat.controller.ts
import type { Request, Response } from 'express';
import type { CreateConversationPayload } from '../types/chat.ts';
import { chatService } from '../services/chat.service.ts';
import type { ParticipantType } from '@prisma/client';
// ✅ FIX: use a top-level type import instead of an inline dynamic import
import type { ChatSocket } from '../socket/chatSocket.ts';

// ── Module-level reference set once by server.ts after ChatSocket is created ──
// Previously this was always null because server.ts did `new ChatSocket(io)`
// without capturing the return value, so setChatSocket() was never called.
let chatSocketInstance: ChatSocket | null = null;

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
  const mapped = map[role?.toUpperCase()];
  if (!mapped) throw new Error(`Unknown role: ${role}`);
  return mapped;
}

export class ChatController {
  // ── Called once from server.ts immediately after `new ChatSocket(io)` ────────
  setChatSocket(instance: ChatSocket) {
    chatSocketInstance = instance;
    console.log('✅ ChatSocket instance registered in ChatController');
  }

  async createConversation(req: Request, res: Response) {
    try {
      const payload: CreateConversationPayload = req.body;
      const conversation = await chatService.createConversation(
        payload,
        String(req.user.id)
      );
      res.status(201).json(conversation);
    } catch (error) {
      console.error('createConversation error:', error);
      res.status(500).json({ error: 'Failed to create conversation' });
    }
  }

  async findOrCreateConversation(req: Request, res: Response) {
    try {
      const payload: CreateConversationPayload = req.body;
      const conversation = await chatService.findOrCreateConversation(
        payload,
        String(req.user.id)
      );
      res.status(200).json(conversation);
    } catch (error) {
      console.error('findOrCreateConversation error:', error);
      res.status(500).json({ error: 'Failed to open conversation' });
    }
  }

  async sendMessage(req: Request, res: Response) {
    try {
      const { conversationId, content } = req.body;

      if (!conversationId || !content?.trim()) {
        return res.status(400).json({ error: 'conversationId and content are required' });
      }

      const senderType = toParticipantType(req.user.role);

      const message = await chatService.sendMessage(
        conversationId,
        String(req.user.id),
        senderType,
        content.trim()
      );

      // ✅ FIX: chatSocketInstance is now always set (wired in server.ts),
      //    so this broadcast fires for every HTTP-sent message and the vendor
      //    receives the `new_message` socket event in real time.
      if (chatSocketInstance) {
        chatSocketInstance
          .broadcastNewMessage(message, conversationId, String(req.user.id))
          .catch((err) => console.error('broadcastNewMessage failed:', err));
      } else {
        // This should never happen after the server.ts fix, but log it just in case
        console.warn('⚠️  chatSocketInstance is null — real-time broadcast skipped');
      }

      res.status(201).json(message);
    } catch (error) {
      console.error('sendMessage error:', error);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }

  async getConversations(req: Request, res: Response) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const userType = toParticipantType(req.user.role);
      const data = await chatService.getUserConversations(
        String(req.user.id),
        userType,
        Number(page),
        Number(limit)
      );
      res.json({
        data,
        pagination: {
          page:  Number(page),
          limit: Number(limit),
          total: data.length,
          pages: 1,
        },
      });
    } catch (error) {
      console.error('getConversations error:', error);
      res.status(500).json({ error: 'Failed to get conversations' });
    }
  }

  async getConversationMessages(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const { page = 1, limit = 50 } = req.query;
      const data = await chatService.getConversationMessages(
        conversationId,
        Number(page),
        Number(limit)
      );
      res.json({
        data,
        pagination: {
          page:  Number(page),
          limit: Number(limit),
          total: data.length,
          pages: 1,
        },
      });
    } catch (error) {
      console.error('getConversationMessages error:', error);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  }

  async markAsRead(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const userType = toParticipantType(req.user.role);
      await chatService.markAsRead(
        conversationId,
        String(req.user.id),
        userType
      );
      res.json({ message: 'Messages marked as read' });
    } catch (error) {
      console.error('markAsRead error:', error);
      res.status(500).json({ error: 'Failed to mark as read' });
    }
  }

  async getConversation(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const conversation = await chatService.getConversationById(conversationId);
      if (!conversation)
        return res.status(404).json({ error: 'Conversation not found' });
      res.json(conversation);
    } catch (error) {
      console.error('getConversation error:', error);
      res.status(500).json({ error: 'Failed to get conversation' });
    }
  }
}

export const chatController = new ChatController();