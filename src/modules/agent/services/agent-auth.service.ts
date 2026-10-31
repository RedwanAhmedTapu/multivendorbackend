// src/modules/agent/services/agent-auth.service.ts
//
// Agent identity lifecycle: register, sign in, refresh (rotation), sign out,
// forgot/reset password, change password, sessions, profile.
// Separate from the user auth module in every respect (table, secrets,
// cookie, token audience).

import bcrypt from "bcryptjs";
import { agentDb } from "../agent-db.ts";
import { AgentError, conflict } from "../agent-http.ts";
import {
  AGENT_INVITE_TTL_HOURS,
  AGENT_PASSWORD_RESET_TTL_MINUTES,
  AGENT_REFRESH_TOKEN_TTL_SECONDS,
} from "../agent.config.ts";
import { bdPhoneSchema } from "../validators/agent-primitives.ts";
import { newOpaqueToken, randomCode, sha256, signAgentAccessToken } from "./agent-token.service.ts";
import { registrationRequiresApproval } from "./agent-settings.service.ts";
import { sendAgentPasswordResetEmail } from "./agent-mailer.ts";

const BCRYPT_ROUNDS = 12;
/** A revoked refresh token presented within this window is treated as a
 *  benign race (two tabs refreshing at once), not as token theft. */
const REFRESH_RACE_WINDOW_MS = 30_000;
const RESET_REQUESTS_PER_HOUR = 3;
// Hash compared against when the account doesn't exist, so response time
// doesn't reveal whether an email is registered. Generated once, lazily.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hash(newOpaqueToken(16), BCRYPT_ROUNDS));

export type SessionMeta = { ip: string | null; userAgent: string | null };

export const AGENT_PUBLIC_SELECT = {
  id: true,
  agentCode: true,
  name: true,
  email: true,
  phone: true,
  status: true,
  avatar: true,
  referralCode: true,
  notificationPrefs: true,
  lastLoginAt: true,
  createdAt: true,
  level: { select: { id: true, name: true, rank: true } },
} as const;

/** Pick codes that are not taken yet (collisions are ~1 in 10^9; checked anyway). */
async function freeCodes(db: any): Promise<{ agentCode: string; referralCode: string }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const agentCode = `AG-${randomCode(6)}`;
    const referralCode = `REF-${randomCode(8)}`;
    const taken = await db.agent.findFirst({ where: { OR: [{ agentCode }, { referralCode }] }, select: { id: true } });
    if (!taken) return { agentCode, referralCode };
  }
  throw new AgentError("Could not allocate an agent code, please retry", 503, "CODE_ALLOCATION_FAILED");
}

async function createAgentRow(db: any, data: Record<string, unknown>, select: any): Promise<any> {
  try {
    return await db.agent.create({ data: { ...data, ...(await freeCodes(db)) } as any, select });
  } catch (err: any) {
    const target = String(err?.meta?.target ?? "");
    if (err?.code === "P2002" && target.includes("email")) throw conflict("An agent with this email already exists", "EMAIL_TAKEN");
    if (err?.code === "P2002" && target.includes("phone")) throw conflict("An agent with this phone number already exists", "PHONE_TAKEN");
    if (err?.code === "P2002") throw new AgentError("Please retry", 503, "CODE_ALLOCATION_FAILED");
    throw err;
  }
}

async function assertIdentityFree(email: string, phone: string | null | undefined, exceptId?: string, db: any = agentDb.prisma) {
  const [byEmail, byPhone] = await Promise.all([
    db.agent.findUnique({ where: { email }, select: { id: true } }),
    phone ? db.agent.findUnique({ where: { phone }, select: { id: true } }) : null,
  ]);
  if (byEmail && byEmail.id !== exceptId) throw conflict("An agent with this email already exists", "EMAIL_TAKEN");
  if (byPhone && byPhone.id !== exceptId) throw conflict("An agent with this phone number already exists", "PHONE_TAKEN");
}

