// tests/agent-auth-isolation.security.test.ts
//
// Agent auth is fully separate from user/admin auth:
//   • an agent token never passes authenticateUser (admin/vendor APIs),
//   • a user/admin token never passes authenticateAgent (agent APIs),
//   • wrong audience / type / stale tokenVersion / revoked session → 401,
//   • a non-active agent → 403,
//   • missing or reused secrets → 503 (agent routes only),
//   • every admin-agent route is ADMIN-only; vendor staff, vendors and
//     customers are refused before any controller.
// DB-free: agentDb is an in-memory fake; authenticateUser's lookups are
// stubbed by tests/support/phase1-auth.ts.
//
//   ACCESS_TOKEN_SECRET=test-only-secret npx tsx --test tests/agent-auth-isolation.security.test.ts

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.ACCESS_TOKEN_SECRET ??= "test-only-user-access-secret";
process.env.REFRESH_TOKEN_SECRET ??= "test-only-user-refresh-secret";
const AGENT_SECRET = "test-only-agent-access-secret-0123456789abcdef";
process.env.AGENT_ACCESS_TOKEN_SECRET = AGENT_SECRET;

const { authenticateUser } = await import("../src/middlewares/auth.middleware.ts");
const { authenticateAgent } = await import("../src/modules/agent/middlewares/agent-auth.middleware.ts");
const { resetAgentAuthConfig, getAgentAuthConfig } = await import("../src/modules/agent/agent.config.ts");
const { signAgentAccessToken } = await import("../src/modules/agent/services/agent-token.service.ts");
const { adminAgentRouter, agentPortalRouter, agentAuthRouter } = await import("../src/modules/agent/agent.routes.ts");
const { installAgentFakeDb } = await import("./support/agent-fake-db.ts");
const { stubAuth, outcome, fakeRes, run, requestFor, WHO } = await import("./support/phase1-auth.ts");

let fake: ReturnType<typeof installAgentFakeDb>;
let restoreAuth: () => void;

before(() => {
  restoreAuth = stubAuth();
});
after(() => restoreAuth());

beforeEach(async () => {
  resetAgentAuthConfig();
  process.env.AGENT_ACCESS_TOKEN_SECRET = AGENT_SECRET;
  fake?.restore();
  fake = installAgentFakeDb();
  await fake.db.agent.create({
    data: { id: "A1", agentCode: "AG-AAAAAA", referralCode: "REF-AAAAAAAA", name: "Agent", email: "a@x.com", passwordHash: "x", status: "ACTIVE", tokenVersion: 0, levelId: null },
  });
  await fake.db.agentSession.create({
    data: { id: "S1", agentId: "A1", refreshTokenHash: "h1", expiresAt: new Date(Date.now() + 3600_000), revokedAt: null },
  });
});

const agentToken = (over: { tv?: number; sid?: string } = {}) =>
  signAgentAccessToken({ agentId: "A1", sessionId: over.sid ?? "S1", tokenVersion: over.tv ?? 0 });

async function runAgentAuth(token?: string) {
  const req: any = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = fakeRes();
  const result = await run(authenticateAgent, req, res);
  return { result, status: res.statusCode, req, body: res.body };
}

test("a valid agent token passes authenticateAgent and sets req.agent", async () => {
  const r = await runAgentAuth(agentToken());
  assert.equal(r.result, "next");
  assert.equal(r.req.agent.id, "A1");
  assert.equal(r.req.agent.sessionId, "S1");
});

test("an AGENT token is refused by authenticateUser (admin/vendor APIs)", async () => {
  const req: any = { headers: { authorization: `Bearer ${agentToken()}` } };
  const res = fakeRes();
  assert.equal(await run(authenticateUser, req, res), "ended");
  assert.equal(res.statusCode, 401);
});

test("USER/ADMIN tokens are refused by authenticateAgent", async () => {
  for (const who of ["ADMIN", "VENDOR", "CUSTOMER", "ADMIN_EMP_WITH"] as const) {
    const token = requestFor(who).headers.authorization.slice(7);
    const r = await runAgentAuth(token);
    assert.equal(r.status, 401, who);
  }
});

test("an agent-shaped token signed with the USER secret is refused", async () => {
  const forged = jwt.sign({ sid: "S1", tv: 0, typ: "agent" }, process.env.ACCESS_TOKEN_SECRET!, {
    algorithm: "HS256",
    subject: "A1",
    audience: "finixmart-agent",
    issuer: "finixmart-api",
    expiresIn: 300,
  });
  assert.equal((await runAgentAuth(forged)).status, 401);
});

