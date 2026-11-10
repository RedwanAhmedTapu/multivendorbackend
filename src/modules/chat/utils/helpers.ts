import type { ParticipantType, MessageType } from "@prisma/client";
import { identityWhere } from "./participant-resolver.ts";
 
// ✅ Returns ConversationParticipant column names (userId, vendorId, etc.)
export function getParticipantFilter(type: ParticipantType, id: string) {
  return identityWhere(type, id, "userId"); // unknown → customer column (historical)
}

export function getTruncatedText(type: MessageType, content?: string | null): string | null {
  if (type === "IMAGE") return "📷 Photo";
  if (type === "AUDIO") return "🎤 Audio";
  if (type === "SYSTEM") return null;
  if (!content) return null;
  return content.length > 100 ? content.substring(0, 100) + "..." : content;
}