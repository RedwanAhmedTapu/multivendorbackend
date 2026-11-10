// tests/pos-security.test.ts
//
// Vendor POS: employee-session authentication, ownership, subscription
// entitlement and subscription payments. DB-free: every Prisma call is stubbed
// on the shared clients (prisma / prismaDirect); gateway clients are stubbed.
// Run with a dead DATABASE_URL/DIRECT_URL so an un-stubbed query can only fail:
//   DATABASE_URL=postgresql://x@127.0.0.1:1/x DIRECT_URL=postgresql://x@127.0.0.1:1/x \
//   ACCESS_TOKEN_SECRET=test npx tsx --test tests/pos-security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { prisma, prismaDirect } from "../src/config/prisma.ts";
import posRoutes from "../src/routes/pos.routes.ts";
import { posSubscriptionAdminRoutes } from "../src/routes/pos-billing.routes.ts";
import { requirePosEntitlement } from "../src/middlewares/pos-entitlement.middleware.ts";
import { PosService } from "../src/services/pos.service.ts";
import { PosController } from "../src/controllers/pos.controller.ts";
import { posSubscriptionService } from "../src/services/pos-subscription.service.ts";
import { evaluateEntitlement, extendFrom, parsePosPolicy, validatePolicyInput, normalizeAmount, sameAmount } from "../src/modules/pos-subscription/entitlement.ts";
import { redactCredential } from "../src/services/payment-gateway.service.ts";
import { paymentService } from "../src/services/payment.service.ts";
import { AccountingService } from "../src/services/accounting.services.ts";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

assert.ok(/127\.0\.0\.1:1\//.test(process.env.DATABASE_URL ?? ""), "run with a dead DATABASE_URL (see header)");
assert.ok(/127\.0\.0\.1:1\//.test(process.env.DIRECT_URL ?? ""), "run with a dead DIRECT_URL (see header)");

// ─── stubbing ─────────────────────────────────────────────────────────────
function stubber() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (had ? (obj[key] = orig) : delete obj[key]));
  };
  const model = (client: any, name: string, methods: Record<string, any>) => {
    if (!client[name]) set(client, name, {});
    for (const [m, fn] of Object.entries(methods)) set(client[name], m, fn);
  };
  return { set, model, restore: () => restores.reverse().forEach((r) => r()) };
}
type S = ReturnType<typeof stubber>;

