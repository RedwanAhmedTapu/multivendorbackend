// tests/pos-credit.test.ts
//
// POS customer credit — service and accounting behaviour with stubbed Prisma
// delegates (no database). The SQL itself is exercised against a real
// PostgreSQL in tests/pos-credit-postgres.test.ts.
//   npx tsx --test tests/pos-credit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma, prismaDirect } from "../src/config/prisma.ts";
import { PosService } from "../src/services/pos.service.ts";
import { AccountingService, POS_CUSTOMER_RECEIVABLE, posVoucherIdempotencyKey } from "../src/services/accounting.services.ts";
import { isSerializationConflict } from "../src/modules/shared/stock-mutations.ts";

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

const svc = new PosService();
const owner = { userId: "U_V1", employeeId: null, isOwner: true, displayName: "Owner", grants: { posDiscount: true, posCredit: true, posRefund: true, posReports: true } };
const creditClerk = { userId: "U_E1", employeeId: "EMP1", isOwner: false, displayName: "Clerk", grants: { posDiscount: false, posCredit: true, posRefund: true, posReports: false } };
const cashier = { ...creditClerk, employeeId: "EMP2", userId: "U_E2", grants: { posDiscount: false, posCredit: false, posRefund: false, posReports: false } };
const items = [{ variantId: "VAR1", qty: 1, warehouseId: "WH1" }]; // 100 each, no VAT
const D = (n: number) => new Prisma.Decimal(n);

/** The customer row as the database would hold it, plus the SQL the service ran. */
function saleWorld(cust: { loanLimit: number; due: number } | null, opts: { applied?: number; storeStatus?: string } = {}) {
  const s = stubber();
  const raw: { text: string; values: unknown[] }[] = [];
  const committed: string[] = [];
  const vouchers: any[] = [];
  s.model(prisma, "productVariant", {
    findMany: async () => [{ id: "VAR1", name: "Red", price: 100, specialPrice: null, avgCost: 60, taxRate: 0, product: { name: "Shirt" } }],
  });
  s.model(prisma, "vendorWarehouse", { findMany: async () => [{ id: "WH1", isActive: true }] });
  s.model(prisma, "warehouseRack", { findMany: async () => [] });
  s.model(prisma, "posCustomer", { findFirst: async ({ where }: any) => (cust && where.id === "C1" && where.vendorId === "V1" ? { id: "C1", name: "Karim", ...cust } : null) });
  s.model(prisma, "posSettings", { findUnique: async () => ({ invoicePrefix: "INV", voucherPrefix: "POSV" }) });
  const storeReads: string[] = [];
  s.model(prisma, "vendor", { findUnique: async ({ where }: any) => (storeReads.push(where.id), where.id === "V1" ? { status: opts.storeStatus ?? "ACTIVE" } : null) });
  s.model(prisma, "posSale", { findFirst: async () => ({ id: "SALE1" }) });
  s.set(prismaDirect, "$transaction", async (work: any) => {
    const staged: string[] = [];
    const tx: any = {
      warehouseStock: { findFirst: async () => ({ quantity: 10, reservedQty: 0, damagedQty: 0 }), update: async () => staged.push("stock") },
      productVariant: { update: async () => staged.push("variant") },
      posSale: {
        findFirst: async () => null,
        create: async ({ data }: any) => (staged.push("sale"), { id: "SALE1", invoiceNo: "INV-1", customerId: data.customerId, items: data.items.create.map((i: any, k: number) => ({ ...i, id: `IT${k}` })) }),
        update: async () => staged.push("link"),
      },
      stockMovement: { create: async () => staged.push("movement") },
      posCustomer: { findFirst: async () => (cust ? { ...cust } : null) },
      $executeRaw: async (q: Prisma.Sql) => (raw.push({ text: q.text, values: q.values }), staged.push("customer"), opts.applied ?? 1),
    };
    const result = await work(tx);
    committed.push(...staged);
    return result;
  });
  s.set(AccountingService.prototype, "createPOSSaleVoucher", async (d: any) => (vouchers.push(d), { id: "VOUCHER1" }));
  const preCreated: string[] = [];
  s.set(AccountingService.prototype, "ensurePosCustomerReceivableIn", async (db: any, vendorId: string) => (preCreated.push(db ? "in-tx" : `outside:${vendorId}`), "ACC_PCR"));
  return { s, raw, committed, vouchers, preCreated, storeReads };
}

// ─── credit limit ─────────────────────────────────────────────────────────

test("credit: limit 0 (no facility) refuses any due — owner included — before any write", async () => {
  const w = saleWorld({ loanLimit: 0, due: 0 });
  try {
    for (const actor of [owner, creditClerk]) {
      await assert.rejects(svc.createSale("V1", actor, { customerId: "C1", paidAmount: 60, paymentMethod: "CASH", items }), (e: any) => e.statusCode === 409 && /no credit facility/.test(e.message));
    }
    assert.deepEqual(w.committed, []);
  } finally {
    w.s.restore();
  }
});

