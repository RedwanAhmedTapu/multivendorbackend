// src/config/redis.ts
import { createClient } from "redis";

// ── Fail-closed: no hardcoded credentials. These MUST come from env. ──
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT;
const REDIS_USERNAME = process.env.REDIS_USERNAME || "default";
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

if (!REDIS_HOST || !REDIS_PORT || !REDIS_PASSWORD) {
  throw new Error(
    "Redis configuration missing. Set REDIS_HOST, REDIS_PORT and REDIS_PASSWORD in your environment (.env). " +
    "Never hardcode these values in source code."
  );
}

const redisClient = createClient({
  username: REDIS_USERNAME,
  password: REDIS_PASSWORD,
  socket: {
    host: REDIS_HOST,
    port: Number(REDIS_PORT),
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