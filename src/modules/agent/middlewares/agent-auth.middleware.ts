// src/modules/agent/middlewares/agent-auth.middleware.ts
//
// authenticateAgent — the ONLY gate for /api/agent/* (except the public auth
// endpoints). Every request:
//   1. Bearer token verified with the AGENT secret + audience (a user/admin
//      token fails here; an agent token fails authenticateUser).
//   2. Agent row re-read: must exist, be ACTIVE, and its tokenVersion must
//      equal the token's `tv` (suspend / password change / log-out-everywhere
//      invalidate every token immediately).
//   3. The session in `sid` must belong to the agent, be unrevoked and
//      unexpired (log-out of one session takes effect immediately).
// The agent identity is never taken from a body, query or path.

import type { Request, Response, NextFunction } from "express";
import { agentDb } from "../agent-db.ts";
import { AgentError, sendError } from "../agent-http.ts";
import { verifyAgentAccessToken } from "../services/agent-token.service.ts";

export type AgentPrincipal = {
  id: string;
  sessionId: string;
  name: string;
  email: string;
  agentCode: string;
  levelId: string | null;
};

export interface AgentRequest extends Request {
  agent?: AgentPrincipal;
}

const deny = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, message });

export async function authenticateAgent(req: AgentRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      deny(res, 401, "Unauthorized");
      return;
    }
    const token = header.slice(7).trim();
    if (!token) {
      deny(res, 401, "Unauthorized");
      return;
    }

    const claims = verifyAgentAccessToken(token); // throws 503 when not configured
    if (!claims) {
      deny(res, 401, "Unauthorized");
      return;
    }

    const [agent, session] = await Promise.all([
      agentDb.prisma.agent.findUnique({
        where: { id: claims.sub },
        select: { id: true, status: true, tokenVersion: true, name: true, email: true, agentCode: true, levelId: true },
      }),
      agentDb.prisma.agentSession.findUnique({
        where: { id: claims.sid },
        select: { agentId: true, revokedAt: true, expiresAt: true },
      }),
    ]);

    if (!agent || agent.tokenVersion !== claims.tv) {
      deny(res, 401, "Unauthorized");
      return;
    }
    if (!session || session.agentId !== agent.id || session.revokedAt || session.expiresAt <= new Date()) {
      deny(res, 401, "Unauthorized");
      return;
    }
    if (agent.status !== "ACTIVE") {
      deny(res, 403, "Your agent account is not active");
      return;
    }

    req.agent = {
      id: agent.id,
      sessionId: claims.sid,
      name: agent.name,
      email: agent.email,
      agentCode: agent.agentCode,
      levelId: agent.levelId,
    };
    next();
  } catch (err) {
    if (err instanceof AgentError) {
      sendError(res, err);
      return;
    }
    console.error("[agent-auth] verification failed:", (err as any)?.message ?? err);
    deny(res, 500, "Internal server error");
  }
}