test("credit: within and exactly at the limit succeed; existing debt counts; above is refused with the available amount", async () => {
  const w = saleWorld({ loanLimit: 100, due: 60 });
  try {
    // 100 bill, 60 paid → 40 due; 60 + 40 = 100 = limit
    const r = await svc.createSale("V1", creditClerk, { customerId: "C1", paidAmount: 60, paymentMethod: "CASH", items });
    assert.equal(r.duplicate, false);
    assert.ok(w.committed.includes("customer"), "customer row updated in the sale transaction");
    const sql = w.raw[0];
    assert.match(sql.text, /UPDATE "pos_customers"/);
    assert.match(sql.text, /"loanLimit" > 0 AND "due" \+ \$\d+::double precision <= "loanLimit"/, "the limit is checked in the UPDATE itself");
    assert.deepEqual(sql.values.slice(0, 2), [40, 40], "due and loanBalance move by the new due");
    assert.ok(sql.values.includes("C1") && sql.values.includes("V1"), "scoped to this vendor's customer");
    await assert.rejects(
      svc.createSale("V1", creditClerk, { customerId: "C1", paidAmount: 59, paymentMethod: "CASH", items }),
      (e: any) => e.statusCode === 409 && /Credit limit exceeded: 40\.00 available of 100\.00, this sale needs 41\.00/.test(e.message),
    );
  } finally {
    w.s.restore();
  }
});

test("credit: if the row changed meanwhile the in-transaction check refuses and the whole sale rolls back", async () => {
  const w = saleWorld({ loanLimit: 100, due: 0 }, { applied: 0 });
  try {
    await assert.rejects(svc.createSale("V1", owner, { customerId: "C1", paidAmount: 50, paymentMethod: "CASH", items }), (e: any) => e.statusCode === 409);
    assert.deepEqual(w.committed, [], "no sale, stock, movement or customer change committed");
    assert.equal(w.vouchers.length, 0, "no voucher");
  } finally {
    w.s.restore();
  }
});

test("credit: needs posCredit and a customer; walk-ins never touch a customer row", async () => {
  const w = saleWorld({ loanLimit: 1000, due: 0 });
  try {
    await assert.rejects(svc.createSale("V1", cashier, { customerId: "C1", paidAmount: 50, paymentMethod: "CASH", items }), (e: any) => e.statusCode === 403);
    await assert.rejects(svc.createSale("V1", owner, { paidAmount: 50, paymentMethod: "CASH", items }), /Select a customer/);
    await svc.createSale("V1", cashier, { paidAmount: 500, paymentMethod: "CASH", items }); // walk-in over-payment = change
    assert.equal(w.raw.length, 0, "no customer update for a walk-in");
    // spoofed identity/permission fields are ignored
    await assert.rejects(
      svc.createSale("V1", cashier, { customerId: "C1", paidAmount: 50, paymentMethod: "CASH", items, ...({ canGrantLoan: true, posCredit: true, vendorId: "V1", role: "VENDOR" } as any) }),
      (e: any) => e.statusCode === 403,
    );
  } finally {
    w.s.restore();
  }
});

test("customer figures: a paid sale for a registered customer counts the order, spend and time — once", async () => {
  const w = saleWorld({ loanLimit: 0, due: 0 });
  try {
    const before = Date.now();
    await svc.createSale("V1", cashier, { customerId: "C1", paidAmount: 100, paymentMethod: "CASH", items });
    assert.equal(w.raw.length, 1, "one customer statement");
    const [due, bal, net, at] = w.raw[0].values as any[];
    assert.deepEqual([due, bal, net], [0, 0, 100]);
    assert.ok(Date.parse(at) >= before - 1000, "server time");
    assert.match(w.raw[0].text, /"orders" = "orders" \+ 1/);
  } finally {
    w.s.restore();
  }
});

test("unsupported amount fields (extra charge, due write-off, wallet top-up) are refused, not silently recorded", async () => {
  const w = saleWorld(null);
  try {
    for (const k of ["extraAmount", "dueCutAmount", "walletAddAmount"]) {
      await assert.rejects(svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: "CASH", items, [k]: 5 } as any), (e: any) => e.statusCode === 400 && e.message.includes(k));
    }
    await svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: "CASH", items, extraAmount: 0, dueCutAmount: 0, walletAddAmount: 0 });
    assert.deepEqual(w.committed.filter((c) => c === "sale"), ["sale"], "zeros are accepted");
  } finally {
    w.s.restore();
  }
});

// ─── refunds / voids ──────────────────────────────────────────────────────

