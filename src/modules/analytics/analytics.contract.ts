// modules/analytics/analytics.contract.ts
//
// Business Advisor — the event contract, identifiers and calendar helpers.
// Pure (no database); shared by the recorder, the ingestion endpoint and the
// query service.
//
// Who writes what (see analytics.recorder.ts):
//   PRODUCT_VIEW          browser → POST /api/analytics/events, validated here
//                         (public product, vendor derived server-side, bots and
//                         staff accounts ignored, ≤1 per session·product·30 min)
//   CHECKOUT_STARTED      browser signals the checkout page opened (signed-in
//                         only); the PRODUCTS come from the server-side cart
//   ADD_TO_CART / REMOVE_FROM_CART / CART_QUANTITY_CHANGED
//                         server, after the cart mutation succeeded
//   CHECKOUT_FAILED       server, from the quote / place-order failure, as an
//                         allowlisted category (never the raw error message)
//   ORDER_PLACED          server, after placeOrder committed (one row per line)
// Payment outcomes are NOT events: they are read from Order / Payment (the
// trusted payment flow) when journeys are summarised.

import { createHash } from "node:crypto";

export const ANALYTICS_EVENT_TYPES = [
  "PRODUCT_VIEW",
  "ADD_TO_CART",
  "REMOVE_FROM_CART",
  "CART_QUANTITY_CHANGED",
  "CHECKOUT_STARTED",
  "CHECKOUT_FAILED",
  "ORDER_PLACED",
] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

/** Event types a browser may send; everything else is server-only. */
export const CLIENT_EVENT_TYPES = ["PRODUCT_VIEW", "CHECKOUT_STARTED"] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/** Allowlisted entry points (anything else is stored as null). */
export const EVENT_SOURCES = ["PRODUCT_PAGE", "QUICK_VIEW", "BUY_NOW", "CART", "CHECKOUT", "WISHLIST"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];
export function safeSource(v: unknown): EventSource | null {
  return typeof v === "string" && (EVENT_SOURCES as readonly string[]).includes(v) ? (v as EventSource) : null;
}

/** Checkout failure categories — the only failure detail ever stored. */
export const CHECKOUT_FAILURE_REASONS = [
  "STOCK_UNAVAILABLE",
  "SHIPPING_UNAVAILABLE",
  "ADDRESS_INVALID",
  "PRICE_CHANGED",
  "QUOTE_REVIEW_REQUIRED",
  "CART_CHANGED",
  "VALIDATION",
  "OTHER",
] as const;
export type CheckoutFailureReason = (typeof CHECKOUT_FAILURE_REASONS)[number];

/**
 * Map a checkout / quote failure to a category. Reads the error's class code
 * or message only to classify it; the message itself is never stored.
 */
export function classifyCheckoutFailure(err: unknown): CheckoutFailureReason {
  const e = err as { code?: unknown; reason?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const reason = typeof e?.reason === "string" ? e.reason : "";
  const msg = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  if (reason === "PRICE_ACK_REQUIRED") return "PRICE_CHANGED";
  if (reason === "QUOTE_CHANGED" || code === "QUOTE_REQUIRED" || code === "CHECKOUT_CHANGED") return "QUOTE_REVIEW_REQUIRED";
  if (code === "ADDRESS_NOT_FOUND" || msg.includes("address not found")) return "ADDRESS_INVALID";
  if (msg.includes("insufficient stock") || msg.includes("no longer available") || msg.includes("out of stock") || msg.includes("unavailable")) return "STOCK_UNAVAILABLE";
  if (msg.includes("courier") || msg.includes("delivery route") || msg.includes("shipping")) return "SHIPPING_UNAVAILABLE";
  if (msg.includes("cart changed") || msg.includes("already processed") || msg.includes("no selected items")) return "CART_CHANGED";
  if (msg.includes("required") || msg.includes("must be") || msg.includes("invalid")) return "VALIDATION";
  return "OTHER";
}

// ── identifiers ─────────────────────────────────────────────────────────

/** Browser-generated ids (visitor in localStorage, session in sessionStorage). */
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const ANALYTICS_SESSION_HEADER = "x-fm-analytics-session";
export const ANALYTICS_VISITOR_HEADER = "x-fm-analytics-visitor";

export function safeClientId(v: unknown): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && CLIENT_ID.test(s) ? s : null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Pseudonymous actor key. A signed-in customer is "u:" + a hash of the user
 * id (so the raw id is not stored); an anonymous browser is "v:" + its random
 * visitor id. Vendors never see actor keys (journeys are labelled by a short
 * hash of the session key).
 */
export function actorKeyFor(userId: string | null | undefined, visitorId: string | null): string | null {
  if (userId) return `u:${sha(`finixmart-analytics:${userId}`).slice(0, 40)}`;
  if (visitorId) return `v:${visitorId}`;
  return null;
}

/** Journey key: the browser session id, else one journey per actor per day. */
export function sessionKeyFor(sessionId: string | null, actorKey: string, day: Date): string {
  return sessionId ? `s:${sessionId}` : `d:${sha(`${actorKey}:${isoDay(day)}`).slice(0, 32)}`;
}

/** Display label for a journey — never reversible to a customer. */
export function journeyLabel(sessionKey: string): string {
  return `J-${sha(sessionKey).slice(0, 8).toUpperCase()}`;
}

export function hashKey(parts: string[]): string {
  return sha(parts.join("|")).slice(0, 32);
}

// ── calendar (Asia/Dhaka, UTC+6, no DST) ────────────────────────────────

export const TZ_OFFSET_MINUTES = 6 * 60;
export const ANALYTICS_TIMEZONE = "Asia/Dhaka";

/** The Asia/Dhaka calendar day of an instant, as a UTC-midnight Date (for @db.Date). */
export function dhakaDay(at: Date): Date {
  const shifted = new Date(at.getTime() + TZ_OFFSET_MINUTES * 60_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" → UTC-midnight Date, or null when malformed / not a real date. */
export function parseDay(v: unknown): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || isoDay(d) !== v ? null : d;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Inclusive day count of [from, to]. */
export function dayCount(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

/** 30-minute bucket of an instant — the view / checkout-start dedup window. */
export function halfHourBucket(at: Date): number {
  return Math.floor(at.getTime() / (30 * 60_000));
}

export function tenMinuteBucket(at: Date): number {
  return Math.floor(at.getTime() / (10 * 60_000));
}

/** Requests from crawlers / link previews / scripts are not customer views. */
export function looksLikeBot(userAgent: unknown): boolean {
  if (typeof userAgent !== "string" || userAgent.length < 8) return true;
  return /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|curl|wget|python-requests|axios|node-fetch|headless|lighthouse|pingdom|monitor/i.test(userAgent);
}

/** Money (Decimal | number | string) × quantity → integer minor units (paisa). */
export function toMinor(price: unknown, quantity: number): number | null {
  const n = typeof price === "number" ? price : Number(String(price ?? ""));
  if (!Number.isFinite(n) || !Number.isFinite(quantity)) return null;
  return Math.round(n * quantity * 100);
}

export const ANALYTICS_LIMITS = {
  maxRangeDays: 92,
  defaultRangeDays: 30,
  maxEventsPerRequest: 20,
  journeysPageSize: 20,
  journeyMaxEvents: 60,
  productsPageMax: 50,
  /** A journey whose last event is older than this, with no order, is "abandoned". */
  abandonAfterHours: 24,
  /** Minimum sample before a ratio-based insight is shown. */
  insightMinSample: 20,
} as const;

export const RETENTION_DAYS_DEFAULT = 180;
