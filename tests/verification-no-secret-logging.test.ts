// tests/verification-no-secret-logging.test.ts
//
// Phase 4 — verification.service must not write secrets to the logs:
//   1. email-verification tokens (lock contention and "no data" paths);
//   2. an SMS failure: the axios error carries the request config, whose URL
//      holds the SMS API key and the OTP text — the error object must not be
//      logged; a non-sensitive diagnostic stays.
// Throwaway values only; Redis in memory; axios.get replaced (no network).
//   npx tsx --test tests/verification-no-secret-logging.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

const SMS_KEY = "TEST_SMS_API_KEY_9f2c71";
process.env.BULKSMS_API_KEY = SMS_KEY;
process.env.BULKSMS_SENDER_ID = "TEST_SENDER";
const redisClient = (await import("../src/config/redis.ts")).default as any;
const verification = await import("../src/services/verification.service.ts");

let kv: Map<string, string>;
let lines: string[];
const restores: (() => void)[] = [];
const swap = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
beforeEach(() => {
  kv = new Map();
  lines = [];
  swap(redisClient, "get", async (k: string) => kv.get(k) ?? null);
  swap(redisClient, "set", async (k: string, v: string, o?: any) => (o?.NX && kv.has(k) ? null : (kv.set(k, v), "OK")));
  swap(redisClient, "del", async (k: string) => (kv.delete(k) ? 1 : 0));
  swap(redisClient, "incr", async (k: string) => (kv.set(k, String(Number(kv.get(k) ?? 0) + 1)), Number(kv.get(k))));
  for (const m of ["log", "info", "warn", "error", "debug"] as const)
    swap(console, m, (...a: unknown[]) => lines.push(a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()) + " " + (x instanceof Error ? `${x.message} ${JSON.stringify((x as any).config ?? {})}` : "")).join(" ")));
});
afterEach(() => restores.splice(0).reverse().forEach((r) => r()));

const TOKEN = "ab".repeat(32); // 64 hex chars, the accepted format

test("1. email-verification tokens are never logged (in-progress lock, missing data)", async () => {
  kv.set(`lock:email:${TOKEN}`, "1"); // another request holds the lock
  await assert.rejects(verification.verifyEmail(TOKEN), /already in progress/);
  kv.clear();
  assert.equal(await verification.verifyEmail(TOKEN), null); // no stored data
  assert.ok(lines.length >= 2, "diagnostics are still written");
  assert.ok(!lines.some((l) => l.includes(TOKEN)), lines.join("\n"));
});

test("2. an SMS failure logs neither the API key nor the OTP (the axios error's request config)", async () => {
  swap(axios, "get", async (url: string) => {
    const err: any = new Error("connect ETIMEDOUT");
    err.isAxiosError = true;
    err.code = "ETIMEDOUT";
    err.config = { url, method: "get" };
    throw err;
  });
  await assert.rejects(verification.sendOtp("1712345678"), /Failed to send OTP/);
  const joined = lines.join("\n");
  assert.ok(!joined.includes(SMS_KEY), `the SMS API key was logged:\n${joined}`);
  assert.ok(!/OTP code is \d{6}/.test(joined) && !/OTP%20code%20is%20\d{6}/.test(joined), `the OTP was logged:\n${joined}`);
  assert.ok(lines.some((l) => /SMS sending failed/.test(l)), "a non-sensitive diagnostic remains");
});
