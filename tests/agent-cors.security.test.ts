// tests/agent-cors.security.test.ts
//
// The agent app's origin may call the agent API with credentials, and NOTHING
// else (in particular not the site's /api/auth/refresh, which reads the site's
// refreshToken cookie). Real express + cors over HTTP, no database.
//
//   npx tsx --test tests/agent-cors.security.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import cors from "cors";
import { agentAwareCorsOptions, isAgentApiPath } from "../src/modules/agent/agent-cors.ts";

const SITE = "http://localhost:3000";
const BLOG = "http://localhost:3001";
const AGENT = "http://localhost:3002";
const EVIL = "https://evil.example";

let server: Server;
let base = "";

before(async () => {
  const app = express();
  app.use(cors(agentAwareCorsOptions([SITE, BLOG], AGENT)));
  const okRoute = (_req: express.Request, res: express.Response) => res.json({ ok: true });
  for (const p of ["/api/agent/auth/refresh", "/api/agent/dashboard/summary", "/api/agent", "/api/auth/refresh", "/api/admin/agents", "/api/agents", "/api/user-orders"]) {
    app.get(p, okRoute);
    app.post(p, okRoute);
  }
  // CORS refusals surface as errors; answer without any CORS headers.
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(403).json({ ok: false }));
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

async function call(path: string, origin: string | null, method = "GET") {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (method === "OPTIONS") headers["Access-Control-Request-Method"] = "POST";
  const res = await fetch(base + path, { method, headers });
  return { status: res.status, allowOrigin: res.headers.get("access-control-allow-origin"), allowCredentials: res.headers.get("access-control-allow-credentials") };
}

test("agent origin is allowed, with credentials, on the agent API (requests and preflights)", async () => {
  for (const p of ["/api/agent/auth/refresh", "/api/agent/dashboard/summary", "/api/agent"]) {
    for (const m of ["GET", "OPTIONS"]) {
      const r = await call(p, AGENT, m);
      assert.equal(r.allowOrigin, AGENT, `${m} ${p}`);
      assert.equal(r.allowCredentials, "true", `${m} ${p} credentials`);
    }
  }
});

test("agent origin is refused everywhere else — the site refresh endpoint above all", async () => {
  for (const p of ["/api/auth/refresh", "/api/admin/agents", "/api/agents", "/api/user-orders"]) {
    for (const m of ["POST", "OPTIONS"]) {
      const r = await call(p, AGENT, m);
      assert.equal(r.allowOrigin, null, `${m} ${p} must not allow the agent origin`);
      assert.equal(r.status, 403, `${m} ${p}`);
    }
  }
});

test("site origins keep working on every route, agent API included; unknown origins never", async () => {
  for (const p of ["/api/auth/refresh", "/api/admin/agents", "/api/agent/auth/refresh"]) {
    assert.equal((await call(p, SITE)).allowOrigin, SITE, p);
    assert.equal((await call(p, BLOG)).allowOrigin, BLOG, p);
    assert.equal((await call(p, EVIL)).allowOrigin, null, `${p} evil`);
  }
  // No Origin header (server-to-server): allowed as before.
  assert.equal((await call("/api/auth/refresh", null)).status, 200);
});

test("path matching is exact: /api/agents and /api/admin/agents are not agent API paths", () => {
  assert.equal(isAgentApiPath("/api/agent"), true);
  assert.equal(isAgentApiPath("/api/agent/"), true);
  assert.equal(isAgentApiPath("/api/agent/auth/login"), true);
  for (const p of ["/api/agents", "/api/agentx/auth", "/api/admin/agents", "/api/auth/refresh", "/", ""]) assert.equal(isAgentApiPath(p), false, p);
});

test("server.ts uses the path-scoped CORS and no longer widens the global list", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(src, /app\.use\(cors\(agentAwareCorsOptions\(allowedOrigins, agentFrontendOrigin\(\)\)\)\)/, "REST CORS goes through agentAwareCorsOptions");
  assert.ok(!/restAllowedOrigins/.test(src), "no global list including the agent origin");
  assert.ok(!/\[\s*\.\.\.allowedOrigins\s*,\s*agentFrontendOrigin\(\)\s*\]/.test(src), "agent origin never appended to allowedOrigins");
});
