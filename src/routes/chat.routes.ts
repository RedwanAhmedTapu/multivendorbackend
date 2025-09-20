import { authenticateUser } from '../middlewares/auth.middleware.ts';
import { chatController } from '../controllers/chat.controller.ts';
import { Router } from 'express';

const router = Router();

// All routes require authentication
router.use(authenticateUser);

// Conversation routes
router.post('/conversations', chatController.createConversation);
router.get('/conversations', chatController.getConversations);
router.get('/conversations/:conversationId', chatController.getConversation);
// routes/chat.routes.ts
router.post('/conversations/find-or-create', chatController.findOrCreateConversation);

// Message routes
router.post('/messages', chatController.sendMessage);
router.get('/conversations/:conversationId/messages', chatController.getConversationMessages);
router.patch('/conversations/:conversationId/read', chatController.markAsRead);

export default router;