export async function hashAgentPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Self-registration. Status follows the admin setting registrationRequiresApproval.
 *
 * Enumeration-safe: when the email or phone already belongs to an agent, no
 * row is created and the caller gets the same result shape (agent = null) —
 * the HTTP response is identical either way. The password is hashed first in
 * both cases so the response time doesn't reveal it either. (Admin-created
 * agents keep the explicit 409: the admin needs to know.)
 */
export async function registerAgent(input: { name: string; email: string; phone?: string; password: string }) {
  const passwordHash = await hashAgentPassword(input.password);
  const requiresApproval = await registrationRequiresApproval();
  try {
    await assertIdentityFree(input.email, input.phone);
    const agent = await createAgentRow(
      agentDb.prisma,
      {
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        passwordHash,
        status: requiresApproval ? "PENDING" : "ACTIVE",
      },
      AGENT_PUBLIC_SELECT,
    );
    return { agent, requiresApproval };
  } catch (err) {
    // Already registered (checked, or lost a concurrent insert on the unique key).
    if (err instanceof AgentError && (err.code === "EMAIL_TAKEN" || err.code === "PHONE_TAKEN")) {
      return { agent: null, requiresApproval };
    }
    throw err;
  }
}

/**
 * Admin-created agent (ACTIVE) with an unusable random password and a
 * set-password (invite) token. Runs on the caller's transaction so the agent,
 * its invite token and the audit row commit together.
 */
export async function createAgentByAdmin(
  tx: any,
  input: { name: string; email: string; phone?: string; levelId?: string | null },
  adminUserId: string,
) {
  await assertIdentityFree(input.email, input.phone, undefined, tx);
  const agent = await createAgentRow(
    tx,
    {
      name: input.name,
      email: input.email,
      phone: input.phone ?? null,
      levelId: input.levelId ?? null,
      passwordHash: await hashAgentPassword(newOpaqueToken(32)),
      status: "ACTIVE",
      approvedById: adminUserId,
      approvedAt: new Date(),
      createdById: adminUserId,
    },
    AGENT_PUBLIC_SELECT,
  );
  const inviteToken = await issuePasswordToken(agent.id, AGENT_INVITE_TTL_HOURS * 60, tx);
  return { agent, inviteToken };
}

async function newSession(agentId: string, meta: SessionMeta, db: any = agentDb.prisma) {
  const refreshToken = newOpaqueToken();
  const session = await db.agentSession.create({
    data: {
      agentId,
      refreshTokenHash: sha256(refreshToken),
      ip: meta.ip,
      userAgent: meta.userAgent,
      expiresAt: new Date(Date.now() + AGENT_REFRESH_TOKEN_TTL_SECONDS * 1000),
      lastUsedAt: new Date(),
    },
    select: { id: true, expiresAt: true },
  });
  return { refreshToken, session };
}

export async function loginAgent(input: { identifier: string; password: string }, meta: SessionMeta) {
  const identifier = input.identifier.trim();
  let where: { email: string } | { phone: string } | null = null;
  if (identifier.includes("@")) where = { email: identifier.toLowerCase() };
  else {
    const phone = bdPhoneSchema.safeParse(identifier);
    if (phone.success) where = { phone: phone.data };
  }
  const agent = where
    ? await agentDb.prisma.agent.findUnique({ where: where as any, select: { id: true, passwordHash: true, status: true, tokenVersion: true } })
    : null;
  const valid = await bcrypt.compare(input.password, agent?.passwordHash ?? (await getDummyHash()));
  if (!agent || !valid) throw new AgentError("Invalid email/phone or password", 401, "INVALID_CREDENTIALS");
  if (agent.status === "PENDING") throw new AgentError("Your agent account is waiting for admin approval", 403, "AGENT_PENDING");
  if (agent.status !== "ACTIVE") throw new AgentError("Your agent account is not active. Please contact support.", 403, "AGENT_INACTIVE");

  const { refreshToken, session } = await newSession(agent.id, meta);
  await agentDb.prisma.agent.update({ where: { id: agent.id }, data: { lastLoginAt: new Date() } });
  const accessToken = signAgentAccessToken({ agentId: agent.id, sessionId: session.id, tokenVersion: agent.tokenVersion });
  const profile = await getAgentMe(agent.id);
  return { accessToken, refreshToken, refreshExpiresAt: session.expiresAt, agent: profile };
}