function refundWorld(sale: { paidAmount: number; dueAmount: number; status?: string; customerId?: string | null; refundedQty?: number }) {
  const s = stubber();
  const row = {
    id: "SALE1", vendorId: "V1", invoiceNo: "INV-1", status: sale.status ?? (sale.dueAmount > 0 ? "PENDING" : "PAID"), saleDate: new Date(),
    subtotal: 200, discountAmount: 0, taxAmount: 0, netBilling: 200, paidAmount: sale.paidAmount, dueAmount: sale.dueAmount,
    customerId: sale.customerId === undefined ? "C1" : sale.customerId, paymentMethod: "CASH", accountingVoucherId: "VSALE",
    items: [{ id: "IT1", qty: 2, refundedQty: sale.refundedQty ?? 0, price: 100, cost: 60, name: "Shirt", variantId: null, warehouseId: null, rackId: null, taxRate: 0 }],
  };
  const writes: any[] = [];
  const raw: any[] = [];
  const vouchers: any[] = [];
  const tx: any = {
    posSale: {
      findFirst: async ({ where }: any) => (where.vendorId === "V1" && where.id === "SALE1" ? { ...row, items: row.items.map((i) => ({ ...i })) } : null),
      updateMany: async (a: any) => {
        writes.push(a);
        const ok = a.where.dueAmount === row.dueAmount && a.where.paidAmount === row.paidAmount;
        if (ok) Object.assign(row, a.data);
        return { count: ok ? 1 : 0 };
      },
      update: async (a: any) => (writes.push(a), Object.assign(row, a.data)),
      findFirstOrThrow: async () => row,
    },
    posSaleItem: {
      updateMany: async (a: any) => {
        const it = row.items[0];
        if (it.refundedQty > a.where.refundedQty.lte) return { count: 0 };
        it.refundedQty += a.data.refundedQty.increment;
        return { count: 1 };
      },
      findMany: async () => row.items.map((i) => ({ qty: i.qty, refundedQty: i.refundedQty })),
    },
    posCustomer: { findFirst: async () => ({ name: "Karim" }) },
    $executeRaw: async (q: Prisma.Sql) => (raw.push(q.values), 1),
    voucher: { findUnique: async ({ where }: any) => byKey(where.idempotencyKey) },
  };
  const byKey = (k: string) => {
    const i = vouchers.findIndex((d) => posVoucherIdempotencyKey("REFUND", "POS_SALE_REFUNDED", "pos_refund", d.vendorId, d.refundInvoiceId) === k);
    return i < 0 ? null : { id: `VR${i + 1}` };
  };
  s.set(prismaDirect, "$transaction", async (work: any) => work(tx));
  s.model(prisma, "posSale", { findFirst: async ({ where }: any) => (where.vendorId === "V1" && where.id === "SALE1" ? { id: "SALE1", invoiceNo: "INV-1" } : null) });
  s.model(prisma, "voucher", { findUnique: async ({ where }: any) => byKey(where.idempotencyKey) });
  s.set(AccountingService.prototype, "createPOSRefundVoucher", async (d: any) => (vouchers.push(d), { id: `VR${vouchers.length}` }));
  s.set(AccountingService.prototype, "posReceivableAccountForSale", async (_db: any, _v: string, voucherId: string) => `RECV_OF_${voucherId}`);
  return { s, row, writes, raw, vouchers, tx };
}
const num = (d: any) => Number(d?.toString?.() ?? d);

test("refund of a fully unpaid credit sale: no cash goes out, the due is cancelled", async () => {
  const w = refundWorld({ paidAmount: 0, dueAmount: 200 });
  try {
    const r = await svc.refundSale("V1", creditClerk, "SALE1", {});
    assert.deepEqual([r.cashRefund, r.dueReduced, r.isFullRefund], [0, 200, true]);
    assert.deepEqual([num(w.vouchers[0].cashRefund), num(w.vouchers[0].receivableCut)], [0, 200]);
    assert.equal(w.vouchers[0].receivableAccountId, "RECV_OF_VSALE", "clears the receivable the sale debited");
    assert.deepEqual([w.row.dueAmount, w.row.paidAmount, w.row.status], [0, 0, "REFUNDED"]);
    assert.deepEqual(w.raw[0], [200, 200, 200, 0, "C1", "V1"], "customer due/loanBalance −200, spent −200, orders unchanged");
  } finally {
    w.s.restore();
  }
});

test("refund of a partly paid sale: cancels the unpaid part first, then refunds only collected cash", async () => {
  const w = refundWorld({ paidAmount: 120, dueAmount: 80 });
  try {
    const first = await svc.refundSale("V1", creditClerk, "SALE1", { items: [{ saleItemId: "IT1", qty: 1 }] }); // 100 worth
    assert.deepEqual([first.dueReduced, first.cashRefund], [80, 20]);
    assert.deepEqual([w.row.dueAmount, w.row.paidAmount, w.row.status], [0, 100, "PAID"], "nothing left owed on the kept item");
    const second = await svc.refundSale("V1", creditClerk, "SALE1", { items: [{ saleItemId: "IT1", qty: 1 }] });
    assert.deepEqual([second.dueReduced, second.cashRefund, second.isFullRefund], [0, 100, true]);
    const cash = w.vouchers.reduce((s, v) => s + num(v.cashRefund), 0);
    const cut = w.vouchers.reduce((s, v) => s + num(v.receivableCut), 0);
    assert.deepEqual([cash, cut], [120, 80], "cash back = cash collected; due cancelled = due owed");
    await assert.rejects(svc.refundSale("V1", creditClerk, "SALE1", {}), (e: any) => e.statusCode === 409, "a repeated refund is refused");
  } finally {
    w.s.restore();
  }
});

test("refund of a fully paid sale returns cash and touches no due", async () => {
  const w = refundWorld({ paidAmount: 200, dueAmount: 0, customerId: null });
  try {
    const r = await svc.refundSale("V1", creditClerk, "SALE1", {});
    assert.deepEqual([r.cashRefund, r.dueReduced], [200, 0]);
    assert.equal(w.vouchers[0].receivableAccountId, undefined);
    assert.equal(w.raw.length, 0, "walk-in sale: no customer row");
  } finally {
    w.s.restore();
  }
});

