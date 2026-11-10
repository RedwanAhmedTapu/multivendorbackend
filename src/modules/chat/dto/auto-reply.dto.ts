import { z } from "zod";

// Phase 0: the ONLY fields a vendor may set on its own auto-reply rule.
// scope / vendorId / triggerCount / ids / timestamps are never taken from the
// request — the service forces scope VENDOR and the authenticated vendor id.
// Unknown keys are stripped (zod's default). Message types are the ones a
// client may send in chat (no SYSTEM / QUICK_REPLY).
const Fields = {
  name: z.string().trim().min(1).max(120),
  triggerType: z.enum(["KEYWORD", "FIRST_MESSAGE", "INACTIVITY", "AWAY_MODE"]),
  isActive: z.boolean(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(50),
  matchType: z.enum(["EXACT", "CONTAINS", "STARTS_WITH", "REGEX"]),
  inactivitySeconds: z.number().int().min(0).max(7 * 24 * 3600).nullable(),
  message: z.string().trim().min(1).max(2000),
  messageType: z.enum(["TEXT", "IMAGE", "AUDIO"]),
  mediaUrl: z.string().url().max(2048).nullable(),
  maxTriggersPerConv: z.number().int().min(1).max(100),
  cooldownSeconds: z.number().int().min(0).max(7 * 24 * 3600),
};

export const CreateAutoReplySchema = z.object({
  name: Fields.name,
  triggerType: Fields.triggerType,
  message: Fields.message,
  isActive: Fields.isActive.optional(),
  keywords: Fields.keywords.optional(),
  matchType: Fields.matchType.optional(),
  inactivitySeconds: Fields.inactivitySeconds.optional(),
  messageType: Fields.messageType.optional(),
  mediaUrl: Fields.mediaUrl.optional(),
  maxTriggersPerConv: Fields.maxTriggersPerConv.optional(),
  cooldownSeconds: Fields.cooldownSeconds.optional(),
});

export const UpdateAutoReplySchema = CreateAutoReplySchema.partial();

export type CreateAutoReplyInput = z.infer<typeof CreateAutoReplySchema>;
export type UpdateAutoReplyInput = z.infer<typeof UpdateAutoReplySchema>;
