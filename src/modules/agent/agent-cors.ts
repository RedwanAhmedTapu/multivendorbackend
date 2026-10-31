// src/modules/agent/agent-cors.ts
//
// CORS for the REST API with the agent portal kept on its own routes.
//
// The agent app (AGENT_FRONTEND_URL, port 3002) is a different origin from the
// marketplace site. It is allowed — with credentials — ONLY on the agent API
// (/api/agent and /api/agent/*). Every other route keeps the site's origin
// list. Allowing it globally would let script running in the agent app call
// e.g. POST /api/auth/refresh with the site's `refreshToken` cookie
// (sameSite "lax", path "/") and read a signed-in site user's or admin's
// access token.

import type { Request } from "express";
import type { CorsOptions, CorsOptionsDelegate } from "cors";

/** True for /api/agent and anything below it (not /api/agents, not /api/admin/agents). */
export function isAgentApiPath(path: string): boolean {
  return path === "/api/agent" || path.startsWith("/api/agent/");
}

/**
 * Options delegate for `cors()`: the site origins everywhere, plus the agent
 * app origin on the agent API only. A request without an Origin header
 * (server-to-server, curl) is allowed as before.
 */
export function agentAwareCorsOptions(siteOrigins: readonly string[], agentOrigin: string): CorsOptionsDelegate<Request> {
  const siteOnly = new Set(siteOrigins);
  const withAgent = new Set([...siteOrigins, agentOrigin]);
  return (req, callback) => {
    const allowed = isAgentApiPath(req.path) ? withAgent : siteOnly;
    const options: CorsOptions = {
      origin: (origin, cb) => {
        if (!origin || allowed.has(origin)) return cb(null, true);
        cb(new Error("Not allowed by CORS"));
      },
      credentials: true,
    };
    callback(null, options);
  };
}
