// routes/chat.routes.ts
import { authenticateUser } from '../middlewares/auth.middleware.ts';
import { chatController } from '../controllers/chat.controller.ts';
import { Router } from 'express';

const router = Router();
router.use(authenticateUser);

// ✅ Static routes MUST come before parameterised ones.
// `/conversations/find-or-create` must be above `/:conversationId`
// otherwise Express captures "find-or-create" as the conversationId param.
router.post('/conversations/find-or-create', chatController.findOrCreateConversation.bind(chatController));

router.post('/conversations',                             chatController.createConversation.bind(chatController));
router.get('/conversations',                              chatController.getConversations.bind(chatController));
router.get('/conversations/:conversationId',              chatController.getConversation.bind(chatController));

router.post('/messages',                                  chatController.sendMessage.bind(chatController));
router.get('/conversations/:conversationId/messages',     chatController.getConversationMessages.bind(chatController));
router.patch('/conversations/:conversationId/read',       chatController.markAsRead.bind(chatController));

export default router;