// ─── identities ───────────────────────────────────────────────────────────
type Person = { user: { id: string; role: string; vendorId: string | null }; employee: { id: string; vendorId: string | null; permissions: Record<string, unknown>; isActive?: boolean } | null };
const PEOPLE: Record<string, Person> = {
  VENDOR: { user: { id: "U_V1", role: "VENDOR", vendorId: "V1" }, employee: null },
  VEMP_POS: { user: { id: "U_E1", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP1", vendorId: "V1", permissions: { posAccess: true } } },
  VEMP_ALL: { user: { id: "U_E3", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP3", vendorId: "V1", permissions: { posAccess: true, posRefund: true, posReports: true, posDiscount: true, posCredit: true } } },
  VEMP_NOPOS: { user: { id: "U_E2", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP2", vendorId: "V1", permissions: { orderManagement: true, posRefund: true } } },
  ADMIN: { user: { id: "U_A", role: "ADMIN", vendorId: null }, employee: { id: "EMP_A", vendorId: null, permissions: {} } },
  AEMP_SUBS: { user: { id: "U_AE", role: "EMPLOYEE", vendorId: null }, employee: { id: "EMP_AE", vendorId: null, permissions: { posSubscriptionManagement: true, posAccess: true } } },
  CUSTOMER: { user: { id: "U_C", role: "CUSTOMER", vendorId: null }, employee: null },
};

function stubAuth(s: S) {
  const people = Object.values(PEOPLE);
  s.set(prisma.user, "findUnique", async ({ where }: any) => {
    const p = people.find((x) => x.user.id === where.id);
    return p ? { id: p.user.id, name: "n", email: null, role: p.user.role, isActive: true, vendorId: p.user.vendorId } : null;
  });
  s.set(prisma.vendor, "findUnique", async ({ where }: any) => (where.id === "V1" ? { id: "V1", storeName: "Store", email: null } : null));
  s.set(prisma.employee, "findFirst", async ({ where }: any) => {
    const e = people.find((x) => x.user.id === where.userId)?.employee;
    return e ? { id: e.id, vendorId: e.vendorId } : null;
  });
  s.set(prisma.employee, "findUnique", async ({ where }: any) => {
    const e = people.map((x) => x.employee).find((x) => x?.id === where.id);
    return e ? { id: e.id, permissions: e.permissions, isActive: e.isActive ?? true, vendorId: e.vendorId } : null;
  });
}
const bearer = (who: string) => {
  const p = PEOPLE[who];
  return `Bearer ${jwt.sign({ id: p.user.id, role: p.user.role }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" })}`;
};

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.setHeader = (k: string, v: string) => (res.headers[k] = v);
  res.json = (b: unknown) => ((res.body = b), res.onEnd?.(), res);
  return res;
}
function runMw(fn: any, req: any, res: any): Promise<"next" | "ended"> {
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
function req(who: string | null, extra: Partial<{ body: any; query: any; params: any; headers: Record<string, string> }> = {}) {
  const headers: Record<string, string> = { ...(extra.headers ?? {}) };
  if (who) headers.authorization = bearer(who);
  return { headers, body: extra.body ?? {}, query: extra.query ?? {}, params: extra.params ?? {}, method: "POST", url: "/x" } as any;
}
/** Run a router's middleware chain for one route; "controller" when everything passed. */
async function outcome(router: any, r: any, method: string, path: string): Promise<string> {
  const res = fakeRes();
  for (const layer of router.stack.filter((l: any) => !l.route)) {
    if ((await runMw(layer.handle, r, res)) === "ended") return String(res.statusCode);
  }
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method} ${path} not registered`);
  for (const h of layer.route.stack.map((x: any) => x.handle).slice(0, -1)) {
    if ((await runMw(h, r, res)) === "ended") return String(res.statusCode);
  }
  return "controller";
}
function stubSubscription(s: S, sub: any) {
  s.model(prisma, "posSubscription", { findUnique: async ({ where }: any) => (where.vendorId === "V1" ? sub : null) });
  s.model(prisma, "platformSettings", { findMany: async () => [] });
}
const ACTIVE_SUB = { status: "ACTIVE", source: "PAID", expiresAt: new Date(Date.now() + 86_400_000) };

// Route categories (every route on the router must be classified).
const ROUTES = (posRoutes as any).stack.filter((l: any) => l.route).map((l: any) => ({ method: Object.keys(l.route.methods)[0], path: l.route.path as string }));
const BILLING = new Set(["get /subscription", "get /subscription/plans", "get /subscription/payments", "post /subscription/checkout"]);
const READS = new Set(["get /me", "get /dashboard", "get /sales", "get /sales/:id", "get /customers", "get /customers/:id", "get /bank-accounts", "get /settings", "get /staff"]);
const OPERATIONS = new Set([
  "get /variant/lookup/:code", "get /products", "post /sales", "post /sales/:id/refund", "post /sales/:id/void", "post /sales/:id/pay-due",
  "post /customers", "put /customers/:id", "post /bank-accounts", "put /settings",
]);

// ═══ 1. Identity: the session only ═════════════════════════════════════════

test("route inventory: every POS route is classified; no terminal-login or staff-mutation route remains", () => {
  const keys = ROUTES.map((r: any) => `${r.method} ${r.path}`);
  for (const k of keys) assert.ok(BILLING.has(k) || READS.has(k) || OPERATIONS.has(k), `unclassified route ${k}`);
  assert.equal(keys.length, BILLING.size + READS.size + OPERATIONS.size);
  for (const gone of ["post /staff/login", "post /:vendorId/staff/login", "get /staff/me", "post /staff", "put /staff/:id", "post /staff/:id/reset-password", "post /staff/from-employee", "post /staff/:id/link-employee"]) {
    assert.ok(!keys.includes(gone), `${gone} must not exist`);
  }
});

test("session gate on every route: vendor owner and vendor staff with posAccess only; scope from the session", async () => {
  const s = stubber();
  stubAuth(s);
  stubSubscription(s, ACTIVE_SUB);
  try {
    const allowed = new Set(["VENDOR", "VEMP_POS", "VEMP_ALL"]);
    const bad: string[] = [];
    for (const who of [...Object.keys(PEOPLE), null]) {
      const r = req(who, { query: { vendorId: "V2" }, body: { vendorId: "V2", staffId: "S9" }, headers: { "x-pos-staff-token": "anything" } });
      const res = fakeRes();
      let got = "pass";
      for (const layer of (posRoutes as any).stack.filter((l: any) => !l.route)) {
        if ((await runMw(layer.handle, r, res)) === "ended") {
          got = String(res.statusCode);
          break;
        }
      }
      const want = who === null ? "401" : allowed.has(who) ? "pass" : "403";
      if (got !== want) bad.push(`${who}: want ${want} got ${got}`);
      if (got === "pass") {
        assert.equal(r.vendorScope, "V1", "payload vendorId ignored");
        assert.equal(r.posActor.userId, PEOPLE[who!].user.id);
        assert.equal(r.posActor.employeeId, PEOPLE[who!].employee?.id ?? null);
      }
    }
    assert.deepEqual(bad, []);
  } finally {
    s.restore();
  }
});

test("revoking posAccess (or deactivating the employee) bites on the next request", async () => {
  const s = stubber();
  stubAuth(s);
  stubSubscription(s, ACTIVE_SUB);
  const emp = PEOPLE.VEMP_POS.employee!;
  try {
    assert.equal(await outcome(posRoutes, req("VEMP_POS"), "post", "/sales"), "controller");
    emp.permissions = { posAccess: false };
    assert.equal(await outcome(posRoutes, req("VEMP_POS"), "post", "/sales"), "403");
    emp.permissions = { posAccess: true };
    emp.isActive = false;
    assert.equal(await outcome(posRoutes, req("VEMP_POS"), "get", "/sales"), "403");
  } finally {
    emp.permissions = { posAccess: true };
    emp.isActive = true;
    s.restore();
  }
});

test("per-action grants: refund/void need posRefund, dashboard posReports, configuration is owner-only", async () => {
  const s = stubber();
  stubAuth(s);
  stubSubscription(s, ACTIVE_SUB);
  try {
    for (const [m, p] of [["post", "/sales/:id/refund"], ["post", "/sales/:id/void"]]) {
      assert.equal(await outcome(posRoutes, req("VEMP_POS"), m, p), "403", `${p} without posRefund`);
      assert.equal(await outcome(posRoutes, req("VEMP_ALL"), m, p), "controller");
      assert.equal(await outcome(posRoutes, req("VENDOR"), m, p), "controller");
    }
    assert.equal(await outcome(posRoutes, req("VEMP_POS"), "get", "/dashboard"), "403");
    assert.equal(await outcome(posRoutes, req("VEMP_ALL"), "get", "/dashboard"), "controller");
    for (const [m, p] of [["put", "/settings"], ["post", "/bank-accounts"], ["get", "/staff"]]) {
      assert.equal(await outcome(posRoutes, req("VEMP_ALL"), m, p), "403", `${p} is owner-only`);
      assert.equal(await outcome(posRoutes, req("VENDOR"), m, p), "controller");
    }
    assert.equal(await outcome(posRoutes, req("VEMP_ALL"), "post", "/subscription/checkout"), "403", "only the owner buys");
  } finally {
    s.restore();
  }
});

// ═══ 2. Entitlement per route category ═════════════════════════════════════

test("every operational route is blocked (402) unless the subscription is active; reads and renewal never are", async () => {
  const states: Record<string, any> = {
    ACTIVE: ACTIVE_SUB,
    EXPIRED_BY_DATE: { status: "ACTIVE", source: "PAID", expiresAt: new Date(Date.now() - 86_400_000) },
    EXPIRED_STATUS: { status: "EXPIRED", source: "TRIAL", expiresAt: new Date(Date.now() + 86_400_000) },
    SUSPENDED: { status: "SUSPENDED", source: "PAID", expiresAt: new Date(Date.now() + 86_400_000) },
    REVOKED: { status: "CANCELLED", source: "PAID", expiresAt: new Date() },
    NONE: null,
    INVALID: { status: "ACTIVE", source: "PAID", expiresAt: null },
  };
  const prev = process.env.POS_SUBSCRIPTION_ENFORCEMENT;
  delete process.env.POS_SUBSCRIPTION_ENFORCEMENT;
  const bad: string[] = [];
  try {
    for (const [name, sub] of Object.entries(states)) {
      const s = stubber();
      stubAuth(s);
      stubSubscription(s, sub);
      try {
        for (const r of ROUTES) {
          const key = `${r.method} ${r.path}`;
          const got = await outcome(posRoutes, req("VENDOR"), r.method, r.path);
          const want = OPERATIONS.has(key) ? (name === "ACTIVE" ? "controller" : "402") : "controller";
          if (got !== want) bad.push(`${name} ${key}: want ${want} got ${got}`);
        }
      } finally {
        s.restore();
      }
    }
    assert.deepEqual(bad, []);
  } finally {
    if (prev !== undefined) process.env.POS_SUBSCRIPTION_ENFORCEMENT = prev;
  }
});

test("monitor mode (explicit) lets operations through with a would-deny flag; grace operates", async () => {
  const s = stubber();
  const prev = process.env.POS_SUBSCRIPTION_ENFORCEMENT;
  try {
    stubSubscription(s, null);
    process.env.POS_SUBSCRIPTION_ENFORCEMENT = "monitor";
    const res = fakeRes();
    assert.equal(await runMw(requirePosEntitlement, { vendorScope: "V1", method: "POST" }, res), "next");
    assert.equal(res.headers["X-POS-Entitlement"], "would-deny:NONE");
    delete process.env.POS_SUBSCRIPTION_ENFORCEMENT;
    s.model(prisma, "platformSettings", { findMany: async () => [{ key: "pos.grace.days", value: "3" }] });
    s.model(prisma, "posSubscription", { findUnique: async () => ({ status: "ACTIVE", source: "PAID", expiresAt: new Date(Date.now() - 86_400_000) }) });
    await posSubscriptionService.getPolicy(prisma as any, { fresh: true }); // refresh the policy cache
    const res2 = fakeRes();
    assert.equal(await runMw(requirePosEntitlement, { vendorScope: "V1", method: "POST" }, res2), "next");
    assert.equal(res2.headers["X-POS-Entitlement"], "grace");
  } finally {
    if (prev === undefined) delete process.env.POS_SUBSCRIPTION_ENFORCEMENT;
    else process.env.POS_SUBSCRIPTION_ENFORCEMENT = prev;
    s.model(prisma, "platformSettings", { findMany: async () => [] });
    await posSubscriptionService.getPolicy(prisma as any, { fresh: true });
    s.restore();
  }
});

test("a permitted employee of an unentitled store is refused (independent checks)", async () => {
  const s = stubber();
  stubAuth(s);
  stubSubscription(s, null);
  try {
    assert.equal(await outcome(posRoutes, req("VEMP_ALL"), "post", "/sales/:id/refund"), "402");
    assert.equal(await outcome(posRoutes, req("VEMP_ALL"), "get", "/sales"), "controller", "history stays readable");
  } finally {
    s.restore();
  }
});

// ═══ 3. Service: ownership, attribution, permissions ══════════════════════

const svc = new PosService();
const cashier = { userId: "U_E1", employeeId: "EMP1", isOwner: false, displayName: "Cashier", grants: { posDiscount: false, posCredit: false, posRefund: false, posReports: false } };
const owner = { userId: "U_V1", employeeId: null, isOwner: true, displayName: "Owner", grants: { posDiscount: true, posCredit: true, posRefund: true, posReports: true } };

test("payload vendorId is ignored: list and read use the session scope", async () => {
  const s = stubber();
  try {
    let where: any;
    s.model(prisma, "posSale", { findMany: async (a: any) => ((where = a.where), []), count: async () => 0 });
    const c = new PosController();
    await c.listSales({ vendorScope: "V1", posActor: cashier, query: { vendorId: "V2" } } as any, fakeRes());
    assert.equal(where.vendorId, "V1");
    let got: any;
    s.model(prisma, "posSale", { findFirst: async (a: any) => ((got = a.where), null) });
    const res = fakeRes();
    await c.getSale({ vendorScope: "V1", posActor: cashier, params: { id: "SALE_OF_V2" } } as any, res);
    assert.deepEqual(got, { id: "SALE_OF_V2", vendorId: "V1" });
    assert.equal(res.statusCode, 404);
  } finally {
    s.restore();
  }
});

test("cross-vendor ids: refund / void / pay-due / customer update → 404, nothing written", async () => {
  const s = stubber();
  const writes: string[] = [];
  const tx: any = {
    posSale: { findFirst: async () => null, update: async () => writes.push("sale.update"), updateMany: async () => (writes.push("sale.updateMany"), { count: 1 }) },
    posSaleItem: { updateMany: async () => (writes.push("item.updateMany"), { count: 1 }) },
  };
  try {
    s.set(prismaDirect, "$transaction", async (work: any) => work(tx));
    s.model(prisma, "posCustomer", { findFirst: async () => null, update: async () => writes.push("customer.update") });
    await assert.rejects(svc.refundSale("V1", owner, "FOREIGN", {}), (e: any) => e.statusCode === 404);
    await assert.rejects(svc.voidSale("V1", owner, "FOREIGN", "oops"), (e: any) => e.statusCode === 404);
    await assert.rejects(svc.payDue("V1", owner, "FOREIGN", { payingAmount: 10, paymentMethod: "CASH" }), (e: any) => e.statusCode === 404);
    await assert.rejects(svc.updateCustomer("V1", "FOREIGN", { name: "x" }, true), (e: any) => e.statusCode === 404);
    assert.deepEqual(writes, []);
  } finally {
    s.restore();
  }
});

test("customer writes are whitelisted: balances can't be set, credit terms need posCredit", async () => {
  const s = stubber();
  try {
    let data: any;
    s.model(prisma, "posCustomer", { create: async (a: any) => ((data = a.data), a.data) });
    await svc.createCustomer("V1", { name: "Rahim", phone: "017", due: -5000, walletBalance: 99999, vendorId: "V2", id: "X" }, false);
    assert.equal(data.vendorId, "V1");
    for (const k of ["due", "walletBalance", "id"]) assert.ok(!(k in data), `${k} not writable`);
    await assert.rejects(svc.createCustomer("V1", { name: "R", phone: "1", loanLimit: 500 }, false), (e: any) => e.statusCode === 403);
  } finally {
    s.restore();
  }
});

function saleStubs(s: S, opts: { failAccounting?: boolean } = {}) {
  const committed: string[] = [];
  const created: any[] = [];
  s.model(prisma, "productVariant", {
    findMany: async ({ where }: any) =>
      (where.id.in as string[])
        .filter((id) => id === "VAR1" && where.product.vendorId === "V1")
        .map((id) => ({ id, name: "Red", price: { toString: () => "100" }, specialPrice: null, avgCost: 60, taxRate: 0, product: { name: "Shirt" } })),
  });
  s.model(prisma, "vendorWarehouse", {
    findMany: async ({ where }: any) => (where.id.in as string[]).filter((id) => id === "WH1" && where.vendorId === "V1").map((id) => ({ id, isActive: true })),
  });
  s.model(prisma, "warehouseRack", { findMany: async () => [{ id: "RK_OTHER", warehouseId: "WH_OTHER" }] });
  s.model(prisma, "posCustomer", { findFirst: async ({ where }: any) => (where.id === "C1" && where.vendorId === "V1" ? { id: "C1", name: "Karim" } : null) });
  s.model(prisma, "posBankAccount", { findFirst: async ({ where }: any) => (where.id === "B1" && where.vendorId === "V1" ? { id: "B1" } : null) });
  s.model(prisma, "posSettings", { findUnique: async () => ({ invoicePrefix: "INV", voucherPrefix: "POSV" }) });
  s.model(prisma, "vendor", { findUnique: async ({ where }: any) => (where.id === "V1" ? { status: "ACTIVE" } : null) });
  s.model(prisma, "posSale", { findFirst: async () => ({ id: "SALE1" }) });
  s.set(prismaDirect, "$transaction", async (work: any) => {
    const staged: string[] = [];
    const tx: any = {
      warehouseStock: { findFirst: async () => ({ id: "WS", quantity: 10, reservedQty: 0, damagedQty: 0 }), update: async () => staged.push("stock") },
      productVariant: { update: async () => staged.push("variant.stock") },
      posSale: {
        findFirst: async () => null,
        create: async ({ data }: any) => (staged.push("sale"), created.push(data), { id: "SALE1", invoiceNo: "INV-1", customerId: data.customerId, items: data.items.create.map((i: any, n: number) => ({ ...i, id: `IT${n}` })) }),
        update: async () => staged.push("sale.voucherLink"),
      },
      stockMovement: { create: async ({ data }: any) => staged.push(`movement:${data.createdBy}`) },
    };
    const result = await work(tx);
    committed.push(...staged);
    return result;
  });
  s.set(AccountingService.prototype, "createPOSSaleVoucher", async (_d: any, db: any) => {
    assert.ok(db, "voucher is posted on the sale's transaction client");
    if (opts.failAccounting) throw new Error("COA account not found");
    return { id: "VOUCHER1" };
  });
  return { committed, created };
}

test("createSale: foreign variant / warehouse / rack / customer / bank account are refused before any write", async () => {
  const s = stubber();
  const { committed } = saleStubs(s);
  const base = { paidAmount: 100, paymentMethod: "CASH" as const };
  try {
    await assert.rejects(svc.createSale("V1", cashier, { ...base, items: [{ variantId: "VAR_OF_V2", qty: 1, warehouseId: "WH1" }] }), (e: any) => e.statusCode === 404);
    await assert.rejects(svc.createSale("V1", cashier, { ...base, items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH_OF_V2" }] }), (e: any) => e.statusCode === 404);
    await assert.rejects(svc.createSale("V1", cashier, { ...base, items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1", rackId: "RK_OTHER" }] }), (e: any) => e.statusCode === 404);
    await assert.rejects(svc.createSale("V1", cashier, { ...base, customerId: "C_OF_V2", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] }), (e: any) => e.statusCode === 404);
    await assert.rejects(svc.createSale("V1", cashier, { ...base, bankAccountId: "B_OF_V2", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] }), (e: any) => e.statusCode === 404);
    await assert.rejects(svc.createSale("V1", cashier, { ...base, items: [{ variantId: "VAR1", qty: 1 }] }), /warehouse/);
    await assert.rejects(svc.createSale("V1", cashier, { ...base, items: [{ variantId: "VAR1", qty: -3, warehouseId: "WH1" }] }), /whole number/);
    assert.deepEqual(committed, []);
  } finally {
    s.restore();
  }
});

test("createSale: attributed to the authenticated employee; client staffId/price/cost/date ignored; discount and credit need grants", async () => {
  const s = stubber();
  const { created, committed } = saleStubs(s);
  try {
    await svc.createSale("V1", cashier, {
      paidAmount: 200,
      paymentMethod: "CASH",
      items: [{ variantId: "VAR1", qty: 2, warehouseId: "WH1", price: 1, cost: 0 } as any],
      ...({ staffId: "SOMEONE_ELSE", vendorId: "V2", saleDate: "2020-01-01", soldByEmployeeId: "EMP_X" } as any),
    });
    const d = created[0];
    assert.equal(d.vendorId, "V1");
    assert.equal(d.staffId, null, "no legacy terminal attribution written");
    assert.equal(d.soldByUserId, "U_E1");
    assert.equal(d.soldByEmployeeId, "EMP1", "the authenticated employee");
    assert.equal(d.items.create[0].price, 100, "catalog price, not the client's");
    assert.equal(d.items.create[0].cost, 60, "server cost");
    assert.ok(Math.abs(d.saleDate.getTime() - Date.now()) < 60_000, "server time");
    assert.ok(committed.includes("movement:EMP1"), "stock movement attributed to the employee");

    created.length = 0;
    await svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: "CASH", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] });
    assert.equal(created[0].soldByUserId, "U_V1");
    assert.equal(created[0].soldByEmployeeId, null, "owner sale");

    await assert.rejects(svc.createSale("V1", cashier, { paidAmount: 90, paymentMethod: "CASH", discountType: "FLAT", discountAmount: 10, items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] }), (e: any) => e.statusCode === 403, "discount needs posDiscount");
    await assert.rejects(svc.createSale("V1", cashier, { paidAmount: 50, paymentMethod: "CASH", customerId: "C1", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] }), (e: any) => e.statusCode === 403, "credit needs posCredit");
    await assert.rejects(svc.createSale("V1", { ...cashier, grants: { ...cashier.grants, posCredit: true } }, { paidAmount: 50, paymentMethod: "CASH", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] }), /customer/, "credit needs a customer");
  } finally {
    s.restore();
  }
});

test("createSale: an accounting failure rolls back the sale and stock (single transaction)", async () => {
  const s = stubber();
  const { committed } = saleStubs(s, { failAccounting: true });
  try {
    await assert.rejects(svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: "CASH", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] }), /COA account not found/);
    assert.deepEqual(committed, []);
  } finally {
    s.restore();
  }
});

test("payment methods: Purchase Entry values and supplier fields never enter a sale; every terminal method posts to a seeded vendor ledger account", async () => {
  const s = stubber();
  const { created, committed } = saleStubs(s);
  const vouchers: any[] = [];
  s.set(AccountingService.prototype, "createPOSSaleVoucher", async (d: any) => (vouchers.push(d), { id: "VOUCHER1" }));
  const items = [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }];
  try {
    // Purchase Entry's human values (and anything else) are not POS methods.
    for (const v of ["Cheque", "CHEQUE", "Bank Transfer", "Mobile Banking", "Cash", "cash", "PURCHASE", "", null]) {
      await assert.rejects(svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: v as any, items }), (e: any) => e.statusCode === 400, String(v));
    }
    assert.deepEqual(committed, [], "nothing written for a refused method");
    // The only account id a sale accepts is a legacy PosBankAccount of this vendor:
    // a VendorPaymentAccount id (or another vendor's account) is refused, not attached.
    await assert.rejects(svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: "BANK_TRANSFER", bankAccountId: "VPA1", items }), (e: any) => e.statusCode === 404);
    await assert.rejects(svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: "CARD", bankAccountId: "B_OF_V2", items }), (e: any) => e.statusCode === 404);
    assert.deepEqual(committed, []);

    const supplierish = { supplierId: "SUP1", purchaseId: "PO1", purchaseOrderId: "PO1", purchasePaymentId: "PP1", vendorPaymentAccountId: "VPA1" };
    for (const m of ["CASH", "CARD", "BANK_TRANSFER", "BKASH", "NAGAD"]) {
      created.length = 0;
      await svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: m as any, items, ...(supplierish as any) });
      assert.equal(created[0].paymentMethod, m);
      for (const k of Object.keys(supplierish)) assert.ok(!(k in created[0]), `${k} never reaches the sale`);
    }
  } finally {
    s.restore();
  }

  // Which ledger account each terminal method debits, vs. the vendor COA seed
  // (VENDOR_COA is module-private next to its own PrismaClient: read the source).
  const src = readFileSync(new URL("../src/services/accounting.services.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const VENDOR_COA"), src.indexOf("];", src.indexOf("const VENDOR_COA")));
  const seeded = new Set([...block.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]));
  assert.ok(seeded.has("Cash at Bank Account") && seeded.size >= 10, "seed list parsed");
  const t = stubber();
  const debited: string[] = [];
  const STOP = new Error("stop");
  t.set(AccountingService.prototype, "resolveAccountIdIn", async (_db: any, _t: any, _id: any, _c: any, name: string) => {
    debited.push(name);
    throw STOP;
  });
  try {
    const acc = new AccountingService();
    const voucherFor = async (label: string) => {
      debited.length = 0;
      await assert.rejects(acc.createPOSSaleVoucher({ vendorId: "V1", paymentMethod: label, paidAmount: 100, dueAmount: 0 } as any, {} as any), STOP);
      return debited[0];
    };
    for (const d of vouchers) assert.ok(seeded.has(await voucherFor(d.paymentMethod)), `${d.paymentMethod} → seeded account`);
    assert.equal(vouchers.length, 5);
    // Why the terminal does not offer Rocket: its account is not in the seed.
    assert.equal(seeded.has(await voucherFor("Rocket")), false);
  } finally {
    t.restore();
  }
});

test("refund bounded per line; a concurrent refund of the same line loses", async () => {
  const s = stubber();
  const sale = { id: "SALE1", vendorId: "V1", invoiceNo: "INV-1", status: "PAID", subtotal: 200, discountAmount: 0, taxAmount: 0, customerId: null, paymentMethod: "CASH", saleDate: new Date(), items: [{ id: "IT1", qty: 2, refundedQty: 1, price: 100, cost: 60, name: "Shirt", variantId: null, warehouseId: null, rackId: null, taxRate: 0 }] };
  let conditional: any;
  const tx: any = {
    posSale: { findFirst: async ({ where }: any) => (where.vendorId === "V1" && where.id === "SALE1" ? sale : null), update: async () => ({}) },
    posSaleItem: { updateMany: async (a: any) => ((conditional = a.where), { count: 0 }), findMany: async () => [] },
  };
  try {
    s.set(prismaDirect, "$transaction", async (work: any) => work(tx));
    await assert.rejects(svc.refundSale("V1", owner, "SALE1", { items: [{ saleItemId: "IT1", qty: 2 }] }), /exceeds what is left/);
    await assert.rejects(svc.refundSale("V1", owner, "SALE1", { items: [{ saleItemId: "IT1", qty: 1 }] }), (e: any) => e.statusCode === 409);
    assert.deepEqual(conditional, { id: "IT1", saleId: "SALE1", refundedQty: { lte: 1 } });
  } finally {
    s.restore();
  }
});

test("pay-due: bounded by the due and decremented conditionally", async () => {
  const s = stubber();
  const sale = { id: "SALE1", vendorId: "V1", invoiceNo: "INV-1", status: "PENDING", customerId: "C1", dueAmount: 50 };
  let dec: any;
  const tx: any = { posSale: { findFirst: async () => sale, updateMany: async (a: any) => ((dec = a), { count: 0 }) } };
  try {
    s.set(prismaDirect, "$transaction", async (work: any) => work(tx));
    await assert.rejects(svc.payDue("V1", cashier, "SALE1", { payingAmount: 80, paymentMethod: "CASH" }), /exceeds due/);
    await assert.rejects(svc.payDue("V1", cashier, "SALE1", { payingAmount: 30, paymentMethod: "CASH" }), (e: any) => e.statusCode === 409);
    assert.equal(dec.where.vendorId, "V1");
    assert.equal(dec.data.dueAmount.decrement, 30);
  } finally {
    s.restore();
  }
});

// ═══ 4. Entitlement rules ══════════════════════════════════════════════════

const NOW = new Date("2026-10-22T06:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

test("evaluator: only ACTIVE/GRACE operate; EXPIRED status always blocks", () => {
  const e = (sub: any, g = 0) => evaluateEntitlement(sub, NOW, g);
  assert.deepEqual([e(null).state, e(null).canOperate], ["NONE", false]);
  assert.deepEqual([e({ status: "ACTIVE", source: "PAID", expiresAt: days(3) }).state, e({ status: "ACTIVE", source: "PAID", expiresAt: days(3) }).daysLeft], ["ACTIVE", 3]);
  assert.equal(e({ status: "ACTIVE", source: "PAID", expiresAt: days(-1) }).canOperate, false);
  assert.equal(e({ status: "ACTIVE", source: "PAID", expiresAt: days(-1) }, 3).state, "GRACE");
  assert.equal(e({ status: "ACTIVE", source: "PAID", expiresAt: days(-4) }, 3).state, "EXPIRED");
  assert.equal(e({ status: "EXPIRED", source: "TRIAL", expiresAt: days(10) }).canOperate, false, "status wins over a future date");
  assert.equal(e({ status: "SUSPENDED", source: "PAID", expiresAt: days(10) }).canOperate, false);
  assert.equal(e({ status: "CANCELLED", source: "PAID", expiresAt: days(10) }).canOperate, false);
  assert.equal(e({ status: "ACTIVE", source: "PAID", expiresAt: null }).state, "INVALID");
  assert.equal(e({ status: "ACTIVE", source: "COMPLIMENTARY", expiresAt: null }).canOperate, true);
  assert.equal(e({ status: "WEIRD", source: "PAID", expiresAt: days(10) }).state, "INVALID");
});

test("extension, policy and money helpers", () => {
  assert.equal(extendFrom(days(5), NOW, 30).getTime(), days(35).getTime());
  assert.equal(extendFrom(days(-5), NOW, 30).getTime(), days(30).getTime());
  assert.throws(() => extendFrom(null, NOW, 0));
  assert.deepEqual(parsePosPolicy({}), { trialEnabled: false, trialDays: null, graceDays: 0 });
  assert.equal(validatePolicyInput({ trialEnabled: true }).ok, false);
  assert.equal(normalizeAmount("1500.0000"), "1500.00");
  assert.equal(normalizeAmount("1500.001"), null);
  assert.equal(sameAmount("1499.99", "1500.00"), false);
});

// ═══ 5. Trial (inside the approval transaction) ════════════════════════════

function trialTx(state: { grants: Set<string>; subs: Set<string>; settings: Record<string, string> }) {
  const writes: string[] = [];
  const tx: any = {
    platformSettings: { findMany: async () => Object.entries(state.settings).map(([key, value]) => ({ key, value })) },
    posSubscription: {
      findUnique: async ({ where }: any) => (state.subs.has(where.vendorId) ? { id: "SUB" } : null),
      create: async ({ data }: any) => (writes.push("sub"), state.subs.add(data.vendorId), { id: "SUB", ...data }),
    },
    posTrialGrant: {
      createMany: async ({ data }: any) => {
        if (state.grants.has(data[0].vendorId)) return { count: 0 };
        state.grants.add(data[0].vendorId);
        writes.push("grant");
        return { count: 1 };
      },
    },
    posSubscriptionPeriod: { create: async () => writes.push("period") },
  };
  return { tx, writes };
}

test("trial: off by default; granted once; re-approval and existing subscriptions never grant another", async () => {
  const state = { grants: new Set<string>(), subs: new Set<string>(), settings: {} as Record<string, string> };
  let t = trialTx(state);
  assert.deepEqual(await posSubscriptionService.grantTrialOnApproval(t.tx, "V1", "VENDOR_APPROVAL", NOW), { granted: false, reason: "trial-disabled" });
  assert.deepEqual(t.writes, []);
  state.settings = { "pos.trial.enabled": "true", "pos.trial.days": "30" };
  t = trialTx(state);
  assert.equal((await posSubscriptionService.grantTrialOnApproval(t.tx, "V1", "VENDOR_APPROVAL", NOW)).granted, true);
  assert.deepEqual(t.writes, ["grant", "sub", "period"]);
  state.subs.delete("V1");
  t = trialTx(state);
  assert.deepEqual(await posSubscriptionService.grantTrialOnApproval(t.tx, "V1", "VENDOR_VERIFICATION", NOW), { granted: false, reason: "already-granted" });
  state.subs.add("V2");
  t = trialTx(state);
  assert.deepEqual(await posSubscriptionService.grantTrialOnApproval(t.tx, "V2", "VENDOR_APPROVAL", NOW), { granted: false, reason: "has-subscription" });
});

// ═══ 6. Admin lifecycle ════════════════════════════════════════════════════

function lifecycleStubs(s: S, sub: any, opts: { versionConflict?: boolean } = {}) {
  const log: any[] = [];
  const tx: any = {
    vendor: { findUnique: async () => ({ id: "V1" }) },
    posSubscription: {
      findUnique: async () => sub,
      updateMany: async (a: any) => (log.push(["update", a]), { count: opts.versionConflict ? 0 : 1 }),
      findUniqueOrThrow: async () => ({ ...sub, ...log.at(-1)[1].data }),
      create: async (a: any) => (log.push(["create", a]), { id: "SUBNEW", ...a.data }),
    },
    posSubscriptionPeriod: { create: async (a: any) => log.push(["period", a.data]), findFirst: async () => ({ previousStatus: "CANCELLED" }) },
    auditLog: { create: async (a: any) => log.push(["audit", a.data]) },
  };
  s.set(prismaDirect, "$transaction", async (work: any) => work(tx));
  return log;
}
const admin = { rawId: "U_A", role: "ADMIN" };

test("admin operations need a reason, use optimistic concurrency and write period + audit rows", async () => {
  const s = stubber();
  try {
    const sub = { id: "SUB1", vendorId: "V1", status: "EXPIRED", source: "TRIAL", expiresAt: new Date(Date.now() - 2 * 86_400_000), version: 3, planId: null };
    let log = lifecycleStubs(s, sub);
    await assert.rejects(posSubscriptionService.extend("V1", { days: 30 }, admin), /reason/);
    await posSubscriptionService.extend("V1", { days: 30, reason: "Goodwill extension" }, admin);
    const upd = log.find((l) => l[0] === "update")[1];
    assert.deepEqual(upd.where, { id: "SUB1", version: 3 });
    assert.equal(upd.data.status, "ACTIVE", "an audited extension restores access");
    assert.ok(Math.abs(upd.data.expiresAt.getTime() - (Date.now() + 30 * 86_400_000)) < 2000, "expired → counts from now");
    assert.equal(log.find((l) => l[0] === "audit")[1].userId, "U_A");

    log = lifecycleStubs(s, { ...sub, status: "ACTIVE" }, { versionConflict: true });
    await assert.rejects(posSubscriptionService.suspend("V1", { reason: "Fraud review" }, admin), (e: any) => e.statusCode === 409);
    assert.ok(!log.some((l) => l[0] === "period"));

    log = lifecycleStubs(s, { ...sub, status: "SUSPENDED" });
    await posSubscriptionService.restore("V1", { reason: "Review cleared" }, admin);
    assert.equal(log.find((l) => l[0] === "update")[1].data.status, "CANCELLED", "a revoked-then-suspended subscription stays revoked");
  } finally {
    s.restore();
  }
});

test("admin subscription routes: ADMIN or admin staff with posSubscriptionManagement; plans/policy writes ADMIN only", async () => {
  const s = stubber();
  stubAuth(s);
  try {
    const r = posSubscriptionAdminRoutes as any;
    assert.equal(await outcome(r, req("ADMIN"), "get", "/"), "controller");
    assert.equal(await outcome(r, req("AEMP_SUBS"), "post", "/:vendorId/extend"), "controller");
    assert.equal(await outcome(r, req("AEMP_SUBS"), "put", "/policy"), "403");
    assert.equal(await outcome(r, req("AEMP_SUBS"), "post", "/plans"), "403");
    for (const who of ["VENDOR", "VEMP_POS", "VEMP_NOPOS", "CUSTOMER"]) assert.equal(await outcome(r, req(who), "get", "/"), "403", who);
  } finally {
    s.restore();
  }
});

// ═══ 7. Subscription payments ══════════════════════════════════════════════

const PAYMENT = { id: "P1", tranId: "POSSUB1", vendorId: "V1", planId: "PL1", status: "PENDING", gateway: "SSLCOMMERZ", amount: { toFixed: () => "1500.00" }, currency: "BDT", durationDays: 30, paymentProviderId: "sslcommerz" };

test("callbacks: forged / unverified / mismatched / failed payments never unlock access", async () => {
  const s = stubber();
  const writes: string[] = [];
  let applied = 0;
  try {
    s.model(prisma, "posSubscriptionPayment", {
      findUnique: async () => PAYMENT,
      updateMany: async (a: any) => (writes.push(`payment:${a.data.status ?? "note"}`), { count: 1 }),
    });
    s.set(prismaDirect, "$transaction", async () => {
      applied++;
      throw new Error("must not apply");
    });
    s.set(paymentService, "verifiedSslcommerzOutcome", async () => ({ kind: "UNVERIFIED" }));
    assert.equal(await posSubscriptionService.handleCallback("SSLCOMMERZ", "POSSUB1"), "pending", "forged success redirect");
    s.set(paymentService, "validatePayment", async () => ({ status: "VALID", tran_id: "POSSUB1", amount: "15.00", currency: "BDT", currency_type: "BDT", currency_amount: "15.00" }));
    assert.equal(await posSubscriptionService.handleCallback("SSLCOMMERZ", "POSSUB1", { valId: "V" }), "pending", "amount mismatch");
    s.set(paymentService, "validatePayment", async () => ({ status: "VALID", tran_id: "OTHER", amount: "1500.00", currency: "BDT", currency_type: "BDT", currency_amount: "1500.00" }));
    assert.equal(await posSubscriptionService.handleCallback("SSLCOMMERZ", "POSSUB1", { valId: "V" }), "pending", "val_id of another transaction");
    s.set(paymentService, "validatePayment", async () => ({ status: "VALID", tran_id: "POSSUB1", amount: "1500.00", currency: "USD", currency_type: "USD", currency_amount: "1500.00" }));
    assert.equal(await posSubscriptionService.handleCallback("SSLCOMMERZ", "POSSUB1", { valId: "V" }), "pending", "wrong currency");
    assert.equal(await posSubscriptionService.handleCallback("EPS", "POSSUB1"), "unknown", "gateway mismatch");
    s.set(paymentService, "verifiedSslcommerzOutcome", async () => ({ kind: "FAILED" }));
    assert.equal(await posSubscriptionService.handleCallback("SSLCOMMERZ", "POSSUB1"), "failed");
    assert.equal(applied, 0, "no entitlement transaction ever ran");
    assert.ok(writes.every((w) => w === "payment:note" || w === "payment:FAILED"));
  } finally {
    s.restore();
  }
});

function applyTx(state: { status: string; expires: Date | null; version: number; conflictsLeft: number; periods: any[] }) {
  return {
    posSubscriptionPayment: {
      findUnique: async () => ({ ...PAYMENT, status: state.status }),
      updateMany: async (a: any) => (a.where.status.in.includes(state.status) ? ((state.status = "PAID"), { count: 1 }) : { count: 0 }),
    },
    posSubscription: {
      findUnique: async () => ({ id: "SUB1", vendorId: "V1", status: "ACTIVE", source: "TRIAL", expiresAt: state.expires, version: state.version }),
      updateMany: async (a: any) => {
        if (state.conflictsLeft > 0) {
          state.conflictsLeft--;
          return { count: 0 };
        }
        state.expires = a.data.expiresAt;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ id: "SUB1", status: "ACTIVE", expiresAt: state.expires, planId: "PL1" }),
    },
    posSubscriptionPeriod: { create: async (a: any) => state.periods.push(a.data) },
    auditLog: { create: async () => ({}) },
  };
}

test("verified payment: applied exactly once (duplicate callbacks), atomic period, retried past a concurrent admin change", async () => {
  const s = stubber();
  try {
    // Transaction semantics: a thrown error rolls back the payment flip.
    const state = { status: "PENDING", expires: new Date(Date.now() + 2 * 86_400_000) as Date | null, version: 1, conflictsLeft: 1, periods: [] as any[] };
    s.set(prismaDirect, "$transaction", async (work: any) => {
      const snapshot = state.status;
      try {
        return await work(applyTx(state));
      } catch (e) {
        state.status = snapshot;
        throw e;
      }
    });
    const before = state.expires!.getTime();
    assert.equal(await posSubscriptionService.applyPaid("POSSUB1", "BANK1", {}), "paid", "conflict retried, then applied");
    assert.equal(await posSubscriptionService.applyPaid("POSSUB1", "BANK1", {}), "paid", "duplicate callback");
    assert.equal(state.periods.length, 1, "one period, one extension");
    assert.equal(state.periods[0].paymentId, "P1");
    assert.ok(Math.abs(state.expires!.getTime() - (before + 30 * 86_400_000)) < 1000, "stacks 30 days on the current end once");

    // Persistent conflict: verified payment stays PENDING (not lost, not double-applied).
    const st2 = { status: "PENDING", expires: null, version: 1, conflictsLeft: 99, periods: [] as any[] };
    s.set(prismaDirect, "$transaction", async (work: any) => {
      const snap = st2.status;
      try {
        return await work(applyTx(st2 as any));
      } catch (e) {
        st2.status = snap;
        throw e;
      }
    });
    assert.equal(await posSubscriptionService.applyPaid("POSSUB1", "BANK1", {}), "pending");
    assert.equal(st2.status, "PENDING");
    assert.equal(st2.periods.length, 0);
  } finally {
    s.restore();
  }
});

// ═══ 8. Gateway credential responses ═══════════════════════════════════════

test("gateway credentials: secrets never leave the server", () => {
  const r = redactCredential({ id: "c", storeId: "store1", username: "u", storePassword: "s3cret", password: "p", hashKey: "h", accessToken: "tok" });
  assert.equal(r.storeId, "store1");
  for (const k of ["storePassword", "password", "hashKey", "accessToken"] as const) assert.equal(r[k], "********", k);
  assert.ok(!JSON.stringify(r).includes("s3cret"));
});

// ═══ 9. Selling workflow: products, idempotent checkout, change, receipt ═══

test("terminal products: only this vendor's live variants and POS-sellable stock in its active warehouses", async () => {
  const s = stubber();
  try {
    let args: any;
    s.model(prisma, "productVariant", {
      findMany: async (a: any) => (
        (args = a),
        [{
          id: "VAR1", name: "Red", sku: "S1", barcode: null, price: 100, specialPrice: 90, taxRate: 5,
          product: { id: "P1", name: "Shirt", category: { name: "Fashion" } }, images: [],
          warehouseStock: [
            { warehouseId: "WH2", rackId: null, quantity: 5, reservedQty: 0, damagedQty: 0, warehouse: { name: "B", isDefault: false }, rack: null },
            { warehouseId: "WH1", rackId: "R1", quantity: 10, reservedQty: 3, damagedQty: 1, warehouse: { name: "A", isDefault: true }, rack: { code: "A-01" } },
          ],
        }]
      ),
    });
    const out = await svc.listProducts("V1", { q: "shirt", take: 5000 });
    assert.equal(args.where.product.vendorId, "V1");
    assert.equal(args.where.product.isDeleted, false);
    assert.deepEqual(args.where.availability, { not: false });
    assert.deepEqual(args.select.warehouseStock.where, { warehouse: { vendorId: "V1", isActive: true }, rowNumber: null, shelfNumber: null });
    assert.equal(args.take, 200, "page size is capped");
    assert.equal(out[0].price, 90, "special price shown");
    assert.equal(out[0].locations[0].warehouseId, "WH1", "default warehouse first");
    assert.equal(out[0].locations[0].available, 6, "quantity − reserved − damaged");
    assert.equal(out[0].totalAvailable, 11);
  } finally {
    s.restore();
  }
});

test("createSale: the same clientRequestId never sells twice (repeat and concurrent race)", async () => {
  const s = stubber();
  const { committed } = saleStubs(s);
  try {
    // 1) repeat after success → existing sale returned, no transaction
    s.model(prisma, "posSale", { findFirst: async ({ where }: any) => (where.clientRequestId === "req-00000001" || where.id === "SALE_PRIOR" ? { id: "SALE_PRIOR" } : null) });
    const again = await svc.createSale("V1", cashier, { clientRequestId: "req-00000001", paidAmount: 100, paymentMethod: "CASH", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] });
    assert.equal(again.duplicate, true);
    assert.equal((again.sale as any).id, "SALE_PRIOR");
    assert.deepEqual(committed, [], "nothing new written");

    // 2) concurrent submit lost the unique (vendorId, clientRequestId) → winner's sale, no partial writes
    let lookups = 0;
    s.model(prisma, "posSale", {
      findFirst: async ({ where }: any) => {
        if (where.clientRequestId) return lookups++ === 0 ? null : { id: "SALE_WINNER" };
        return where.id === "SALE_WINNER" ? { id: "SALE_WINNER" } : null;
      },
    });
    s.set(prismaDirect, "$transaction", async () => {
      const e: any = new Error("Unique constraint failed on (vendorId, clientRequestId)");
      e.code = "P2002";
      throw e;
    });
    const raced = await svc.createSale("V1", cashier, { clientRequestId: "req-00000002", paidAmount: 100, paymentMethod: "CASH", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] });
    assert.equal(raced.duplicate, true);
    assert.equal((raced.sale as any).id, "SALE_WINNER");

    await assert.rejects(svc.createSale("V1", cashier, { clientRequestId: "bad id!", paidAmount: 1, paymentMethod: "CASH", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] }), /clientRequestId/);
  } finally {
    s.restore();
  }
});

test("createSale: cash above the bill is change (not revenue); stock check uses the deducted row; receipt is the server's sale", async () => {
  const s = stubber();
  const { created } = saleStubs(s);
  let stockWhere: any;
  try {
    const orig = (prismaDirect as any).$transaction;
    s.set(prismaDirect, "$transaction", async (work: any) =>
      orig(async (tx: any) => {
        const ff = tx.warehouseStock.findFirst;
        tx.warehouseStock.findFirst = async (a: any) => ((stockWhere = a.where), ff(a));
        return work(tx);
      }),
    );
    let receiptQuery: any;
    s.model(prisma, "posSale", { findFirst: async (a: any) => (a.where.clientRequestId ? null : ((receiptQuery = a.where), { id: "SALE1", netBilling: 100 })) });
    const r = await svc.createSale("V1", owner, { clientRequestId: "req-00000003", paidAmount: 500, paymentMethod: "CASH", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }] });
    // VAR1: price 100, tax 0 → net 100
    assert.equal(created[0].netBilling, 100);
    assert.equal(created[0].paidAmount, 100, "only the bill is recorded as paid");
    assert.equal(created[0].dueAmount, 0);
    assert.equal(r.change, 400);
    assert.equal(r.duplicate, false);
    assert.equal(created[0].clientRequestId, "req-00000003");
    assert.deepEqual(stockWhere, { variantId: "VAR1", warehouseId: "WH1", rackId: null, rowNumber: null, shelfNumber: null });
    assert.deepEqual(receiptQuery, { id: "SALE1", vendorId: "V1" }, "receipt read back vendor-scoped after commit");
  } finally {
    s.restore();
  }
});

// ─── POST /pos/sales → 400 "Request could not be completed" ───────────────

test("sale 400 reproduced: a database without pos_sales.clientRequestId fails with P2022; the client sees the generic 400, the server log names the column and nothing sensitive", async () => {
  const s = stubber();
  const logs: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  s.model(prisma, "vendor", { findUnique: async () => ({ status: "ACTIVE" }) });
  s.model(prisma, "posSale", {
    findFirst: async () => {
      throw new Prisma.PrismaClientKnownRequestError("The column `pos_sales.clientRequestId` does not exist in the current database.", {
        code: "P2022",
        clientVersion: "test",
        meta: { modelName: "PosSale", column: "pos_sales.clientRequestId" },
      });
    },
  });
  const req: any = {
    method: "POST",
    baseUrl: "/api/pos",
    route: { path: "/sales" },
    headers: { authorization: "Bearer secret-token" },
    vendorScope: "V1",
    posActor: owner,
    body: { clientRequestId: "req-7f3a9c21", paymentMethod: "BKASH", paidAmount: 105, note: "wallet 01710000001", items: [{ variantId: "VAR1", qty: 1, warehouseId: "WH1", rackId: null }] },
  };
  const res: any = { req, code: 0, body: null, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  try {
    await new PosController().createSale(req, res);
    assert.equal(res.code, 400);
    assert.deepEqual(res.body, { success: false, message: "Request could not be completed" }, "client-facing response unchanged");
    const line = logs.join("\n");
    assert.match(line, /\[pos\] POST \/api\/pos\/sales failed: Prisma P2022/);
    assert.match(line, /pos_sales\.clientRequestId/);
    for (const secret of ["secret-token", "req-7f3a9c21", "01710000001", "does not exist in the current database"]) assert.ok(!line.includes(secret), `log omits ${secret}`);
  } finally {
    console.error = realError;
    s.restore();
  }
});

test("the follow-up migration adds exactly the missing clientRequestId column and index, idempotently; the applied lifecycle copy is left alone", () => {
  const applied = readFileSync(new URL("../prisma/migrations/20261022210000_pos_subscription_lifecycle/migration.sql", import.meta.url), "utf8");
  const followUp = readFileSync(new URL("../prisma/migrations/20261023120000_pos_sale_client_request_id/migration.sql", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const sql = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(schema, /clientRequestId\s+String\?/);
  assert.match(schema, /@@unique\(\[vendorId, clientRequestId\]\)/);
  assert.doesNotMatch(sql(applied), /clientRequestId/, "the applied copy never created it — the cause of P2022");
  assert.match(followUp, /ADD COLUMN IF NOT EXISTS "clientRequestId" TEXT/);
  assert.match(followUp, /CREATE UNIQUE INDEX IF NOT EXISTS "pos_sales_vendorId_clientRequestId_key"\s+ON "public"\."pos_sales"\("vendorId", "clientRequestId"\)/);
  assert.doesNotMatch(sql(followUp), /DROP|DELETE|UPDATE/i, "additive only");
});

test("POS vouchers are keyed per vendor: two stores with the same invoice number each get their own voucher (no foreign voucher, no P2002)", async () => {
  const s = stubber();
  const store = new Map<string, any>();
  let n = 0;
  const db: any = {
    voucher: {
      findUnique: async ({ where }: any) => store.get(where.idempotencyKey) ?? null,
      create: async ({ data }: any) => {
        if (store.has(data.idempotencyKey)) throw new Error("unique idempotencyKey");
        const v = { id: `VCH${++n}`, ...data };
        store.set(data.idempotencyKey, v);
        return v;
      },
    },
    voucherDraftEntry: { create: async () => ({}) },
  };
  s.set(AccountingService.prototype, "resolveAccountIdIn", async (_db: any, _t: any, vid: string, _c: any, name: string) => `${vid}:${name}`);
  s.set(AccountingService.prototype, "generateVoucherNumber", async () => `SAL2610${String(n + 1).padStart(4, "0")}`);
  s.set(AccountingService.prototype, "_postPOSVoucher", async () => undefined);
  s.set(AccountingService.prototype, "_upsertVendorPayable", async () => undefined);
  s.set(AccountingService.prototype, "getVoucherById", async (id: string) => [...store.values()].find((v) => v.id === id));
  const acc = new AccountingService();
  const sale = (vendorId: string) => ({ vendorId, invoiceId: "INV-261023-0001", customerName: "Walk-in", items: [], subtotal: 100, discountAmount: 0, discountType: "pct", discountPct: 0, vatAmount: 0, netBilling: 100, cogsTotal: 60, paidAmount: 100, dueAmount: 0, paymentMethod: "Cash", saleDate: new Date() });
  try {
    const v1 = await acc.createPOSSaleVoucher(sale("V1") as any, db);
    const v2 = await acc.createPOSSaleVoucher(sale("V2") as any, db);
    assert.notEqual(v1.id, v2.id, "the second store gets its own voucher");
    assert.equal(v1.vendorId, "V1");
    assert.equal(v2.vendorId, "V2", "never the other store's voucher");
    const again = await acc.createPOSSaleVoucher(sale("V1") as any, db);
    assert.equal(again.id, v1.id, "still idempotent within one store");
    assert.equal(store.size, 2);
  } finally {
    s.restore();
  }
});

test("POS vouchers never put a PosCustomer id in Voucher.customerId (a marketplace-User FK: vouchers_customerId_fkey → P2003)", async () => {
  const s = stubber();
  const created: any[] = [];
  const db: any = {
    voucher: { findUnique: async () => null, create: async ({ data }: any) => (created.push(data), { id: `VCH${created.length}`, ...data }) },
    voucherDraftEntry: { create: async () => ({}) },
    // Customer balances belong to PosService (one transaction with the sale);
    // the voucher code must not touch them.
    posCustomer: { update: async () => assert.fail("accounting must not change PosCustomer") },
  };
  s.set(AccountingService.prototype, "resolveAccountIdIn", async (_db: any, _t: any, vid: string, _c: any, name: string) => `${vid}:${name}`);
  s.set(AccountingService.prototype, "generateVoucherNumber", async () => `V${created.length + 1}`);
  s.set(AccountingService.prototype, "_postPOSVoucher", async () => undefined);
  s.set(AccountingService.prototype, "ensurePosCustomerReceivableIn", async () => "V1:POS Customer Receivable");
  s.set(AccountingService.prototype, "getVoucherById", async (id: string) => ({ id }));
  const acc = new AccountingService();
  const D = (n: number) => new Prisma.Decimal(n);
  try {
    await acc.createPOSSaleVoucher({ vendorId: "V1", invoiceId: "INV-1", customerId: "POSCUST1", customerName: "Karim", items: [], subtotal: D(200), discountAmount: D(0), discountType: "pct", discountPct: 0, vatAmount: D(0), netBilling: D(200), cogsTotal: D(120), paidAmount: D(150), dueAmount: D(50), paymentMethod: "Cash", saleDate: new Date() } as any, db);
    await acc.createPOSRefundVoucher({ vendorId: "V1", originalInvoiceId: "INV-1", refundInvoiceId: "INV-1-R1", customerId: "POSCUST1", customerName: "Karim", refundItems: [], refundSubtotal: D(100), refundDiscount: D(0), refundVat: D(0), refundNet: D(100), refundCogs: D(60), paymentMethod: "Cash", refundDate: new Date() } as any, db);
    await acc.createPOSDuePaymentVoucher({ vendorId: "V1", originalInvoiceId: "INV-1", paymentInvoiceId: "INV-1-DP1", customerId: "POSCUST1", customerName: "Karim", payingAmount: D(50), paymentMethod: "Cash", paymentDate: new Date() } as any, db);
    assert.equal(created.length, 3);
    for (const v of created) {
      assert.ok(!("customerId" in v) || v.customerId == null, `${v.voucherType} voucher has no customerId`);
      assert.equal(v.vendorId, "V1");
    }
    assert.match(created[0].narration, /Karim/, "customer still named on the sale voucher");
  } finally {
    s.restore();
  }
});

