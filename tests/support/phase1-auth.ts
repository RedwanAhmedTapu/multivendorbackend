// tests/support/phase1-auth.ts
//
// Shared DB-free harness for the Phase 1 security suites: runs a route's
// REAL middleware chain (authenticateUser → … → controller) for a set of
// identities. authenticateUser's user/vendor/employee lookups and the
// permission re-reads (prisma.employee.findUnique) are stubbed on the shared
// Prisma client; tokens are signed with the test process's
// ACCESS_TOKEN_SECRET. Controllers are never invoked.

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { prisma } from "../../src/config/prisma.ts";

export type Person = {
  user: { id: string; role: string; vendorId: string | null };
  employee: { id: string; vendorId: string | null; permissions: Record<string, unknown> } | null;
};

export const PEOPLE = {
  ADMIN: { user: { id: "U_ADMIN", role: "ADMIN", vendorId: null }, employee: { id: "EMP_ADMIN", vendorId: null, permissions: {} } },
  ADMIN_EMP_WITH: { user: { id: "U_AEMP1", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_A1", vendorId: null, permissions: { productManagement: true, offerManagement: true } } },
  ADMIN_EMP_WITHOUT: { user: { id: "U_AEMP2", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_A2", vendorId: null, permissions: { orderManagement: true } } },
  VENDOR_EMP_WITH: { user: { id: "U_VEMP1", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_V1", vendorId: "V1", permissions: { productManagement: true, offerManagement: true } } },
  VENDOR_EMP_WITHOUT: { user: { id: "U_VEMP2", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_V2", vendorId: "V1", permissions: { orderManagement: true } } },
  VENDOR: { user: { id: "U_VENDOR", role: "VENDOR", vendorId: "V1" }, employee: null },
  CUSTOMER: { user: { id: "U_CUST", role: "CUSTOMER", vendorId: null }, employee: null },
} satisfies Record<string, Person>;

export type Who = keyof typeof PEOPLE | "ANONYMOUS";
export const WHO: Who[] = [...(Object.keys(PEOPLE) as (keyof typeof PEOPLE)[]), "ANONYMOUS"];

/** Stub the Prisma reads used by authenticateUser and the permission gates. */
export function stubAuth() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  const people = Object.values(PEOPLE) as Person[];
  const byUserId = new Map(people.map((p) => [p.user.id, p]));
  const byEmployeeId = new Map(people.filter((p) => p.employee).map((p) => [p.employee!.id, p.employee!]));
  set(prisma.user, "findUnique", async ({ where }: any) => {
    const p = byUserId.get(where.id);
    return p ? { id: p.user.id, name: "n", email: null, role: p.user.role, isActive: true, vendorId: p.user.vendorId } : null;
  });
  set(prisma.vendor, "findUnique", async ({ where }: any) => (where.id === "V1" ? { id: "V1", storeName: "Store", email: null } : null));
  set(prisma.employee, "findFirst", async ({ where }: any) => {
    const e = byUserId.get(where.userId)?.employee;
    return e ? { id: e.id, vendorId: e.vendorId } : null;
  });
  set(prisma.employee, "findUnique", async ({ where }: any) => {
    const e = byEmployeeId.get(where.id);
    return e ? { permissions: e.permissions, isActive: true, vendorId: e.vendorId } : null;
  });
  return () => restores.reverse().forEach((r) => r());
}

export function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, ended: false };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => {
    res.body = b;
    res.ended = true;
    res.onEnd?.();
    return res;
  };
  return res;
}

export function run(fn: any, req: any, res: any): Promise<"next" | "ended"> {
  return new Promise((resolve, reject) => {
    res.onEnd = () => resolve("ended");
    try {
      const out = fn(req, res, (err?: unknown) => (err ? reject(err) : resolve("next")));
      if (out && typeof out.then === "function") out.catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

export function requestFor(who: Who, extra: { body?: any; query?: any; params?: any } = {}) {
  const headers: Record<string, string> = {};
  if (who !== "ANONYMOUS") {
    const p = PEOPLE[who];
    headers.authorization = `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
  }
  return { headers, body: extra.body ?? {}, query: extra.query ?? {}, params: extra.params ?? {} } as any;
}

/** The handler chain of one route on an Express router. */
export function routeHandles(router: any, method: string, path: string): any[] {
  const layer = (router.stack as any[]).find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.map((s: any) => s.handle);
}

/** "controller" when every middleware passed; otherwise "<status>". */
export async function outcome(router: any, who: Who, method: string, path: string): Promise<string> {
  const req = requestFor(who);
  const res = fakeRes();
  for (const layer of (router.stack as any[]).filter((l) => !l.route)) {
    if ((await run(layer.handle, req, res)) === "ended") return String(res.statusCode);
  }
  for (const h of routeHandles(router, method, path).slice(0, -1)) {
    if ((await run(h, req, res)) === "ended") return String(res.statusCode);
  }
  return "controller";
}
