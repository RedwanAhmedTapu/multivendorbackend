import { z } from "zod";

export const SendMessageSchema = z.object({
  conversationId: z.string().cuid(),
  messageType: z.enum(["TEXT", "IMAGE", "AUDIO", "QUICK_REPLY", "SYSTEM"]).default("TEXT"),
  content: z.string().max(5000).optional(),
  replyToId: z.string().optional(),
  quickReplyId: z.string().optional(),
  clientId: z.string().min(1, "ClientId is required for deduplication"),
});

export type SendMessageInput = z.infer<typeof SendMessageSchema>;