// tests/agent-auth-flow.test.ts
//
// Agent register / login / refresh rotation / logout / forgot+reset /
// change password, against an in-memory agentDb fake.
//
//   npx tsx --test tests/agent-auth-flow.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.ACCESS_TOKEN_SECRET ??= "test-only-user-access-secret";
process.env.AGENT_ACCESS_TOKEN_SECRET = "test-only-agent-access-secret-0123456789abcdef";

const auth = await import("../src/modules/agent/services/agent-auth.service.ts");
const { resetAgentAuthConfig } = await import("../src/modules/agent/agent.config.ts");
const { verifyAgentAccessToken, sha256 } = await import("../src/modules/agent/services/agent-token.service.ts");
const { invalidateAgentSettingsCache } = await import("../src/modules/agent/services/agent-settings.service.ts");
const { agentMailer } = await import("../src/modules/agent/services/agent-mailer.ts");
const { agentRegisterSchema, agentLoginSchema } = await import("../src/modules/agent/validators/agent-auth.validators.ts");
const { installAgentFakeDb } = await import("./support/agent-fake-db.ts");

let fake: ReturnType<typeof installAgentFakeDb>;
let sent: Array<{ to: string; link?: string }> = [];
const meta = { ip: "127.0.0.1", userAgent: "test" };

beforeEach(() => {
  resetAgentAuthConfig();
  invalidateAgentSettingsCache();
  fake = installAgentFakeDb();
  sent = [];
  agentMailer.send = async (to, data) => {
    sent.push({ to, link: data.ctaLink });
  };
});
afterEach(() => fake.restore());

const register = (over: Record<string, unknown> = {}) =>
  auth.registerAgent(agentRegisterSchema.parse({ name: "Rahim Uddin", email: "Rahim@Example.com", phone: "+8801711223344", password: "secret123", ...over }));

async function setApproval(value: boolean) {
  await fake.db.agentSetting.create({ data: { key: "registrationRequiresApproval", value: { value }, updatedById: "U", updatedAt: new Date() } });
  invalidateAgentSettingsCache();
}

test("registration normalizes identity and waits for approval when the setting is unset (fail-safe)", async () => {
  const { agent, requiresApproval } = await register();
  assert.equal(requiresApproval, true);
  assert.equal(agent.status, "PENDING");
  assert.equal(agent.email, "rahim@example.com");
  assert.equal(agent.phone, "01711223344");
  assert.match(agent.agentCode, /^AG-[A-Z2-9]{6}$/);
  assert.match(agent.referralCode, /^REF-[A-Z2-9]{8}$/);
  const row = fake.db.agent.rows[0];
  assert.notEqual(row.passwordHash, "secret123");
  assert.ok(row.passwordHash.startsWith("$2"));
});

test("registration follows the admin setting registrationRequiresApproval", async () => {
  await setApproval(false);
  assert.equal((await register()).agent.status, "ACTIVE");
  invalidateAgentSettingsCache();
  fake.db.agentSetting.rows[0].value = { value: true };
  assert.equal((await register({ email: "b@x.com", phone: "01811223344" })).agent.status, "PENDING");
});

test("duplicate email / phone: nothing is created and nothing is revealed (no 409)", async () => {
  await register();
  const before = fake.db.agent.rows.length;
  assert.deepEqual(await register({ phone: "01911223344" }), { agent: null, requiresApproval: true }, "email taken");
  assert.deepEqual(await register({ email: "c@x.com" }), { agent: null, requiresApproval: true }, "phone taken");
  assert.equal(fake.db.agent.rows.length, before, "no second row");
  assert.equal(fake.db.agent.rows[0].name, "Rahim Uddin", "existing agent untouched");
});

test("register endpoint: a new and an already-registered email get the identical response", async () => {
  const { register: registerHandler } = await import("../src/modules/agent/controllers/agent-auth.controller.ts");
  const call = async (body: Record<string, unknown>) => {
    const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await new Promise<void>((resolve, reject) => {
      const done = res.json.bind(res);
      res.json = (b: unknown) => (done(b), resolve(), res);
      Promise.resolve(registerHandler({ body, headers: {}, ip: "127.0.0.1" } as any, res, reject as any)).catch(reject);
    });
    return { status: res.statusCode, body: res.body };
  };
  const body = { name: "Rahim Uddin", email: "rahim@example.com", phone: "01711223344", password: "secret123" };
  const fresh = await call(body);
  const again = await call(body);
  const phoneOnly = await call({ ...body, email: "other@example.com" });
  assert.equal(fresh.status, 202);
  assert.deepEqual(again, fresh, "same status and body for an existing email");
  assert.deepEqual(phoneOnly, fresh, "same status and body for an existing phone");
  assert.ok(!JSON.stringify(fresh.body).includes("rahim@example.com"), "no account data echoed");
  assert.equal(fake.db.agent.rows.length, 1);
});