/** Revoke every session and invalidate every access token of an agent. */
export async function revokeAllAgentAccess(agentId: string, db: any = agentDb.prisma): Promise<void> {
  await db.agentSession.updateMany({ where: { agentId, revokedAt: null }, data: { revokedAt: new Date() } });
  await db.agent.update({ where: { id: agentId }, data: { tokenVersion: { increment: 1 } } });
}

export async function refreshAgentSession(rawToken: string | undefined, meta: SessionMeta) {
  const unauthorized = () => new AgentError("Session expired, please sign in again", 401, "REFRESH_INVALID");
  if (!rawToken) throw unauthorized();
  const session = await agentDb.prisma.agentSession.findUnique({
    where: { refreshTokenHash: sha256(rawToken) },
    select: { id: true, agentId: true, revokedAt: true, expiresAt: true, agent: { select: { status: true, tokenVersion: true } } },
  });
  if (!session) throw unauthorized();
  if (session.revokedAt) {
    if (Date.now() - session.revokedAt.getTime() > REFRESH_RACE_WINDOW_MS) {
      // A long-revoked token being replayed: assume theft, end everything.
      await revokeAllAgentAccess(session.agentId);
      console.warn(`[agent-auth] revoked refresh token replayed for agent ${session.agentId}; all sessions revoked`);
    }
    throw unauthorized();
  }
  if (session.expiresAt <= new Date()) throw unauthorized();
  if (session.agent.status !== "ACTIVE") {
    await agentDb.prisma.agentSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    throw new AgentError("Your agent account is not active", 403, "AGENT_INACTIVE");
  }

  // Rotate: the old token is single-use (guarded claim), a new session row
  // carries the new token.
  const rotated = await agentDb.prismaDirect.$transaction(async (tx: any) => {
    const claim = await tx.agentSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claim.count !== 1) return null;
    return newSession(session.agentId, meta, tx);
  });
  if (!rotated) throw unauthorized();
  const accessToken = signAgentAccessToken({ agentId: session.agentId, sessionId: rotated.session.id, tokenVersion: session.agent.tokenVersion });
  return { accessToken, refreshToken: rotated.refreshToken, refreshExpiresAt: rotated.session.expiresAt, agentId: session.agentId };
}

export async function logoutAgent(rawToken: string | undefined, sessionId?: string): Promise<void> {
  const now = new Date();
  if (rawToken) {
    await agentDb.prisma.agentSession.updateMany({ where: { refreshTokenHash: sha256(rawToken), revokedAt: null }, data: { revokedAt: now } });
  }
  if (sessionId) {
    await agentDb.prisma.agentSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
  }
}

/** Creates a single-use password token (reset or invite); older unused ones are voided. */
async function issuePasswordToken(agentId: string, ttlMinutes: number, db: any = agentDb.prisma): Promise<string> {
  const token = newOpaqueToken(32);
  await db.agentPasswordReset.updateMany({ where: { agentId, usedAt: null }, data: { usedAt: new Date() } });
  await db.agentPasswordReset.create({
    data: { agentId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMinutes * 60_000) },
  });
  return token;
}

/** Always resolves the same way whether or not the email exists. */
export async function requestAgentPasswordReset(email: string): Promise<void> {
  const agent = await agentDb.prisma.agent.findUnique({ where: { email }, select: { id: true, name: true, email: true, status: true } });
  if (!agent || agent.status === "DEACTIVATED") return;
  const recent = await agentDb.prisma.agentPasswordReset.count({
    where: { agentId: agent.id, createdAt: { gt: new Date(Date.now() - 60 * 60_000) } },
  });
  if (recent >= RESET_REQUESTS_PER_HOUR) return;
  const token = await issuePasswordToken(agent.id, AGENT_PASSWORD_RESET_TTL_MINUTES);
  try {
    await sendAgentPasswordResetEmail(agent.email, agent.name, token);
  } catch (err: any) {
    console.error(`[agent-auth] password reset email failed for agent ${agent.id}: ${err?.message ?? err}`);
  }
}

