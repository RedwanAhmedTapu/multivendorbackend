import { Server, Socket } from "socket.io";
import { RedisKeys } from "../utils/redis-keys.ts";
import redisClient from "../../../config/redis.ts";
import { actorFrom } from "../utils/chat-access.ts";

// Phase 0: presence is recorded for the AUTHENTICATED actor only (its
// role-specific id). The id a client sends with these events is ignored, so a
// client can't mark someone else online/offline. (The status broadcast itself
// is unchanged.)
export function handlePresence(io: Server, socket: Socket) {
  const actorId = () => actorFrom(socket.data?.user)?.id ?? null;

  socket.on("presence:online", async () => {
    const userId = actorId();
    if (!userId) return;
    await redisClient.set(RedisKeys.userOnline(userId), socket.id, {
      EX: 300,
    });

    await redisClient.sAdd(RedisKeys.onlineUsers(), userId);

    io.emit("presence:status", {
      userId,
      status: "online",
    });
  });

  socket.on("presence:heartbeat", async () => {
    const userId = actorId();
    if (!userId) return;
    await redisClient.expire(RedisKeys.userOnline(userId), 300);
  });

  socket.on("presence:offline", async () => {
    const userId = actorId();
    if (!userId) return;
    await redisClient.del(RedisKeys.userOnline(userId));

    await redisClient.sRem(RedisKeys.onlineUsers(), userId);

    io.emit("presence:status", {
      userId,
      status: "offline",
    });
  });
}