test("void of a credit sale cancels the due and the order count; a concurrent change is refused", async () => {
  const w = refundWorld({ paidAmount: 50, dueAmount: 150 });
  try {
    const r = await svc.voidSale("V1", creditClerk, "SALE1", "wrong customer");
    assert.deepEqual([r.dueReduced, r.cashRefund], [150, 50]);
    assert.deepEqual(w.raw[0], [150, 150, 200, 1, "C1", "V1"], "due/loanBalance −150, spent −200, orders −1");
    assert.equal(w.row.status, "VOIDED");
    const effects = [w.vouchers.length, w.raw.length];
    await assert.rejects(svc.voidSale("V1", creditClerk, "SALE1", "again"), (e: any) => e.statusCode === 409 && /already voided/.test(e.message));
    await assert.rejects(svc.refundSale("V1", creditClerk, "SALE1", {}), (e: any) => e.statusCode === 409, "nor refunded after a void");
    assert.deepEqual([w.vouchers.length, w.raw.length], effects, "a repeated void/refund adds no voucher and no balance change");
  } finally {
    w.s.restore();
  }
  const c = refundWorld({ paidAmount: 0, dueAmount: 200 });
  try {
    const stale = { ...c.row, items: c.row.items.map((i) => ({ ...i })) };
    Object.assign(c.row, { dueAmount: 120, paidAmount: 80 }); // a collection landed after the read
    c.tx.posSale.findFirst = async () => stale;
    await assert.rejects(svc.refundSale("V1", creditClerk, "SALE1", {}), (e: any) => e.statusCode === 409 && /changed meanwhile/.test(e.message));
    assert.equal(c.vouchers.length, 0, "no refund voucher");
  } finally {
    c.s.restore();
  }
});

test("refund refuses to pay back more than was collected", async () => {
  // Inconsistent legacy row: nothing paid, nothing due, but refundable lines left.
  const w = refundWorld({ paidAmount: 0, dueAmount: 0, status: "PAID" });
  try {
    await assert.rejects(svc.refundSale("V1", creditClerk, "SALE1", {}), /more than was collected/);
    assert.equal(w.vouchers.length, 0);
  } finally {
    w.s.restore();
  }
});

// ─── due collection ───────────────────────────────────────────────────────

test("pay-due: optimistic on the due just read (double submit loses), clears the customer due and the sale's own receivable", async () => {
  const s = stubber();
  const sale = { id: "SALE1", vendorId: "V1", invoiceNo: "INV-1", status: "PENDING", customerId: "C1", dueAmount: 50, accountingVoucherId: "VSALE" };
  const calls: any[] = [];
  const vouchers: any[] = [];
  let dueNow = 50;
  const tx: any = {
    posSale: {
      findFirst: async () => ({ ...sale, dueAmount: dueNow }),
      updateMany: async (a: any) => (calls.push(a), a.where.dueAmount === dueNow ? ((dueNow -= a.data.dueAmount.decrement), { count: 1 }) : { count: 0 }),
      findUniqueOrThrow: async () => ({ dueAmount: dueNow }),
      update: async () => ({}),
    },
    posCustomer: { findFirst: async () => ({ name: "Karim" }) },
    $executeRaw: async (q: Prisma.Sql) => (calls.push({ raw: q.values }), 1),
  };
  s.set(prismaDirect, "$transaction", async (work: any) => work(tx));
  s.model(prisma, "posSale", { findFirst: async () => ({ id: "SALE1" }) });
  s.set(AccountingService.prototype, "createPOSDuePaymentVoucher", async (d: any) => (vouchers.push(d), { id: "VP" }));
  s.set(AccountingService.prototype, "posReceivableAccountForSale", async (_db: any, _v: string, id: string) => `RECV_OF_${id}`);
  try {
    await svc.payDue("V1", cashier, "SALE1", { payingAmount: 20, paymentMethod: "CASH" });
    assert.equal(calls[0].where.dueAmount, 50, "exact-value guard");
    assert.deepEqual(calls[1].raw.slice(0, 2), [20, 20], "customer due/loanBalance −20");
    assert.equal(vouchers[0].receivableAccountId, "RECV_OF_VSALE");
    // A duplicate submit computed against the stale due (50) loses:
    tx.posSale.findFirst = async () => ({ ...sale, dueAmount: 50 });
    await assert.rejects(svc.payDue("V1", cashier, "SALE1", { payingAmount: 20, paymentMethod: "CASH" }), (e: any) => e.statusCode === 409);
    tx.posSale.findFirst = async () => ({ ...sale, dueAmount: dueNow });
    await svc.payDue("V1", cashier, "SALE1", { payingAmount: 30, paymentMethod: "CASH" }); // full repayment
    assert.equal(dueNow, 0);
    await assert.rejects(svc.payDue("V1", cashier, "SALE1", { payingAmount: 1, paymentMethod: "CASH" }), (e: any) => e.statusCode === 409, "nothing left to collect");
  } finally {
    s.restore();
  }
});

// ─── credit terms & audit ─────────────────────────────────────────────────

