// modules/chat/socket/socket-auth.ts
//
// Phase 0: authenticates every Socket.IO connection with the SAME rules as the
// HTTP API — authenticateUser (signature + HS256, payload shape, active user,
// role matches the database, role-specific id resolved from the database:
// vendor, active employee, admin's employee row). No second auth system: the
// handshake token is run through authenticateUser itself.
//
// On success socket.data.user is the trusted AuthUser; everything the chat
// socket handlers do is derived from it, never from client payloads. On any
// failure the connection is refused with a generic error (no token content,
// no reason detail beyond Unauthorized / Forbidden).

import type { Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { authenticateUser, type AuthUser } from "../../../middlewares/auth.middleware.ts";

/** Runs the HTTP authenticateUser on a bearer token; resolves the AuthUser or the refusal reason. */
function verifyToken(token: string): Promise<{ user: AuthUser } | { error: "Unauthorized" | "Forbidden" }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { user: AuthUser } | { error: "Unauthorized" | "Forbidden" }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const res: any = {
      statusCode: 401,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json() {
        finish({ error: this.statusCode === 403 ? "Forbidden" : "Unauthorized" });
        return this;
      },
    };
    authenticateUser(req, res, () => finish(req.user?.id ? { user: req.user } : { error: "Unauthorized" })).catch(() =>
      finish({ error: "Unauthorized" })
    );
  });
}

export function chatSocketAuth(socket: Socket, next: (err?: Error) => void) {
  const raw = (socket.handshake?.auth as Record<string, unknown> | undefined)?.token;
  const token = typeof raw === "string" ? raw.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) return next(new Error("Unauthorized"));

  verifyToken(token).then((r) => {
    if ("error" in r) return next(new Error(r.error));
    socket.data.user = r.user;
    // Phase 3: what the session guard needs — kept server-side only, never logged.
    const exp = (jwt.decode(token) as { exp?: unknown } | null)?.exp;
    socket.data.auth = { token, expMs: typeof exp === "number" ? exp * 1000 : 0, checkedAt: Date.now() };
    next();
  });
}

/**
 * Phase 3 — an established connection stays authorized only as long as its
 * credential and its user do (server-side; client timers are not trusted):
 *   - at the access token's `exp` the server disconnects the socket;
 *   - every incoming event first checks expiry, and re-runs authenticateUser
 *     (active user, role, role-specific ids from the database) when the last
 *     check is older than revalidateAfterMs;
 *   - a background sweep re-checks idle sockets every sweepIntervalMs, so a
 *     deactivated user also stops RECEIVING room broadcasts.
 * Failure → the event is not handled (an ack gets { ok: false, error:
 * "Unauthorized" }), the client is told `chat:auth_expired`, and the socket is
 * disconnected, leaving every room. A changed identity (role / vendor /
 * employee) counts as failure. Bounded, not instant: a deactivated user can
 * keep a connection for up to revalidateAfterMs (when sending) or
 * sweepIntervalMs (when only listening). A valid user is never disconnected
 * before the token's own expiry; the client then refreshes and reconnects.
 */
export const socketSessionConfig = { revalidateAfterMs: 60_000, sweepIntervalMs: 5 * 60_000 };

const sameIdentity = (a: AuthUser, b: AuthUser) =>
  a.id === b.id && a.rawId === b.rawId && a.role === b.role && a.vendorId === b.vendorId && a.employeeId === b.employeeId;

export function chatSocketSession(socket: Socket) {
  const auth = socket.data.auth as { token: string; expMs: number; checkedAt: number } | undefined;
  if (!auth || !socket.data.user) {
    socket.disconnect(true);
    return;
  }
  let ended = false;
  let inFlight: Promise<boolean> | null = null;
  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(expiryTimer);
    clearInterval(sweep);
    socket.emit("chat:auth_expired");
    socket.disconnect(true);
  };
  const revalidate = (): Promise<boolean> =>
    (inFlight ??= verifyToken(auth.token)
      .then((r) => {
        if ("error" in r || !sameIdentity(r.user, socket.data.user)) return false;
        socket.data.user = r.user; // fresh name/email; identity unchanged
        auth.checkedAt = Date.now();
        return true;
      })
      .finally(() => (inFlight = null)));
  const stillValid = async (): Promise<boolean> => {
    if (ended) return false;
    if (Date.now() >= auth.expMs) return false;
    if (Date.now() - auth.checkedAt < socketSessionConfig.revalidateAfterMs) return true;
    return revalidate();
  };

  const untilExpiry = Math.min(Math.max(auth.expMs - Date.now(), 0), 2 ** 31 - 1);
  const expiryTimer = setTimeout(end, untilExpiry);
  const sweep = setInterval(() => {
    revalidate().then((ok) => !ok && end(), end);
  }, socketSessionConfig.sweepIntervalMs);
  expiryTimer.unref?.();
  sweep.unref?.();

  socket.use((packet, next) => {
    stillValid().then(
      (ok) => {
        if (ok) return next();
        const ack = packet[packet.length - 1];
        if (typeof ack === "function") ack({ ok: false, error: "Unauthorized" });
        end(); // never next(err): an unhandled server-side "error" event would throw
      },
      () => end()
    );
  });
  socket.on("disconnect", () => {
    ended = true;
    clearTimeout(expiryTimer);
    clearInterval(sweep);
  });
}
