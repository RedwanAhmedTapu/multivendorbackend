// src/modules/agent/services/agent-token.service.ts
//
// Access token: short-lived JWT (HS256) signed with AGENT_ACCESS_TOKEN_SECRET,
//   audience "finixmart-agent", typ "agent". Claims: sub (Agent.id),
//   sid (AgentSession.id), tv (Agent.tokenVersion).
//   A user/admin token cannot pass here (different secret AND audience), and
//   an agent token cannot pass authenticateUser (different secret).
// Refresh token: opaque 48 random bytes; only its SHA-256 is stored
//   (agent_sessions.refreshTokenHash). Rotated on every refresh.

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import {
  AGENT_ACCESS_TOKEN_TTL_SECONDS,
  AGENT_TOKEN_AUDIENCE,
  AGENT_TOKEN_ISSUER,
  getAgentAuthConfig,
} from "../agent.config.ts";

export type AgentAccessClaims = { sub: string; sid: string; tv: number; typ: "agent" };

export function signAgentAccessToken(claims: { agentId: string; sessionId: string; tokenVersion: number }): string {
  const { accessSecret } = getAgentAuthConfig();
  return jwt.sign({ sid: claims.sessionId, tv: claims.tokenVersion, typ: "agent" }, accessSecret, {
    algorithm: "HS256",
    subject: claims.agentId,
    audience: AGENT_TOKEN_AUDIENCE,
    issuer: AGENT_TOKEN_ISSUER,
    expiresIn: AGENT_ACCESS_TOKEN_TTL_SECONDS,
  });
}

/** Returns the claims, or null for ANY invalid token (never throws). */
export function verifyAgentAccessToken(token: string): AgentAccessClaims | null {
  const { accessSecret } = getAgentAuthConfig();
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, accessSecret, {
      algorithms: ["HS256"],
      audience: AGENT_TOKEN_AUDIENCE,
      issuer: AGENT_TOKEN_ISSUER,
    });
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;
  const d = decoded as Record<string, unknown>;
  if (d.typ !== "agent") return null;
  if (typeof d.sub !== "string" || !d.sub) return null;
  if (typeof d.sid !== "string" || !d.sid) return null;
  if (typeof d.tv !== "number" || !Number.isInteger(d.tv)) return null;
  return { sub: d.sub, sid: d.sid, tv: d.tv, typ: "agent" };
}

export function newOpaqueToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

/** Random uppercase code without ambiguous characters, e.g. "7K3Q9P". */
export function randomCode(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}