test("credit terms: only with posCredit; changes are audited with the actor; profile-only edits need no credit right", async () => {
  const s = stubber();
  const audits: any[] = [];
  let stored: any = { id: "C1", vendorId: "V1", name: "Karim", phone: "017", loanLimit: 0, loanInterestRate: 12, loanTenureDays: 30 };
  const tx: any = {
    posCustomer: {
      findFirst: async () => ({ ...stored }),
      update: async ({ data }: any) => (stored = { ...stored, ...data }),
      create: async ({ data }: any) => ({ id: "C2", loanInterestRate: 12, loanTenureDays: 30, loanLimit: 0, ...data }),
    },
    auditLog: { create: async ({ data }: any) => audits.push(data) },
  };
  s.model(prisma, "posCustomer", {
    findFirst: async ({ where }: any) => (where.vendorId === "V1" && where.id === "C1" ? { id: "C1" } : null),
    update: async ({ data }: any) => (stored = { ...stored, ...data }),
  });
  s.set(prismaDirect, "$transaction", async (work: any) => work(tx));
  try {
    await assert.rejects(svc.updateCustomer("V1", "C1", { loanLimit: 5000 }, false, cashier as any), (e: any) => e.statusCode === 403);
    await svc.updateCustomer("V1", "C1", { name: "Karim Uddin", note: "VIP" }, false, cashier as any);
    assert.equal(audits.length, 0);
    await svc.updateCustomer("V1", "C1", { loanLimit: 5000 }, true, creditClerk as any);
    assert.equal(stored.loanLimit, 5000);
    assert.equal(audits.length, 1);
    assert.deepEqual(
      { action: audits[0].action, entity: audits[0].entity, entityId: audits[0].entityId, userId: audits[0].userId, old: audits[0].oldData.loanLimit, new: audits[0].newData.loanLimit, by: audits[0].newData.byEmployeeId, vendor: audits[0].newData.vendorId },
      { action: "POS_CREDIT_TERMS_CHANGED", entity: "PosCustomer", entityId: "C1", userId: "U_E1", old: 0, new: 5000, by: "EMP1", vendor: "V1" },
    );
    await svc.updateCustomer("V1", "C1", { loanLimit: 5000 }, true, creditClerk as any);
    assert.equal(audits.length, 1, "no audit row when nothing changed");
    await assert.rejects(svc.updateCustomer("V2", "C1", { loanLimit: 1 }, true, owner as any), (e: any) => e.statusCode === 404, "other vendor's customer");
    await svc.createCustomer("V1", { name: "New", phone: "018", loanLimit: 300 }, true, owner as any);
    assert.equal(audits.length, 2, "a new customer with credit is audited too");
  } finally {
    s.restore();
  }
});

// ─── accounting ───────────────────────────────────────────────────────────

function ledgerWorld() {
  const s = stubber();
  const created: any[] = [];
  const db: any = {
    voucher: { findUnique: async () => null, create: async ({ data }: any) => (created.push({ ...data, entries: [] }), { id: `V${created.length}`, ...data }) },
    voucherDraftEntry: { create: async ({ data }: any) => created[created.length - 1].entries.push(data) },
    vendorPayable: { upsert: async () => assert.fail("POS must not change what the platform owes the vendor") },
  };
  s.set(AccountingService.prototype, "resolveAccountIdIn", async (_db: any, _t: any, _vid: string, _c: any, name: string) => `ACC:${name}`);
  s.set(AccountingService.prototype, "ensurePosCustomerReceivableIn", async () => `ACC:${POS_CUSTOMER_RECEIVABLE}`);
  s.set(AccountingService.prototype, "generateVoucherNumber", async () => `N${created.length + 1}`);
  s.set(AccountingService.prototype, "_postPOSVoucher", async () => undefined);
  s.set(AccountingService.prototype, "getVoucherById", async (id: string) => ({ id }));
  const bal = (v: any) => [v.entries.reduce((a: number, e: any) => a + num(e.debitAmount), 0), v.entries.reduce((a: number, e: any) => a + num(e.creditAmount), 0)];
  return { s, db, created, bal, acc: new AccountingService() };
}

