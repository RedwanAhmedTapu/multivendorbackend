// src/middlewares/rateLimit.middleware.ts
//
// The OTP / email-verification / password-reset flows already have their
// own Redis-backed per-account rate limits (see verification.service.ts).
// The one endpoint that had NO brute-force protection at all was plain
// password login — someone could try unlimited password guesses against
// any account. These limiters close that gap.
import rateLimit from "express-rate-limit";

// Strict limiter for POST /api/auth/login — keyed by IP, since the
// account identifier (email/phone) lives in the body and may vary per
// attempt (attacker guessing usernames too).
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again in 15 minutes." },
});

// Looser general limiter for the rest of the auth router (register,
// social-login, change-password, etc.) as defense-in-depth against
// scripted abuse, without duplicating the tighter Redis-based limits
// already enforced inside verification.service.ts for OTP/email/reset.
export const authGeneralRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." },
});