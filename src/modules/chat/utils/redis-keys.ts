export const RedisKeys = {
  userOnline: (userId: string) => `chat:online:${userId}`,
  onlineUsers: () => "chat:online:users",
  typing: (convId: string, userId: string) => `chat:typing:${convId}:${userId}`,
  unreadCount: (participantId: string) => `chat:unread:${participantId}`,
  unreadTotal: (userId: string) => `chat:unread:total:${userId}`,
  // Phase 3: versioned + namespaced like autoReplies — pre-fix entries (the old
  // shared `chat:qr:global` could hold other vendors' rows) are never read, and
  // a vendor id can't collide with the platform key.
  quickReplies: (vendorId?: string) => (vendorId ? `chat:qr:v2:vendor:${vendorId}` : "chat:qr:v2:global"),
  // Phase 1: versioned + namespaced. Entries written before the Phase 0 scope
  // fix (the old `chat:ar:global` could hold EVERY vendor's rules, with no TTL)
  // are never read again, and a vendor id can't collide with the global key.
  autoReplies: (vendorId?: string) => (vendorId ? `chat:ar:v2:vendor:${vendorId}` : "chat:ar:v2:global"),
  notifSettings: (ownerId: string) => `chat:notif:${ownerId}`,
  rateLimit: (userId: string) => `chat:rate:${userId}`,
  // Phase 3: scoped to the sender — another user's identical clientId can't
  // block (or be blocked by) this sender's message.
  messageDedup: (senderType: string, senderId: string, clientId: string) => `chat:dedup:v2:${senderType}:${senderId}:${clientId}`,
} as const;