test("ledger: credit-sale due goes to POS Customer Receivable (never Receivable from Platform); every POS voucher balances", async () => {
  const w = ledgerWorld();
  try {
    await w.acc.createPOSSaleVoucher({ vendorId: "V1", invoiceId: "INV-1", customerId: "C1", customerName: "Karim", items: [], subtotal: D(200), discountAmount: D(0), discountType: "pct", discountPct: 0, vatAmount: D(0), netBilling: D(200), cogsTotal: D(120), paidAmount: D(50), dueAmount: D(150), paymentMethod: "Cash", saleDate: new Date() } as any, w.db);
    const sale = w.created[0];
    const accounts = sale.entries.map((e: any) => e.accountId);
    assert.ok(accounts.includes(`ACC:${POS_CUSTOMER_RECEIVABLE}`), "due debited to POS Customer Receivable");
    assert.ok(!accounts.includes("ACC:Receivable from Platform"), "never to Receivable from Platform");
    await w.acc.createPOSRefundVoucher({ vendorId: "V1", originalInvoiceId: "INV-1", refundInvoiceId: "INV-1-R1", customerName: "Karim", refundItems: [], refundSubtotal: D(200), refundDiscount: D(0), refundVat: D(0), refundNet: D(200), refundCogs: D(120), paymentMethod: "Cash", refundDate: new Date(), cashRefund: D(50), receivableCut: D(150), receivableAccountId: "ACC:legacy" } as any, w.db);
    const refund = w.created[1];
    assert.deepEqual(refund.entries.filter((e: any) => num(e.creditAmount) > 0 && e.referenceType === "pos_refund").map((e: any) => [e.accountId, num(e.creditAmount)]).filter(([a]: any) => a !== "ACC:Vendor Funded Discounts" && a !== "ACC:Cost of Goods Sold (Expense)"),
      [["ACC:Cash at Bank Account", 50], ["ACC:legacy", 150]], "cash only for what was paid; the rest clears the sale's receivable");
    await w.acc.createPOSDuePaymentVoucher({ vendorId: "V1", originalInvoiceId: "INV-1", paymentInvoiceId: "INV-1-DP1", customerId: "C1", customerName: "Karim", payingAmount: D(30), paymentMethod: "Cash", paymentDate: new Date(), receivableAccountId: "ACC:legacy" } as any, w.db);
    assert.deepEqual(w.created[2].entries.map((e: any) => e.accountId), ["ACC:Cash at Bank Account", "ACC:legacy"]);
    for (const v of w.created) {
      const [dr, cr] = w.bal(v);
      assert.equal(dr, cr, `${v.voucherType} balances`);
    }
    await assert.rejects(
      w.acc.createPOSRefundVoucher({ vendorId: "V1", originalInvoiceId: "INV-1", refundInvoiceId: "INV-1-R2", customerName: "K", refundItems: [], refundSubtotal: D(100), refundDiscount: D(0), refundVat: D(0), refundNet: D(100), refundCogs: D(0), paymentMethod: "Cash", refundDate: new Date(), cashRefund: D(60), receivableCut: D(60) } as any, w.db),
      /allocation does not add up/,
    );
  } finally {
    w.s.restore();
  }
});

test("ledger: a sale posted before the dedicated account keeps clearing Receivable from Platform; new sales use POS Customer Receivable", async () => {
  const s = stubber();
  const acc = new AccountingService();
  let created: any = null;
  const db: any = {
    ledgerEntry: { findFirst: async ({ where }: any) => (where.voucherId === "OLD" ? { accountId: "ACC_RFP" } : null) },
    chartOfAccount: {
      findFirst: async ({ where }: any) => (where.name === POS_CUSTOMER_RECEIVABLE ? null : { code: "VND-AST-0013" }),
      create: async ({ data }: any) => ((created = data), { id: "ACC_PCR" }),
    },
  };
  try {
    assert.equal(await acc.posReceivableAccountForSale(db, "V1", "OLD"), "ACC_RFP");
    assert.equal(await acc.posReceivableAccountForSale(db, "V1", "NEW"), "ACC_PCR");
    assert.deepEqual(
      { name: created.name, code: created.code, cls: created.accountClass, type: created.accountType, group: created.group, nature: created.nature, entity: [created.entityType, created.entityId] },
      { name: POS_CUSTOMER_RECEIVABLE, code: "VND-AST-0014", cls: "ASSET", type: "CURRENT_ASSET", group: "ACCOUNTS_RECEIVABLE", nature: "DEBIT", entity: ["VENDOR", "V1"] },
      "created once for a vendor seeded before it existed",
    );
  } finally {
    s.restore();
  }
});

test("retry: serialization conflicts from raw queries (P2010 / 40001) are retried like P2034; other errors are not", () => {
  const e = (code: string, meta?: any) => new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "t", meta });
  assert.equal(isSerializationConflict(e("P2034")), true);
  assert.equal(isSerializationConflict(e("P2010", { code: "40001" })), true);
  assert.equal(isSerializationConflict(e("P2010", { code: "23505" })), false);
  assert.equal(isSerializationConflict(e("P2002")), false);
  assert.equal(isSerializationConflict(new Error("40001")), false);
});

// ─── final review additions ───────────────────────────────────────────────

test("first credit sale creates the receivable account OUTSIDE the sale transaction; paid sales never do", async () => {
  const w = saleWorld({ loanLimit: 500, due: 0 });
  try {
    await svc.createSale("V1", owner, { customerId: "C1", paidAmount: 40, paymentMethod: "CASH", items });
    await svc.createSale("V1", owner, { customerId: "C1", paidAmount: 100, paymentMethod: "CASH", items });
    assert.deepEqual(w.preCreated, ["outside:V1"], "only the credit sale, and before the transaction");
  } finally {
    w.s.restore();
  }
});

test("receivable account: a concurrent first creation (P2002) re-reads the winner; a code collision retries; in a transaction nothing is retried", async () => {
  const acc = new AccountingService();
  const p2002 = () => new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "t" });
  // 1) the twin committed the account between our read and our insert
  let reads = 0;
  const raced: any = {
    chartOfAccount: {
      findFirst: async ({ where }: any) => (where.name ? (reads++ === 0 ? null : { id: "WINNER" }) : { code: "VND-AST-0013" }),
      create: async () => { throw p2002(); },
    },
  };
  assert.equal(await acc.ensurePosCustomerReceivableIn(undefined, "V1", raced), "WINNER");
  // 2) another account took the next code: by-name read still empty → retry with a fresh code
  let creates = 0;
  const collided: any = {
    chartOfAccount: {
      findFirst: async ({ where }: any) => (where.name ? null : { code: creates === 0 ? "VND-AST-0013" : "VND-AST-0014" }),
      create: async ({ data }: any) => (creates++ === 0 ? Promise.reject(p2002()) : { id: `NEW:${data.code}` }),
    },
  };
  assert.equal(await acc.ensurePosCustomerReceivableIn(undefined, "V1", collided), "NEW:VND-AST-0015");
  // 3) bounded: a persistent duplicate error surfaces after 3 attempts
  const stuck: any = { chartOfAccount: { findFirst: async ({ where }: any) => (where.name ? null : { code: "VND-AST-0001" }), create: async () => { throw p2002(); } } };
  await assert.rejects(acc.ensurePosCustomerReceivableIn(undefined, "V1", stuck), (e: any) => e.code === "P2002");
  // 4) inside a caller's transaction the error propagates (the transaction must roll back)
  await assert.rejects(acc.ensurePosCustomerReceivableIn(stuck as any, "V1"), (e: any) => e.code === "P2002");
});

