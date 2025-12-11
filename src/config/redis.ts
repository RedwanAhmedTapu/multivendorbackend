// src/config/redis.ts
import { createClient } from "redis";

const redisClient = createClient({
  username: "default",
  password: "KXvuMOkLRJIgcb1ztykNaOY8ulDICZeJ",
  socket: {
    host: "redis-19600.c16.us-east-1-2.ec2.redns.redis-cloud.com",
    port: 19600,
  },
});

redisClient.on("error", (err) => {
  console.error("❌ Redis Client Error:", err);
});

redisClient.on("connect", () => {
  console.log("🔗 Redis socket connected");
});

redisClient.on("ready", () => {
  console.log("✅ Redis ready");
});

let isConnecting = false;

export async function initRedis() {
  // Prevent double-calls
  if (redisClient.isOpen || isConnecting) return;

  isConnecting = true;

  try {
    await redisClient.connect();
    console.log("🚀 Redis fully connected");
  } finally {
    isConnecting = false;
  }
}

export default redisClient;