test("wrong audience, wrong typ, missing claims and 'none' alg are refused", async () => {
  const base = { algorithm: "HS256" as const, subject: "A1", issuer: "finixmart-api", expiresIn: 300 };
  const wrongAud = jwt.sign({ sid: "S1", tv: 0, typ: "agent" }, AGENT_SECRET, { ...base, audience: "finixmart-admin" });
  const wrongTyp = jwt.sign({ sid: "S1", tv: 0, typ: "user" }, AGENT_SECRET, { ...base, audience: "finixmart-agent" });
  const noSid = jwt.sign({ tv: 0, typ: "agent" }, AGENT_SECRET, { ...base, audience: "finixmart-agent" });
  const unsigned = jwt.sign({ sid: "S1", tv: 0, typ: "agent", sub: "A1", aud: "finixmart-agent", iss: "finixmart-api" }, "", { algorithm: "none" } as any);
  for (const t of [wrongAud, wrongTyp, noSid, unsigned]) assert.equal((await runAgentAuth(t)).status, 401);
  assert.equal((await runAgentAuth()).status, 401);
  assert.equal((await runAgentAuth("garbage")).status, 401);
});

test("a stale tokenVersion is refused (suspend / password change / log out everywhere)", async () => {
  const token = agentToken({ tv: 0 });
  await fake.db.agent.update({ where: { id: "A1" }, data: { tokenVersion: { increment: 1 } } });
  assert.equal((await runAgentAuth(token)).status, 401);
});

test("a revoked, expired or foreign session is refused", async () => {
  await fake.db.agentSession.update({ where: { id: "S1" }, data: { revokedAt: new Date() } });
  assert.equal((await runAgentAuth(agentToken())).status, 401);

  await fake.db.agentSession.create({ data: { id: "S2", agentId: "A1", refreshTokenHash: "h2", expiresAt: new Date(Date.now() - 1000), revokedAt: null } });
  assert.equal((await runAgentAuth(agentToken({ sid: "S2" }))).status, 401);

  await fake.db.agentSession.create({ data: { id: "S3", agentId: "OTHER", refreshTokenHash: "h3", expiresAt: new Date(Date.now() + 3600_000), revokedAt: null } });
  assert.equal((await runAgentAuth(agentToken({ sid: "S3" }))).status, 401);
});

test("a PENDING / SUSPENDED / DEACTIVATED agent is refused with 403", async () => {
  for (const status of ["PENDING", "SUSPENDED", "DEACTIVATED"]) {
    await fake.db.agent.update({ where: { id: "A1" }, data: { status } });
    assert.equal((await runAgentAuth(agentToken())).status, 403, status);
  }
});

test("agent auth is disabled (503) when the agent secret is missing, short, or reused", async () => {
  const userSecret = process.env.ACCESS_TOKEN_SECRET!;
  const reused = "x".repeat(40);
  const cases: Array<{ label: string; agent: string | undefined; user: string }> = [
    { label: "missing", agent: undefined, user: userSecret },
    { label: "short", agent: "too-short", user: userSecret },
    { label: "reused user secret", agent: reused, user: reused },
  ];
  for (const c of cases) {
    resetAgentAuthConfig();
    if (c.agent === undefined) delete process.env.AGENT_ACCESS_TOKEN_SECRET;
    else process.env.AGENT_ACCESS_TOKEN_SECRET = c.agent;
    process.env.ACCESS_TOKEN_SECRET = c.user;
    assert.throws(() => getAgentAuthConfig(), (e: any) => e.statusCode === 503, c.label);
    const r = await runAgentAuth("anything");
    assert.equal(r.status, 503, c.label);
  }
  process.env.ACCESS_TOKEN_SECRET = userSecret;
});

test("every /api/admin/agents route: ADMIN passes; staff without agentManagement, vendors, customers, anonymous refused", async () => {
  // P10: the agent-chat routes answer 404 while AGENT_CHAT_ENABLED is off; switch it on (only these route-gate tests read it) so the admin gate is checked on them too.
  process.env.AGENT_CHAT_ENABLED = "1";
  const routes = (adminAgentRouter as any).stack.filter((l: any) => l.route);
  assert.ok(routes.length >= 25, "admin routes registered");
  for (const layer of routes) {
    const path = layer.route.path;
    const method = Object.keys(layer.route.methods)[0];
    for (const who of WHO) {
      const got = await outcome(adminAgentRouter, who, method, path);
      const expected = who === "ADMIN" ? "controller" : who === "ANONYMOUS" ? "401" : "403";
      assert.equal(got, expected, `${method.toUpperCase()} ${path} as ${who}`);
    }
  }
});

