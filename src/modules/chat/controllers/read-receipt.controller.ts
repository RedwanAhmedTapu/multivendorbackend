import type { Request, Response } from "express";
import { ReadReceiptService } from "../services/read-receipt.service.ts";
import { MessageRepository } from "../repositories/message.repository.ts";
import { prisma } from "../../../config/prisma.ts";

const readService = new ReadReceiptService();
const messageRepo = new MessageRepository();

export async function markAsRead(req: Request, res: Response) {
  try {
    const { conversationId, messageId } = req.body;
    const userId = req.user?.id;
    const userType = req.user?.type || req.user?.role;

    if (!conversationId || !messageId || !userId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Resolve the internal participant ID for this user in this conversation
    const participantId = await messageRepo.getParticipantId(conversationId, userId, userType!);
    
    if (!participantId) {
      return res.status(404).json({ error: "Participant record not found" });
    }
    // Phase 0: the read pointer may only move to a message of THIS conversation.
    const message = await prisma.message.findUnique({ where: { id: String(messageId) }, select: { conversationId: true } });
    if (message?.conversationId !== conversationId) {
      return res.status(404).json({ error: "Not found" });
    }

    await readService.markAsRead(conversationId, participantId, messageId, userId);
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}