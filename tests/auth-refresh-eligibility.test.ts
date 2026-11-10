// tests/auth-refresh-eligibility.test.ts
//
// Phase 4 — POST /auth/refresh issues a new access token only to an account
// that authenticateUser would still accept: the user exists and is active, the
// token's role is the user's current role, a VENDOR still has its vendor, an
// EMPLOYEE still has an active employee row. Everything else gets the same
// 403 "Invalid refresh token" as a bad refresh JWT (no account-state detail).
// Contracts kept: 401 without the cookie, 200 { accessToken } on success.
// Throwaway secrets; prisma in memory (no database).
//   npx tsx --test tests/auth-refresh-eligibility.test.ts

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

const ACCESS = randomBytes(24).toString("hex");
const REFRESH = randomBytes(24).toString("hex");
process.env.ACCESS_TOKEN_SECRET = ACCESS;
process.env.REFRESH_TOKEN_SECRET = REFRESH;
const { prisma } = await import("../src/config/prisma.ts");
const { refresh } = await import("../src/modules/auth/controllers/auth.controller.ts");

type Row = Record<string, any>;
let USERS: Record<string, Row>;
let EMPLOYEES: Row[];
let VENDORS: string[];
let dbDown = false;
const restores: (() => void)[] = [];
const swap = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
const db = <T>(v: T) => (dbDown ? Promise.reject(Object.assign(new Error("Can't reach database server at 10.0.0.5"), { code: "P1001" })) : Promise.resolve(v));
swap(prisma.user, "findUnique", ({ where }: Row) => db(USERS[where.id] ? { ...USERS[where.id] } : null));
swap(prisma.employee, "findFirst", ({ where }: Row) => db(EMPLOYEES.find((e) => e.userId === where.userId && (where.isActive === undefined || e.isActive === where.isActive)) ?? null));
swap(prisma.vendor, "findUnique", ({ where }: Row) => db(VENDORS.includes(where.id) ? { id: where.id } : null));
after(() => restores.reverse().forEach((r) => r()));

beforeEach(() => {
  dbDown = false;
  USERS = {
    U_CUST: { id: "U_CUST", role: "CUSTOMER", isActive: true, vendorId: null },
    U_OFF: { id: "U_OFF", role: "CUSTOMER", isActive: false, vendorId: null },
    U_VEND: { id: "U_VEND", role: "VENDOR", isActive: true, vendorId: "V1" },
    U_VGONE: { id: "U_VGONE", role: "VENDOR", isActive: true, vendorId: "V_DELETED" },
    U_EMP: { id: "U_EMP", role: "EMPLOYEE", isActive: true, vendorId: null },
    U_EMPOFF: { id: "U_EMPOFF", role: "EMPLOYEE", isActive: true, vendorId: null },
    U_PROMOTED: { id: "U_PROMOTED", role: "ADMIN", isActive: true, vendorId: null },
  };
  EMPLOYEES = [
    { id: "E1", userId: "U_EMP", isActive: true },
    { id: "E2", userId: "U_EMPOFF", isActive: false },
  ];
  VENDORS = ["V1"];
});

function callRefresh(cookie?: string): Promise<{ status: number; body: any }> {
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
const cookieFor = (id: string, role: string, extra: Row = {}, opts: jwt.SignOptions = { expiresIn: "1d" }) =>
  jwt.sign({ id, role, emailorphone: null, ...extra }, REFRESH, { algorithm: "HS256", ...opts });

test("1. normal refresh: an active user gets a new access token (contract unchanged)", async () => {
  for (const [id, role, extra] of [["U_CUST", "CUSTOMER", {}], ["U_VEND", "VENDOR", { vendorId: "V1" }], ["U_EMP", "EMPLOYEE", {}]] as const) {
    const r = await callRefresh(cookieFor(id, role, extra));
    assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(Object.keys(r.body), ["accessToken"]);
    const p = jwt.verify(r.body.accessToken, ACCESS, { algorithms: ["HS256"] }) as Row;
    assert.equal(p.id, id);
    assert.equal(p.role, role);
  }
});

test("2. ineligible accounts get no token: inactive, deleted, role changed, vendor gone, employee deactivated", async () => {
  const cases: [string, string, Row][] = [
    ["U_OFF", "CUSTOMER", {}],
    ["U_DELETED", "CUSTOMER", {}],
    ["U_PROMOTED", "CUSTOMER", {}], // the token says CUSTOMER, the account is now ADMIN
    ["U_VGONE", "VENDOR", { vendorId: "V_DELETED" }],
    ["U_EMPOFF", "EMPLOYEE", {}],
  ];
  const refused = await callRefresh(cookieFor("U_CUST", "CUSTOMER", {}, { expiresIn: -10 }));
  for (const [id, role, extra] of cases) {
    const r = await callRefresh(cookieFor(id, role, extra));
    assert.equal(r.status, 403, id);
    assert.equal(r.body.accessToken, undefined, `${id} must not receive a token`);
    assert.deepEqual(r.body, refused.body, `${id}: same answer as an invalid refresh token (no account-state detail)`);
  }
});

test("3. invalid refresh credentials: missing (401), expired / wrong secret / garbage (403)", async () => {
  assert.equal((await callRefresh()).status, 401);
  for (const bad of [cookieFor("U_CUST", "CUSTOMER", {}, { expiresIn: -10 }), jwt.sign({ id: "U_CUST", role: "CUSTOMER" }, "wrong-secret"), "not-a-jwt", jwt.sign({ id: "U_CUST", role: "CUSTOMER" }, ACCESS)]) {
    const r = await callRefresh(bad);
    assert.equal(r.status, 403);
    assert.equal(r.body.accessToken, undefined);
  }
});

test("4. database unavailable: no token, no internal detail", async () => {
  dbDown = true;
  const r = await callRefresh(cookieFor("U_CUST", "CUSTOMER"));
  assert.ok(r.status >= 500, `status ${r.status}`);
  assert.equal(r.body.accessToken, undefined);
  assert.ok(!JSON.stringify(r.body).includes("10.0.0.5"));
});