test("validation: weak password, bad phone, bad email are rejected", () => {
  assert.throws(() => agentRegisterSchema.parse({ name: "Ab", email: "a@x.com", password: "short1" }));
  assert.throws(() => agentRegisterSchema.parse({ name: "Ab", email: "a@x.com", password: "lettersonly" }));
  assert.throws(() => agentRegisterSchema.parse({ name: "Ab", email: "a@x.com", phone: "0123", password: "secret123" }));
  assert.throws(() => agentRegisterSchema.parse({ name: "Ab", email: "not-an-email", password: "secret123" }));
  assert.throws(() => agentRegisterSchema.parse({ name: "Ab", email: "a@x.com", password: "secret123", role: "ADMIN" }), "unknown keys rejected");
  assert.throws(() => agentLoginSchema.parse({ identifier: "a@x.com" }));
});

test("login: pending → 403, wrong password → 401 (same message for unknown account), active → tokens", async () => {
  await register();
  await assert.rejects(auth.loginAgent({ identifier: "rahim@example.com", password: "secret123" }, meta), (e: any) => e.statusCode === 403 && e.code === "AGENT_PENDING");
  fake.db.agent.rows[0].status = "ACTIVE";
  await assert.rejects(auth.loginAgent({ identifier: "rahim@example.com", password: "wrong999" }, meta), (e: any) => e.statusCode === 401 && e.code === "INVALID_CREDENTIALS");
  await assert.rejects(auth.loginAgent({ identifier: "nobody@example.com", password: "secret123" }, meta), (e: any) => e.statusCode === 401 && e.code === "INVALID_CREDENTIALS");

  const byPhone = await auth.loginAgent({ identifier: "+880 1711-223344", password: "secret123" }, meta);
  const claims = verifyAgentAccessToken(byPhone.accessToken)!;
  assert.equal(claims.sub, fake.db.agent.rows[0].id);
  assert.equal(claims.tv, 0);
  const session = fake.db.agentSession.rows.find((s: any) => s.id === claims.sid);
  assert.equal(session.refreshTokenHash, sha256(byPhone.refreshToken), "only the hash is stored");
  assert.ok(!JSON.stringify(fake.db.agentSession.rows).includes(byPhone.refreshToken));
});

test("suspended / deactivated agents cannot sign in", async () => {
  await register();
  for (const status of ["SUSPENDED", "DEACTIVATED"]) {
    fake.db.agent.rows[0].status = status;
    await assert.rejects(auth.loginAgent({ identifier: "rahim@example.com", password: "secret123" }, meta), (e: any) => e.statusCode === 403 && e.code === "AGENT_INACTIVE");
  }
});

async function activeLogin() {
  await register();
  fake.db.agent.rows[0].status = "ACTIVE";
  return auth.loginAgent({ identifier: "rahim@example.com", password: "secret123" }, meta);
}

test("refresh rotates the token; the old one is single-use", async () => {
  const first = await activeLogin();
  const second = await auth.refreshAgentSession(first.refreshToken, meta);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.ok(verifyAgentAccessToken(second.accessToken));
  // immediate replay (two tabs racing): refused, but other sessions survive
  await assert.rejects(auth.refreshAgentSession(first.refreshToken, meta), (e: any) => e.statusCode === 401);
  assert.equal(fake.db.agent.rows[0].tokenVersion, 0, "benign race does not nuke sessions");
  const third = await auth.refreshAgentSession(second.refreshToken, meta);
  assert.ok(third.accessToken);
});

test("replaying a long-revoked refresh token revokes everything (theft response)", async () => {
  const first = await activeLogin();
  const second = await auth.refreshAgentSession(first.refreshToken, meta);
  const old = fake.db.agentSession.rows.find((s: any) => s.refreshTokenHash === sha256(first.refreshToken));
  old.revokedAt = new Date(Date.now() - 5 * 60_000);
  await assert.rejects(auth.refreshAgentSession(first.refreshToken, meta), (e: any) => e.statusCode === 401);
  assert.equal(fake.db.agent.rows[0].tokenVersion, 1);
  await assert.rejects(auth.refreshAgentSession(second.refreshToken, meta), (e: any) => e.statusCode === 401);
});

