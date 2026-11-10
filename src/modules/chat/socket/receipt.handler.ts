import { Socket } from "socket.io";
import { prisma } from "../../../config/prisma.ts";
import { ReadReceiptService } from "../services/read-receipt.service.ts";
import { actorFrom, getConversationAccess } from "../utils/chat-access.ts";

// Phase 0: a delivered/seen receipt is recorded for the AUTHENTICATED actor's
// own participant row only, and only for a message of that conversation. The
// participant / user ids a client sends are ignored.
export function handleReceipts(socket: Socket) {
  const readService = new ReadReceiptService();

  socket.on("message:delivered", async (data: { conversationId?: unknown; messageId?: unknown }) => {
    try {
      const actor = actorFrom(socket.data?.user);
      const { conversationId, messageId } = data ?? {};
      if (!actor || typeof conversationId !== "string" || typeof messageId !== "string") return;
      const access = await getConversationAccess(conversationId, actor);
      if (!access?.participant) return; // support staff without a participant row have no receipt to move
      const message = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
      if (message?.conversationId !== conversationId) return;
      await readService.markAsRead(conversationId, access.participant.id, messageId, actor.id);
    } catch {
      // receipts are best-effort; never crash the socket
    }
  });
}