test("refund with an operation id: a repeat AFTER completion returns the first refund and changes nothing", async () => {
  const w = refundWorld({ paidAmount: 120, dueAmount: 80 });
  try {
    const op = "refund-op-0001";
    const first = await svc.refundSale("V1", creditClerk, "SALE1", { items: [{ saleItemId: "IT1", qty: 1 }], clientRequestId: op });
    assert.equal(first.duplicate, false);
    assert.equal(w.vouchers[0].refundInvoiceId, "INV-1-R-op".replace("op", op), "deterministic refund reference");
    const snapshot = JSON.stringify([w.row, w.raw, w.vouchers.length]);
    const again = await svc.refundSale("V1", creditClerk, "SALE1", { items: [{ saleItemId: "IT1", qty: 1 }], clientRequestId: op });
    assert.deepEqual([again.duplicate, (again.voucher as any).id], [true, "VR1"]);
    assert.equal(JSON.stringify([w.row, w.raw, w.vouchers.length]), snapshot, "no second refund, stock, due or cash effect");
    // a different operation id is a new refund (one item is still refundable)
    const other = await svc.refundSale("V1", creditClerk, "SALE1", { items: [{ saleItemId: "IT1", qty: 1 }], clientRequestId: "refund-op-0002" });
    assert.equal(other.duplicate, false);
    assert.equal(w.vouchers.length, 2);
    await assert.rejects(svc.refundSale("V1", creditClerk, "SALE1", { clientRequestId: "bad id!" }), (e: any) => e.statusCode === 400);
  } finally {
    w.s.restore();
  }
});

test("refund with an operation id: a concurrent twin that loses its transaction returns the winner's refund", async () => {
  const w = refundWorld({ paidAmount: 0, dueAmount: 200 });
  try {
    await svc.refundSale("V1", creditClerk, "SALE1", { clientRequestId: "twin-op-0001" });
    // The twin read before the winner committed: its in-transaction lookup saw nothing and it then lost.
    w.tx.voucher.findUnique = async () => null;
    const stale = { ...w.row, status: "PENDING", dueAmount: 200, paidAmount: 0, items: w.row.items.map((i: any) => ({ ...i, refundedQty: 0 })) };
    w.tx.posSale.findFirst = async () => stale;
    const twin = await svc.refundSale("V1", creditClerk, "SALE1", { clientRequestId: "twin-op-0001" });
    assert.deepEqual([twin.duplicate, (twin.voucher as any).id], [true, "VR1"]);
    assert.equal(w.vouchers.length, 1, "no second refund voucher");
  } finally {
    w.s.restore();
  }
});

test("due collection with an operation id: a repeat after completion collects nothing more; a twin that loses returns the first", async () => {
  const s = stubber();
  const sale = { id: "SALE1", vendorId: "V1", invoiceNo: "INV-1", status: "PENDING", customerId: "C1", accountingVoucherId: "VSALE" };
  let dueNow = 100;
  const vouchers: any[] = [];
  const raws: any[] = [];
  const key = (d: any) => posVoucherIdempotencyKey("RECEIPT", "POS_DUE_PAYMENT", "pos_due_payment", d.vendorId, d.paymentInvoiceId);
  const byKey = (k: string) => (vouchers.some((d) => key(d) === k) ? { id: "VP1" } : null);
  const tx: any = {
    posSale: {
      findFirst: async () => ({ ...sale, dueAmount: dueNow }),
      updateMany: async (a: any) => (a.where.dueAmount === dueNow ? ((dueNow -= a.data.dueAmount.decrement), { count: 1 }) : { count: 0 }),
      findUniqueOrThrow: async () => ({ dueAmount: dueNow }),
      update: async () => ({}),
    },
    posCustomer: { findFirst: async () => ({ name: "Karim" }) },
    $executeRaw: async (q: Prisma.Sql) => (raws.push(q.values), 1),
    voucher: { findUnique: async ({ where }: any) => byKey(where.idempotencyKey) },
  };
  s.set(prismaDirect, "$transaction", async (work: any) => work(tx));
  s.model(prisma, "posSale", { findFirst: async () => ({ id: "SALE1", invoiceNo: "INV-1" }) });
  s.model(prisma, "voucher", { findUnique: async ({ where }: any) => byKey(where.idempotencyKey) });
  s.set(AccountingService.prototype, "createPOSDuePaymentVoucher", async (d: any) => (vouchers.push(d), { id: "VP1" }));
  s.set(AccountingService.prototype, "posReceivableAccountForSale", async () => "RECV");
  try {
    const op = { payingAmount: 30, paymentMethod: "CASH" as const, clientRequestId: "collect-op-0001" };
    const first = await svc.payDue("V1", cashier, "SALE1", op);
    assert.equal(first.duplicate, false);
    assert.equal(vouchers[0].paymentInvoiceId, "INV-1-DP-collect-op-0001");
    const again = await svc.payDue("V1", cashier, "SALE1", op);
    assert.equal(again.duplicate, true);
    assert.deepEqual([dueNow, vouchers.length, raws.length], [70, 1, 1], "collected once");
    // twin: in-transaction lookup missed, the optimistic update lost → returns the first
    tx.voucher.findUnique = async () => null;
    tx.posSale.findFirst = async () => ({ ...sale, dueAmount: 100 });
    const twin = await svc.payDue("V1", cashier, "SALE1", op);
    assert.equal(twin.duplicate, true);
    assert.deepEqual([dueNow, vouchers.length], [70, 1]);
    // without an id the old behaviour stands: a second completed request is a new collection
    tx.voucher.findUnique = async ({ where }: any) => byKey(where.idempotencyKey);
    tx.posSale.findFirst = async () => ({ ...sale, dueAmount: dueNow });
    await svc.payDue("V1", cashier, "SALE1", { payingAmount: 30, paymentMethod: "CASH" });
    assert.equal(dueNow, 40, "no operation id → not protected against a deliberate repeat");
  } finally {
    s.restore();
  }
});

