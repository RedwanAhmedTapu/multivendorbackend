// src/lib/courier/redact.ts
//
// Phase 0 (courier booking safety): courier credentials must never reach logs
// or the global error handler. An Axios error carries the full request config
// — including the Api-Key / Secret-Key / Authorization / API-ACCESS-TOKEN
// headers — so raw Axios errors are never logged or forwarded. These helpers
// keep only the message, the HTTP status and a redacted copy of the provider's
// response body.

const REDACTED = "[REDACTED]";

/** Secret-bearing keys, compared case-insensitively with "-" and "_" removed. */
const SECRET_KEYS = new Set([
  "apikey",
  "secretkey",
  "authorization",
  "apiaccesstoken",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "clientsecret",
  "password",
]);

const normalizeKey = (key: string) => key.toLowerCase().replace(/[-_]/g, "");

/** Masks bearer tokens embedded in free text (e.g. an echoed header value). */
function redactString(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`);
}

/** Deep copy of `value` with every secret-bearing key masked. Never mutates the input. */
export function redactSecrets<T>(value: T, depth = 0, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  if (depth > 8 || seen.has(value as object)) return "[Truncated]" as unknown as T;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, depth + 1, seen)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.has(normalizeKey(key)) ? REDACTED : redactSecrets(v, depth + 1, seen);
  }
  return out as T;
}

/** True for errors that carry an HTTP request/response (Axios and look-alikes). */
function isHttpClientError(err: any): boolean {
  return !!err && typeof err === "object" && !!(err.isAxiosError || err.config || err.request || err.response);
}

/** Loggable summary of any courier error: message, HTTP status and the redacted provider body only. */
export function describeCourierError(err: any): { message: string; status?: number; providerData?: unknown } {
  const message = redactString(String(err?.message ?? err ?? "unknown error"));
  if (!isHttpClientError(err)) return { message };
  return {
    message,
    status: err.response?.status,
    providerData: err.response?.data === undefined ? undefined : redactSecrets(err.response.data),
  };
}

/**
 * Error safe to pass to `next()`: HTTP-client errors are replaced by a plain
 * Error holding only the message, status and redacted provider body (never
 * `config`, `request`, `response` or headers). Other errors pass through
 * unchanged so existing error handling (AppError status codes, Multer, …)
 * behaves exactly as before.
 */
export function sanitizeCourierError(err: any): any {
  if (!isHttpClientError(err)) return err;
  const summary = describeCourierError(err);
  const safe: any = new Error(summary.message);
  if (summary.status !== undefined) safe.status = summary.status;
  if (summary.providerData !== undefined) safe.providerData = summary.providerData;
  if (err.courierBookingOutcome) safe.courierBookingOutcome = err.courierBookingOutcome;
  return safe;
}
