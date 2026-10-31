// src/modules/agent/controllers/agent-auth.controller.ts
import type { Request, Response, CookieOptions } from "express";
import { handle, ok, requestOrigin } from "../agent-http.ts";
import {
  AGENT_REFRESH_COOKIE,
  AGENT_REFRESH_COOKIE_PATH,
  AGENT_REFRESH_TOKEN_TTL_SECONDS,
  getAgentAuthConfig,
} from "../agent.config.ts";
import type { AgentRequest } from "../middlewares/agent-auth.middleware.ts";
import * as auth from "../services/agent-auth.service.ts";
import {
  agentChangePasswordSchema,
  agentForgotPasswordSchema,
  agentLoginSchema,
  agentNotificationPrefsSchema,
  agentProfileUpdateSchema,
  agentRegisterSchema,
  agentResetPasswordSchema,
  agentResetTokenSchema,
} from "../validators/agent-auth.validators.ts";

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: AGENT_REFRESH_COOKIE_PATH,
    maxAge: AGENT_REFRESH_TOKEN_TTL_SECONDS * 1000,
  };
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie(AGENT_REFRESH_COOKIE, token, cookieOptions());
}

function clearRefreshCookie(res: Response) {
  const { maxAge: _m, ...opts } = cookieOptions();
  res.clearCookie(AGENT_REFRESH_COOKIE, opts);
}

const readRefreshCookie = (req: Request): string | undefined => {
  const value = (req as any).cookies?.[AGENT_REFRESH_COOKIE];
  return typeof value === "string" && value ? value : undefined;
};

export const register = handle(async (req, res) => {
  getAgentAuthConfig();
  const data = agentRegisterSchema.parse(req.body);
  const { agent, requiresApproval } = await auth.registerAgent(data);
  ok(
    res,
    {
      agent,
      message: requiresApproval
        ? "Registration received. You can sign in once an admin approves your account."
        : "Registration complete. You can sign in now.",
    },
    undefined,
    201,
  );
});

export const login = handle(async (req, res) => {
  getAgentAuthConfig();
  const data = agentLoginSchema.parse(req.body);
  const result = await auth.loginAgent(data, requestOrigin(req));
  setRefreshCookie(res, result.refreshToken);
  ok(res, { accessToken: result.accessToken, agent: result.agent });
});

export const refresh = handle(async (req, res) => {
  getAgentAuthConfig();
  try {
    const result = await auth.refreshAgentSession(readRefreshCookie(req), requestOrigin(req));
    setRefreshCookie(res, result.refreshToken);
    const agent = await auth.getAgentMe(result.agentId);
    ok(res, { accessToken: result.accessToken, agent });
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
});

export const logout = handle(async (req: AgentRequest, res) => {
  await auth.logoutAgent(readRefreshCookie(req));
  clearRefreshCookie(res);
  ok(res, { message: "Signed out" });
});

export const logoutAll = handle(async (req: AgentRequest, res) => {
  await auth.logoutAllAgentSessions(req.agent!.id);
  clearRefreshCookie(res);
  ok(res, { message: "Signed out of every device" });
});

export const forgotPassword = handle(async (req, res) => {
  getAgentAuthConfig();
  const { email } = agentForgotPasswordSchema.parse(req.body);
  await auth.requestAgentPasswordReset(email);
  ok(res, { message: "If an agent account exists for this email, a reset link has been sent." });
});

export const verifyResetToken = handle(async (req, res) => {
  const { token } = agentResetTokenSchema.parse(req.body);
  ok(res, { valid: await auth.verifyAgentResetToken(token) });
});

export const resetPassword = handle(async (req, res) => {
  const { token, password } = agentResetPasswordSchema.parse(req.body);
  await auth.resetAgentPassword(token, password);
  clearRefreshCookie(res);
  ok(res, { message: "Password updated. Sign in with your new password." });
});

export const changePassword = handle(async (req: AgentRequest, res) => {
  const data = agentChangePasswordSchema.parse(req.body);
  const result = await auth.changeAgentPassword(req.agent!.id, req.agent!.sessionId, data.currentPassword, data.newPassword);
  ok(res, { accessToken: result.accessToken, message: "Password changed. Other devices were signed out." });
});

export const me = handle(async (req: AgentRequest, res) => {
  ok(res, await auth.getAgentMe(req.agent!.id));
});

export const sessions = handle(async (req: AgentRequest, res) => {
  ok(res, await auth.listAgentSessions(req.agent!.id, req.agent!.sessionId));
});

export const revokeSession = handle(async (req: AgentRequest, res) => {
  const id = String(req.params.id ?? "");
  await auth.revokeAgentSession(req.agent!.id, id);
  ok(res, { message: "Session signed out" });
});

export const updateProfile = handle(async (req: AgentRequest, res) => {
  const data = agentProfileUpdateSchema.parse(req.body);
  ok(res, await auth.updateAgentProfile(req.agent!.id, data));
});

export const updateNotificationPrefs = handle(async (req: AgentRequest, res) => {
  const data = agentNotificationPrefsSchema.parse(req.body) as Record<string, boolean>;
  ok(res, await auth.updateAgentNotificationPrefs(req.agent!.id, data));
});
