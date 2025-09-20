import type { Request, Response } from 'express';
import type  { CreateConversationPayload } from '../types/chat.ts';
import { chatService } from '../services/chat.service.ts';

export class ChatController {
  async createConversation(req: Request, res: Response) {
    // console.log(req.body);
    // console.log(req.user);
    try {
      const payload: CreateConversationPayload = req.body;
      const userId = req.user.id;
      const userType = req.user.role as any;

      const conversation = await chatService.createConversation(payload, userId);
      res.status(201).json(conversation);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create conversation' });
    }
  }
// ✅ NEW: Find or create conversation
  async findOrCreateConversation(req: Request, res: Response) {
    try {
      const payload: CreateConversationPayload = req.body;
      const userId = req.user.id;

      const conversation = await chatService.findOrCreateConversation(payload, userId);
      res.status(200).json(conversation);
    } catch (error) {
      res.status(500).json({ error: 'Failed to open conversation' });
    }
  }
  async sendMessage(req: Request, res: Response) {
    
    try {
      const { conversationId, content } = req.body;
      const userId = req.user.id;
      const userType = req.user.role;

      const message = await chatService.sendMessage(
        conversationId,
        userId,
        userType,
        content
      );

      res.status(201).json(message);
    } catch (error) {
      console.log(error)
      res.status(500).json({ error: 'Failed to send message' });
    }
  }

  async getConversations(req: Request, res: Response) {

    try {
      const { page = 1, limit = 20 } = req.query;
      const userId = req.user.id;
      const userType = req.user.role;

      const conversations = await chatService.getUserConversations(
        userId,
        userType,
        Number(page),
        Number(limit)
      );

      res.json(conversations);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get conversations' });
    }
  }

  async getConversationMessages(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const { page = 1, limit = 50 } = req.query;

      const messages = await chatService.getConversationMessages(
        conversationId,
        Number(page),
        Number(limit)
      );

      res.json(messages);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get messages' });
    }
  }

  async markAsRead(req: Request, res: Response) {
    try {
      const { conversationId } = req.params;
      const userId = req.user.id;
      const userType = req.user.role;

      await chatService.markAsRead(conversationId, userId, userType);
      res.json({ message: 'Messages marked as read' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to mark as read' });
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
      res.status(500).json({ error: 'Failed to get conversation' });
    }
  }
}

export const chatController = new ChatController();