test("unsupported amount fields: negatives, text and malformed values are refused before any write; absent/null/zero are accepted", async () => {
  const w = saleWorld(null);
  try {
    const bad = [-1, "abc", "5", 0.01, true, [5], { n: 1 }, Number.POSITIVE_INFINITY];
    for (const v of bad) {
      for (const k of ["extraAmount", "dueCutAmount", "walletAddAmount"]) {
        await assert.rejects(svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: "CASH", items, [k]: v } as any), (e: any) => e.statusCode === 400, `${k}=${JSON.stringify(v)}`);
      }
    }
    assert.deepEqual(w.committed, [], "nothing written for any refused value");
    for (const v of [undefined, null, "", 0, "0", false]) {
      await svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: "CASH", items, extraAmount: v, dueCutAmount: v, walletAddAmount: v } as any);
    }
    assert.equal(w.committed.filter((c) => c === "sale").length, 6, "zero-equivalent values keep older clients working");
  } finally {
    w.s.restore();
  }
});

// ─── store status ─────────────────────────────────────────────────────────

test("suspended / deactivated store: owner and staff can't open new sales (cash or credit) — refused before any write", async () => {
  for (const status of ["SUSPENDED", "DEACTIVATED"]) {
    const w = saleWorld({ loanLimit: 500, due: 0 }, { storeStatus: status });
    try {
      for (const actor of [owner, creditClerk, cashier]) {
        await assert.rejects(svc.createSale("V1", actor, { paidAmount: 100, paymentMethod: "CASH", items }), (e: any) => e.statusCode === 403 && e.message.includes(status.toLowerCase()), `${status} cash sale`);
        await assert.rejects(svc.createSale("V1", actor, { customerId: "C1", paidAmount: 40, paymentMethod: "CASH", items }), (e: any) => e.statusCode === 403, `${status} credit sale`);
      }
      assert.deepEqual([w.committed, w.raw, w.vouchers, w.preCreated], [[], [], [], []], "no stock, sale, customer, account or voucher change");
      // spoofed status / vendor in the body changes nothing: the status is read for the session's vendor
      await assert.rejects(svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: "CASH", items, ...({ status: "ACTIVE", vendorId: "V2", storeStatus: "ACTIVE" } as any) }), (e: any) => e.statusCode === 403);
      assert.ok(w.storeReads.every((id) => id === "V1"), "status read for the session vendor only");
    } finally {
      w.s.restore();
    }
  }
});

test("pending (onboarding) and active stores can sell; an unknown store id is refused", async () => {
  for (const status of ["PENDING", "ACTIVE"]) {
    const w = saleWorld(null, { storeStatus: status });
    try {
      await svc.createSale("V1", owner, { paidAmount: 100, paymentMethod: "CASH", items });
      assert.ok(w.committed.includes("sale"), `${status} store sells`);
    } finally {
      w.s.restore();
    }
  }
  const w = saleWorld(null);
  try {
    await assert.rejects(svc.createSale("V9", owner, { paidAmount: 100, paymentMethod: "CASH", items }), (e: any) => e.statusCode === 404, "no store row");
  } finally {
    w.s.restore();
  }
});

test("a suspended store can still settle existing obligations: refunds, voids and due collection don't read the store status", async () => {
  const w = refundWorld({ paidAmount: 50, dueAmount: 150 });
  const s = stubber();
  s.model(prisma, "vendor", { findUnique: async () => assert.fail("refund/void must not be blocked by store status") });
  try {
    const r = await svc.refundSale("V1", creditClerk, "SALE1", { items: [{ saleItemId: "IT1", qty: 1 }] });
    assert.equal(r.duplicate, false);
  } finally {
    s.restore();
    w.s.restore();
  }
});