test("refresh refuses missing, unknown, expired tokens and inactive agents", async () => {
  await assert.rejects(auth.refreshAgentSession(undefined, meta), (e: any) => e.statusCode === 401);
  await assert.rejects(auth.refreshAgentSession("nope", meta), (e: any) => e.statusCode === 401);
  const login = await activeLogin();
  fake.db.agent.rows[0].status = "SUSPENDED";
  await assert.rejects(auth.refreshAgentSession(login.refreshToken, meta), (e: any) => e.statusCode === 403);
});

test("logout revokes the session; logout-all bumps tokenVersion", async () => {
  const login = await activeLogin();
  await auth.logoutAgent(login.refreshToken);
  assert.ok(fake.db.agentSession.rows.every((s: any) => s.revokedAt));
  const again = await auth.loginAgent({ identifier: "rahim@example.com", password: "secret123" }, meta);
  await auth.logoutAllAgentSessions(fake.db.agent.rows[0].id);
  assert.equal(fake.db.agent.rows[0].tokenVersion, 1);
  await assert.rejects(auth.refreshAgentSession(again.refreshToken, meta), (e: any) => e.statusCode === 401);
});

test("forgot password: same outcome for unknown emails, single-use expiring token, all sessions revoked on reset", async () => {
  await activeLogin();
  await auth.requestAgentPasswordReset("nobody@example.com");
  assert.equal(sent.length, 0);
  await auth.requestAgentPasswordReset("rahim@example.com");
  assert.equal(sent.length, 1);
  const token = new URL(sent[0].link!).searchParams.get("token")!;
  assert.ok(sent[0].link!.startsWith("http://localhost:3002/reset-password?token="));
  assert.equal(await auth.verifyAgentResetToken(token), true);
  await auth.resetAgentPassword(token, "newsecret456");
  assert.equal(await auth.verifyAgentResetToken(token), false);
  await assert.rejects(auth.resetAgentPassword(token, "another789"), (e: any) => e.code === "RESET_TOKEN_INVALID");
  assert.equal(fake.db.agent.rows[0].tokenVersion, 1);
  assert.ok(fake.db.agentSession.rows.every((s: any) => s.revokedAt));
  const login = await auth.loginAgent({ identifier: "rahim@example.com", password: "newsecret456" }, meta);
  assert.ok(login.accessToken);
});

test("an expired reset token is refused; a new request voids older tokens; at most 3 per hour", async () => {
  await activeLogin();
  await auth.requestAgentPasswordReset("rahim@example.com");
  const t1 = new URL(sent[0].link!).searchParams.get("token")!;
  await auth.requestAgentPasswordReset("rahim@example.com");
  assert.equal(await auth.verifyAgentResetToken(t1), false, "older token voided");
  const t2 = new URL(sent[1].link!).searchParams.get("token")!;
  fake.db.agentPasswordReset.rows.find((r: any) => r.tokenHash === sha256(t2)).expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(auth.resetAgentPassword(t2, "newsecret456"), (e: any) => e.code === "RESET_TOKEN_INVALID");
  await auth.requestAgentPasswordReset("rahim@example.com");
  await auth.requestAgentPasswordReset("rahim@example.com");
  assert.equal(sent.length, 3, "rate limited to 3 per hour");
});

test("change password: needs the current password, keeps this session, signs out the others", async () => {
  const a = await activeLogin();
  const b = await auth.loginAgent({ identifier: "rahim@example.com", password: "secret123" }, meta);
  const agentId = fake.db.agent.rows[0].id;
  const sidA = verifyAgentAccessToken(a.accessToken)!.sid;
  await assert.rejects(auth.changeAgentPassword(agentId, sidA, "wrong", "newsecret456"), (e: any) => e.code === "CURRENT_PASSWORD_WRONG");
  const res = await auth.changeAgentPassword(agentId, sidA, "secret123", "newsecret456");
  const claims = verifyAgentAccessToken(res.accessToken)!;
  assert.equal(claims.tv, 1);
  assert.equal(claims.sid, sidA);
  const sidB = verifyAgentAccessToken(b.accessToken)!.sid;
  assert.ok(fake.db.agentSession.rows.find((s: any) => s.id === sidB).revokedAt);
  assert.equal(fake.db.agentSession.rows.find((s: any) => s.id === sidA).revokedAt ?? null, null);
});

test("admin-created agents are ACTIVE with an invite token and no usable password", async () => {
  const { agent, inviteToken } = await auth.createAgentByAdmin(fake.db, { name: "Karim", email: "karim@x.com" }, "U_ADMIN");
  assert.equal(agent.status, "ACTIVE");
  assert.ok(await auth.verifyAgentResetToken(inviteToken));
  const row = fake.db.agentPasswordReset.rows[0];
  assert.ok(row.expiresAt.getTime() - Date.now() > 71 * 3600_000, "72h invite");
});
