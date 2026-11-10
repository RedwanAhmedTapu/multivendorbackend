// tests/auth-refresh-secret.test.ts
//
// Phase 3 — the refresh endpoint's access-token signing secret.
//   1. startup with an empty / missing ACCESS_TOKEN_SECRET fails closed with a clear,
//      non-secret diagnostic (child process; nothing else is printed);
//   2. refresh signs with the secret validated at startup — never with the
//      predictable literal "access-secret", even if the environment variable
//      disappears or is emptied at runtime (the old code read process.env per
//      request and fell back to the literal);
//   3. the refresh response and the server's logs never contain the token.
// Throwaway secrets generated here; no database (refresh doesn't touch it).
//   npx tsx --test tests/auth-refresh-secret.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

const ACCESS = randomBytes(24).toString("hex");
const REFRESH = randomBytes(24).toString("hex");
process.env.ACCESS_TOKEN_SECRET = ACCESS;
process.env.REFRESH_TOKEN_SECRET = REFRESH;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { refresh } = await import("../src/modules/auth/controllers/auth.controller.ts");
// Phase 4: refresh now re-checks the account (auth-refresh-eligibility.test.ts);
// an in-memory active vendor U1 / V1 keeps this file database-free.
const { prisma } = await import("../src/config/prisma.ts");
(prisma.user as any).findUnique = async ({ where }: any) => (where.id === "U1" ? { id: "U1", role: "VENDOR", isActive: true, vendorId: "V1" } : null);
(prisma.vendor as any).findUnique = async ({ where }: any) => (where.id === "V1" ? { id: "V1" } : null);

function callRefresh(cookie: string | undefined): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const res: any = {
      statusCode: 200,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(body: any) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    };
    refresh({ cookies: cookie ? { refreshToken: cookie } : {} } as any, res);
  });
}
const refreshCookie = () => jwt.sign({ id: "U1", role: "VENDOR", vendorId: "V1" }, REFRESH, { algorithm: "HS256", expiresIn: "7d" });

test("1. startup without ACCESS_TOKEN_SECRET fails closed with a clear, non-secret message", () => {
  const env = { ...process.env, REFRESH_TOKEN_SECRET: REFRESH, DATABASE_URL: "postgresql://u:p@127.0.0.1:9/db" };
  // Empty, not deleted: the Prisma client loads the project .env on import but
  // never overrides a variable that is already set, so an empty value is the
  // only way to simulate "not configured" without touching .env.
  env.ACCESS_TOKEN_SECRET = "";
  const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "-e", "import('./src/modules/auth/controllers/auth.controller.ts').then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); })"], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(r.status, 0, "module load must fail");
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /ACCESS_TOKEN_SECRET is required/);
  assert.ok(!out.includes(REFRESH), "no secret in the diagnostic");
});

test("2. refresh signs with the startup secret — never the literal fallback, even if the env var disappears at runtime", async () => {
  for (const mutate of [() => delete process.env.ACCESS_TOKEN_SECRET, () => (process.env.ACCESS_TOKEN_SECRET = "")]) {
    mutate();
    try {
      const r = await callRefresh(refreshCookie());
      assert.equal(r.status, 200);
      const t = r.body.accessToken as string;
      assert.doesNotThrow(() => jwt.verify(t, ACCESS, { algorithms: ["HS256"] }), "verifies with the configured secret");
      assert.throws(() => jwt.verify(t, "access-secret", { algorithms: ["HS256"] }), "not forgeable with the predictable literal");
    } finally {
      process.env.ACCESS_TOKEN_SECRET = ACCESS;
    }
  }
  // unchanged contract
  assert.equal((await callRefresh(undefined)).status, 401);
  assert.equal((await callRefresh(jwt.sign({ id: "U1" }, "wrong", { expiresIn: "1h" }))).status, 403);
});

test("3. the issued access token is never written to the server's logs", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) (console as any)[k] = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  let token = "";
  try {
    token = (await callRefresh(refreshCookie())).body.accessToken;
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(token.length > 20);
  assert.ok(!lines.some((l) => l.includes(token) || l.includes(ACCESS)), lines.join("\n"));
});
