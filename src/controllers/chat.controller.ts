// controllers/chat.controller.ts
import type { Request, Response } from 'express';
import type { CreateConversationPayload } from '../types/chat.ts';
import { chatService } from '../services/chat.service.ts';
import type { ParticipantType } from '@prisma/client';
import type { ChatSocket } from '../socket/chatSocket.ts';

// ── Module-level reference ──
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

  async getConversations(req: Request, res: Response) {
    try {
      const { page = 1, limit = 20, type } = req.query;
      const userType = toParticipantType(req.user.role);

      let result;
      if (type && type !== 'ALL') {
        result = await chatService.getUserConversationsByType(
          String(req.user.id),
          userType,
          String(type),
          Number(page),
          Number(limit)
        );
      } else {
        result = await chatService.getUserConversations(
          String(req.user.id),
          userType,
          Number(page),
          Number(limit)
        );
      }

      res.json(result);
    } catch (error) {
      console.error('getConversations error:', error);
      res.status(500).json({ error: 'Failed to get conversations' });
    }
  }

  async searchConversations(req: Request, res: Response) {
    try {
      const { q, page = 1, limit = 20 } = req.query;
      if (!q || typeof q !== 'string') {
        return res.status(400).json({ error: 'Search query "q" is required' });
      }

      const userType = toParticipantType(req.user.role);
      const result = await chatService.searchConversations(
        String(req.user.id),
        userType,
        q,
        Number(page),
        Number(limit)
      );

      res.json(result);
    } catch (error) {
      console.error('searchConversations error:', error);
      res.status(500).json({ error: 'Failed to search conversations' });
    }
  }

  async getConversation(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const conversation = await chatService.getConversationById(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      res.json(conversation);
    } catch (error) {
      console.error('getConversation error:', error);
      res.status(500).json({ error: 'Failed to get conversation' });
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

      if (chatSocketInstance) {
        chatSocketInstance
          .broadcastNewMessage(message, conversationId, String(req.user.id))
          .catch((err) => console.error('broadcastNewMessage failed:', err));
      } else {
        console.warn('⚠️  chatSocketInstance is null — real-time broadcast skipped');
      }

      res.status(201).json(message);
    } catch (error) {
      console.error('sendMessage error:', error);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }

  async getConversationMessages(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const { page = 1, limit = 50 } = req.query;
      const result = await chatService.getConversationMessages(
        conversationId,
        Number(page),
        Number(limit)
      );
      res.json(result);
    } catch (error) {
      console.error('getConversationMessages error:', error);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  }

  async markAsRead(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const userType = toParticipantType(req.user.role);
      const result = await chatService.markAsRead(
        conversationId,
        String(req.user.id),
        userType
      );

      if (chatSocketInstance) {
        chatSocketInstance
          .broadcastReadStatus(conversationId, String(req.user.id), userType)
          .catch((err) => console.error('broadcastReadStatus failed:', err));
      }

      res.json(result);
    } catch (error) {
      console.error('markAsRead error:', error);
      res.status(500).json({ error: 'Failed to mark as read' });
    }
  }

  async getUnreadCount(req: Request, res: Response) {
    try {
      const userType = toParticipantType(req.user.role);
      const result = await chatService.getUnreadCount(
        String(req.user.id),
        userType
      );
      res.json(result);
    } catch (error) {
      console.error('getUnreadCount error:', error);
      res.status(500).json({ error: 'Failed to get unread count' });
    }
  }

  async muteConversation(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const userType = toParticipantType(req.user.role);
      const conversation = await chatService.muteConversation(
        conversationId,
        String(req.user.id),
        userType
      );
      res.json(conversation);
    } catch (error) {
      console.error('muteConversation error:', error);
      res.status(500).json({ error: 'Failed to mute conversation' });
    }
  }

  async unmuteConversation(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const userType = toParticipantType(req.user.role);
      const conversation = await chatService.unmuteConversation(
        conversationId,
        String(req.user.id),
        userType
      );
      res.json(conversation);
    } catch (error) {
      console.error('unmuteConversation error:', error);
      res.status(500).json({ error: 'Failed to unmute conversation' });
    }
  }

  async leaveConversation(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const userType = toParticipantType(req.user.role);
      const result = await chatService.leaveConversation(
        conversationId,
        String(req.user.id),
        userType
      );
      res.json(result);
    } catch (error) {
      console.error('leaveConversation error:', error);
      res.status(500).json({ error: 'Failed to leave conversation' });
    }
  }
}

export const chatController = new ChatController();