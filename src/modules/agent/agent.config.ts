// src/modules/agent/agent.config.ts
//
// Agent authentication is completely separate from admin/vendor/customer
// authentication: own secrets, own token audience, own refresh cookie.
//
// Fail-closed WITHOUT taking the marketplace down: if the agent secrets are
// missing, too short, or equal to the user secrets, every agent auth route
// answers 503 and a startup error is logged — the rest of the API is
// unaffected. (A hard throw at import time would stop the whole server.)

import { AgentError } from "./agent-http.ts";

export const AGENT_TOKEN_AUDIENCE = "finixmart-agent";
export const AGENT_TOKEN_ISSUER = "finixmart-api";
export const AGENT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const AGENT_REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const AGENT_PASSWORD_RESET_TTL_MINUTES = 30;
export const AGENT_INVITE_TTL_HOURS = 72;
/** Cookie name and path: never collides with the site's `refreshToken` cookie,
 *  and the browser only sends it to the agent auth endpoints. */
export const AGENT_REFRESH_COOKIE = "fm_agent_rt";
export const AGENT_REFRESH_COOKIE_PATH = "/api/agent/auth";
const MIN_SECRET_LENGTH = 32;

export type AgentAuthConfig = {
  accessSecret: string;
  appUrl: string;
};

let cached: { config: AgentAuthConfig | null; problem: string | null } | null = null;

function evaluate(): { config: AgentAuthConfig | null; problem: string | null } {
  const access = process.env.AGENT_ACCESS_TOKEN_SECRET;
  const appUrl = (process.env.AGENT_FRONTEND_URL || "http://localhost:3002").replace(/\/+$/, "");
  if (!access) return { config: null, problem: "AGENT_ACCESS_TOKEN_SECRET is not set" };
  if (access.length < MIN_SECRET_LENGTH) {
    return { config: null, problem: `AGENT_ACCESS_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters` };
  }
  const userSecrets = [process.env.ACCESS_TOKEN_SECRET, process.env.REFRESH_TOKEN_SECRET, process.env.JWT_SECRET].filter(Boolean);
  if (userSecrets.includes(access)) {
    return { config: null, problem: "AGENT_ACCESS_TOKEN_SECRET must differ from the user token secrets" };
  }
  return { config: { accessSecret: access, appUrl }, problem: null };
}

/** For tests: re-read the environment. */
export function resetAgentAuthConfig(): void {
  cached = null;
}

/** Throws 503 when agent auth is not configured. */
export function getAgentAuthConfig(): AgentAuthConfig {
  if (!cached) cached = evaluate();
  if (!cached.config) {
    throw new AgentError("Agent sign-in is not available right now", 503, "AGENT_AUTH_NOT_CONFIGURED");
  }
  return cached.config;
}

/** Startup report (called once from server.ts). Never prints secret values. */
export function reportAgentAuthConfig(): void {
  cached = evaluate();
  if (cached.problem) {
    console.error(`❌ [agent] Agent auth disabled: ${cached.problem}. Agent routes will answer 503.`);
  } else {
    console.log("✅ [agent] Agent auth configured");
  }
}

/** Origin of the agent app, for CORS (http://localhost:3002 by default). */
export function agentFrontendOrigin(): string {
  return (process.env.AGENT_FRONTEND_URL || "http://localhost:3002").replace(/\/+$/, "");
}