test("agentManagement: admin-side staff holding it pass every admin agent route; vendor staff holding it are still refused", async () => {
  // P10: the agent-chat routes answer 404 while AGENT_CHAT_ENABLED is off; switch it on (only these route-gate tests read it) so the admin gate is checked on them too.
  process.env.AGENT_CHAT_ENABLED = "1";
  const { PEOPLE } = await import("./support/phase1-auth.ts");
  const adminStaff = PEOPLE.ADMIN_EMP_WITH.employee.permissions as Record<string, unknown>;
  const vendorStaff = PEOPLE.VENDOR_EMP_WITH.employee.permissions as Record<string, unknown>;
  adminStaff.agentManagement = true;
  vendorStaff.agentManagement = true;
  try {
    const routes = (adminAgentRouter as any).stack.filter((l: any) => l.route);
    for (const layer of routes) {
      const path = layer.route.path;
      const method = Object.keys(layer.route.methods)[0];
      assert.equal(await outcome(adminAgentRouter, "ADMIN_EMP_WITH", method, path), "controller", `${method.toUpperCase()} ${path} as admin staff with agentManagement`);
      assert.equal(await outcome(adminAgentRouter, "VENDOR_EMP_WITH", method, path), "403", `${method.toUpperCase()} ${path} as vendor staff with agentManagement`);
      assert.equal(await outcome(adminAgentRouter, "ADMIN", method, path), "controller", `${method.toUpperCase()} ${path} as ADMIN`);
    }
    // Revocation bites on the next request (permissions are re-read).
    delete adminStaff.agentManagement;
    assert.equal(await outcome(adminAgentRouter, "ADMIN_EMP_WITH", "get", "/settings"), "403", "revoked");
  } finally {
    delete adminStaff.agentManagement;
    delete vendorStaff.agentManagement;
  }
});

test("an AGENT token is refused on every admin agent route", async () => {
  const token = agentToken();
  const req: any = { headers: { authorization: `Bearer ${token}` }, body: {}, query: {}, params: {} };
  const res = fakeRes();
  const first = (adminAgentRouter as any).stack.find((l: any) => !l.route);
  assert.equal(await run(first.handle, req, res), "ended");
  assert.equal(res.statusCode, 401);
});

test("every /api/agent portal route requires an agent token (admin token → 401)", async () => {
  const gate = (agentPortalRouter as any).stack.find((l: any) => !l.route);
  assert.equal(gate.handle, authenticateAgent, "router-level authenticateAgent");
  const adminToken = requestFor("ADMIN").headers.authorization;
  const res = fakeRes();
  assert.equal(await run(gate.handle, { headers: { authorization: adminToken } } as any, res), "ended");
  assert.equal(res.statusCode, 401);
});

test("authenticated agent-auth endpoints are gated; public ones are not", async () => {
  const gated = ["/logout-all", "/change-password", "/me", "/sessions", "/sessions/:id", "/profile", "/notification-prefs"];
  const publicPaths = ["/register", "/login", "/refresh", "/logout", "/forgot-password", "/verify-reset-token", "/reset-password"];
  for (const layer of (agentAuthRouter as any).stack.filter((l: any) => l.route)) {
    const handles = layer.route.stack.map((s: any) => s.handle);
    if (gated.includes(layer.route.path)) assert.ok(handles.includes(authenticateAgent), `${layer.route.path} gated`);
    if (publicPaths.includes(layer.route.path)) assert.ok(!handles.includes(authenticateAgent), `${layer.route.path} public`);
  }
});

test("agentManagement is an admin-only grant: an ADMIN may grant it, a VENDOR owner may not", async () => {
  const { validatePermissionPatch, ADMIN_ONLY_PERMISSION_KEYS, KNOWN_PERMISSION_KEYS } = await import("../src/middlewares/permission.middleware.ts");
  assert.ok(KNOWN_PERMISSION_KEYS.includes("agentManagement"), "known key");
  assert.ok((ADMIN_ONLY_PERMISSION_KEYS as readonly string[]).includes("agentManagement"), "admin-only");
  assert.deepEqual(validatePermissionPatch({ agentManagement: true }, "ADMIN"), { ok: true });
  assert.equal((validatePermissionPatch({ agentManagement: true }, "VENDOR") as any).status, 403);
});
