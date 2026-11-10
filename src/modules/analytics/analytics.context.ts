// modules/analytics/analytics.context.ts
//
// Journey context for a request: pseudonymous actor + journey key, from the
// authenticated user (server-side) and the browser's random analytics ids
// (headers x-fm-analytics-visitor / x-fm-analytics-session, format-checked).
// Staff accounts (VENDOR / EMPLOYEE / ADMIN) are not shoppers — their
// browsing and test carts are never recorded, so a vendor previewing its own
// products doesn't inflate its numbers.

import {
  ANALYTICS_SESSION_HEADER,
  ANALYTICS_VISITOR_HEADER,
  actorKeyFor,
  dhakaDay,
  safeClientId,
  sessionKeyFor,
} from "./analytics.contract.ts";
import type { ActorContext } from "./analytics.recorder.ts";

const STAFF_ROLES = new Set(["VENDOR", "EMPLOYEE", "ADMIN"]);

export function isStaff(user: { role?: string } | null | undefined): boolean {
  return !!user && STAFF_ROLES.has(String(user.role ?? "").toUpperCase());
}

/** The users-table id of the signed-in customer (rawId when present). */
export function customerUserId(user: { id?: string; rawId?: string; role?: string } | null | undefined): string | null {
  if (!user || isStaff(user)) return null;
  return user.rawId || user.id || null;
}

/** null → don't record (staff account, or no identifiable browser / user). */
export function analyticsContext(req: { headers?: Record<string, unknown>; user?: any }, now: Date = new Date()): ActorContext | null {
  if (isStaff(req.user)) return null;
  const headers = req.headers ?? {};
  const visitor = safeClientId(headers[ANALYTICS_VISITOR_HEADER]);
  const session = safeClientId(headers[ANALYTICS_SESSION_HEADER]);
  const actorKey = actorKeyFor(customerUserId(req.user), visitor);
  if (!actorKey) return null;
  return { actorKey, sessionKey: sessionKeyFor(session, actorKey, dhakaDay(now)) };
}