export async function verifyAgentResetToken(token: string): Promise<boolean> {
  const row = await agentDb.prisma.agentPasswordReset.findUnique({ where: { tokenHash: sha256(token) }, select: { usedAt: true, expiresAt: true } });
  return !!row && !row.usedAt && row.expiresAt > new Date();
}

export async function resetAgentPassword(token: string, password: string): Promise<void> {
  const passwordHash = await hashAgentPassword(password);
  const ok = await agentDb.prismaDirect.$transaction(async (tx: any) => {
    const row = await tx.agentPasswordReset.findUnique({ where: { tokenHash: sha256(token) }, select: { id: true, agentId: true } });
    if (!row) return false;
    const claim = await tx.agentPasswordReset.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claim.count !== 1) return false;
    await tx.agent.update({ where: { id: row.agentId }, data: { passwordHash } });
    await revokeAllAgentAccess(row.agentId, tx);
    return true;
  });
  if (!ok) throw new AgentError("This link is invalid or has expired. Request a new one.", 400, "RESET_TOKEN_INVALID");
}

/** Changes the password, signs out every OTHER session, returns a fresh access token for this one. */
export async function changeAgentPassword(agentId: string, sessionId: string, currentPassword: string, newPassword: string) {
  const agent = await agentDb.prisma.agent.findUnique({ where: { id: agentId }, select: { passwordHash: true } });
  if (!agent || !(await bcrypt.compare(currentPassword, agent.passwordHash))) {
    throw new AgentError("Current password is incorrect", 400, "CURRENT_PASSWORD_WRONG");
  }
  const passwordHash = await hashAgentPassword(newPassword);
  const updated = await agentDb.prismaDirect.$transaction(async (tx: any) => {
    await tx.agentSession.updateMany({ where: { agentId, revokedAt: null, NOT: { id: sessionId } }, data: { revokedAt: new Date() } });
    return tx.agent.update({ where: { id: agentId }, data: { passwordHash, tokenVersion: { increment: 1 } }, select: { tokenVersion: true } });
  });
  return { accessToken: signAgentAccessToken({ agentId, sessionId, tokenVersion: updated.tokenVersion }) };
}

export async function logoutAllAgentSessions(agentId: string): Promise<void> {
  await agentDb.prismaDirect.$transaction(async (tx: any) => revokeAllAgentAccess(agentId, tx));
}

export async function getAgentMe(agentId: string) {
  const agent = await agentDb.prisma.agent.findUnique({ where: { id: agentId }, select: AGENT_PUBLIC_SELECT });
  if (!agent) throw new AgentError("Agent not found", 404, "NOT_FOUND");
  return agent;
}

export async function listAgentSessions(agentId: string, currentSessionId: string) {
  const rows = await agentDb.prisma.agentSession.findMany({
    where: { agentId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true, expiresAt: true },
  });
  return rows.map((r: any) => ({ ...r, current: r.id === currentSessionId }));
}

export async function revokeAgentSession(agentId: string, sessionId: string): Promise<void> {
  const res = await agentDb.prisma.agentSession.updateMany({ where: { id: sessionId, agentId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (res.count !== 1) throw new AgentError("Session not found", 404, "NOT_FOUND");
}

export async function updateAgentProfile(agentId: string, data: { name?: string; phone?: string | null }) {
  if (data.phone) {
    const clash = await agentDb.prisma.agent.findUnique({ where: { phone: data.phone }, select: { id: true } });
    if (clash && clash.id !== agentId) throw conflict("An agent with this phone number already exists", "PHONE_TAKEN");
  }
  await agentDb.prisma.agent.update({ where: { id: agentId }, data });
  return getAgentMe(agentId);
}

export async function updateAgentNotificationPrefs(agentId: string, prefs: Record<string, boolean>) {
  const current = await agentDb.prisma.agent.findUnique({ where: { id: agentId }, select: { notificationPrefs: true } });
  const merged = { ...((current?.notificationPrefs as Record<string, boolean>) ?? {}), ...prefs };
  await agentDb.prisma.agent.update({ where: { id: agentId }, data: { notificationPrefs: merged } });
  return merged;
}
