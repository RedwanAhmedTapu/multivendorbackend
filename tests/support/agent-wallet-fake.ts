// tests/support/agent-wallet-fake.ts
//
// Extends the in-memory agent fake (agent-fake-db.ts) with what the Phase 7
// wallet code needs: composite unique keys, Decimal-safe increments,
// aggregate/groupBy, the reversal → commission relation, and transactions
// that EMULATE the wallet row lock: `SELECT … FOR UPDATE` on agent_wallets
// blocks any other transaction on the same agent until the holder finishes.
// Without that emulation two concurrent withdrawals would interleave freely,
// so the concurrency tests prove the code takes the lock before reading.

import Decimal from "decimal.js";
import { makeTable, matches } from "./agent-fake-db.ts";

/** A unique check on several columns, like @@unique([a, b]). */
export function compositeUnique(table: any, keys: string[]) {
  const create = table.create;
  table.create = async (args: any) => {
    if (table.rows.some((r: any) => keys.every((k) => r[k] === args.data[k]))) {
      const err: any = new Error(`Unique constraint failed on (${keys.join(", ")})`);
      err.code = "P2002";
      throw err;
    }
    return create(args);
  };
}

/** Decimal-safe { increment } on updateMany (the shared fake adds with JS +). */
export function decimalIncrements(table: any) {
  const updateMany = table.updateMany;
  table.updateMany = async ({ where, data }: any) => {
    const fixed: any = { ...data };
    const inc: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as any) && typeof (v as any).increment === "string") {
        inc[k] = (v as any).increment;
        delete fixed[k];
      }
    }
    const before = table.rows.filter((r: any) => matches(r, where));
    const res = await updateMany({ where, data: fixed });
    if (res.count) for (const r of before) for (const [k, v] of Object.entries(inc)) r[k] = new Decimal(r[k] ?? 0).plus(v).toFixed(2);
    return res;
  };
}

/** aggregate({ where, _sum }) and groupBy({ by: [one], where, _count, _sum }). */
export function aggregates(table: any) {
  const sum = (rows: any[], field: string) => (rows.length ? rows.reduce((s, r) => s.plus(r[field] ?? 0), new Decimal(0)).toFixed(2) : null);
  table.aggregate = async ({ where, _sum }: any) => {
    const rows = table.rows.filter((r: any) => matches(r, where));
    const out: any = { _sum: {} };
    for (const f of Object.keys(_sum ?? {})) out._sum[f] = sum(rows, f);
    return out;
  };
  table.groupBy = async ({ by, where, _sum }: any) => {
    const groups = new Map<string, any[]>();
    for (const r of table.rows.filter((r: any) => matches(r, where))) {
      const k = r[by[0]];
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups].map(([k, rows]) => {
      const g: any = { [by[0]]: k, _count: { _all: rows.length }, _sum: {} };
      for (const f of Object.keys(_sum ?? {})) g._sum[f] = sum(rows, f);
      return g;
    });
  };
}

/** findMany orderBy on one or more simple fields (the shared fake ignores it). */
export function ordering(table: any) {
  const findMany = table.findMany;
  table.findMany = async (args: any = {}) => {
    const list = await findMany({ ...args, skip: undefined, take: undefined });
    const order = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
    if (order.length) {
      // findMany returns copies; order them by the stored rows' values.
      list.sort((a: any, b: any) => {
        for (const o of order) {
          const [k, dir] = Object.entries(o)[0] as [string, string];
          const av = a[k] instanceof Date ? a[k].getTime() : a[k];
          const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
          if (av === bv || av === undefined || bv === undefined) continue;
          return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
        }
        return 0;
      });
    }
    let out = list;
    if (args.skip) out = out.slice(args.skip);
    if (args.take) out = out.slice(0, args.take);
    return out;
  };
}

/** Install the Phase 7 tables and the locking transaction on an agent fake. */
export function installWalletTables(db: any) {
  db.agentWallet = makeTable("wallet", {
    defaults: () => ({ available: "0.00", pendingClearance: "0.00", onHold: "0.00", totalEarned: "0.00", totalWithdrawn: "0.00" }),
  });
  db.agentWalletTransaction = makeTable("wtx");
  compositeUnique(db.agentWalletTransaction, ["type", "refType", "refId"]);
  ordering(db.agentWalletTransaction);
  db.agentPayoutMethod = makeTable("pm", { defaults: () => ({ isDefault: false, bankName: null, branch: null, routingNumber: null }) });
  ordering(db.agentPayoutMethod);
  db.agentWithdrawal = makeTable("wd", {
    defaults: () => ({ status: "REQUESTED", fee: "0.00", autoApproved: false, reviewedById: null, reviewedAt: null, rejectReason: null, paidById: null, paidAt: null, transactionRef: null }),
  });
  compositeUnique(db.agentWithdrawal, ["agentId", "clientRequestId"]);
  aggregates(db.agentWithdrawal);
  ordering(db.agentWithdrawal);
  const wdFindUnique = db.agentWithdrawal.findUnique;
  db.agentWithdrawal.findUnique = async (args: any) => {
    const k = args.where?.agentId_clientRequestId;
    return wdFindUnique(k ? { ...args, where: k } : args);
  };

  // reversal → commission relation (where + select)
  const commissionOf = (r: any) => db.agentCommission.rows.find((c: any) => c.id === r.commissionId);
  const revFindMany = db.agentCommissionReversal.findMany;
  db.agentCommissionReversal.findMany = async (args: any = {}) => {
    const { commission: relWhere, ...where } = args.where ?? {};
    const { commission: relSelect, ...select } = args.select ?? {};
    const ids = db.agentCommissionReversal.rows.filter((r: any) => (relWhere ? matches(commissionOf(r) ?? {}, relWhere) : true)).map((r: any) => r.id);
    const list = await revFindMany({ ...args, where: { ...where, id: { in: ids } }, select: args.select ? { ...select, id: true } : undefined });
    return list.map((r: any) => {
      const full = db.agentCommissionReversal.rows.find((x: any) => x.id === r.id);
      const out = { ...r };
      if (relSelect) {
        const c = commissionOf(full);
        out.commission = Object.fromEntries(Object.keys(relSelect.select).map((k) => [k, c?.[k]]));
      }
      if (args.select && !args.select.id) delete out.id;
      return out;
    });
  };
  aggregates(db.agentCommission);

  // Raw SQL: wallet insert + row lock; advisory locks are no-ops.
  const locks = new Map<string, Promise<void>>();
  const rawFor = (held: Set<string>, release: Array<() => void>) => async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join("?");
    if (sql.includes('INSERT INTO "agent_wallets"')) {
      const agentId = values[0];
      if (!db.agentWallet.rows.some((r: any) => r.agentId === agentId)) await db.agentWallet.create({ data: { id: agentId, agentId } });
      return 1;
    }
    if (sql.includes('FROM "agent_wallets"') && sql.includes("FOR UPDATE")) {
      const key = String(values[0]);
      if (held.has(key)) return 1;
      while (locks.has(key)) await locks.get(key);
      let done!: () => void;
      locks.set(key, new Promise<void>((r) => (done = r)));
      held.add(key);
      release.push(() => {
        locks.delete(key);
        done();
      });
      return 1;
    }
    return 0;
  };
  db.$executeRaw = rawFor(new Set(), []); // outside a transaction a lock is never held
  db.$transaction = async (fn: any) => {
    const held = new Set<string>();
    const release: Array<() => void> = [];
    const tx = Object.create(db);
    tx.$executeRaw = rawFor(held, release);
    try {
      return await fn(tx);
    } finally {
      for (const r of release) r();
    }
  };
}
