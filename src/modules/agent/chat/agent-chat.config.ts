// src/modules/agent/chat/agent-chat.config.ts
//
// P10 — agents inside the existing chat module. ON by default. AGENT_CHAT_ENABLED
// is only an optional kill switch: "0" or "false" turns everything agent-specific
// off (the site and agent app have NEXT_PUBLIC_AGENT_CHAT_ENABLED, same rule).
// Switched off, the existing chat behaves exactly as before
// (tests/chat-baseline/ run with the variable unset and with "0").

export const agentChatEnabled = (): boolean => !/^(0|false)$/i.test(String(process.env.AGENT_CHAT_ENABLED ?? "").trim());

/** Conversation types that involve an agent (added by migration 20261103000000). */
export const AGENT_CONVERSATION_TYPES = ["AGENT_SUPPORT", "AGENT_VENDOR"] as const;
export type AgentConversationType = (typeof AGENT_CONVERSATION_TYPES)[number];
export const isAgentConversationType = (type: unknown): type is AgentConversationType =>
  typeof type === "string" && (AGENT_CONVERSATION_TYPES as readonly string[]).includes(type);

export const AGENT_CHAT_LIMITS = {
  /** Max characters per message in an agent conversation (any sender). */
  maxChars: 2000,
  /** Messages per minute per agent (on top of the chat module's own limit). */
  perMinute: 20,
  /** Image attachments in agent conversations. */
  maxAttachmentBytes: 5 * 1024 * 1024,
  allowedImageTypes: ["image/jpeg", "image/png", "image/webp"] as readonly string[],
  /** Attachment links handed out in agent-visible conversations expire after this. */
  signedUrlSeconds: 10 * 60,
} as const;

/** Shown to every side of an agent conversation (moderation is allowed and audited). */
export const MODERATION_NOTICE = "FinixMart admins can read this conversation.";

/** Soft PII check: a Bangladeshi mobile number or an e-mail address in free text → warning (never a block). */
export function piiWarning(text: string | null | undefined): string | null {
  if (!text) return null;
  const phone = /(?:\+?88)?01[3-9][\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/.test(text);
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
  return phone || email ? "Please don't share customers' phone numbers or e-mail addresses in agent chats." : null;
}
