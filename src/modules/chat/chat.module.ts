import { Router } from "express";
import { Server } from "socket.io";
import chatmediaRoutes from "./routes/media.routes.ts";
import conversationRoutes from "./routes/conversation.routes.ts";
import messageRoutes from "./routes/message.routes.ts";
import quickReplyRoutes from "./routes/quick-reply.routes.ts";
import autoReplyRoutes from "./routes/auto-reply.routes.ts";
import notificationRoutes from "./routes/notification.routes.ts";
import readReceiptRoutes from "./routes/read-receipt.routes.ts";
import { initChatSocket } from "./socket/chat.handler.ts";
import { handleTyping } from "./socket/typing.handler.ts";
import { handlePresence } from "./socket/presence.handler.ts";
import { handleReceipts } from "./socket/receipt.handler.ts";
import { chatSocketAuth, chatSocketSession } from "./socket/socket-auth.ts";

export function setupChatModule(io: Server): Router {
  const router = Router();

  // REST API Routes
  router.use("/media", chatmediaRoutes);
  router.use("/conversations", conversationRoutes);
  router.use("/messages", messageRoutes);
  router.use("/quick-replies", quickReplyRoutes);
  router.use("/auto-replies", autoReplyRoutes);
  router.use("/notifications", notificationRoutes);
  router.use("/read-receipts", readReceiptRoutes);

  // Socket.io Setup
  // Phase 0: every connection must carry a valid access token, verified with
  // the same rules as the HTTP API; handlers trust only socket.data.user.
  io.use(chatSocketAuth);
  // Phase 3: the connection stays authorized only while its token and user are valid.
  io.on("connection", chatSocketSession);
  initChatSocket(io);
  
  io.on("connection", (socket) => {
    handlePresence(io, socket);
    handleTyping(io, socket);
    handleReceipts(socket);
  });

  return router;
}

// Export services for use in other parts of the app if needed
export { ConversationService } from "./services/conversation.service.ts";
export { MessageService } from "./services/message.service.ts";
export { AutoReplyService } from "./services/auto-reply.service.ts";