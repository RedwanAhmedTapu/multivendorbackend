import { Server, Socket } from "socket.io";
import redisClient from "../../../config/redis.ts";
import { RedisKeys } from "../utils/redis-keys.ts";
import { actorFrom } from "../utils/chat-access.ts";

// Phase 0: typing events carry the AUTHENTICATED actor's id (socket.data.userId
// was never set, so every event said `userId: undefined`) and are relayed only
// into a conversation room this socket already joined — joining requires the
// access check in chat.handler.ts.
export function handleTyping(io: Server, socket: Socket) {
  const allowed = (data: { conversationId?: unknown }) => {
    const actor = actorFrom(socket.data?.user);
    const conversationId = data?.conversationId;
    if (!actor || typeof conversationId !== "string" || !socket.rooms.has(`conversation:${conversationId}`)) return null;
    return { userId: actor.id, conversationId };
  };

  socket.on("typing:start", async (data: { conversationId: string }) => {
    const ok = allowed(data);
    if (!ok) return;
    const key = RedisKeys.typing(ok.conversationId, ok.userId);
    await redisClient.set(key, "1", {
      EX: 5,
    });
    socket.to(`conversation:${ok.conversationId}`).emit("typing:start", { userId: ok.userId });
  });

  socket.on("typing:stop", async (data: { conversationId: string }) => {
    const ok = allowed(data);
    if (!ok) return;
    await redisClient.del(RedisKeys.typing(ok.conversationId, ok.userId));
    socket.to(`conversation:${ok.conversationId}`).emit("typing:stop", { userId: ok.userId });
  });
}
